import type { DatosFacturaVenta } from "../documental/extractInvoiceData";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import { textosParecidos } from "../utils/textoParecido";
import { parsearImporteCashflow } from "../cashflow/parseoImportes";
import { fetchDetalleRegistros, type DetalleRegistro } from "./cashflowSheet";
import {
  actualizarMessageIdRegistroManualCashflow,
  crearPendienteRegistroManualCashflow,
  type CorreoDeRegistroCashflow,
} from "./pendienteRegistroManualCashflowStore";
import { botonesRegistroManualCashflow } from "./registroManualCashflowDestino";

/**
 * Facturas de VENTA que llegan por correo (pedido de Carlos, 2026-10-02): se lee el importe y el vencimiento, se
 * propone la fila en INGRESOS del cashflow en la semana del vencimiento —para ver cuándo entrará ese dinero— y, al
 * aprobarla, se responde a quien la envió. Nada se escribe ni se envía sin el botón: reutiliza la propuesta de
 * registro manual (registroManualCashflowCallbackHandler.ts).
 */

/** Semana ISO de una fecha YYYY-MM-DD, con la etiqueta que usa la hoja («S41»). */
export function semanaIsoDe(fecha: string): { etiqueta: string; semana: number; anio: number } | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha.trim());
  if (!m) return undefined;
  const dia = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(dia.getTime()) || dia.getUTCMonth() !== Number(m[2]) - 1) return undefined;
  // El jueves de la misma semana decide a qué año ISO pertenece.
  const jueves = new Date(dia);
  jueves.setUTCDate(dia.getUTCDate() + 4 - (dia.getUTCDay() || 7));
  const anio = jueves.getUTCFullYear();
  const semana = Math.ceil(((jueves.getTime() - Date.UTC(anio, 0, 1)) / 86_400_000 + 1) / 7);
  return { etiqueta: `S${String(semana).padStart(2, "0")}`, semana, anio };
}

const fechaLarga = (fecha: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : fecha;
};

export interface PlanIngresoFactura {
  empresa: "WOBA" | "EWORKS";
  cliente: string;
  proyecto: string;
  semana: string;
  valor: number;
  /** Fecha usada para calcular la semana y de dónde salió. */
  fechaSemana: string;
  origenFecha: "vencimiento" | "factura" | "hoy";
  avisos: string[];
}

/** Decide qué fila se propone. undefined si la factura no es de WOBA ni de eWorks (el cashflow solo cubre esas dos). */
export function planificarIngresoDeFactura(factura: DatosFacturaVenta, hoy: Date = new Date()): PlanIngresoFactura | undefined {
  if (factura.empresa !== "WOBA" && factura.empresa !== "EWORKS") return undefined;
  const hoyIso = hoy.toISOString().slice(0, 10);
  const candidatas: Array<[string, PlanIngresoFactura["origenFecha"]]> = [
    [factura.fechaVencimiento, "vencimiento"], [factura.fechaFactura, "factura"], [hoyIso, "hoy"],
  ];
  const [fechaSemana, origenFecha] = candidatas.find(([fecha]) => semanaIsoDe(fecha)) as [string, PlanIngresoFactura["origenFecha"]];
  const semana = semanaIsoDe(fechaSemana)!;
  const avisos: string[] = [];
  if (origenFecha === "factura") avisos.push("La factura no indica vencimiento ni plazo de pago: uso la semana de su fecha de emisión. Si se cobra más tarde, dime la semana correcta.");
  if (origenFecha === "hoy") avisos.push("No pude leer ninguna fecha en la factura: uso la semana actual. Dime la semana correcta si es otra.");
  if (semana.anio !== hoy.getUTCFullYear()) avisos.push(`El vencimiento cae en ${semana.anio}: la hoja solo guarda «${semana.etiqueta}», sin año; el vencimiento completo queda escrito en la columna de proyecto.`);
  if (factura.moneda !== "EUR") avisos.push(`La factura está en ${factura.moneda}: se registra ese importe tal cual (la hoja no convierte monedas) y la moneda queda indicada en la fila.`);
  const proyecto = [
    factura.numero ? `Factura ${factura.numero}` : "Factura",
    origenFecha === "vencimiento" ? `vence ${fechaLarga(fechaSemana)}` : "",
    factura.moneda !== "EUR" ? factura.moneda : "",
  ].filter(Boolean).join(" · ");
  return { empresa: factura.empresa, cliente: factura.cliente, proyecto, semana: semana.etiqueta, valor: factura.total, fechaSemana, origenFecha, avisos };
}

/** Fila de ingresos que ya parece ser esta misma factura (mismo importe y su número, o el mismo cliente y semana). */
export function ingresoYaRegistrado(registros: DetalleRegistro[], plan: PlanIngresoFactura, numero: string): DetalleRegistro | undefined {
  return registros.find((r) =>
    r.categoria === "INGRESOS" && Math.abs(parsearImporteCashflow(r.valor) - plan.valor) <= 0.01 &&
    ((numero && (r.proyecto ?? "").includes(numero)) ||
      (textosParecidos(r.cliente ?? "", plan.cliente) && r.semana.toUpperCase().replace(/^S0?/, "S") === plan.semana.replace(/^S0?/, "S"))));
}

