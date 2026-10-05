/**
 * Texto de los avisos del vigilante. Puro: recibe lo detectado y devuelve el mensaje; no envía nada.
 * Formato de Telegram: **negrita** (lo convierte core/telegram/client.ts); sin botones — todo es informativo.
 */
import type { PolizaConFila } from "../polizaRegistroSheet";
import type { CorreoSeguro } from "./correos";
import type { CargoAnomalo, PagoAmbiguo, PagoConfirmado, PagoEnTransito, PosibleDevolucion } from "./cruces";
import { diaMes } from "./fechas";
import { formatearEuros } from "./importes";
import { importeEnEur, type MovimientoBanco } from "./tipos";

export interface DevolucionDetectada {
  devolucion: PosibleDevolucion;
  /** true si el vigilante devolvió la póliza a «pendiente» en el registro. */
  revertida: boolean;
}

export interface ContenidoInforme {
  hoy: string;
  devoluciones: DevolucionDetectada[];
  confirmados: PagoConfirmado[];
  enTransito: PagoEnTransito[];
  cargos: CargoAnomalo[];
  correos: CorreoSeguro[];
  ambiguos: PagoAmbiguo[];
  /** Pólizas con pago pendiente cuyo cargo no aparece en el banco (lectura completa de su empresa). */
  sinPago: PolizaConFila[];
  /** Avisos de cobertura de esta revisión (una cuenta o el correo no se pudieron leer): solo acompañan a otras novedades. */
  advertencias: string[];
  /** Lecturas que llevan días fallando: justifican un mensaje por sí solas (nunca callar un fallo que se repite). */
  fallosPersistentes: string[];
}

export interface Informe {
  titulo: string;
  cuerpo: string;
}

const MAX_CORREOS_EN_AVISO = 8;

const recortar = (texto: string, max: number) => (texto.length > max ? `${texto.slice(0, max - 1).trim()}…` : texto);

export function etiquetaPoliza(p: PolizaConFila): string {
  return `[${p.empresa}] ${p.tipoCobertura}${p.numeroPoliza ? ` (${p.numeroPoliza})` : ""}`;
}

/** «−323,24 € el 05/10 en BBVA («Markel Insurance SE ADEUDO…»)» */
export function describirMovimiento(m: MovimientoBanco): string {
  const eur = importeEnEur(m);
  const importe =
    m.moneda === "EUR" || eur == null
      ? `${formatearEuros(m.importe)}${m.moneda === "EUR" ? " €" : ` ${m.moneda}`}`
      : `${formatearEuros(m.importe)} ${m.moneda} (≈ ${formatearEuros(eur)} €)`;
  return `${importe} el ${diaMes(m.fecha)} en ${m.cuenta} («${recortar(m.descripcion.replace(/\s+/g, " "), 80)}»)`;
}

const ETIQUETA_SENAL: Record<string, string> = {
  incidencia: "🚨 posible incidencia",
  recibo: "recibo/pago",
  documento: "documento adjunto",
  firma: "pide firma",
};

function lineaCorreo(c: CorreoSeguro): string {
  const cuando = new Date(c.fecha);
  const fecha = `${String(cuando.getUTCDate()).padStart(2, "0")}/${String(cuando.getUTCMonth() + 1).padStart(2, "0")}`;
  const senales = c.senales.length ? ` — ${c.senales.map((s) => ETIQUETA_SENAL[s]).join(", ")}` : "";
  const adjuntos = c.adjuntos.length ? ` · ${c.adjuntos.length} adjunto(s): ${recortar(c.adjuntos.slice(0, 3).join(", "), 120)}` : "";
  return `- 📧 ${fecha} · ${c.remitente} · «${recortar(c.asunto.replace(/\s+/g, " "), 100)}»${senales}${adjuntos}`;
}

function textoCargo(c: CargoAnomalo): string {
  const donde = `[${c.movimiento.empresa}] cargo de ${describirMovimiento(c.movimiento)}`;
  switch (c.tipo) {
    case "no_registrada":
      return `- 🆕 ${donde} — no hay ninguna póliza registrada de esta contraparte (${c.contraparte.nombre}). ¿Es un seguro nuevo?`;
    case "sin_poliza_vigente":
      return `- ⚠️ ${donde} — la única póliza registrada de ${c.contraparte.nombre} está vencida o sin contratar.`;
    case "dada_de_baja":
      return `- 🚨 ${donde} — ${c.contraparte.nombre} estaba dado de baja (${c.contraparte.motivo}).`;
    case "no_aplicado":
      return `- ↩️ ${donde} — el saldo del banco no lo refleja: probablemente se devolvió. Comprueba si el recibo quedó impagado.`;
  }
}

function textoDevolucion({ devolucion: d, revertida }: DevolucionDetectada): string {
  const poliza = etiquetaPoliza(d.vigilado.poliza);
  const pago = describirMovimiento(d.vigilado.movimiento);
  const accion = revertida ? "He devuelto la póliza a «pendiente» en el registro." : "No he tocado el registro: confírmalo con el banco o la correduría.";
  if (d.entrada) {
    const entrada = describirMovimiento(d.entrada);
    return d.certeza === "probable"
      ? `- ↩️ ${poliza}: el pago de ${pago} parece devuelto — entró ${entrada}. ${accion}`
      : `- ↩️ ${poliza}: tras el pago de ${pago} entró ${entrada}; podría ser la devolución. ${accion}`;
  }
  return `- ↩️ ${poliza}: el saldo del banco ya no refleja el pago de ${pago} (así se devolvieron los adeudos de Allianz y Aegon el 01/09). ${accion}`;
}

