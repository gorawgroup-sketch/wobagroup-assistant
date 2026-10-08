import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import { consumirGastoPendienteDatosPorId, restaurarGastoPendienteDatos, type GastoPendienteDatos } from "./gastoPendienteDatosStore";
import { procesarGastoEntrante } from "./procesarGastoEntrante";

/**
 * Un gasto que quedó esperando «el monto exacto y la moneda» (pregunta anterior al 08-10) ya no necesita ninguna respuesta: Wobi convierte
 * solo a la tasa del día y busca el cargo en el banco (conversionAutomatica.ts). Este reproceso retoma ese pendiente con los mismos datos
 * y publica la propuesta con botones, sin pedirle nada a nadie. Si el reproceso falla, el pendiente se restaura tal cual.
 */
export type ResultadoReprocesoMoneda = "propuesta" | "sigue_pendiente" | "sin_cambios";

export async function reprocesarPendienteDeMoneda(p: GastoPendienteDatos): Promise<ResultadoReprocesoMoneda> {
  const pendiente = await consumirGastoPendienteDatosPorId(p.chatId, p.id);
  if (!pendiente) return "sin_cambios";
  try {
    const resultado = await procesarGastoEntrante({
      chatId: pendiente.chatId,
      rutaLocal: pendiente.rutaLocal,
      nombreArchivoOriginal: pendiente.nombreArchivoOriginal,
      mimeType: pendiente.mimeType,
      datos: { ...pendiente.datos },
      deColaCorreo: pendiente.deColaCorreo,
      correoOrigen: pendiente.correoOrigen,
      origenAdjuntoGmail: pendiente.origenAdjuntoGmail,
    });
    if (resultado === "pendiente_datos") return "sigue_pendiente";
    if (resultado === "propuesta_duplicada" && pendiente.deColaCorreo) {
      await avanzarColaCorreoSiActivo(
        pendiente.chatId,
        { threadId: pendiente.correoOrigen?.threadId, mensajeId: pendiente.correoOrigen?.mensajeIdGmail },
        `gasto-pendiente-datos:${pendiente.id}:resolver`
      );
    }
    return "propuesta";
  } catch (error) {
    console.error("[reprocesarPendienteMoneda] El reproceso falló; se restaura el pendiente:", error instanceof Error ? error.message : error);
    await restaurarGastoPendienteDatos(pendiente);
    return "sin_cambios";
  }
}
