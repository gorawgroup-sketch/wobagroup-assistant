import type { FilaExtracto } from "./extractoRevolut";

/**
 * Correo a quien gastó con la tarjeta: texto FIJO (sin IA), con los datos reales de cada cargo. Un solo correo por
 * persona con todos sus cargos — nunca uno por transacción. Sale del buzón de Wobi (asistente@wobagroup.com) y pide
 * los soportes a ese mismo buzón, donde el flujo de correo ya crea el gasto y lo concilia.
 */

/** Lo mínimo de un cargo que necesita el correo (y lo que se guarda en la campaña pendiente). */
export type CargoCorreo = Pick<FilaExtracto, "id" | "fecha" | "comercio" | "total" | "monedaCuenta" | "importeOriginal" | "monedaOriginal" | "tarjeta4">;

export const BUZON_SOPORTES = "asistente@wobagroup.com";

const fmt = (n: number, moneda: string): string =>
  `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${moneda}`;

const fechaCorta = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);

export function nombreDePila(nombreCompleto: string): string {
  const partes = nombreCompleto.trim().split(/\s+/).filter(Boolean);
  return partes[0] ? partes[0][0].toUpperCase() + partes[0].slice(1).toLowerCase() : "";
}

export interface DatosCorreoSoportes {
  titular: string;
  empresa: string;
  desde: string;
  hasta: string;
  cargos: CargoCorreo[];
  /** Cuántos de estos cargos ya se pidieron en un envío anterior (recordatorio). */
  yaSolicitados?: number;
  /** Hoja de seguimiento compartida y editable de esta persona (Google Sheets). Con ella ya no se adjunta Excel ni se pide reenviar. */
  hojaUrl?: string;
}

/** Con hoja compartida: nadie tiene que reenviar lo ya enviado; lo indica en la hoja y lo buscamos nosotros primero. */
export const TEXTO_YA_ENVIADOS_CON_HOJA =
  "Si ya enviaste alguno de ellos, no hace falta que lo reenvíes: indícalo en la columna «Comment» de tu hoja compartida (fecha y destinatario) y lo localizamos nosotros primero. Si todavía no los has enviado, te pedimos que lo hagas.";
export const TEXTO_HOJA_ANTES = "Aquí tienes tu hoja de seguimiento, la misma de siempre y editable por ti: ";
export const TEXTO_HOJA_DESPUES = ". En ella ves el estado de cada cargo y cuándo se pidió, y puedes dejar tus comentarios; respondemos en la columna «Wobi's answer» y nunca borramos lo que escribes.";
export const textoHojaCompartida = (url: string): string => `${TEXTO_HOJA_ANTES}${url}${TEXTO_HOJA_DESPUES}`;

/** Subtotal por moneda de cuenta; las monedas nunca se suman entre sí. */
export function totalesPorMoneda(cargos: CargoCorreo[]): Array<{ moneda: string; total: number }> {
  const m = new Map<string, number>();
  for (const c of cargos) m.set(c.monedaCuenta, (m.get(c.monedaCuenta) ?? 0) + Math.abs(c.total));
  return [...m.entries()].map(([moneda, total]) => ({ moneda, total }));
}

export function asuntoCorreoSoportes(d: Pick<DatosCorreoSoportes, "empresa" | "desde" | "hasta">): string {
  return `${d.empresa} · Soportes pendientes de tus gastos con tarjeta (${fechaCorta(d.desde)} – ${fechaCorta(d.hasta)})`;
}

export function lineaCargo(f: CargoCorreo): string {
  const original = f.monedaOriginal && f.monedaOriginal !== f.monedaCuenta ? ` (${fmt(f.importeOriginal, f.monedaOriginal)} en el comercio)` : "";
  const tarjeta = f.tarjeta4 ? ` · tarjeta ···${f.tarjeta4}` : "";
  return `• ${fechaCorta(f.fecha)} · ${f.comercio || "(sin comercio)"} · ${fmt(Math.abs(f.total), f.monedaCuenta)}${original}${tarjeta}`;
}

export function redactarCorreoSoportes(d: DatosCorreoSoportes): string {
  const totales = totalesPorMoneda(d.cargos).map((t) => fmt(t.total, t.moneda)).join(" + ");
  const recordatorio = d.yaSolicitados && d.yaSolicitados > 0
    ? `\n(${d.yaSolicitados === d.cargos.length ? "Todos estos cargos ya te los habíamos pedido antes" : `${d.yaSolicitados} de estos cargos ya te los habíamos pedido antes`}; los incluimos de nuevo porque seguimos sin verlos conciliados.)\n`
    : "";
  return [
    `Hola, ${nombreDePila(d.titular) || d.titular}:`,
    "",
    `Estamos desarrollando la habilidad de nuestro asistente para mejorar la conciliación de gastos y estabilizar la contabilidad mensual de ${d.empresa}. Por esa razón te escribimos: estos son los cargos hechos con tu tarjeta entre el ${fechaCorta(d.desde)} y el ${fechaCorta(d.hasta)} que todavía no tienen su soporte conciliado en nuestra contabilidad.`,
    "",
    `Por favor, envía la factura o el recibo de cada uno respondiendo a este correo (o escribiendo a ${BUZON_SOPORTES}).`,
    "",
    d.hojaUrl
      ? TEXTO_YA_ENVIADOS_CON_HOJA
      : "Si ya los habías enviado y te los pedimos de nuevo, te agradecemos que los reenvíes: por alguna razón nuestro sistema no reconoció lo que ya mandaste. Esto no debería volver a pasar en adelante, pero por ahora te pedimos este favor. Si todavía no los has enviado, te pedimos que lo hagas.",
    recordatorio,
    ...d.cargos.map(lineaCargo),
    "",
    `Total de ${d.cargos.length} ${d.cargos.length === 1 ? "cargo" : "cargos"}: ${totales}.`,
    "",
    d.hojaUrl
      ? textoHojaCompartida(d.hojaUrl)
      : "Te adjuntamos esta misma lista en Excel, con una columna de estado, solo para tu propio control: no hace falta devolverla; lo que necesitamos son los soportes.",
    "",
    "Si un mismo comprobante cubre varias operaciones, indícanos cuáles. Si algún cargo no lo reconoces o corresponde a otra persona, cuéntanoslo para revisarlo.",
    "",
    "Gracias por tu ayuda.",
  ].join("\n");
}
