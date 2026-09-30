import { createHash } from "node:crypto";
import { listarPolizas } from "../seguros/polizaRegistroSheet";
import { calcularAlertasSeguros, type PolizaProximaARenovar, type PolizaPagoSinConfirmar } from "../seguros/alertas";
import {
  obtenerAlertasSegurosYaNotificadas,
  marcarAlertaSeguroNotificada,
  purgarAlertasSegurosNoActivas,
} from "../seguros/alertasNotificadasStore";
import { sendTelegramMessageExpandable } from "../telegram/client";

function claveRenovacion(p: PolizaProximaARenovar): string {
  return `${p.id}:renovacion`;
}

function claveRenovacionVersion(p: PolizaProximaARenovar): string {
  return p.fechaVencimiento;
}

function clavePago(p: PolizaPagoSinConfirmar): string {
  return `${p.id}:pago`;
}

/**
 * A diferencia de una fecha de vencimiento, la historia de un pago
 * pendiente evoluciona en texto libre (ver notas de
 * woba_showroom_complemento_2026_2027, que pasó de "sin sello de pagado" a
 * "el banco lo devolvió, aviso directo de Allianz, plazo legal" en la misma
 * sesión) — dedup solo por estadoPago habría dejado ese cambio real sin
 * avisar de nuevo. Un hash de estadoPago+prima+notas cambia con cualquier
 * edición real del caso, sin necesitar que este job entienda QUÉ cambió.
 */
function clavePagoVersion(p: PolizaPagoSinConfirmar): string {
  return createHash("sha256").update(`${p.estadoPago}|${p.prima}|${p.notas}`).digest("hex").slice(0, 16);
}

function describirDiasRestantes(dias: number): string {
  if (dias < 0) return `VENCIDA hace ${Math.abs(dias)} día(s)`;
  if (dias === 0) return "vence HOY";
  if (dias === 1) return "vence mañana";
  return `vence en ${dias} día(s)`;
}

/**
 * Job diario: revisa el registro real de pólizas (core/seguros/, ver
 * docs/wobi-seguros.md §6.4 — "mismo patrón que revisarAlertasFiscales.ts")
 * y avisa por Telegram cuando algo nuevo necesita atención — pólizas que
 * entran en la ventana de 30 días para vencer, y pagos pendientes o
 * devueltos por el banco (ver el hallazgo real de la póliza de WOBA que
 * Allianz puso en suspenso, docs/wobi-seguros.md §22).
 *
 * Dedup por id+versión (core/seguros/alertasNotificadasStore.ts), NO por
 * ventana fija como revisarAlertasFiscales — la ventana de Seguros es de 30
 * días, no 2, así que repetir el aviso cada día durante un mes sería puro
 * ruido. Se avisa una vez por versión (fecha de vencimiento para
 * renovaciones, hash del caso para pagos) y se queda en silencio hasta que
 * algo cambie de verdad.
 *
 * Sin gate de día hábil (a diferencia de revisarAnotacionesCashflow) —
 * mismo criterio que revisarAlertasFiscales/revisarAplazamientoImpuestos:
 * esto son vencimientos y plazos reales (una póliza puede quedar en
 * suspenso con un plazo legal corriendo), no avisos informativos que
 * puedan esperar al lunes sin riesgo.
 *
 * Deliberadamente informativo, sin botones — a diferencia de
 * revisarAlertasFiscales (que sí ofrece "registrar en Holded"), acá todavía
 * no hay una acción de un solo clic que ejecutar (verificar caja disponible
 * y proponer el pago es §6.2, explícitamente pendiente de construir). Un
 * mensaje claro con el motivo es la primera versión útil sin inventar un
 * botón que no hace nada real todavía.
 */
