import JSZip from "jszip";
import type { Empresa } from "../holded/client";
import { buscarGastosDeEtiqueta, type CoberturaBusqueda, type GastoEtiquetado } from "../holded/gastosPorEtiqueta";
import { descargarAdjuntosCompraHolded } from "../holded/write";
import { answerCallbackQuery, sendTelegramDocument, sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import { describirPeriodo, generarInformeReintegroPDF, importe, resumirReintegro } from "./informeReintegro";
import { ajustarFiltrosAlBoton, codificarFiltros, decodificarFiltros, normalizarExclusiones, prepararGastosReintegro } from "./filtrosReintegro";

/**
 * Entrega por Telegram del informe de reintegro (informeReintegro.ts) y de sus comprobantes. Todo es de solo lectura
 * en Holded: no crea, edita ni concilia nada.
 */

const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];
/** Telegram admite documentos de hasta 50 MB por bot: cada ZIP se queda por debajo. */
const MAX_BYTES_ZIP = 44 * 1024 * 1024;

const paraArchivo = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const etiquetaCompacta = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);

/** Mes «2026-09» → primer y último día. undefined si no es un mes válido. */
export function rangoDeMes(mes: string): { desde: string; hasta: string } | undefined {
  const m = /^(\d{4})-(\d{2})$/.exec(mes.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return undefined;
  return { desde: `${m[1]}-${m[2]}-01`, hasta: new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10) };
}

/** El mismo orden y numeración que el informe: primero los pagados, después los no pagados. */
export function gastosNumerados(gastos: GastoEtiquetado[]): Array<{ numero: number; gasto: GastoEtiquetado }> {
  const r = resumirReintegro(gastos);
  return [...r.pagados, ...r.sinPagar].map((gasto, i) => ({ numero: i + 1, gasto }));
}

export function nombreComprobante(numero: number, gasto: GastoEtiquetado, original: string, indice: number): string {
  const ext = (/\.([A-Za-z0-9]{2,5})$/.exec(original)?.[1] ?? "pdf").toLowerCase();
  return `${String(numero).padStart(2, "0")}_${gasto.fecha}_${paraArchivo(gasto.proveedor)}_${gasto.total.toFixed(2).replace(".", ",")}${indice > 0 ? `_${indice + 1}` : ""}.${ext}`;
}

export interface PeticionReintegro {
  empresa: Empresa;
  etiqueta: string;
  persona: string;
  desde: string;
  hasta: string;
  destinatario?: string;
  /** Solo los gastos pagados en bancos (sin la parte de «sin pagar»). */
  soloPagados?: boolean;
  /** Proveedores/palabras a excluir del informe (se cobran por separado), p. ej. «Northgate España». */
  excluir?: string[];
}

/** Genera el informe, lo envía como documento y deja el botón de comprobantes. Devuelve el resumen para el chat. */
export async function enviarInformeReintegro(chatId: number, p: PeticionReintegro): Promise<string> {
  const { gastos: encontrados, cobertura } = await buscarGastosDeEtiqueta(p.empresa, p.etiqueta, p.desde, p.hasta);
  const periodo = describirPeriodo(p.desde, p.hasta);
  if (encontrados.length === 0) {
    return `No encontré gastos de ${p.empresa} con la etiqueta de "${p.etiqueta}" en ${periodo}. ${describirCobertura(cobertura)}`;
  }
  // Los filtros viajan en el botón del ZIP: el PDF y los comprobantes usan EXACTAMENTE los mismos (misma lista y numeración).
  const baseBoton = `reintegrozip:${p.empresa}:${etiquetaCompacta(p.etiqueta)}:${p.desde}:${p.hasta}`;
  const filtros = ajustarFiltrosAlBoton(baseBoton, { soloPagados: p.soloPagados === true, excluir: normalizarExclusiones(p.excluir ?? []) });
  const { gastos, excluidos, omitidosSinPagar } = prepararGastosReintegro(encontrados, filtros);
  if (gastos.length === 0) {
    return `Tras aplicar los filtros no queda ningún gasto (excluidos ${excluidos.length}, sin pagar en banco ${omitidosSinPagar.length}); no se generó el informe.`;
  }
  const r = resumirReintegro(gastos);
  const pdf = await generarInformeReintegroPDF({
    ...p, gastos, cobertura, soloPagados: filtros.soloPagados, exclusiones: p.excluir?.length ? p.excluir : undefined,
  });
  const totales = filtros.soloPagados
    ? `Pagado en bancos: ${importe(r.totalPagado, r.moneda)} (${r.pagados.length} gastos) · Total a reintegrar: ${importe(r.total, r.moneda)}`
    : `Pagado en bancos: ${importe(r.totalPagado, r.moneda)} (${r.pagados.length}) · Sin pagar en bancos: ${importe(r.totalSinPagar, r.moneda)} (${r.sinPagar.length}) · Total: ${importe(r.total, r.moneda)} (${r.pagados.length + r.sinPagar.length})`;
  await sendTelegramDocument(chatId, pdf, `Reintegro_${paraArchivo(p.persona)}_${paraArchivo(periodo)}.pdf`, `Solicitud de reintegro — ${p.persona} — ${periodo}\n${totales}`);
  await sendTelegramMessageWithButtons(
    chatId,
    `📎 Los comprobantes de esos ${gastos.length} gastos se pueden descargar en un archivo comprimido, numerados igual que en el informe.`,
    [[{ text: "📎 Descargar comprobantes (ZIP)", callback_data: `${baseBoton}${codificarFiltros(filtros) ? `:${codificarFiltros(filtros)}` : ""}` }]]
  );
  return (
    `Informe de reintegro enviado como PDF al chat (${p.persona}, ${periodo}, ${p.empresa}), con el botón para descargar los comprobantes. ${totales}.\n` +
    `Sin pagar en bancos: ${r.sinPagar.map((g) => `${g.proveedor} ${importe(g.total, g.moneda)} (${g.fecha})`).join("; ") || "ninguno"}.\n` +
    (excluidos.length ? `Excluidos a petición: ${excluidos.map((g) => `${g.proveedor} ${importe(g.total, g.moneda)} (${g.fecha})`).join("; ")}.\n` : "") +
    (filtros.soloPagados && omitidosSinPagar.length ? `Dejados fuera por no estar pagados en banco: ${omitidosSinPagar.map((g) => `${g.proveedor} ${importe(g.total, g.moneda)} (${g.fecha})`).join("; ")}.\n` : "") +
    `${describirCobertura(cobertura)}${r.otrasMonedas.length ? ` Hay ${r.otrasMonedas.length} gasto(s) en otra moneda que no se suman al total.` : ""}`
  );
}