function textoConfirmado(c: PagoConfirmado): string {
  if (c.consolidado) {
    const recibos = c.polizas.map((p) => `${etiquetaPoliza(p)} ${p.prima} €`).join(" + ");
    return `- ✅ Un solo pago de ${describirMovimiento(c.movimiento)} cubre ${c.polizas.length} recibos: ${recibos}. Marcados como pagados.`;
  }
  return `- ✅ ${etiquetaPoliza(c.polizas[0])}: ${describirMovimiento(c.movimiento)}. Marcada como pagada.`;
}

/**
 * Aviso para Telegram: solo lo NUEVO. Devuelve null si no hay nada que contar: el vigilante calla cuando no hay
 * novedades, y un fallo de lectura aislado tampoco justifica un mensaje (acompaña a otras novedades); uno que lleva
 * días repitiéndose sí (fallosPersistentes).
 */
export function construirInforme(c: ContenidoInforme): Informe | null {
  const hayNovedad =
    c.devoluciones.length + c.confirmados.length + c.enTransito.length + c.cargos.length + c.correos.length + c.ambiguos.length +
      c.fallosPersistentes.length > 0;
  if (!hayNovedad) return null;
  return { titulo: `🛡️ Seguros — novedades del ${diaMes(c.hoy)}`, cuerpo: cuerpoDelInforme(c, false) };
}

function cuerpoDelInforme(c: ContenidoInforme, paraChat: boolean): string {
  const bloques: string[] = [];
  if (c.devoluciones.length > 0) bloques.push(`**Devoluciones** (${c.devoluciones.length})\n${c.devoluciones.map(textoDevolucion).join("\n")}`);
  if (c.confirmados.length > 0) bloques.push(`**Pagos confirmados en el banco** (${c.confirmados.length})\n${c.confirmados.map(textoConfirmado).join("\n")}`);
  if (c.enTransito.length > 0) {
    bloques.push(
      `**Cargos vistos que aún no doy por pagados** (${c.enTransito.length})\n` +
        c.enTransito
          .map((t) => `- ⏳ ${t.polizas.map(etiquetaPoliza).join(" + ")}: ${describirMovimiento(t.movimiento)} — ${t.motivo}. Lo vuelvo a mirar en la próxima revisión.`)
          .join("\n")
    );
  }
  if (c.cargos.length > 0) bloques.push(`**Cargos de seguros que no encajan** (${c.cargos.length})\n${c.cargos.map(textoCargo).join("\n")}`);
  if (c.ambiguos.length > 0) {
    bloques.push(
      `**Pagos que no sé atribuir** (${c.ambiguos.length})\n` +
        c.ambiguos.map((a) => `- ❓ ${etiquetaPoliza(a.poliza)} (${a.poliza.prima} €): ${a.motivo}. Confírmalo tú.`).join("\n")
    );
  }
  if (c.correos.length > 0) {
    const visibles = c.correos.slice(-MAX_CORREOS_EN_AVISO);
    const resto = c.correos.length - visibles.length;
    bloques.push(
      `**Correos nuevos de aseguradoras y corredurías** (${c.correos.length})\n${visibles.map(lineaCorreo).join("\n")}${resto > 0 ? `\n- … y ${resto} anterior(es)` : ""}`
    );
  }
  if (paraChat && c.sinPago.length > 0) {
    bloques.push(
      `**Pendientes de pago que siguen sin aparecer en el banco** (${c.sinPago.length})\n` +
        c.sinPago.map((p) => `- ⏳ ${etiquetaPoliza(p)}: ${p.prima} €`).join("\n")
    );
  }
  const incompletas = [...c.fallosPersistentes.map((a) => `🔁 ${a}`), ...c.advertencias];
  if (incompletas.length > 0) bloques.push(`**Revisión incompleta**\n${incompletas.map((a) => `- ℹ️ ${a}`).join("\n")}`);
  bloques.push("Detalle completo en Cerebro (nodo Seguros, grupo Finanzas).");
  return bloques.join("\n\n");
}

/** Respuesta para el chat («revisa los seguros»): siempre responde, aunque no haya novedades. */
export function construirRespuestaChat(c: ContenidoInforme): string {
  const hayNovedad =
    c.devoluciones.length + c.confirmados.length + c.enTransito.length + c.cargos.length + c.correos.length + c.ambiguos.length + c.sinPago.length +
      c.fallosPersistentes.length > 0;
  if (!hayNovedad) {
    const aviso = c.advertencias.length ? `\n\n${c.advertencias.map((a) => `- ℹ️ ${a}`).join("\n")}` : "";
    return `Revisión de seguros del ${diaMes(c.hoy)}: sin novedades. No hay cargos nuevos de aseguradoras ni correos nuevos de corredurías, y no hay recibos pendientes de pago.${aviso}`;
  }
  return `Revisión de seguros del ${diaMes(c.hoy)}:\n\n${cuerpoDelInforme(c, true)}`;
}
