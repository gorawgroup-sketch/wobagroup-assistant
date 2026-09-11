import { createHash } from "node:crypto";
import type { Empresa } from "./client";
import { esRechazoDefinitivoSinCompra } from "./durablePurchase";

export type EstadoEdicionCompra = "preparada" | "editando" | "verificada" | "incierta";

export interface RegistroEdicionCompra {
  clave: string;
  proceso: string;
  estado: EstadoEdicionCompra;
  empresa: Empresa;
  purchaseId: string;
  huellaSolicitud: string;
  huellaEsperada?: string;
  verificarTotal?: boolean;
  creadoEn: number;
  actualizadoEn: number;
  verificadoEn?: number;
}

export interface PreparacionEdicionCompra {
  huellaEsperada: string;
  verificarTotal: boolean;
  /** Solo vive en memoria durante la llamada; el ledger nunca persiste el body financiero. */
  payload: unknown;
}

export interface ResultadoEdicionCompra<T> {
  id: string;
  valor: T;
}

export interface RepositorioEdicionesCompra {
  reservar(registro: RegistroEdicionCompra): Promise<{ registro: RegistroEdicionCompra; nuevo: boolean }>;
  obtener(clave: string): Promise<RegistroEdicionCompra | undefined>;
  actualizarPreparada(clave: string, registro: RegistroEdicionCompra): Promise<RegistroEdicionCompra | undefined>;
  marcarEditando(clave: string, huellaEsperada: string, verificarTotal: boolean): Promise<RegistroEdicionCompra | undefined>;
  marcarPreparada(clave: string): Promise<void>;
  marcarVerificada(clave: string): Promise<void>;
  marcarIncierta(clave: string): Promise<void>;
  listarPendientes(): Promise<RegistroEdicionCompra[]>;
}

export interface TransporteEdicionCompra<T> {
  preparar(): Promise<PreparacionEdicionCompra>;
  editar(preparacion: PreparacionEdicionCompra): Promise<void>;
  verificar(registro: RegistroEdicionCompra): Promise<ResultadoEdicionCompra<T> | undefined>;
}

export class EdicionCompraInciertaError extends Error {
  constructor() {
    super(
      "Holded no confirmó si la edición quedó aplicada. Wobi bloqueó cualquier repetición automática y la dejó pendiente de verificación para evitar sobrescribir el documento."
    );
    this.name = "EdicionCompraInciertaError";
  }
}