export function textoRespuestaFacturaProcesada(factura: DatosFacturaVenta, plan: PlanIngresoFactura): string {
  const cuando = plan.origenFecha === "vencimiento" ? `, con vencimiento el ${fechaLarga(plan.fechaSemana)}` : "";
  return `Hola,\n\nLa factura${factura.numero ? ` ${factura.numero}` : ""} de ${plan.empresa === "EWORKS" ? "eWorks" : "WOBA"} a ${factura.cliente} por ` +
    `${factura.total.toFixed(2)} ${factura.moneda}${cuando} ya fue leída y procesada: su importe está registrado en el cashflow, ` +
    `en ingresos de la semana ${plan.semana.replace(/^S/, "")}.\n\nUn saludo.`;
}

export interface EntradaFacturaVenta {
  chatId: number;
  factura: DatosFacturaVenta;
  nombreArchivo: string;
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string; mensajeIdGmail?: string; partId?: string; deColaCorreo?: boolean };
  notaAdjunto?: string;
}

/**
 * Publica la propuesta con botones. Devuelve false cuando no corresponde (empresa fuera del cashflow): quien llama
 * sigue con el archivado normal.
 */
export async function proponerIngresoDesdeFacturaVenta(entrada: EntradaFacturaVenta): Promise<boolean> {
  const plan = planificarIngresoDeFactura(entrada.factura);
  if (!plan) return false;
  const { factura } = entrada;

  // Aviso, no bloqueo: si la lectura de la hoja falla se propone igual y se dice que no se pudo comprobar.
  let avisoDuplicado = "";
  try {
    const previo = ingresoYaRegistrado(await fetchDetalleRegistros(), plan, factura.numero);
    if (previo) avisoDuplicado = `\n⚠️ En Ingresos ya hay una fila que parece esta misma factura: «${previo.cliente ?? ""}» — ${previo.semana}, ${previo.valor}. Confirma solo si es otra.`;
  } catch (error) {
    console.error("[ingresoDesdeFacturaVenta] No se pudo comprobar si el ingreso ya estaba registrado:", error instanceof Error ? error.message : error);
    avisoDuplicado = "\n⚠️ No pude comprobar si esta factura ya estaba en Ingresos; revísalo antes de confirmar.";
  }

  const resumen = `${plan.cliente} — ${plan.proyecto} — semana ${plan.semana}, ${plan.valor.toFixed(2)} (bloque "ingresos")`;
  const correo: CorreoDeRegistroCashflow | undefined = entrada.correoOrigen
    ? { ...entrada.correoOrigen, textoRespuesta: textoRespuestaFacturaProcesada(factura, plan) }
    : undefined;
  const pendiente = await crearPendienteRegistroManualCashflow({
    chatId: entrada.chatId, messageId: 0, empresa: plan.empresa, bloque: "ingresos", clienteOConcepto: plan.cliente,
    proyecto: plan.proyecto, semana: plan.semana, valor: plan.valor, resumen, correo,
  });

  const texto = [
    entrada.notaAdjunto ?? "",
    `💶 **Factura de venta** — ${plan.empresa === "EWORKS" ? "eWorks" : "WOBA"} factura a ${factura.cliente}`,
    `Nº ${factura.numero || "(sin número)"} · total ${factura.total.toFixed(2)} ${factura.moneda}` +
      `${factura.fechaFactura ? ` · emitida ${fechaLarga(factura.fechaFactura)}` : ""}` +
      `${factura.fechaVencimiento ? ` · vence ${fechaLarga(factura.fechaVencimiento)}` : ""}`,
    factura.concepto ? `Concepto: ${factura.concepto}` : "",
    "",
    `Propuesta: registrarla en **Ingresos** del cashflow, semana **${plan.semana}** ` +
      `(${plan.origenFecha === "vencimiento" ? "la del vencimiento" : plan.origenFecha === "factura" ? "la de la fecha de emisión" : "la actual"}, ${fechaLarga(plan.fechaSemana)}). Crea una fila nueva; no toca ninguna existente.`,
    ...plan.avisos.map((a) => `ℹ️ ${a}`),
    avisoDuplicado.trim(),
    correo ? `\nCon «registrar y responder», contesto a ${correo.de} que la factura ya está leída y su importe en el cashflow.` : "",
  ].filter((linea, i, todas) => linea !== "" || (i > 0 && todas[i - 1] !== "")).join("\n");

  const botones = [
    ...(correo ? [[{ text: "✅ Registrar en Ingresos y responder al remitente", callback_data: `regmanualcf_confirmar:${pendiente.id}:ingresos:responder` }]] : []),
    ...botonesRegistroManualCashflow(pendiente.id, "ingresos", true),
  ];
  const messageId = await sendTelegramMessageWithButtons(entrada.chatId, texto, botones);
  await actualizarMessageIdRegistroManualCashflow(pendiente.id, messageId);
  return true;
}
