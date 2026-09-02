import { obtenerAccionesPendientes, marcarAccionCompletada, type AccionProgramada } from "./accionesProgramadasStore";
import { sendTelegramMessage } from "../telegram/client";
import { askClaude } from "../claude/client";

/**
 * Job periódico: revisa la cola de acciones programadas (ver
 * accionesProgramadasStore.ts / programarAccion.ts) y dispara cada una en
 * su momento — pedido explícito de Carlos: "WOBI debe encargarse de las
 * acciones que haya que hacer", sin volver a pedir aprobación para
 * EJECUTARLA (la aprobación ya la dio quien la programó al pedirlo).
 *
 * tipo="fecha": se dispara apenas `ahora >= fechaObjetivo`.
 * tipo="condicion": en cada corrida le pide a Claude (con sus herramientas
 * normales de lectura) que verifique si la condición ya se cumplió — si no,
 * no hace nada (silencioso, no molesta cada vez que no ha pasado nada).
 *
 * Cuando dispara, llama a askClaude con la instrucción guardada y el chatId
 * real — mismo camino seguro que "✅ Hazlo tú" en las anotaciones de
 * cashflow y en los correos: cualquier escritura real (Holded, correo)
 * sigue pasando por su propio flujo de propuesta+botón, esto no le da a
 * Claude ningún poder nuevo, solo la vía libre para investigar y actuar
 * sobre ESTA acción en concreto.
 */
export async function revisarAccionesProgramadas(): Promise<{ disparadas: number }> {
  const pendientes = await obtenerAccionesPendientes();
  if (pendientes.length === 0) {
    return { disparadas: 0 };
  }

  const ahora = new Date();
  let disparadas = 0;

  for (const accion of pendientes) {
    try {
      if (accion.tipo === "fecha") {
        if (!accion.fechaObjetivo || new Date(accion.fechaObjetivo) > ahora) continue;
        await dispararAccion(accion);
        disparadas++;
        continue;
      }

      // tipo === "condicion"
      const seCumplio = await verificarCondicion(accion);
      if (!seCumplio) continue;
      await dispararAccion(accion);
      disparadas++;
    } catch (error) {
      console.error(`[revisarAccionesProgramadas] Error procesando acción ${accion.id} (se reintenta en la próxima corrida):`, error);
    }
  }

  console.log(`[revisarAccionesProgramadas] ${disparadas} acción(es) disparada(s) de ${pendientes.length} pendiente(s).`);
  return { disparadas };
}

async function verificarCondicion(accion: AccionProgramada): Promise<boolean> {
  const prompt =
    `Verifica si esta condición YA se cumplió, usando tus herramientas de solo lectura (Holded, cashflow, ` +
    `correo, lo que haga falta). Condición a verificar: "${accion.condicion}". Contexto: ${accion.contexto}. ` +
    `Responde ÚNICAMENTE con la palabra "SI" si ya se cumplió, o "NO" si todavía no o no se puede verificar — ` +
    `sin explicación adicional.`;

  try {
    const respuesta = await askClaude(prompt);
    return respuesta.trim().toUpperCase().startsWith("SI");
  } catch (error) {
    console.error(`[revisarAccionesProgramadas] Error verificando condición de ${accion.id} (se trata como no cumplida):`, error);
    return false;
  }
}

async function dispararAccion(accion: AccionProgramada): Promise<void> {
  await sendTelegramMessage(
    accion.chatId,
    `⏰ Acción programada — ${accion.contexto}\n\n🔄 Procesando: ${accion.instruccion}`
  ).catch((error) => console.error(`[revisarAccionesProgramadas] No se pudo avisar 'Procesando...' de ${accion.id} (no crítico):`, error));

  try {
    const instruccionCompleta =
      `Se programó esta acción para ejecutarse ahora (${accion.tipo === "fecha" ? "llegó la fecha" : "se cumplió la condición"}). ` +
      `Contexto original: ${accion.contexto}. Instrucción: ${accion.instruccion}. ` +
      `Investiga y ejecuta lo que corresponda con las herramientas disponibles, y reporta el resultado.`;

    const respuesta = await askClaude(instruccionCompleta, accion.chatId);
    await sendTelegramMessage(accion.chatId, `✅ ${accion.contexto}\n\n${respuesta}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[revisarAccionesProgramadas] Error ejecutando acción ${accion.id}:`, message);
    await sendTelegramMessage(accion.chatId, `⚠️ Error ejecutando la acción programada (${accion.contexto}): ${message}`).catch(
      (e) => console.error("[revisarAccionesProgramadas] No se pudo avisar del error (no crítico):", e)
    );
    return; // no se marca completada — se reintenta en la próxima corrida
  }

  await marcarAccionCompletada(accion.id).catch((error) =>
    console.error(`[revisarAccionesProgramadas] Error marcando ${accion.id} como completada (no crítico):`, error)
  );
}
