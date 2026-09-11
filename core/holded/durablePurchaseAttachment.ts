import { createHash } from "node:crypto";
import type { Empresa } from "./client";
import { esRechazoDefinitivoSinCompra } from "./durablePurchase";

export type EstadoAdjuntoCompra = "preparado" | "subiendo" | "verificado" | "incierto";

export interface ResultadoAdjuntoCompra {
  attachmentId: string;
  fileName: string;
}

export interface RegistroAdjuntoCompra {
  clave: string;
  proceso: string;
  estado: EstadoAdjuntoCompra;
  empresa: Empresa;
  purchaseId: string;
  contentHash: string;
  fileName: string;
  huellaSolicitud: string;
  attachmentId?: string;
  creadoEn: number;
  actualizadoEn: number;
  verificadoEn?: number;
}

export interface RepositorioAdjuntosCompra {
  reservar(registro: RegistroAdjuntoCompra): Promise<{ registro: RegistroAdjuntoCompra; nuevo: boolean }>;
  obtener(clave: string): Promise<RegistroAdjuntoCompra | undefined>;
  actualizarPreparado(clave: string, registro: RegistroAdjuntoCompra): Promise<RegistroAdjuntoCompra | undefined>;
  marcarSubiendo(clave: string): Promise<RegistroAdjuntoCompra | undefined>;
  marcarPreparado(clave: string): Promise<void>;
  marcarVerificado(clave: string, resultado: ResultadoAdjuntoCompra): Promise<void>;
  marcarIncierto(clave: string): Promise<void>;
  listarPendientes(): Promise<RegistroAdjuntoCompra[]>;
}

export interface TransporteAdjuntoCompra {
  buscar(registro: RegistroAdjuntoCompra): Promise<ResultadoAdjuntoCompra | undefined>;
  subir(fileName: string): Promise<ResultadoAdjuntoCompra>;
}

export class AdjuntoCompraInciertoError extends Error {
  constructor() {
    super(
      "Holded no confirmó si el comprobante quedó adjuntado. Wobi bloqueó cualquier repetición automática y lo dejó pendiente de verificación para evitar un archivo duplicado."
    );
    this.name = "AdjuntoCompraInciertoError";
  }
}

export class ConflictoAdjuntoCompraError extends AdjuntoCompraInciertoError {
  constructor() {
    super();
    this.message =
      "La misma aprobación ya inició la subida de un comprobante diferente. Wobi la bloqueó hasta verificar el archivo anterior en Holded.";
    this.name = "ConflictoAdjuntoCompraError";
  }
}

/**
 * Solo un archivo local ausente justifica reconstruir la copia temporal.
 * Reintentar tras un timeout o un error de Holded podría duplicar el efecto.
 */
