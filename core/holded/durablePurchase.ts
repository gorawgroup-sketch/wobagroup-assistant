import { createHash } from "node:crypto";
import type { Empresa } from "./client";

export type EstadoCreacionCompra = "preparada" | "creando" | "verificada" | "incierta";

export interface ResultadoCreacionCompra {
  id: string;
}

export interface RegistroCreacionCompra {
  clave: string;
  proceso: string;
  estado: EstadoCreacionCompra;
  marcador: string;
  empresa: Empresa;
  contactId: string;
  fecha: string;
  huellaSolicitud: string;
  holdedPurchaseId?: string;
  creadoEn: number;
  actualizadoEn: number;
  verificadoEn?: number;
}

export interface RepositorioCreacionesCompra {
  reservar(registro: RegistroCreacionCompra): Promise<{ registro: RegistroCreacionCompra; nuevo: boolean }>;
  obtener(clave: string): Promise<RegistroCreacionCompra | undefined>;
  actualizarPreparada(clave: string, registro: RegistroCreacionCompra): Promise<RegistroCreacionCompra | undefined>;
  marcarCreando(clave: string): Promise<RegistroCreacionCompra | undefined>;
  marcarPreparada(clave: string): Promise<void>;
  marcarVerificada(clave: string, resultado: ResultadoCreacionCompra): Promise<void>;
  marcarIncierta(clave: string): Promise<void>;
  listarPendientes(): Promise<RegistroCreacionCompra[]>;
}

export interface TransporteCreacionCompra {
  buscar(registro: RegistroCreacionCompra): Promise<ResultadoCreacionCompra | undefined>;
  crear(marcador: string): Promise<ResultadoCreacionCompra>;
}

export class CreacionCompraInciertaError extends Error {
  constructor() {
    super(
      "Holded no confirmó si la compra quedó creada. Wobi bloqueó cualquier repetición automática y la dejó pendiente de verificación para evitar un gasto duplicado."
    );
    this.name = "CreacionCompraInciertaError";
  }
}

export class ConflictoCreacionCompraError extends CreacionCompraInciertaError {
  constructor() {
    super();
    this.message =
      "La misma aprobación ya inició una creación de compra con datos distintos. Wobi la bloqueó hasta verificar el resultado anterior en Holded.";
    this.name = "ConflictoCreacionCompraError";
  }
}

