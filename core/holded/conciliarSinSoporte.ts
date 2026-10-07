import { randomUUID } from "node:crypto";
import { agregarFilaAtomica, eliminarFila, leerFilas } from "../google/sheetsKeyValueStore";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import { conMutex } from "../utils/asyncMutex";
import { estaConciliado, type Empresa } from "./client";
import { crearGastoHolded, leerEstadoMovimiento, marcarMovimientoConciliadoSinDocumento, obtenerCompraHoldedPorId, reconciliarMovimiento } from "./write";

/**
 * Cerrar un cargo SIN soporte — decisión explícita de Carlos (2026-10-06, correo de Alejandro, Footprint). Dos modos, ambos con
 * antes/ahora y confirmación de superadministrador (nada se escribe al proponer; la propuesta se consume ANTES de escribir y
 * después se relee Holded para contar lo que quedó de verdad; nunca se repite sola):
 *
 *  · «par»: un cargo y su reembolso TOTAL (suman cero, misma cuenta y moneda; Rappi 0,83 USD). Ambos movimientos se marcan
 *    conciliados sin enlazar documento (Holded los deja `forced_reconciled`). El efecto contable neto es cero, así que no hace
 *    falta ningún gasto.
 *  · «gasto»: un cargo real sin recibo (Payu*uber 7,37 €). Se CREA el gasto en Holded sin adjunto, clonando proveedor, cuenta
 *    contable, etiquetas y tratamiento fiscal de un gasto ya registrado de la misma persona (la plantilla), y se concilia con
 *    el cargo. El gasto queda en la contabilidad, marcado «SIN SOPORTE» en su descripción para poder localizarlo.
 *
 * Marcar un cargo con gasto real como conciliado sin documento NO está permitido: dejaría el gasto fuera de los libros.
 */
const TAB_NAME = "_conciliar_sin_soporte";
const HEADERS = ["id", "modo", "empresa", "chatId", "creadoEn", "datosJson"];
const NUM_COLS = HEADERS.length;
const TTL_MS = 48 * 60 * 60 * 1000;
const MUTEX = `conciliar-sin-soporte:${TAB_NAME}`;

const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];
export type ModoSinSoporte = "par" | "gasto";

export interface MovimientoRef { cuentaId: string; movimientoId: string; fecha: string }
interface DatosPar { motivo: string; descripcion: string; importe: number; moneda: string; movimientos: [MovimientoRef, MovimientoRef] }
interface DatosGasto {
  motivo: string; descripcion: string; importe: number; moneda: string; movimiento: MovimientoRef; concepto: string;
  plantilla: { compraId: string; contactId: string; proveedor: string; cuentaId?: string; tags: string[] };
}
export interface PropuestaSinSoporte { id: string; modo: ModoSinSoporte; empresa: Empresa; chatId: number; creadoEn: number; datos: DatosPar | DatosGasto }

const dinero = (n: number, m: string): string => `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${m}`;
const fechaCorta = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);
const num = (v: unknown): number => { const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : NaN; };

/* ───── textos (puros) ───── */

export function textoPropuestaPar(empresa: Empresa, d: DatosPar): string {
  const [a, b] = d.movimientos;
  return [
    `🧾 Cerrar cargo + reembolso sin gasto — ${empresa}`,
    `${d.descripcion}: ${dinero(d.importe, d.moneda)} de salida (${fechaCorta(a.fecha)}) y ${dinero(d.importe, d.moneda)} de entrada (${fechaCorta(b.fecha)}). Suman cero.`,
    `Motivo: ${d.motivo}`,
    "",
    "Antes: los dos movimientos están pendientes de conciliar en Holded.",
    "Ahora (si confirmas): los dos quedan marcados como conciliados, sin enlazar ningún documento. No se crea gasto ni asiento: el efecto contable neto es cero porque el dinero salió y volvió.",
  ].join("\n");
}