export function esArchivoLocalInexistente(error: unknown): boolean {
  let actual: unknown = error;
  const vistos = new Set<unknown>();
  while (actual && !vistos.has(actual)) {
    vistos.add(actual);
    if (typeof actual === "object" && "code" in actual && (actual as { code?: unknown }).code === "ENOENT") {
      return true;
    }
    actual = typeof actual === "object" && "cause" in actual ? (actual as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function hash(valor: string): string {
  return createHash("sha256").update(valor).digest("hex");
}

function extensionSegura(extension: string): string {
  const normalizada = extension.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return normalizada || "bin";
}

export function identidadAdjuntoCompra(
  idempotencyKey: string,
  empresa: Empresa,
  purchaseId: string,
  contentHash: string,
  extension: string,
  proceso: string,
  ahora = Date.now()
): RegistroAdjuntoCompra {
  const identidad = idempotencyKey.trim();
  const compra = purchaseId.trim();
  const contenido = contentHash.trim().toLowerCase();
  if (!identidad || identidad.length > 300) {
    throw new Error("La clave idempotente del comprobante es obligatoria y debe tener como máximo 300 caracteres.");
  }
  if (!compra || compra.length > 200) throw new Error("El id de la compra es obligatorio.");
  if (!/^[a-f0-9]{64}$/.test(contenido)) throw new Error("La huella SHA-256 del comprobante no es válida.");

  const clave = hash(`wobi-holded-purchase-attachment-v1\0${empresa}\0${identidad}`);
  // El nombre es deliberadamente opaco y estable por compra+contenido. Así,
  // dos propuestas distintas para el mismo archivo convergen en el mismo
  // nombre y la consulta previa evita un segundo POST.
  const marcadorArchivo = hash(`wobi-holded-purchase-file-v1\0${empresa}\0${compra}\0${contenido}`).slice(0, 24);
  const fileName = `comprobante_wobi_${marcadorArchivo}.${extensionSegura(extension)}`;
  return {
    clave,
    proceso,
    estado: "preparado",
    empresa,
    purchaseId: compra,
    contentHash: contenido,
    fileName,
    huellaSolicitud: hash(`${compra}\0${contenido}\0${fileName}`),
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
}

function resultadoGuardado(registro: RegistroAdjuntoCompra): ResultadoAdjuntoCompra {
  return { attachmentId: registro.attachmentId ?? registro.fileName, fileName: registro.fileName };
}

async function verificarExistencia(
  registro: RegistroAdjuntoCompra,
  repositorio: RepositorioAdjuntosCompra,
  transporte: TransporteAdjuntoCompra
): Promise<ResultadoAdjuntoCompra | undefined> {
  const encontrado = await transporte.buscar(registro);
  if (encontrado) await repositorio.marcarVerificado(registro.clave, encontrado);
  return encontrado;
}

/**
 * Frontera conservadora para POST /purchases/{id}/attachments. Incluye una
 * consulta previa para deduplicar el mismo contenido aunque llegue desde dos
 * propuestas distintas.
 */
export async function ejecutarAdjuntoCompraDurable(
  inicial: RegistroAdjuntoCompra,
  repositorio: RepositorioAdjuntosCompra,
  transporte: TransporteAdjuntoCompra
): Promise<{ resultado: ResultadoAdjuntoCompra; reutilizado: boolean }> {
  let { registro } = await repositorio.reservar(inicial);

  if (registro.huellaSolicitud !== inicial.huellaSolicitud) {
    if (registro.estado !== "preparado") throw new ConflictoAdjuntoCompraError();
    const actualizado = await repositorio.actualizarPreparado(registro.clave, inicial);
    if (!actualizado) throw new ConflictoAdjuntoCompraError();
    registro = actualizado;
  }

  if (registro.estado === "verificado") {
    return { resultado: resultadoGuardado(registro), reutilizado: true };
  }

  if (registro.estado === "subiendo" || registro.estado === "incierto") {
    try {
      const encontrado = await verificarExistencia(registro, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // La lectura falló: nunca se convierte en permiso para subir otra vez.
    }
    if (registro.estado === "subiendo") await repositorio.marcarIncierto(registro.clave).catch(() => undefined);
    throw new AdjuntoCompraInciertoError();
  }

  // Consulta previa: cubre otra aprobación que ya adjuntó exactamente los
  // mismos bytes a la misma compra con el nombre opaco compartido.
  const existente = await transporte.buscar(registro);
  if (existente) {
    await repositorio.marcarVerificado(registro.clave, existente);
    return { resultado: existente, reutilizado: true };
  }

  const subiendo = await repositorio.marcarSubiendo(registro.clave);
  if (!subiendo) {
    const actual = await repositorio.obtener(registro.clave);
    if (actual?.estado === "verificado") return { resultado: resultadoGuardado(actual), reutilizado: true };
    throw new AdjuntoCompraInciertoError();
  }

  let resultado: ResultadoAdjuntoCompra;
  try {
    resultado = await transporte.subir(subiendo.fileName);
  } catch (error) {
    if (esRechazoDefinitivoSinCompra(error)) {
      await repositorio.marcarPreparado(subiendo.clave);
      throw error;
    }
    try {
      const encontrado = await verificarExistencia(subiendo, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // El POST o la consulta pueden haber fallado; se conserva la salida segura.
    }
    await repositorio.marcarIncierto(subiendo.clave).catch(() => undefined);
    throw new AdjuntoCompraInciertoError();
  }

  try {
    await repositorio.marcarVerificado(subiendo.clave, resultado);
  } catch {
    try {
      const encontrado = await verificarExistencia(subiendo, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // Holded ya respondió éxito; nunca repetir el POST por un fallo del ledger.
    }
    await repositorio.marcarIncierto(subiendo.clave).catch(() => undefined);
    throw new AdjuntoCompraInciertoError();
  }

  return { resultado, reutilizado: false };
}

/** Reconciliación de solo lectura; jamás invoca el POST de adjuntos. */
export async function reconciliarAdjuntosCompraPendientes(
  repositorio: RepositorioAdjuntosCompra,
  buscar: TransporteAdjuntoCompra["buscar"]
): Promise<{ revisados: number; verificados: number; inciertos: number; errores: number }> {
  const pendientes = await repositorio.listarPendientes();
  let verificados = 0;
  let inciertos = 0;
  let errores = 0;
  for (const registro of pendientes) {
    try {
      const encontrado = await buscar(registro);
      if (encontrado) {
        await repositorio.marcarVerificado(registro.clave, encontrado);
        verificados++;
      } else {
        if (registro.estado === "subiendo") await repositorio.marcarIncierto(registro.clave);
        inciertos++;
      }
    } catch {
      errores++;
    }
  }
  return { revisados: pendientes.length, verificados, inciertos, errores };
}