function jsonEstable(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(jsonEstable).join(",")}]`;
  const objeto = valor as Record<string, unknown>;
  return `{${Object.keys(objeto)
    .sort()
    .map((clave) => `${JSON.stringify(clave)}:${jsonEstable(objeto[clave])}`)
    .join(",")}}`;
}

export function identidadCreacionCompra(
  idempotencyKey: string,
  empresa: Empresa,
  contactId: string,
  fecha: string,
  solicitud: unknown,
  ahora = Date.now()
): RegistroCreacionCompra {
  const identidad = idempotencyKey.trim();
  const contacto = contactId.trim();
  const fechaNormalizada = fecha.trim();
  if (!identidad || identidad.length > 300) {
    throw new Error("La clave idempotente de la compra es obligatoria y debe tener como máximo 300 caracteres.");
  }
  if (!contacto || contacto.length > 100) throw new Error("El contacto de la compra es obligatorio.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaNormalizada)) throw new Error("La fecha durable de la compra debe usar YYYY-MM-DD.");

  const clave = createHash("sha256")
    .update(`wobi-holded-purchase-v1\0${empresa}\0${identidad}`)
    .digest("hex");
  return {
    clave,
    proceso: "crear_gasto",
    estado: "preparada",
    marcador: `[wobi:${clave}]`,
    empresa,
    contactId: contacto,
    fecha: fechaNormalizada,
    huellaSolicitud: createHash("sha256").update(jsonEstable(solicitud)).digest("hex"),
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
}

function resultadoGuardado(registro: RegistroCreacionCompra): ResultadoCreacionCompra {
  return { id: registro.holdedPurchaseId ?? "" };
}

function codigoHttp(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const valor = e.response?.status ?? e.status ?? e.code;
  const numero = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(numero) ? numero : undefined;
}

/** Solo rechazos 4xx inequívocos permiten repetir. Timeouts, 408/409/425/429 y 5xx son ambiguos. */
export function esRechazoDefinitivoSinCompra(error: unknown): boolean {
  const codigo = codigoHttp(error);
  return codigo !== undefined && codigo >= 400 && codigo < 500 && ![408, 409, 425, 429].includes(codigo);
}

async function verificarExistencia(
  registro: RegistroCreacionCompra,
  repositorio: RepositorioCreacionesCompra,
  transporte: TransporteCreacionCompra
): Promise<ResultadoCreacionCompra | undefined> {
  const encontrado = await transporte.buscar(registro);
  if (encontrado) await repositorio.marcarVerificada(registro.clave, encontrado);
  return encontrado;
}

/** Consulta previa: evita recalcular impuestos/tasas y, sobre todo, repetir un POST ya iniciado. */
export async function consultarCreacionCompraDurable(
  idempotencyKey: string,
  empresa: Empresa,
  contactId: string,
  fecha: string,
  solicitud: unknown,
  repositorio: RepositorioCreacionesCompra,
  buscar: TransporteCreacionCompra["buscar"]
): Promise<ResultadoCreacionCompra | undefined> {
  const identidad = identidadCreacionCompra(idempotencyKey, empresa, contactId, fecha, solicitud);
  const registro = await repositorio.obtener(identidad.clave);
  if (!registro || registro.estado === "preparada") return undefined;
  if (registro.huellaSolicitud !== identidad.huellaSolicitud) throw new ConflictoCreacionCompraError();
  if (registro.estado === "verificada") return resultadoGuardado(registro);
  const encontrado = await buscar(registro);
  if (encontrado) {
    await repositorio.marcarVerificada(registro.clave, encontrado);
    return encontrado;
  }
  if (registro.estado === "creando") await repositorio.marcarIncierta(registro.clave);
  throw new CreacionCompraInciertaError();
}

/**
 * Frontera conservadora para compras de Holded:
 * - preparada puede crear;
 * - creando/incierta solo consulta el marcador interno, nunca repite POST;
 * - verificada devuelve el id durable;
 * - un rechazo 4xx inequívoco vuelve a preparada y permite corregir la propuesta.
 */
export async function ejecutarCreacionCompraDurable(
  idempotencyKey: string,
  empresa: Empresa,
  contactId: string,
  fecha: string,
  solicitud: unknown,
  proceso: string,
  repositorio: RepositorioCreacionesCompra,
  transporte: TransporteCreacionCompra,
  ahora = Date.now()
): Promise<{ resultado: ResultadoCreacionCompra; reutilizado: boolean }> {
  const inicial = { ...identidadCreacionCompra(idempotencyKey, empresa, contactId, fecha, solicitud, ahora), proceso };
  let { registro } = await repositorio.reservar(inicial);

  if (registro.huellaSolicitud !== inicial.huellaSolicitud) {
    if (registro.estado !== "preparada") throw new ConflictoCreacionCompraError();
    const actualizado = await repositorio.actualizarPreparada(registro.clave, inicial);
    if (!actualizado) throw new ConflictoCreacionCompraError();
    registro = actualizado;
  }

  if (registro.estado === "verificada") {
    return { resultado: resultadoGuardado(registro), reutilizado: true };
  }

  if (registro.estado === "creando" || registro.estado === "incierta") {
    const encontrado = await verificarExistencia(registro, repositorio, transporte);
    if (encontrado) return { resultado: encontrado, reutilizado: true };
    if (registro.estado === "creando") await repositorio.marcarIncierta(registro.clave);
    throw new CreacionCompraInciertaError();
  }

  const creando = await repositorio.marcarCreando(registro.clave);
  if (!creando) {
    const actual = await repositorio.obtener(registro.clave);
    if (actual?.estado === "verificada") return { resultado: resultadoGuardado(actual), reutilizado: true };
    throw new CreacionCompraInciertaError();
  }

  let resultado: ResultadoCreacionCompra;
  try {
    resultado = await transporte.crear(creando.marcador);
  } catch (error) {
    if (esRechazoDefinitivoSinCompra(error)) {
      await repositorio.marcarPreparada(creando.clave);
      throw error;
    }
    try {
      const encontrado = await verificarExistencia(creando, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // La lectura también falló o fue ambigua: se conserva la salida segura.
    }
    await repositorio.marcarIncierta(creando.clave);
    throw new CreacionCompraInciertaError();
  }

  try {
    await repositorio.marcarVerificada(creando.clave, resultado);
  } catch {
    try {
      const encontrado = await verificarExistencia(creando, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // El POST pudo terminar; nunca se repite si falla el checkpoint.
    }
    await repositorio.marcarIncierta(creando.clave).catch(() => undefined);
    throw new CreacionCompraInciertaError();
  }

  return { resultado, reutilizado: false };
}

export async function reconciliarCreacionesCompraPendientes(
  repositorio: RepositorioCreacionesCompra,
  buscar: TransporteCreacionCompra["buscar"]
): Promise<{ revisadas: number; verificadas: number; inciertas: number; errores: number }> {
  const pendientes = await repositorio.listarPendientes();
  let verificadas = 0;
  let inciertas = 0;
  let errores = 0;
  for (const registro of pendientes) {
    try {
      const encontrado = await buscar(registro);
      if (encontrado) {
        await repositorio.marcarVerificada(registro.clave, encontrado);
        verificadas++;
      } else {
        if (registro.estado === "creando") await repositorio.marcarIncierta(registro.clave);
        inciertas++;
      }
    } catch {
      errores++;
    }
  }
  return { revisadas: pendientes.length, verificadas, inciertas, errores };
}