export async function revisarAlertasSeguros(): Promise<{ avisosEnviados: number }> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;

  if (!chatId) {
    console.error("[revisarAlertasSeguros] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { avisosEnviados: 0 };
  }

  const polizas = await listarPolizas();
  const { proximasARenovar, pagosSinConfirmar } = calcularAlertasSeguros(polizas);

  // Purga primero lo que ya no está activo — corre siempre, incluso si no hay nada nuevo que avisar
  // (mismo criterio que revisarAnotacionesCashflow: la purga no depende de si hay algo que notificar).
  const idsActivos = new Set([...proximasARenovar.map(claveRenovacion), ...pagosSinConfirmar.map(clavePago)]);
  const purgadas = await purgarAlertasSegurosNoActivas(idsActivos).catch((error) => {
    console.error("[revisarAlertasSeguros] Error purgando alertas inactivas (no crítico):", error);
    return 0;
  });
  if (purgadas > 0) {
    console.log(`[revisarAlertasSeguros] ${purgadas} alerta(s) purgada(s) del registro (ya no activas).`);
  }

  if (proximasARenovar.length === 0 && pagosSinConfirmar.length === 0) {
    return { avisosEnviados: 0 };
  }

  const yaNotificadas = await obtenerAlertasSegurosYaNotificadas();

  const pagosNuevos = pagosSinConfirmar.filter((p) => yaNotificadas.get(clavePago(p)) !== clavePagoVersion(p));
  const renovacionesNuevas = proximasARenovar.filter(
    (p) => yaNotificadas.get(claveRenovacion(p)) !== claveRenovacionVersion(p)
  );

  if (pagosNuevos.length === 0 && renovacionesNuevas.length === 0) {
    return { avisosEnviados: 0 };
  }

  const bloques: string[] = [];
  if (pagosNuevos.length > 0) {
    bloques.push(
      `⚠️ *Pagos pendientes o devueltos* (${pagosNuevos.length}):\n` +
        pagosNuevos
          .map((p) => `- [${p.empresa}] ${p.tipoCobertura} (${p.aseguradora}) — ${p.prima} ${p.moneda}\n  ${p.notas || "Sin notas."}`)
          .join("\n")
    );
  }
  if (renovacionesNuevas.length > 0) {
    bloques.push(
      `📅 *Próximas a vencer* (${renovacionesNuevas.length}):\n` +
        renovacionesNuevas
          .map(
            (p) =>
              `- [${p.empresa}] ${p.tipoCobertura} (${p.numeroPoliza}, ${p.aseguradora}) — ${describirDiasRestantes(p.diasRestantes)}, vence ${p.fechaVencimiento}`
          )
          .join("\n")
    );
  }
  const cuerpo = bloques.join("\n\n") + "\n\nDetalle completo en Cerebro (nodo Seguros, grupo Finanzas).";

  let avisosEnviados = 0;
  try {
    await sendTelegramMessageExpandable(chatId, "🛡️ Seguros — necesita tu atención", cuerpo);
    avisosEnviados = pagosNuevos.length + renovacionesNuevas.length;
  } catch (error) {
    console.error("[revisarAlertasSeguros] Error enviando aviso a Telegram (se reintenta mañana):", error);
    return { avisosEnviados: 0 }; // no se marca nada como notificado — se reintenta completo en la próxima corrida
  }

  for (const p of pagosNuevos) {
    await marcarAlertaSeguroNotificada(clavePago(p), clavePagoVersion(p)).catch((error) =>
      console.error("[revisarAlertasSeguros] Error marcando alerta de pago como notificada (no crítico):", error)
    );
  }
  for (const p of renovacionesNuevas) {
    await marcarAlertaSeguroNotificada(claveRenovacion(p), claveRenovacionVersion(p)).catch((error) =>
      console.error("[revisarAlertasSeguros] Error marcando alerta de renovación como notificada (no crítico):", error)
    );
  }

  console.log(
    `[revisarAlertasSeguros] 1 mensaje enviado con ${pagosNuevos.length} pago(s) y ${renovacionesNuevas.length} renovación(es) nueva(s).`
  );
  return { avisosEnviados };
}
