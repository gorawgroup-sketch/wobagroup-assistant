import { randomUUID } from "node:crypto";
import type { ClasificacionDocumento } from "./classifyFile";

export interface PropuestaClasificacion {
  id: string;
  nombreArchivo: string;
  clasificacion: ClasificacionDocumento;
  chatId: number;
  messageId: number;
  creadoEn: number;
}

/**
 * Store en memoria de propuestas de clasificación pendientes. Aceptable aquí
 * (a diferencia de las propuestas de cashflow, que sí persisten en el Sheet)
 * porque aprobar una propuesta de archivo todavía NO ejecuta ninguna
 * escritura real (eso es el Paso 3) — si se pierde por un reinicio, el peor
 * caso es que el botón diga "ya no disponible" y haya que reenviar el archivo.
 */
const propuestas = new Map<string, PropuestaClasificacion>();

const TTL_MS = 24 * 60 * 60 * 1000; // 1 día

export function crearPropuestaClasificacion(
  datos: Omit<PropuestaClasificacion, "id" | "creadoEn">
): PropuestaClasificacion {
  const propuesta: PropuestaClasificacion = {
    ...datos,
    id: randomUUID().slice(0, 8),
    creadoEn: Date.now(),
  };
  propuestas.set(propuesta.id, propuesta);
  return propuesta;
}

export function consumirPropuestaClasificacion(id: string): PropuestaClasificacion | undefined {
  const propuesta = propuestas.get(id);
  if (!propuesta) return undefined;

  propuestas.delete(id);

  if (Date.now() - propuesta.creadoEn > TTL_MS) {
    return undefined;
  }

  return propuesta;
}
