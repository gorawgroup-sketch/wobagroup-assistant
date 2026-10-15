import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { descargarArchivoDrive } from "../../drive/client";
import { procesarGastoEntrante } from "../../gastos/procesarGastoEntrante";
import { normalizarBusqueda } from "../../gastos/reenviarPreguntaPendiente";
import { buscarComprasPorMonto } from "../../holded/write";
import type { Empresa } from "../../holded/client";
import { monedasPermitidasConciliacionMultiple, type ConciliacionPlanificada, type PagoExacto, type PlanConciliacion, type ReferenciaMovimiento } from "../../holded/conciliacionMultiple/model";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../../telegram/client";
import { actualizarDeclaracion, obtenerDeclaracion, type CargoDeclarado, type Declaracion } from "./declaracionStore";
import { localizarMovimientosDeclarados, type CargoLocalizado } from "./localizarCargos";

/**
 * Paso C del flujo «declaración de gastos sin soporte» (Carlos, 12-10 y 15-10-2026): la declaración FIRMADA es el comprobante
 * de UN SOLO gasto por el valor total de los cargos que relaciona, y TODOS esos cargos del banco se concilian contra ese gasto
 * (conciliación múltiple, core/holded/conciliacionMultiple). Vale para cualquier persona y empresa.
 *  - Si el gasto del total ya existe en Holded (p. ej. se creó desde el chat), se propone directamente la conciliación múltiple.
 *  - Si no existe, se propone crearlo por el camino de siempre (propuesta con botón, contacto, duplicados) llevando ya la
 *    conciliación planificada: al crearse, el sistema propone el lote con los cargos localizados en vez de buscar un cargo suelto.
 * Nada se escribe sin botón: «Aplicar» solo prepara; «Crear» y «Confirmar conciliación múltiple» son del superadministrador.
 */
const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");
const DIAS_BUSQUEDA_COMPRA = 120;

export interface CompraTotal { id: string; contactName: string; total: number; fecha: string; documentNumber?: string }
export type AccionPlan = "conciliar_existente" | "crear_y_conciliar" | "ya_resuelta" | "bloqueado";
export interface PlanAplicacion { declaracion: Declaracion; total: number; moneda: string; compra?: CompraTotal; comprasPosibles: CompraTotal[]; cargos: CargoLocalizado[]; accion: AccionPlan; bloqueos: string[] }

export interface LectorPlan {
  compras(empresa: Empresa, d: Declaracion, total: number, moneda: string): Promise<CompraTotal[]>;
  cargos(empresa: Empresa, cargos: CargoDeclarado[]): Promise<CargoLocalizado[]>;
  /** Pagos ya aplicados a la compra del total (para comprobar que los cargos conciliados lo están CON ESA compra). */
  pagos(empresa: Empresa, compraId: string): Promise<PagoExacto[]>;
}

export const numeroDocumentoDeclaracion = (d: Pick<Declaracion, "id">): string => `DECL-${d.id}`;
export const totalDeclarado = (cargos: CargoDeclarado[]): number => Math.round(cargos.reduce((s, c) => s + c.valor, 0) * 100) / 100;

/** La compra del total: por número de documento de la declaración o por el nombre del titular como contacto. */
export function esCompraDeLaDeclaracion(c: CompraTotal, d: Pick<Declaracion, "id" | "titular">): boolean {
  if ((c.documentNumber ?? "").trim().toUpperCase() === numeroDocumentoDeclaracion(d).toUpperCase()) return true;
  const contacto = normalizarBusqueda(c.contactName);
  const partes = normalizarBusqueda(d.titular).split(/\s+/).filter((x) => x.length >= 3);
  return partes.length >= 2 && partes.filter((p) => contacto.includes(p)).length >= 2;
}

const lectorReal: LectorPlan = {
  compras: async (empresa, d, total, moneda) => {
    const hoy = new Date().toISOString().slice(0, 10);
    const compras = await buscarComprasPorMonto(empresa, total, hoy, DIAS_BUSQUEDA_COMPRA, moneda);
    return compras.filter((c) => esCompraDeLaDeclaracion(c, d)).map((c) => ({ id: c.id, contactName: c.contactName, total: c.total, fecha: c.fecha, documentNumber: c.documentNumber }));
  },
  cargos: (empresa, cargos) => localizarMovimientosDeclarados(empresa, cargos),
  pagos: async (empresa, compraId) => {
    const { HoldedConciliacionAdapter } = await import("../../holded/conciliacionMultiple/holdedAdapter");
    return (await new HoldedConciliacionAdapter().compra(empresa, compraId)).pagos;
  },
};