export function describirCobertura(c: CoberturaBusqueda): string {
  return `Cobertura: ${c.facturasListadas} factura(s) del periodo y ${c.comprasPropiasLeidas} gasto(s) registrados por Wobi (incluye tickets)` +
    `${c.lecturasFallidas > 0 ? `; ${c.lecturasFallidas} no se pudieron leer en Holded y podrían faltar` : ""}. ` +
    `Un ticket creado a mano en Holded, fuera de Wobi, puede no aparecer.`;
}

async function answerSeguro(id: string, texto?: string): Promise<void> {
  try {
    await answerCallbackQuery(id, texto);
  } catch (error) {
    console.error("[reintegroTelegram] No se pudo responder el callback_query (no crítico):", error instanceof Error ? error.message : error);
  }
}

/** Botón «Descargar comprobantes»: reúne los adjuntos de Holded en uno o varios ZIP y los envía al chat. */
export async function handleReintegroZipCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.message?.chat.id;
  const [, empresa, etiqueta, desde, hasta, segmentoFiltros] = (callback.data ?? "").split(":");
  if (!chatId || !EMPRESAS.includes(empresa as Empresa) || !etiqueta || !/^\d{4}-\d{2}-\d{2}$/.test(desde ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(hasta ?? "")) {
    await answerSeguro(callback.id, "Petición no válida.");
    return;
  }
  await answerSeguro(callback.id, "Reuniendo comprobantes...");
  await sendTelegramMessage(chatId, "🔄 Reuniendo los comprobantes desde Holded; puede tardar un par de minutos...");
  try {
    const { gastos: encontrados } = await buscarGastosDeEtiqueta(empresa as Empresa, etiqueta, desde, hasta);
    // Mismos filtros y misma preparación que el informe (vienen en el botón): la numeración coincide con la del PDF.
    const { gastos } = prepararGastosReintegro(encontrados, decodificarFiltros(segmentoFiltros));
    const numerados = gastosNumerados(gastos);
    const sinComprobante: string[] = [];
    const fallidos: string[] = [];
    const lotes: Array<{ zip: JSZip; bytes: number; archivos: number }> = [{ zip: new JSZip(), bytes: 0, archivos: 0 }];
    for (const { numero, gasto } of numerados) {
      const rotulo = `${numero}. ${gasto.proveedor} ${importe(gasto.total, gasto.moneda)} (${gasto.fecha})`;
      try {
        const adjuntos = await descargarAdjuntosCompraHolded(empresa as Empresa, gasto.id);
        if (adjuntos.length === 0) { sinComprobante.push(rotulo); continue; }
        adjuntos.forEach((a, i) => {
          let lote = lotes[lotes.length - 1];
          if (lote.archivos > 0 && lote.bytes + a.bytes.length > MAX_BYTES_ZIP) { lote = { zip: new JSZip(), bytes: 0, archivos: 0 }; lotes.push(lote); }
          lote.zip.file(nombreComprobante(numero, gasto, a.nombreArchivo, i), a.bytes);
          lote.bytes += a.bytes.length; lote.archivos++;
        });
      } catch (error) {
        console.error(`[reintegroTelegram] No se pudo descargar el comprobante del gasto ${gasto.id}:`, error instanceof Error ? error.message : error);
        fallidos.push(rotulo);
      }
    }
    const conArchivos = lotes.filter((l) => l.archivos > 0);
    const base = `Comprobantes_${paraArchivo(etiqueta)}_${desde}_a_${hasta}`;
    for (const [i, lote] of conArchivos.entries()) {
      const buffer = await lote.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      await sendTelegramDocument(chatId, buffer, `${base}${conArchivos.length > 1 ? `_parte${i + 1}` : ""}.zip`,
        `Comprobantes ${conArchivos.length > 1 ? `(parte ${i + 1} de ${conArchivos.length}) ` : ""}— ${lote.archivos} archivo(s), numerados como en el informe.`);
    }
    const total = conArchivos.reduce((s, l) => s + l.archivos, 0);
    await sendTelegramMessage(chatId, [
      total > 0 ? `✅ Enviados ${total} comprobante(s) de ${numerados.length} gasto(s).` : "⚠️ Ninguno de esos gastos tiene comprobante adjunto en Holded.",
      sinComprobante.length ? `Sin comprobante en Holded:\n${sinComprobante.map((s) => `• ${s}`).join("\n")}` : "",
      fallidos.length ? `No se pudieron descargar (vuelve a pulsar el botón para reintentar):\n${fallidos.map((s) => `• ${s}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[reintegroTelegram] Error reuniendo los comprobantes:", message);
    await sendTelegramMessage(chatId, `⚠️ No pude reunir los comprobantes: ${message.slice(0, 300)}. El botón sigue disponible para reintentarlo.`);
  }
}
