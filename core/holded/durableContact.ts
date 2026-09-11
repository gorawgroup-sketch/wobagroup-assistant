import { createHash } from "node:crypto";
import type { Empresa } from "./client";

export type EstadoCreacionContacto = "preparada" | "creando" | "verificada" | "incierta";

export interface ResultadoCreacionContacto {
  id: string;
  name: string;
}

export interface RegistroCreacionContacto {
  clave: string;
  proceso: string;
  estado: EstadoCreacionContacto;
  empresa: Empresa;
  nombre: string;
  nombreNormalizado: string;
  codigoFiscal?: string;
  codigoFiscalNormalizado?: string;
  huellaSolicitud: string;
  holdedContactId?: string;
  creadoEn: number;
  actualizadoEn: number;
  verificadoEn?: number;
}

export interface RepositorioCreacionesContacto {
  reservar(registro: RegistroCreacionContacto): Promise<{ registro: RegistroCreacionContacto; nuevo: boolean }>;
  obtener(clave: string): Promise<RegistroCreacionContacto | undefined>;
  marcarCreando(clave: string): Promise<RegistroCreacionContacto | undefined>;
  marcarPreparada(clave: string): Promise<void>;
  marcarVerificada(clave: string, resultado: ResultadoCreacionContacto): Promise<void>;
  marcarIncierta(clave: string): Promise<void>;
  listarPendientes(): Promise<RegistroCreacionContacto[]>;
}

export type InspeccionCreacionContacto =
  | { estado: "ausente" }
  | { estado: "unico"; resultado: ResultadoCreacionContacto }
  | { estado: "ambiguo"; cantidad: number };

export interface TransporteCreacionContacto {
  inspeccionar(registro: RegistroCreacionContacto): Promise<InspeccionCreacionContacto>;
  crear(registro: RegistroCreacionContacto): Promise<ResultadoCreacionContacto>;
}

export class CreacionContactoInciertaError extends Error {
  constructor() {
    super(
      "Holded no confirmó si el contacto quedó creado. Wobi bloqueó cualquier repetición automática y lo dejó pendiente de verificación para evitar proveedores duplicados."
    );
    this.name = "CreacionContactoInciertaError";
  }
}

export class ContactosHoldedAmbiguosError extends CreacionContactoInciertaError {
  constructor(public readonly cantidad: number, public readonly despuesDeEscritura: boolean) {
    super();
    this.message = despuesDeEscritura
      ? `Holded devuelve ${cantidad} contactos exactos después del intento de creación. Wobi no puede atribuir uno con seguridad y bloqueó cualquier repetición.`
      : `Holded ya contiene ${cantidad} contactos exactos para este proveedor. Wobi no creó otro; hay que resolver el duplicado antes de continuar.`;
    this.name = "ContactosHoldedAmbiguosError";
  }
}

function hash(valor: string): string {
  return createHash("sha256").update(valor).digest("hex");
}