/** Un cargo ya conciliado cuenta como resuelto solo si la compra del total tiene un pago con su importe, cuenta y fecha. */
export function pagadoPorLaCompra(x: CargoLocalizado, pagos: PagoExacto[]): boolean {
  if (!x.movimiento) return false;
  const centimos = Math.round(Math.abs(x.movimiento.importe) * 100);
  return pagos.some((p) => p.centimos === centimos && p.accountId === x.movimiento!.accountId && p.fecha === x.movimiento!.fecha);
}

/** Lógica pura: qué toca hacer con lo que devolvieron Holded y el banco. */
export function decidirAccion(compras: CompraTotal[], cargos: CargoLocalizado[], pagosDeLaCompra: PagoExacto[] = []): { accion: AccionPlan; bloqueos: string[] } {
  const bloqueos: string[] = [];
  const monedas = [...new Set(cargos.map((x) => x.cargo.moneda.toUpperCase()))];
  if (monedas.length > 1) bloqueos.push(`los cargos mezclan monedas (${monedas.join(", ")}): un solo gasto por el total exige una sola moneda; separa la declaración por moneda`);
  const permitidas = monedasPermitidasConciliacionMultiple();
  for (const m of monedas) if (!permitidas.includes(m)) bloqueos.push(`la conciliación múltiple no está habilitada en ${m} (hoy: ${permitidas.join(", ")})`);
  if (compras.length > 1) bloqueos.push(`hay ${compras.length} compras posibles del total en Holded (${compras.map((c) => `${c.contactName} ${c.fecha} ${c.documentNumber ?? "sin número"}`).join(" / ")}): dime cuál es`);
  for (const x of cargos) if (x.situacion === "no_encontrado" || x.situacion === "ambiguo") bloqueos.push(`${x.cargo.fecha} · ${x.cargo.lugar} · ${x.cargo.valor.toFixed(2)} ${x.cargo.moneda}: ${x.situacion === "ambiguo" ? "varios cargos posibles" : "sin cargo en el banco"} (${x.detalle ?? ""})`);
  if (bloqueos.length) return { accion: "bloqueado", bloqueos };
  const conciliados = cargos.filter((x) => x.situacion === "ya_conciliado");
  if (compras.length === 1 && conciliados.length === cargos.length && cargos.every((x) => pagadoPorLaCompra(x, pagosDeLaCompra))) return { accion: "ya_resuelta", bloqueos };
  if (conciliados.length) return { accion: "bloqueado", bloqueos: conciliados.map((x) => `${x.cargo.fecha} · ${x.cargo.lugar} · ${x.cargo.valor.toFixed(2)}: ${pagadoPorLaCompra(x, pagosDeLaCompra) ? "ya conciliado con el gasto del total" : (x.detalle ?? "ya conciliado") + " (con otro documento: revísalo en Holded)"}`) };
  return { accion: compras.length === 1 ? "conciliar_existente" : "crear_y_conciliar", bloqueos };
}

export async function planificarAplicacion(d: Declaracion, lector: LectorPlan = lectorReal): Promise<PlanAplicacion> {
  const moneda = (d.cargos[0]?.moneda ?? "EUR").toUpperCase();
  const total = totalDeclarado(d.cargos);
  const [compras, cargos] = await Promise.all([lector.compras(d.empresa as Empresa, d, total, moneda), lector.cargos(d.empresa as Empresa, d.cargos)]);
  const pagos = compras.length === 1 && cargos.some((x) => x.situacion === "ya_conciliado") ? await lector.pagos(d.empresa as Empresa, compras[0].id) : [];
  const { accion, bloqueos } = decidirAccion(compras, cargos, pagos);
  return { declaracion: d, total, moneda, compra: compras.length === 1 ? compras[0] : undefined, comprasPosibles: compras, cargos, accion, bloqueos };
}

export function textoPlan(p: PlanAplicacion): string {
  const linea = (x: CargoLocalizado) => `  • ${x.cargo.fecha} · ${x.cargo.lugar} · ${x.cargo.valor.toFixed(2)} ${x.cargo.moneda}` +
    (x.movimiento ? ` → banco ${x.movimiento.fecha} «${x.movimiento.descripcion}» (${x.movimiento.cuenta})` : "") + (x.situacion === "ya_conciliado" ? " · ya conciliado" : "");
  const partes = [`📎 Declaración firmada de ${p.declaracion.titular} (${p.declaracion.empresa}): un solo gasto de ${p.total.toFixed(2)} ${p.moneda} por ${p.declaracion.cargos.length} cargo(s), con la declaración como comprobante.`];
  partes.push(p.compra ? `Gasto del total: ya existe en Holded (${p.compra.contactName} · ${p.compra.total.toFixed(2)} · ${p.compra.fecha}${p.compra.documentNumber ? ` · ${p.compra.documentNumber}` : ""}).` : "Gasto del total: no existe en Holded, se propone crearlo.");
  partes.push("Cargos en el banco:", ...p.cargos.map(linea));
  if (p.bloqueos.length) partes.push("No se puede aplicar todavía:", ...p.bloqueos.map((b) => `  ⚠️ ${b}`));
  return partes.join("\n");
}