export function textoPropuestaGasto(empresa: Empresa, d: DatosGasto, fecha: string): string {
  return [
    `🧾 Crear gasto SIN soporte y conciliarlo — ${empresa}`,
    `Cargo: ${d.descripcion} · ${dinero(d.importe, d.moneda)} · ${fechaCorta(fecha)}`,
    `Motivo: ${d.motivo}`,
    "",
    "Antes: el cargo está pendiente de conciliar en Holded y no hay gasto.",
    `Ahora (si confirmas): se crea en Holded un gasto de ${dinero(d.importe, d.moneda)} del ${fechaCorta(fecha)} SIN adjunto, con el proveedor ${d.plantilla.proveedor}, la misma cuenta contable y las etiquetas (${d.plantilla.tags.join(", ") || "ninguna"}) de un gasto ya registrado de esta persona, la descripción «${d.concepto} — SIN SOPORTE» y se concilia con el cargo. Queda en la contabilidad; si más adelante llega el recibo, se adjunta a ese gasto.`,
  ].join("\n");
}

/* ───── almacén ───── */

async function guardar(p: PropuestaSinSoporte): Promise<void> {
  await conMutex(MUTEX, async () => {
    const vencidas = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).filter((f) => Date.now() - (Number(f.valores[4]) || 0) > TTL_MS).map((f) => f.rowIndex);
    for (const fila of vencidas.reverse()) await eliminarFila(TAB_NAME, fila, HEADERS);
    await agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, [p.id, p.modo, p.empresa, p.chatId, p.creadoEn, JSON.stringify(p.datos)]);
  });
}

async function consumir(id: string): Promise<PropuestaSinSoporte | undefined> {
  return conMutex(MUTEX, async () => {
    const fila = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).find((f) => f.valores[0] === id);
    if (!fila) return undefined;
    await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
    try {
      const v = fila.valores;
      if (!EMPRESAS.includes(v[2] as Empresa) || !["par", "gasto"].includes(v[1])) return undefined;
      return { id: v[0], modo: v[1] as ModoSinSoporte, empresa: v[2] as Empresa, chatId: Number(v[3]), creadoEn: Number(v[4]) || 0, datos: JSON.parse(v[5]) };
    } catch (error) {
      console.error("[conciliarSinSoporte] Propuesta ilegible, se descarta:", error instanceof Error ? error.message : error);
      return undefined;
    }
  });
}

async function publicar(chatId: number, p: PropuestaSinSoporte, texto: string): Promise<void> {
  await guardar(p);
  await sendTelegramMessageWithButtons(chatId, texto, [[
    { text: p.modo === "par" ? "✅ Cerrar los dos" : "✅ Crear gasto y conciliar", callback_data: `sinsop_ok:${p.id}` },
    { text: "❌ Cancelar", callback_data: `sinsop_no:${p.id}` },
  ]]);
}

/* ───── propuestas ───── */

async function leerPendiente(empresa: Empresa, m: MovimientoRef): Promise<{ importe: number; moneda: string } | string> {
  const e = await leerEstadoMovimiento(empresa, m.cuentaId, m.movimientoId, m.fecha);
  if (!e) return "No encuentro ese movimiento en Holded (revisa la cuenta, el id y la fecha).";
  if (estaConciliado(e.status)) return `El movimiento del ${fechaCorta(m.fecha)} ya figura conciliado en Holded (${e.status}).`;
  if (e.status === "partial" || Math.abs(num(e.reconciled_amount) || 0) > 0.005) return `El movimiento del ${fechaCorta(m.fecha)} ya está conciliado en parte con un documento; no lo toco para no perder ese enlace.`;
  const importe = num(e.amount);
  if (!Number.isFinite(importe) || importe === 0) return "No pude leer el importe del movimiento.";
  return { importe, moneda: String(e.currency ?? "EUR").toUpperCase() };
}

