import { esDiaHabilEspana } from "../utils/diaHabil";
import { listarArchivosTsRepo, leerArchivoRepo, proponerCorreccionComoPR } from "../github/client";
import { revisarCodigoAutonomamente } from "../claude/client";
import { obtenerMapaUltimaRevision, marcarArchivoRevisado } from "./revisionArchivoStore";
import { crearPendienteAutorrepair } from "../github/autorrepairPendienteStore";
import { sendTelegramMessageWithButtons } from "../telegram/client";

const ARCHIVOS_POR_NOCHE = 3;
// Un archivo más largo que esto se salta (sin marcarlo revisado, para no perderlo de la rotación) —
// una reescritura completa de un archivo grande arriesga quedar truncada en la respuesta del modelo.
const MAX_LINEAS_ARCHIVO = 400;

/**
 * Autorrevisión nocturna de código — pedido explícito de Carlos: "que el
 * sistema se autorrevise y autorrepare lo necesario de manera inteligente
 * para que estemos seguros que el sistema todo el tiempo esté estable", con
 * el diseño más completo que confirmó ("también revisar y corregir el
 * código solo"). Cada noche rota unos pocos archivos de una lista BLANCA
 * de rutas ya vetadas como seguras (ver rutasSeguras.ts — dinero,
 * seguridad/acceso y comunicación externa quedan siempre fuera por
 * diseño, no por excepción), y si encuentra un bug real y concreto, abre un Pull Request con
 * el arreglo y pide aprobación por un tap en Telegram — NUNCA fusiona nada
 * por su cuenta (ver autorrepairCallbackHandler.ts). Corre solo en días
 * hábiles españoles, mismo criterio de costo controlado que el resto de
 * los avisos no urgentes de este proyecto.
 */
export async function autorrevisionCodigo(): Promise<{ revisados: number; propuestos: number }> {
  if (!esDiaHabilEspana()) {
    console.log("[autorrevisionCodigo] Fin de semana, no corre.");
    return { revisados: 0, propuestos: 0 };
  }

  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;
  if (!chatId) {
    console.error("[autorrevisionCodigo] CASHFLOW_ALERTS_CHAT_ID no configurado, no se puede notificar.");
    return { revisados: 0, propuestos: 0 };
  }

  let candidatos: string[];
  try {
    candidatos = await listarArchivosTsRepo();
  } catch (error) {
    console.error("[autorrevisionCodigo] Error listando archivos del repo:", error);
    return { revisados: 0, propuestos: 0 };
  }

  const mapaRevision = await obtenerMapaUltimaRevision();
  const ordenados = [...candidatos].sort((a, b) => (mapaRevision.get(a) || 0) - (mapaRevision.get(b) || 0));

  let revisados = 0;
  let propuestos = 0;

  for (const ruta of ordenados) {
    if (revisados >= ARCHIVOS_POR_NOCHE) break;

    try {
      const archivo = await leerArchivoRepo(ruta);
      if (!archivo) continue;

      const numLineas = archivo.contenido.split("\n").length;
      if (numLineas > MAX_LINEAS_ARCHIVO) {
        // Se marca revisado igual (aunque no se revise de verdad) para que no vuelva a encabezar la
        // rotación cada noche — hallazgo real de auditoría: sin esto, un archivo grande se
        // redescargaba de GitHub todas las noches, para siempre, antes de llegar a uno revisable.
        await marcarArchivoRevisado(ruta);
        continue;
      }

      revisados++;
      const resultado = await revisarCodigoAutonomamente({ ruta, contenidoActual: archivo.contenido });
      await marcarArchivoRevisado(ruta);

      if (!resultado.encontroProblema || !resultado.contenidoNuevoCompleto) continue;

      // Si la reescritura vino sospechosamente más corta que el original (posible truncamiento de
      // la respuesta), se descarta — mejor perder este hallazgo que abrir un PR que corrompe el archivo.
      const lineasNuevo = resultado.contenidoNuevoCompleto.split("\n").length;
      if (lineasNuevo < numLineas * 0.6) {
        console.error(`[autorrevisionCodigo] Reescritura de ${ruta} parece truncada (${lineasNuevo} vs ${numLineas} líneas) — se descarta.`);
        continue;
      }

      const pr = await proponerCorreccionComoPR({
        ruta,
        shaArchivoEnMain: archivo.sha,
        contenidoNuevo: resultado.contenidoNuevoCompleto,
        mensajeCommit: `Autorrevisión: ${resultado.resumen}`,
        tituloPR: `Autorrevisión: ${resultado.resumen}`,
        cuerpoPR: `${resultado.diagnostico}\n\n---\nPropuesto automáticamente por la autorrevisión nocturna de Wobi. Requiere aprobación manual antes de fusionar.`,
      });

      await crearPendienteAutorrepair({
        numeroPR: pr.numero,
        rama: pr.rama,
        ruta,
        resumen: resultado.resumen || "",
        urlPR: pr.url,
        chatId,
      });

      propuestos++;

      await sendTelegramMessageWithButtons(
        chatId,
        `🔧 *Autorrevisión de código* — encontré un bug real en \`${ruta}\`:\n\n${resultado.resumen}\n\n${resultado.diagnostico}\n\n${pr.url}`,
        [
          [
            { text: "✅ Desplegar", callback_data: `autorrepair_desplegar:${pr.numero}` },
            { text: "❌ Descartar", callback_data: `autorrepair_descartar:${pr.numero}` },
          ],
        ]
      );
    } catch (error) {
      console.error(`[autorrevisionCodigo] Error revisando ${ruta} (no crítico, sigue con el siguiente):`, error);
    }
  }

  return { revisados, propuestos };
}