const referencias = (cargos: CargoLocalizado[]): ReferenciaMovimiento[] => cargos.map((x) => ({ accountId: x.movimiento!.accountId, movementId: x.movimiento!.movementId, fecha: x.movimiento!.fecha }));
const motivoPlan = (d: Declaracion, total: number, moneda: string): string =>
  `Declaración de gastos sin soporte firmada por ${d.titular} (${d.empresa}, ${d.nombreArchivo}): sus ${d.cargos.length} cargo(s) suman ${total.toFixed(2)} ${moneda}, el total del gasto.`.slice(0, 500);

export async function proponerAplicacion(chatId: number, d: Declaracion): Promise<void> {
  const plan = await planificarAplicacion(d);
  if (plan.accion === "ya_resuelta") {
    await marcarAplicada(d, plan.compra!.id, plan.cargos, "adjuntado", "todos los cargos ya estaban conciliados con el gasto del total");
    await sendTelegramMessage(chatId, `${textoPlan(plan)}\n\n✅ Todo estaba ya hecho: la declaración queda marcada como aplicada.`);
    return;
  }
  if (plan.accion === "bloqueado") {
    await sendTelegramMessage(chatId, `${textoPlan(plan)}\n\nCuando el banco esté sincronizado o me digas cuál es, pide «aplica la declaración firmada de ${d.titular}».`);
    return;
  }
  const etiqueta = plan.accion === "conciliar_existente"
    ? `✅ Aplicar: conciliar los ${plan.cargos.length} cargos con el gasto`
    : `✅ Aplicar: crear el gasto de ${plan.total.toFixed(2)} y conciliar ${plan.cargos.length} cargos`;
  await sendTelegramMessageWithButtons(chatId, `${textoPlan(plan)}\n\n¿Aplico? ${plan.accion === "conciliar_existente" ? "Te mando el desglose de la conciliación múltiple con su botón." : "Te propongo el gasto con su botón; al crearlo, te mando la conciliación múltiple con los cargos."}`, [
    [{ text: etiqueta, callback_data: `decl_aplicar:${d.id}` }],
    [{ text: "⏸️ Ahora no", callback_data: `decl_noaplicar:${d.id}` }],
  ]);
}

async function descargarFirmada(d: Declaracion): Promise<{ rutaLocal: string; nombre: string; mimeType: string }> {
  if (!d.archivoFirmadoDriveId) throw new Error("La declaración no tiene archivo firmado en Drive.");
  const a = await descargarArchivoDrive(d.archivoFirmadoDriveId);
  await mkdir(UPLOADS_DIR, { recursive: true });
  const ext = (a.name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".pdf").toLowerCase();
  const rutaLocal = join(UPLOADS_DIR, `${Date.now()}_declaracion_firmada_${d.id}${ext}`);
  await writeFile(rutaLocal, a.bytes);
  return { rutaLocal, nombre: a.name, mimeType: a.mimeType };
}

async function marcarAplicada(d: Declaracion, compraId: string, cargos: CargoLocalizado[], estadoSoporte: "adjuntado" | "propuesto", nota: string): Promise<void> {
  const marcados = d.cargos.map((c) => { const x = cargos.find((y) => y.cargo.id === c.id); return { ...c, estadoSoporte, compraId, ...(x?.movimiento ? { movimiento: { accountId: x.movimiento.accountId, movementId: x.movimiento.movementId, fecha: x.movimiento.fecha } } : {}) }; });
  await actualizarDeclaracion(d.id, { cargos: marcados, estado: estadoSoporte === "adjuntado" ? "aplicada" : d.estado, nota: `${d.nota ? `${d.nota} ` : ""}[${new Date().toISOString().slice(0, 10)}: ${nota}]` });
}

export type ResultadoAplicacion =
  | { modo: "conciliacion_propuesta"; planId: string; cargos: number }
  | { modo: "gasto_propuesto"; cargos: number; salida: string }
  | { modo: "ya_resuelta" }
  | { modo: "bloqueado"; bloqueos: string[] };

