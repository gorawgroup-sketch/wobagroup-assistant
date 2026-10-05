/**
 * Resumen semanal de Wobi Seguros para Carlos. Sin IA (coste cero): junta lo que ya consta —pagos sin confirmar,
 * vencimientos y pagos que vienen, y lo que está esperando a una decisión o acción suya— y calla si no hay nada.
 * Es el «dime si hay algo pendiente» hecho a diario de ver, sin tener que preguntarlo.
 */
import type { PolizaConFila } from "./polizaRegistroSheet";
import type { EntradaConocimiento } from "./agente/conocimiento";
import { diasEntre, diaMes } from "./vigilante/fechas";

export const HORIZONTE_DIAS_RESUMEN = 60;

export interface EventoProximo {
  /** YYYY-MM-DD */
  fecha: string;
  texto: string;
  tipo: "vencimiento" | "pago";
}

const FECHA_EN_TEXTO = /(\d{2})\/(\d{2})\/(\d{4})/;

/**
 * Vencimientos y pagos dentro del horizonte: la fecha de vencimiento de cada póliza viva y los «PRÓXIMO PAGO: …
 * dd/mm/aaaa» que las revisiones anotan en el registro. (Cuando exista un calendario de pagos estructurado, esta
 * función es el único sitio que cambia.)
 */
export function eventosProximos(polizas: PolizaConFila[], hoy: string, dias = HORIZONTE_DIAS_RESUMEN): EventoProximo[] {
  const eventos: EventoProximo[] = [];
  for (const p of polizas) {
    if (p.estado === "vencida" || p.estado === "no_contratada" || p.estado === "pendiente_confirmacion") continue;
    if (p.fechaVencimiento) {
      const d = diasEntre(hoy, p.fechaVencimiento);
      if (d <= dias) eventos.push({ fecha: p.fechaVencimiento, tipo: "vencimiento", texto: `Vence ${p.tipoCobertura} (${p.aseguradora || "aseguradora sin confirmar"}${p.numeroPoliza ? `, ${p.numeroPoliza}` : ""})` });
    }
    for (const frase of p.notas.matchAll(/PRÓXIMO PAGO:[^|]*/g)) {
      const m = frase[0].match(FECHA_EN_TEXTO);
      if (!m) continue;
      const fecha = `${m[3]}-${m[2]}-${m[1]}`;
      const d = diasEntre(hoy, fecha);
      if (d >= 0 && d <= dias) eventos.push({ fecha, tipo: "pago", texto: `[${p.empresa}] ${frase[0].replace("PRÓXIMO PAGO:", "").trim().replace(/\.$/, "")}` });
    }
  }
  return eventos.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

export interface InformeSemanal {
  titulo: string;
  cuerpo: string;
}

export function construirInformeSemanal(d: { hoy: string; polizas: PolizaConFila[]; conocimiento: EntradaConocimiento[] }): InformeSemanal | null {
  const pendientesDePago = d.polizas.filter((p) => p.estadoPago === "pendiente" || p.estadoPago === "sin_confirmar");
  const proximos = eventosProximos(d.polizas, d.hoy);
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
