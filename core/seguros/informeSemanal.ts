/**
 * Resumen semanal de Wobi Seguros para Carlos. Sin IA (coste cero): junta lo que ya consta —pagos sin confirmar,
 * vencimientos y pagos que vienen, y lo que está esperando a una decisión o acción suya— y calla si no hay nada.
 * Es el «dime si hay algo pendiente» hecho a diario de ver, sin tener que preguntarlo.
 */
import type { PolizaConFila } from "./polizaRegistroSheet";
import type { EntradaConocimiento } from "./agente/conocimiento";
import { diasEntre, diaMes } from "./vigilante/fechas";
import { formatearEuros } from "./vigilante/importes";
import type { PagoSeguro } from "./pagos/tipos";

export const HORIZONTE_DIAS_RESUMEN = 60;

export interface EventoProximo {
  /** YYYY-MM-DD */
  fecha: string;
  texto: string;
  tipo: "vencimiento" | "pago";
  polizaId: string;
  empresa: string;
}

const FECHA_EN_TEXTO = /(\d{2})\/(\d{2})\/(\d{4})/;

/** Cómo se ve un pago del calendario estructurado en los resúmenes y en el panel. */
export function textoDePagoCalendario(p: PagoSeguro): string {
  const importe = `${formatearEuros(p.importe)} ${p.moneda === "EUR" ? "€" : p.moneda}${p.estimado ? " (estimado)" : ""}`;
  return `[${p.empresa}] ${p.concepto} — ${importe}${p.cuentaDeCargo ? ` · ${p.forma === "transferencia" ? "transferencia" : "adeudo"} en «${p.cuentaDeCargo}»` : ""}`;
}

/**
 * Vencimientos y pagos dentro del horizonte: la fecha de vencimiento de cada póliza viva y sus pagos. Los pagos salen del calendario
 * estructurado (`pagos`, pestaña `_pagos_seguros`) para las pólizas que tienen alguno previsto; para las demás, de los «PRÓXIMO PAGO: …
 * dd/mm/aaaa» que las revisiones anotan en el registro (así, si el calendario no se puede leer o aún no cubre una póliza, no se pierde nada).
 */
export function eventosProximos(polizas: PolizaConFila[], hoy: string, dias = HORIZONTE_DIAS_RESUMEN, pagos?: PagoSeguro[] | null): EventoProximo[] {
  const eventos: EventoProximo[] = [];
  const previstos = (pagos ?? []).filter((p) => p.estado === "previsto");
  const polizasConCalendario = new Set(previstos.map((p) => p.polizaId));
  for (const p of polizas) {
    if (p.estado === "vencida" || p.estado === "no_contratada" || p.estado === "pendiente_confirmacion") continue;
    if (p.fechaVencimiento) {
      const d = diasEntre(hoy, p.fechaVencimiento);
      if (d <= dias) eventos.push({ fecha: p.fechaVencimiento, tipo: "vencimiento", polizaId: p.id, empresa: p.empresa, texto: `Vence ${p.tipoCobertura} (${p.aseguradora || "aseguradora sin confirmar"}${p.numeroPoliza ? `, ${p.numeroPoliza}` : ""})` });
    }
    if (polizasConCalendario.has(p.id)) continue;
    for (const frase of p.notas.matchAll(/PRÓXIMO PAGO:[^|]*/g)) {
      const m = frase[0].match(FECHA_EN_TEXTO);
      if (!m) continue;
      const fecha = `${m[3]}-${m[2]}-${m[1]}`;
      const d = diasEntre(hoy, fecha);
      if (d >= 0 && d <= dias) eventos.push({ fecha, tipo: "pago", polizaId: p.id, empresa: p.empresa, texto: `[${p.empresa}] ${frase[0].replace("PRÓXIMO PAGO:", "").trim().replace(/\.$/, "")}` });
    }
  }
  const vivas = new Set(polizas.filter((p) => p.estado !== "vencida" && p.estado !== "no_contratada" && p.estado !== "pendiente_confirmacion").map((p) => p.id));
  for (const pago of previstos) {
    const d = diasEntre(hoy, pago.fecha);
    if (d >= 0 && d <= dias && vivas.has(pago.polizaId)) eventos.push({ fecha: pago.fecha, tipo: "pago", polizaId: pago.polizaId, empresa: pago.empresa, texto: textoDePagoCalendario(pago) });
  }
  return eventos.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

export interface InformeSemanal {
  titulo: string;
  cuerpo: string;
}

export function construirInformeSemanal(d: { hoy: string; polizas: PolizaConFila[]; conocimiento: EntradaConocimiento[]; pagos?: PagoSeguro[] | null }): InformeSemanal | null {
  const pendientesDePago = d.polizas.filter((p) => p.estadoPago === "pendiente" || p.estadoPago === "sin_confirmar");
  const proximos = eventosProximos(d.polizas, d.hoy, HORIZONTE_DIAS_RESUMEN, d.pagos);
  const esperandoACarlos = d.conocimiento.filter((e) => e.vigente && e.tipo === "pendiente_carlos");
  if (pendientesDePago.length + proximos.length + esperandoACarlos.length === 0) return null;

  const bloques: string[] = [];
  if (pendientesDePago.length > 0) {
    bloques.push(
      `**Pagos sin confirmar** (${pendientesDePago.length})\n` +
        pendientesDePago.map((p) => `- [${p.empresa}] ${p.tipoCobertura} — ${p.prima} ${p.moneda} (${p.estadoPago})`).join("\n")
    );
  }
  if (esperandoACarlos.length > 0) {
    bloques.push(
      `**Esperando a Carlos** (${esperandoACarlos.length})\n` +
        esperandoACarlos.map((e) => `- ${e.texto} (desde el ${diaMes(e.fecha)}, hace ${diasEntre(e.fecha, d.hoy)} días)`).join("\n")
    );
  }
  bloques.push(
    proximos.length > 0
      ? `**Próximos ${HORIZONTE_DIAS_RESUMEN} días**\n${proximos.map((e) => `- ${diaMes(e.fecha)}/${e.fecha.slice(0, 4)} · ${e.texto}`).join("\n")}`
      : `**Próximos ${HORIZONTE_DIAS_RESUMEN} días:** ningún pago ni vencimiento anotado.`
  );
  bloques.push("Pregúntale a Wobi Seguros por cualquiera de estos puntos. Detalle completo en Cerebro (nodo Seguros).");
  return { titulo: `🛡️ Seguros — resumen semanal (${diaMes(d.hoy)})`, cuerpo: bloques.join("\n\n") };
}