export async function proponerParCompensado(chatId: number, datos: { empresa: Empresa; movimientos: MovimientoRef[]; motivo: string; descripcion?: string }): Promise<string> {
  if (datos.movimientos.length !== 2) return "Hacen falta exactamente dos movimientos: el cargo y su reembolso.";
  const [a, b] = datos.movimientos;
  if (a.cuentaId !== b.cuentaId) return "El cargo y el reembolso deben ser de la misma cuenta; no propuse nada.";
  const [ra, rb] = [await leerPendiente(datos.empresa, a), await leerPendiente(datos.empresa, b)];
  if (typeof ra === "string") return `${ra} No propuse nada.`;
  if (typeof rb === "string") return `${rb} No propuse nada.`;
  if (ra.moneda !== rb.moneda) return "El cargo y el reembolso están en monedas distintas; no propuse nada.";
  if (Math.abs(ra.importe + rb.importe) > 0.006) return `No suman cero (${dinero(ra.importe, ra.moneda)} y ${dinero(rb.importe, rb.moneda)}): no es un reembolso total, así que no lo cierro sin gasto. No propuse nada.`;
  const [salida, entrada] = ra.importe < 0 ? [a, b] : [b, a];
  const d: DatosPar = { motivo: datos.motivo.trim() || "reembolso total del cargo", descripcion: datos.descripcion?.trim() || "Cargo y reembolso", importe: Math.abs(ra.importe), moneda: ra.moneda, movimientos: [salida, entrada] };
  const p: PropuestaSinSoporte = { id: randomUUID().slice(0, 8), modo: "par", empresa: datos.empresa, chatId, creadoEn: Date.now(), datos: d };
  await publicar(chatId, p, textoPropuestaPar(datos.empresa, d));
  return "Te mostré la propuesta con sus botones; no se ha escrito nada en Holded todavía.";
}

export async function proponerGastoSinSoporte(chatId: number, datos: { empresa: Empresa; movimiento: MovimientoRef; plantillaCompraId: string; concepto: string; motivo: string; descripcion?: string }): Promise<string> {
  const r = await leerPendiente(datos.empresa, datos.movimiento);
  if (typeof r === "string") return `${r} No propuse nada.`;
  if (r.importe >= 0) return "Solo creo un gasto sin soporte para un cargo (salida de dinero). No propuse nada.";
  const compra = await obtenerCompraHoldedPorId(datos.empresa, datos.plantillaCompraId).catch(() => undefined);
  const linea = compra?.lines?.[0] as { account?: string; taxes?: unknown[] } | undefined;
  if (!compra?.contact_id || !linea) return "No pude leer el gasto de plantilla en Holded. No propuse nada.";
  if (String(compra.currency ?? "EUR").toUpperCase() !== r.moneda) return "La plantilla y el cargo están en monedas distintas; no propuse nada.";
  if ((linea.taxes ?? []).length > 0) return "La plantilla lleva impuestos; por ahora el gasto sin soporte solo se crea sin impuestos. No propuse nada.";
  const d: DatosGasto = {
    motivo: datos.motivo.trim() || "no existe el recibo", descripcion: datos.descripcion?.trim() || "Cargo del banco", importe: Math.abs(r.importe), moneda: r.moneda,
    movimiento: datos.movimiento, concepto: datos.concepto.trim() || "Gasto",
    plantilla: { compraId: datos.plantillaCompraId, contactId: String(compra.contact_id), proveedor: String((compra as { contact_name?: string }).contact_name ?? "el mismo proveedor"), cuentaId: linea.account, tags: Array.isArray(compra.tags) ? compra.tags.map(String) : [] },
  };
  const p: PropuestaSinSoporte = { id: randomUUID().slice(0, 8), modo: "gasto", empresa: datos.empresa, chatId, creadoEn: Date.now(), datos: d };
  await publicar(chatId, p, textoPropuestaGasto(datos.empresa, d, datos.movimiento.fecha));
  return "Te mostré la propuesta con sus botones; no se ha escrito nada en Holded todavía.";
}

/* ───── ejecución ───── */

async function responder(id: string, texto?: string): Promise<void> {
  try { await answerCallbackQuery(id, texto); } catch (error) {
    console.error("[conciliarSinSoporte] No se pudo responder al botón (no crítico):", error instanceof Error ? error.message : error);
  }
}

