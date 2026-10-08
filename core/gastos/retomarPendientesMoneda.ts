import { hayActividadCallbackReciente } from "../telegram/callbackActivity";
import {
  consumirGastoPendienteDatosPorId,
  guardarGastoPendienteDatos,
  obtenerGastosPendienteDatosPorChat,
  type GastoPendienteDatos,
} from "./gastoPendienteDatosStore";
import { procesarGastoEntrante, type ResultadoGastoEntrante } from "./procesarGastoEntrante";

/**
 * Norma de resolución autónoma, primera aplicación (Carlos, 2026-10-08, caso «Lunch - 180 pesos mexicanos - revolut»):
 * un recibo en una moneda sin cuenta real se quedaba esperando que Carlos dijera cuánto salió del banco. El importe real
 * solo lo sabe el banco, así que en cada revisión de correo se vuelve a buscar el cargo (la sincronización bancaria corre
 * a diario) SIN volver a preguntar: si aparece un único cargo, el flujo sigue solo hasta la propuesta con botones; si no,
 * el pendiente se conserva en silencio (el resumen diario ya lo lista) y se vuelve a intentar en la siguiente revisión.
 * Nunca escribe en Holded: procesarGastoEntrante solo propone.
 */
export interface DependenciasRetoma {
  listar: (chatId: number) => Promise<GastoPendienteDatos[]>;
  consumir: (chatId: number, id: string) => Promise<GastoPendienteDatos | undefined>;
  restaurar: (p: GastoPendienteDatos) => Promise<unknown>;
  procesar: (p: GastoPendienteDatos) => Promise<ResultadoGastoEntrante>;
  hayActividadReciente: (chatId: number) => boolean;
}

const dependenciasReales: DependenciasRetoma = {
  listar: obtenerGastosPendienteDatosPorChat,
  consumir: consumirGastoPendienteDatosPorId,
  restaurar: guardarGastoPendienteDatos,
  procesar: (p) => procesarGastoEntrante({
    chatId: p.chatId, rutaLocal: p.rutaLocal, nombreArchivoOriginal: p.nombreArchivoOriginal, mimeType: p.mimeType,
    datos: p.datos, deColaCorreo: p.deColaCorreo, correoOrigen: p.correoOrigen, origenAdjuntoGmail: p.origenAdjuntoGmail,
    retomaSilenciosa: true,
  }),
  hayActividadReciente: (chatId) => hayActividadCallbackReciente(chatId),
};

export interface ResultadoRetoma { intentados: number; resueltos: number; siguenPendientes: number; errores: number }

export async function retomarPendientesMonedaSinPreguntar(
  chatId: number,
  deps: DependenciasRetoma = dependenciasReales
): Promise<ResultadoRetoma> {
  const resultado: ResultadoRetoma = { intentados: 0, resueltos: 0, siguenPendientes: 0, errores: 0 };
  // Si Carlos está respondiendo ahora mismo (botón o texto en curso), no competir con su respuesta.
  if (deps.hayActividadReciente(chatId)) return resultado;
  const pendientes = (await deps.listar(chatId)).filter((p) => p.motivo === "moneda");
  for (const p of pendientes) {
    const tomado = await deps.consumir(chatId, p.id);
    if (!tomado) continue; // ya lo resolvió otro camino
    resultado.intentados++;
    try {
      const salida = await deps.procesar(tomado);
      // «pendiente_datos» = procesarGastoEntrante ya volvió a guardar el pendiente (sin mensaje, por retomaSilenciosa).
      if (salida === "pendiente_datos") resultado.siguenPendientes++;
      else resultado.resueltos++;
    } catch (error) {
      resultado.errores++;
      console.error("[retomarPendientesMoneda] Error retomando un pendiente de moneda (se restaura):", error);
      await deps.restaurar(tomado).catch((e) => console.error("[retomarPendientesMoneda] No se pudo restaurar el pendiente:", e));
    }
  }
  if (resultado.intentados > 0) console.log("[retomarPendientesMoneda]", JSON.stringify(resultado));
  return resultado;
}