export function normalizarNombreContacto(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizarCodigoFiscalContacto(valor: string): string {
  return valor.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function identidadCreacionContacto(
  empresa: Empresa,
  nombre: string,
  codigoFiscal: string | undefined,
  proceso: string,
  ahora = Date.now()
): RegistroCreacionContacto {
  const nombreLimpio = nombre.trim().replace(/\s+/g, " ");
  const nombreNormalizado = normalizarNombreContacto(nombreLimpio);
  const codigoLimpio = codigoFiscal?.trim().replace(/\s+/g, " ") || undefined;
  const codigoFiscalNormalizado = codigoLimpio ? normalizarCodigoFiscalContacto(codigoLimpio) : undefined;

  if (!nombreNormalizado || nombreLimpio.length > 200) {
    throw new Error("El nombre del contacto es obligatorio y debe tener como máximo 200 caracteres.");
  }
  if (codigoLimpio && (!codigoFiscalNormalizado || codigoLimpio.length > 100)) {
    throw new Error("El código fiscal del contacto debe tener como máximo 100 caracteres válidos.");
  }

  const identidad = `${empresa}\0supplier\0${nombreNormalizado}\0${codigoFiscalNormalizado ?? ""}`;
  return {
    clave: hash(`wobi-holded-contact-v1\0${identidad}`),
    proceso,
    estado: "preparada",
    empresa,
    nombre: nombreLimpio,
    nombreNormalizado,
    codigoFiscal: codigoLimpio,
    codigoFiscalNormalizado,
    huellaSolicitud: hash(identidad),
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
}

function resultadoGuardado(registro: RegistroCreacionContacto): ResultadoCreacionContacto {
  return { id: registro.holdedContactId ?? "", name: registro.nombre };
}

function codigoHttp(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const valor = e.response?.status ?? e.status ?? e.code;
  const numero = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(numero) ? numero : undefined;
}

/** Holded documenta 422 como validación. Timeouts, 408/409/425/429 y 5xx siguen siendo ambiguos. */
export function esRechazoDefinitivoSinContacto(error: unknown): boolean {
  const codigo = codigoHttp(error);
  return codigo !== undefined && codigo >= 400 && codigo < 500 && ![408, 409, 425, 429].includes(codigo);
}

async function recuperar(
  registro: RegistroCreacionContacto,
  repositorio: RepositorioCreacionesContacto,
  transporte: TransporteCreacionContacto,
  despuesDeEscritura: boolean
): Promise<ResultadoCreacionContacto | undefined> {
  const inspeccion = await transporte.inspeccionar(registro);
  if (inspeccion.estado === "ambiguo") {
    throw new ContactosHoldedAmbiguosError(inspeccion.cantidad, despuesDeEscritura);
  }
  if (inspeccion.estado !== "unico") return undefined;
  await repositorio.marcarVerificada(registro.clave, inspeccion.resultado);
  return inspeccion.resultado;
}

/**
 * Frontera exactamente-una-vez para POST /contacts:
 * - siempre consulta primero coincidencias exactas;
 * - registra `creando` antes del único POST permitido;
 * - tras cualquier resultado ambiguo solo consulta, nunca vuelve a crear;
 * - varias coincidencias exactas bloquean la selección automática.
 */
export async function ejecutarCreacionContactoDurable(
  inicial: RegistroCreacionContacto,
  repositorio: RepositorioCreacionesContacto,
  transporte: TransporteCreacionContacto
): Promise<{ resultado: ResultadoCreacionContacto; reutilizado: boolean }> {
  const { registro } = await repositorio.reservar(inicial);
  if (registro.huellaSolicitud !== inicial.huellaSolicitud) throw new CreacionContactoInciertaError();

  if (registro.estado === "verificada") {
    const resultado = resultadoGuardado(registro);
    if (resultado.id) return { resultado, reutilizado: true };
    throw new CreacionContactoInciertaError();
  }

  if (registro.estado === "creando" || registro.estado === "incierta") {
    try {
      const encontrado = await recuperar(registro, repositorio, transporte, true);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch (error) {
      if (error instanceof ContactosHoldedAmbiguosError) {
        if (registro.estado === "creando") await repositorio.marcarIncierta(registro.clave).catch(() => undefined);
        throw error;
      }
      // Un fallo de lectura no puede autorizar otro POST.
    }
    if (registro.estado === "creando") await repositorio.marcarIncierta(registro.clave).catch(() => undefined);
    throw new CreacionContactoInciertaError();
  }

  const previo = await transporte.inspeccionar(registro);
  if (previo.estado === "ambiguo") throw new ContactosHoldedAmbiguosError(previo.cantidad, false);
  if (previo.estado === "unico") {
    await repositorio.marcarVerificada(registro.clave, previo.resultado);
    return { resultado: previo.resultado, reutilizado: true };
  }

  const creando = await repositorio.marcarCreando(registro.clave);
  if (!creando) throw new CreacionContactoInciertaError();

  let resultado: ResultadoCreacionContacto;
  try {
    resultado = await transporte.crear(creando);
  } catch (error) {
    if (esRechazoDefinitivoSinContacto(error)) {
      await repositorio.marcarPreparada(creando.clave);
      throw error;
    }
    try {
      const encontrado = await recuperar(creando, repositorio, transporte, true);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch (recuperacionError) {
      await repositorio.marcarIncierta(creando.clave).catch(() => undefined);
      if (recuperacionError instanceof ContactosHoldedAmbiguosError) throw recuperacionError;
      throw new CreacionContactoInciertaError();
    }
    await repositorio.marcarIncierta(creando.clave).catch(() => undefined);
    throw new CreacionContactoInciertaError();
  }

  try {
    await repositorio.marcarVerificada(creando.clave, resultado);
  } catch {
    try {
      const encontrado = await recuperar(creando, repositorio, transporte, true);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch (error) {
      await repositorio.marcarIncierta(creando.clave).catch(() => undefined);
      if (error instanceof ContactosHoldedAmbiguosError) throw error;
      throw new CreacionContactoInciertaError();
    }
    await repositorio.marcarIncierta(creando.clave).catch(() => undefined);
    throw new CreacionContactoInciertaError();
  }

  return { resultado, reutilizado: false };
}

/** Recuperación de arranque exclusivamente por GET. */
export async function reconciliarCreacionesContactoPendientes(
  repositorio: RepositorioCreacionesContacto,
  inspeccionar: TransporteCreacionContacto["inspeccionar"]
): Promise<{ revisadas: number; verificadas: number; inciertas: number; ambiguas: number; errores: number }> {
  const pendientes = await repositorio.listarPendientes();
  let verificadas = 0;
  let inciertas = 0;
  let ambiguas = 0;
  let errores = 0;
  for (const registro of pendientes) {
    try {
      const inspeccion = await inspeccionar(registro);
      if (inspeccion.estado === "unico") {
        await repositorio.marcarVerificada(registro.clave, inspeccion.resultado);
        verificadas++;
      } else {
        if (registro.estado === "creando") await repositorio.marcarIncierta(registro.clave);
        if (inspeccion.estado === "ambiguo") ambiguas++;
        inciertas++;
      }
    } catch {
      errores++;
    }
  }
  return { revisadas: pendientes.length, verificadas, inciertas, ambiguas, errores };
}