async function ejecutarPar(p: PropuestaSinSoporte, d: DatosPar): Promise<string> {
  for (const m of d.movimientos) {
    const antes = await leerEstadoMovimiento(p.empresa, m.cuentaId, m.movimientoId, m.fecha);
    if (!antes) return "⚠️ No pude releer uno de los movimientos antes de escribir; no escribí nada.";
    if (estaConciliado(antes.status) || Math.abs(num(antes.reconciled_amount) || 0) > 0.005) return `ℹ️ Uno de los movimientos ya cambió en Holded (${antes.status}); no escribí nada.`;
  }
  const hechos: string[] = [];
  for (const m of d.movimientos) {
    await marcarMovimientoConciliadoSinDocumento(p.empresa, m.cuentaId, m.movimientoId);
    const despues = await leerEstadoMovimiento(p.empresa, m.cuentaId, m.movimientoId, m.fecha);
    if (!despues || !estaConciliado(despues.status)) {
      return `⚠️ Marqué ${hechos.length} de 2 movimientos; el del ${fechaCorta(m.fecha)} no aparece conciliado en Holded (estado: ${despues?.status ?? "desconocido"}). No sigo ni repito: revísalo en Holded.${hechos.length ? ` Ya quedó conciliado: ${hechos.join(", ")}.` : ""}`;
    }
    hechos.push(`${fechaCorta(m.fecha)} (${despues.status})`);
  }
  return `✅ Cerrado: ${d.descripcion} — ${dinero(d.importe, d.moneda)} de salida y de entrada, conciliados entre sí sin gasto (${hechos.join(" y ")}).`;
}

async function ejecutarGasto(p: PropuestaSinSoporte, d: DatosGasto): Promise<string> {
  const antes = await leerEstadoMovimiento(p.empresa, d.movimiento.cuentaId, d.movimiento.movimientoId, d.movimiento.fecha);
  if (!antes) return "⚠️ No pude releer el cargo antes de escribir; no creé nada.";
  if (estaConciliado(antes.status) || Math.abs(num(antes.reconciled_amount) || 0) > 0.005) return `ℹ️ El cargo ya cambió en Holded (${antes.status}); no creé nada.`;
  const { id: gastoId } = await crearGastoHolded(p.empresa, {
    contactId: d.plantilla.contactId,
    fecha: d.movimiento.fecha,
    descripcion: `${d.concepto} — SIN SOPORTE (${d.motivo})`,
    lineas: [{ concepto: `${d.concepto} — SIN SOPORTE`, base: d.importe, tipoIvaPct: 0, tratamientoFiscal: "sin_impuesto" }],
    cuentaId: d.plantilla.cuentaId,
    tags: d.plantilla.tags,
    moneda: d.moneda,
  }, { idempotencyKey: `sin-soporte:${p.id}`, proceso: "gasto_sin_soporte" });
  const r = await reconciliarMovimiento(p.empresa, d.movimiento.cuentaId, d.movimiento.movimientoId, d.movimiento.fecha, gastoId);
  if (!r.ok) {
    return `⚠️ Creé el gasto en Holded (id ${gastoId}, sin soporte) pero la conciliación con el cargo no quedó confirmada (estado: ${r.statusFinal}). No repito nada: revisa el gasto y el cargo en Holded.`;
  }
  return `✅ Gasto creado SIN soporte y conciliado: ${d.concepto} · ${dinero(d.importe, d.moneda)} · ${fechaCorta(d.movimiento.fecha)} (${p.empresa}). Id del gasto: ${gastoId}. Si llega el recibo, adjúntalo a ese gasto.`;
}

export async function handleConciliarSinSoporteCallback(callback: TelegramCallbackQuery): Promise<void> {
  const [accion, id] = (callback.data ?? "").split(":");
  const chatId = callback.message?.chat.id;
  const mensajeId = callback.message?.message_id;
  if (!id || !chatId || !mensajeId) { await responder(callback.id, "Petición no válida."); return; }

  const propuesta = await consumir(id);
  if (!propuesta) { await responder(callback.id, "Esta propuesta ya no está disponible."); return; }

  if (accion === "sinsop_no") {
    await responder(callback.id, "Cancelado.");
    await editTelegramMessage(chatId, mensajeId, "❌ Cancelado: no se escribió nada en Holded.", []);
    return;
  }

  await responder(callback.id, "Aplicando...");
  await editTelegramMessage(chatId, mensajeId, "🔄 Aplicando en Holded...", []).catch(() => undefined);
  try {
    const mensaje = propuesta.modo === "par" ? await ejecutarPar(propuesta, propuesta.datos as DatosPar) : await ejecutarGasto(propuesta, propuesta.datos as DatosGasto);
    await editTelegramMessage(chatId, mensajeId, mensaje, []);
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[conciliarSinSoporte] Error:", mensaje);
    await editTelegramMessage(chatId, mensajeId, `⚠️ No pude confirmar la operación (${mensaje}). No la repito sola: revisa el cargo en Holded.`, []).catch(() => undefined);
  }
}
