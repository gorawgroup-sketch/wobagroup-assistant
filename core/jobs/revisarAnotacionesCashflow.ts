import { obtenerAnotacionesCashflow, type AnotacionCashflow } from "../google/cashflowComments";
import {
  obtenerAnotacionesYaNotificadas,
  marcarAnotacionNotificada,
  purgarAnotacionesNoActivas,
} from "./anotacionesCashflowNotificadasStore";
import { sendTelegramMessage } from "../telegram/client";
import { askClaude } from "../claude/client";

function describirUbicacion(a: AnotacionCashflow): string {
  if (!a.registro) return "⚠️ fila no ubicada (el valor de la celda ya no coincide con ningún registro actual)";
  const r = a.registro;
  return `${r.categoria}${r.empresa ? ` (${r.empresa})` : ""} — ${r.cliente || r.concepto || "(sin nombre)"}${
    r.proyecto ? ` / ${r.proyecto}` : ""
  } — semana ${r.semana || "?"}`;
}

/**
 * Job diario: detecta comentarios NUEVOS o EDITADOS (ver
 * anotacionesCashflowNotificadasStore) sin resolver en el Sheet de
 * cashflow (core/google/cashflowComments.ts — comentarios reales de Sheets,
 * no las notas clásicas) y pide a Claude una recomendación de cómo
 * proceder para cada uno — UN mensaje individual por Telegram por
 * anotación, mismo criterio que revisarAplazamientoImpuestos ("un mensaje
 * individual por fila, no un resumen agrupado"), y no solo por
 * consistencia: verificado en vivo que un solo mensaje con varias
 * anotaciones batcheadas puede superar el límite de 4096 caracteres de
 * Telegram y fallar el envío completo (400 "message is too long").
 *
 * Pedido explícito de Carlos: "identifiques cuando el cashflow tenga una
 * anotación de estas para que me recomiendes inteligentemente como
 * proceder" — a diferencia de revisarAplazamientoImpuestos (que repite el
 * aviso cada día dentro de su ventana), acá se avisa UNA vez por versión
 * del comentario (dedup por id+modifiedTime), porque un comentario no
 * tiene una ventana de vencimiento fija — reenviar lo mismo todos los días
 * mientras siga sin resolver sería puro ruido.
 *
 * Usa askClaude (sin chatId, para no tocar el historial de conversación
 * real) en vez de una plantilla fija — Claude puede incluso usar sus
 * propias herramientas de solo lectura (ej. consultar_estado_factura_holded)
 * para verificar si algo mencionado en la anotación ya ocurrió en la
 * práctica antes de recomendar. Cada anotación se marca notificada solo si
 * su propio envío tuvo éxito — una falla en una no bloquea a las demás.
 *
 * También purga del registro cualquier anotación ya notificada que haya
 * dejado de estar activa (se resolvió o se borró en Sheets) — pedido
 * explícito de Carlos: no tiene sentido guardarla ahí una vez que
 * desapareció del cashflow, ver purgarAnotacionesNoActivas.
 */
export async function revisarAnotacionesCashflow(): Promise<{ avisosEnviados: number }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;

  if (!chatId) {
    console.error("[revisarAnotacionesCashflow] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { avisosEnviados: 0 };
  }

  const anotaciones = await obtenerAnotacionesCashflow(true);

  // Purga primero lo que ya no está activo (resuelto o borrado desde la
  // última corrida) — corre siempre, incluso si no hay anotaciones nuevas
  // que avisar, para que el registro de notificadas no acumule basura.
  const idsActivos = new Set(anotaciones.map((a) => a.id).filter(Boolean));
  const purgadas = await purgarAnotacionesNoActivas(idsActivos).catch((error) => {
    console.error("[revisarAnotacionesCashflow] Error purgando anotaciones inactivas (no crítico):", error);
    return 0;
  });
  if (purgadas > 0) {
    console.log(`[revisarAnotacionesCashflow] ${purgadas} anotación(es) purgada(s) del registro (resueltas o borradas).`);
  }

  if (anotaciones.length === 0) {
    return { avisosEnviados: 0 };
  }

  const yaNotificadas = await obtenerAnotacionesYaNotificadas();
  const nuevas = anotaciones.filter((a) => a.id && yaNotificadas.get(a.id) !== a.modificado);

  let avisosEnviados = 0;

  for (const a of nuevas) {
    const respuestas =
      a.respuestas.length > 0 ? `\nRespuestas: ${a.respuestas.map((r) => `${r.autor}: "${r.contenido}"`).join(" | ")}` : "";
    const detalle =
      `Valor: ${a.valorCelda}\nUbicación: ${describirUbicacion(a)}\n${a.autor} (${a.creado.slice(0, 10)}): "${a.contenido}"${respuestas}`;

    const prompt =
      `Encontré esta anotación nueva o editada sin resolver en el Sheet de cashflow (comentario real de ` +
      `Google Sheets en la columna VALOR de Pagos Proyectos/Ingresos). Dame una recomendación breve y ` +
      `concreta de cómo proceder (cuándo pagar/cobrar, qué condición hay que verificar, a quién avisar) — ` +
      `no te limites a repetir el comentario, da tu propio análisis. Si crees que ya se resolvió en la ` +
      `práctica, dilo (puedes verificar en Holded si hace falta). Si la fila no se pudo ubicar, dilo ` +
      `también en vez de inventar contexto.\n\n${detalle}`;

    let respuesta: string;
    try {
      respuesta = await askClaude(prompt, undefined, "Carlos");
    } catch (error) {
      console.error("[revisarAnotacionesCashflow] Error generando recomendación con Claude:", error);
      respuesta = detalle; // fallback: manda el detalle crudo en vez de no avisar nada
    }

    try {
      await sendTelegramMessage(chatId, `📝 Anotación en el cashflow:\n\n${respuesta}`);
    } catch (error) {
      console.error("[revisarAnotacionesCashflow] Error enviando aviso a Telegram (se reintenta mañana):", error);
      continue; // no se marca como notificado — se reintenta en la próxima corrida
    }

    avisosEnviados++;
    await marcarAnotacionNotificada(a.id, a.modificado).catch((error) =>
      console.error("[revisarAnotacionesCashflow] Error marcando anotación como notificada (no crítico):", error)
    );
  }

  console.log(`[revisarAnotacionesCashflow] ${avisosEnviados} anotación(es) nueva(s) avisada(s).`);
  return { avisosEnviados };
}