export class ConflictoEdicionCompraError extends EdicionCompraInciertaError {
  constructor() {
    super();
    this.message =
      "La misma aprobación ya inició una edición con datos distintos. Wobi bloqueó el cambio hasta verificar el resultado anterior en Holded.";
    this.name = "ConflictoEdicionCompraError";
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

export function identidadEdicionCompra(
  idempotencyKey: string,
  empresa: Empresa,
  purchaseId: string,
  cambios: unknown,
  proceso: string,
  ahora = Date.now()
): RegistroEdicionCompra {
  const identidad = idempotencyKey.trim();
  const compra = purchaseId.trim();
  if (!identidad || identidad.length > 300) {
    throw new Error("La clave idempotente de la edición es obligatoria y debe tener como máximo 300 caracteres.");
  }
  if (!compra || compra.length > 200) throw new Error("El id de la compra a editar es obligatorio.");
  const clave = createHash("sha256")
    .update(`wobi-holded-purchase-edit-v1\0${empresa}\0${identidad}`)
    .digest("hex");
  return {
    clave,
    proceso,
    estado: "preparada",
    empresa,
    purchaseId: compra,
    huellaSolicitud: createHash("sha256")
      .update(jsonEstable({ purchaseId: compra, cambios }))
      .digest("hex"),
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
}

async function verificar<T>(
  registro: RegistroEdicionCompra,
  repositorio: RepositorioEdicionesCompra,
  transporte: TransporteEdicionCompra<T>
): Promise<ResultadoEdicionCompra<T> | undefined> {
  if (!registro.huellaEsperada) return undefined;
  const encontrado = await transporte.verificar(registro);
  if (encontrado) await repositorio.marcarVerificada(registro.clave);
  return encontrado;
}

/**
 * Frontera durable para PUT /purchases/{id}. Una vez que el estado llega a
 * editando, ningún camino vuelve a ejecutar el PUT: solo relee la compra y
 * compara una huella de los campos esperados.
 */
export async function ejecutarEdicionCompraDurable<T>(
  idempotencyKey: string,
  empresa: Empresa,
  purchaseId: string,
  cambios: unknown,
  proceso: string,
  repositorio: RepositorioEdicionesCompra,
  transporte: TransporteEdicionCompra<T>,
  ahora = Date.now()
): Promise<{ resultado: ResultadoEdicionCompra<T>; reutilizado: boolean }> {
  const inicial = identidadEdicionCompra(idempotencyKey, empresa, purchaseId, cambios, proceso, ahora);
  let { registro } = await repositorio.reservar(inicial);

  if (registro.huellaSolicitud !== inicial.huellaSolicitud) {
    if (registro.estado !== "preparada") throw new ConflictoEdicionCompraError();
    const actualizado = await repositorio.actualizarPreparada(registro.clave, inicial);
    if (!actualizado) throw new ConflictoEdicionCompraError();
    registro = actualizado;
  }

  if (registro.estado !== "preparada") {
    try {
      const encontrado = await verificar(registro, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // La lectura o su checkpoint fallaron; después de editando nunca se
      // puede afirmar que el documento quedó intacto ni repetir el PUT.
    }
    if (registro.estado === "editando") await repositorio.marcarIncierta(registro.clave).catch(() => undefined);
    throw new EdicionCompraInciertaError();
  }

  // Toda lectura/cálculo ocurre antes de declarar que el PUT pudo salir.
  // Si preparar falla, el registro continúa en preparada y es seguro corregir.
  const preparacion = await transporte.preparar();
  if (!preparacion.huellaEsperada?.trim()) throw new Error("La edición no produjo una huella verificable.");
  const editando = await repositorio.marcarEditando(
    registro.clave,
    preparacion.huellaEsperada,
    preparacion.verificarTotal
  );
  if (!editando) {
    const actual = await repositorio.obtener(registro.clave);
    if (actual) {
      try {
        const encontrado = await verificar(actual, repositorio, transporte);
        if (encontrado) return { resultado: encontrado, reutilizado: true };
      } catch {
        // Otra ejecución ya cruzó la frontera de escritura; salida segura.
      }
    }
    throw new EdicionCompraInciertaError();
  }

  try {
    await transporte.editar(preparacion);
  } catch (error) {
    if (esRechazoDefinitivoSinCompra(error)) {
      await repositorio.marcarPreparada(editando.clave);
      throw error;
    }
    try {
      const encontrado = await verificar(editando, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // El PUT o la lectura pueden haber fallado; el estado seguro es incierta.
    }
    await repositorio.marcarIncierta(editando.clave).catch(() => undefined);
    throw new EdicionCompraInciertaError();
  }

  try {
    const encontrado = await verificar(editando, repositorio, transporte);
    if (encontrado) return { resultado: encontrado, reutilizado: false };
  } catch {
    // Un 200 sin relectura verificable no demuestra el estado final.
  }
  await repositorio.marcarIncierta(editando.clave).catch(() => undefined);
  throw new EdicionCompraInciertaError();
}

export async function reconciliarEdicionesCompraPendientes<T>(
  repositorio: RepositorioEdicionesCompra,
  verificarRegistro: TransporteEdicionCompra<T>["verificar"]
): Promise<{ revisadas: number; verificadas: number; inciertas: number; errores: number }> {
  const pendientes = await repositorio.listarPendientes();
  let verificadas = 0;
  let inciertas = 0;
  let errores = 0;
  for (const registro of pendientes) {
    try {
      const encontrado = registro.huellaEsperada ? await verificarRegistro(registro) : undefined;
      if (encontrado) {
        await repositorio.marcarVerificada(registro.clave);
        verificadas++;
      } else {
        if (registro.estado === "editando") await repositorio.marcarIncierta(registro.clave);
        inciertas++;
      }
    } catch {
      errores++;
    }
  }
  return { revisadas: pendientes.length, verificadas, inciertas, errores };
}
