import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { textosParecidos } from "../utils/textoParecido";

export interface IdentidadGastoProcesado {
  huellaContenido?: string;
  numeroDocumento?: string;
  proveedor?: string;
  monto?: number;
  moneda?: string;
  fecha?: string;
  concepto?: string;
}

export type MotivoCoincidenciaIdentidad = "mismo_archivo" | "mismo_numero_y_proveedor";

export function normalizarNumeroDocumentoIdentidad(numero: string | undefined): string {
  return (numero ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

export function esNumeroDocumentoIdentificable(numero: string | undefined): boolean {
  const normalizado = normalizarNumeroDocumentoIdentidad(numero);
  return normalizado !== "" && normalizado !== "00000";
}

export async function calcularHuellaContenido(rutaLocal: string): Promise<string> {
  const bytes = await readFile(rutaLocal);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Coincidencias suficientemente fuertes para impedir otra propuesta sin
 * pedirle al usuario que vuelva a decidir:
 * - mismos bytes del comprobante; o
 * - mismo número legal y proveedor reconociblemente equivalente.
 *
 * No bloquea solo por importe/fecha: dos taxis o comidas legítimas pueden
 * repetirse el mismo día por el mismo valor.
 */
export function coincidenciaIdentidadGasto(
  actual: IdentidadGastoProcesado,
  registrado: IdentidadGastoProcesado
): MotivoCoincidenciaIdentidad | undefined {
  const huellaActual = actual.huellaContenido?.trim().toLowerCase();
  const huellaRegistrada = registrado.huellaContenido?.trim().toLowerCase();
  if (huellaActual && huellaRegistrada && huellaActual === huellaRegistrada) return "mismo_archivo";

  if (!esNumeroDocumentoIdentificable(actual.numeroDocumento) || !esNumeroDocumentoIdentificable(registrado.numeroDocumento)) {
    return undefined;
  }
  if (normalizarNumeroDocumentoIdentidad(actual.numeroDocumento) !== normalizarNumeroDocumentoIdentidad(registrado.numeroDocumento)) {
    return undefined;
  }
  if (!actual.proveedor?.trim() || !registrado.proveedor?.trim()) return undefined;
  if (!textosParecidos(actual.proveedor, registrado.proveedor)) return undefined;
  if (!Number.isFinite(actual.monto) || !Number.isFinite(registrado.monto)) return undefined;
  if (Math.abs(Math.abs(actual.monto as number) - Math.abs(registrado.monto as number)) > 0.011) return undefined;
  if (!actual.moneda || !registrado.moneda || actual.moneda.toUpperCase() !== registrado.moneda.toUpperCase()) return undefined;
  if (!actual.fecha || !registrado.fecha || actual.fecha.slice(0, 10) !== registrado.fecha.slice(0, 10)) return undefined;
  return "mismo_numero_y_proveedor";
}

/**
 * La clave durable deja de depender de una propuesta concreta cuando existe
 * una identidad documental fuerte. Así, dos botones nacidos de correos
 * distintos para el mismo PDF/número terminan en la MISMA operación durable.
 */
export function claveIdempotenciaGasto(params: {
  empresa: string;
  contactId: string;
  propuestaId: string;
  numeroDocumento?: string;
  huellaContenido?: string;
  fecha?: string;
}): string {
  const numero = normalizarNumeroDocumentoIdentidad(params.numeroDocumento);
  const identidad = esNumeroDocumentoIdentificable(numero)
    ? `documento\0${params.empresa}\0${params.contactId}\0${numero}\0${params.fecha?.slice(0, 10) ?? ""}`
    : params.huellaContenido?.trim()
      ? `archivo\0${params.empresa}\0${params.huellaContenido.trim().toLowerCase()}`
      : `propuesta\0${params.empresa}\0${params.propuestaId}`;
  return `gasto:${createHash("sha256").update(identidad).digest("hex")}`;
}