/** Ejecuta el plan tras el botón «Aplicar»: prepara la conciliación múltiple o propone el gasto único con ella planificada. */
export async function aplicarDeclaracion(chatId: number, d: Declaracion): Promise<ResultadoAplicacion> {
  const plan = await planificarAplicacion(d);
  if (plan.accion === "bloqueado") return { modo: "bloqueado", bloqueos: plan.bloqueos };
  if (plan.accion === "ya_resuelta") {
    await marcarAplicada(d, plan.compra!.id, plan.cargos, "adjuntado", "todos los cargos ya estaban conciliados con el gasto del total");
    return { modo: "ya_resuelta" };
  }
  const planificada: ConciliacionPlanificada = { movimientos: referencias(plan.cargos), motivo: motivoPlan(d, plan.total, plan.moneda), origen: { tipo: "declaracion", id: d.id } };
  if (plan.accion === "conciliar_existente") {
    const { conciliacionMultiple } = await import("../../holded/conciliacionMultiple/runtime");
    const { proponerPlanConciliacionMultiple } = await import("../../holded/conciliacionMultiple/proponer");
    const p = await conciliacionMultiple.preparar({ empresa: d.empresa as Empresa, chatId, compraId: plan.compra!.id, ...planificada });
    await proponerPlanConciliacionMultiple(chatId, p, `📎 Declaración firmada de ${d.titular}: conciliación de sus ${plan.cargos.length} cargo(s) con el gasto del total.`);
    await marcarAplicada(d, plan.compra!.id, plan.cargos, "propuesto", `conciliación múltiple propuesta (plan ${p.id}) contra la compra ${plan.compra!.id}`);
    return { modo: "conciliacion_propuesta", planId: p.id, cargos: plan.cargos.length };
  }
  const firmada = await descargarFirmada(d);
  const fecha = [...d.cargos].map((c) => c.fecha).sort().pop() ?? new Date().toISOString().slice(0, 10);
  let salida: Awaited<ReturnType<typeof procesarGastoEntrante>>;
  try {
    salida = await procesarGastoEntrante({
    chatId, rutaLocal: firmada.rutaLocal, nombreArchivoOriginal: firmada.nombre, mimeType: firmada.mimeType,
    datos: {
      esFacturaOGasto: true, proveedor: d.titular, monto: plan.total, moneda: plan.moneda, fecha, numeroDocumento: numeroDocumentoDeclaracion(d),
      concepto: `Gastos sin comprobante declarados y firmados por ${d.titular} (${d.cargos.length} cargos)`,
      reciboSimplificado: true,
      lineas: d.cargos.map((c) => ({ concepto: `${c.fecha} · ${c.lugar} (sin comprobante)`, base: c.valor, tipoIvaPct: 0 })),
      empresaProbable: d.empresa as Empresa, personaAsociada: d.titular, confianza: "alta",
      razon: `Soporte: declaración de gastos sin soporte firmada por ${d.titular} (${d.nombreArchivo}). Al crear el gasto se propone la conciliación con sus ${d.cargos.length} cargo(s) del banco ya localizados.`,
    },
    conciliacionPlanificada: planificada,
  });
  } catch (error) {
    await unlink(firmada.rutaLocal).catch(() => undefined);
    throw error;
  }
  if (salida !== "propuesta_enviada" && salida !== "propuesta_pendiente_existente") {
    // La propuesta no llegó a mostrarse con botones (duplicado o datos pendientes): no se marca nada y se explica.
    await unlink(firmada.rutaLocal).catch(() => undefined);
    const motivo = salida === "propuesta_duplicada"
      ? "Holded ya tiene este gasto o uno igual (ver el aviso de arriba): pide «aplica la declaración firmada» otra vez para conciliarlo con la compra existente"
      : "el gasto quedó pendiente de datos (ver el aviso de arriba); resuélvelo y pide «aplica la declaración firmada» otra vez";
    return { modo: "bloqueado", bloqueos: [motivo] };
  }
  await marcarAplicada(d, "", plan.cargos, "propuesto", `gasto único de ${plan.total.toFixed(2)} ${plan.moneda} propuesto con la conciliación de ${plan.cargos.length} cargo(s) planificada (${salida})`);
  return { modo: "gasto_propuesto", cargos: plan.cargos.length, salida };
}

/** Al completarse un plan múltiple originado por una declaración (botón «Confirmar»), la declaración pasa a «aplicada». */
export async function registrarPlanCompletadoDeDeclaracion(p: PlanConciliacion): Promise<void> {
  if (p.origen?.tipo !== "declaracion") return;
  const d = await obtenerDeclaracion(p.origen.id);
  if (!d) throw new Error(`No existe la declaración ${p.origen.id}.`);
  const cargos = d.cargos.map((c) => ({ ...c, estadoSoporte: "adjuntado" as const, compraId: p.compra.id }));
  await actualizarDeclaracion(d.id, { cargos, estado: "aplicada", nota: `${d.nota ? `${d.nota} ` : ""}[${new Date().toISOString().slice(0, 10)}: plan ${p.id} completado, ${p.movimientos.length} cargo(s) conciliados con la compra ${p.compra.id}]` });
}
