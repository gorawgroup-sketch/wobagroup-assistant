import ExcelJS from "exceljs";
import { BUZON_SOPORTES, nombreDePila, TEXTO_HOJA_ANTES, TEXTO_HOJA_DESPUES, TEXTO_YA_ENVIADOS_CON_HOJA, totalesPorMoneda, type DatosCorreoSoportes } from "./redactarCorreoSoportes";

/**
 * Versión «con cuadro» del correo de soportes: una tabla HTML en el cuerpo (Nº, fecha, comercio, importe cargado, importe
 * en el comercio, tarjeta y una casilla de estado) y una hoja de Excel adjunta con la misma lista y una columna de estado
 * desplegable, para que quien recibe pueda llevar su propio seguimiento. La hoja es solo para su control: lo que se pide
 * de vuelta son los soportes (PDF o foto), respondiendo al correo.
 */

const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n: number): string => new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const fechaCorta = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);
const limpiarComercio = (t: string): string => t.replace(/\s+/g, " ").trim() || "(sin comercio)";

const ORDEN = (a: { fecha: string }, b: { fecha: string }): number => a.fecha.localeCompare(b.fecha);

const TH = "padding:8px 10px;background:#1f3a5f;color:#ffffff;text-align:left;font-weight:600;border:1px solid #1f3a5f;white-space:nowrap";
const TD = "padding:7px 10px;border:1px solid #d9dee5;vertical-align:top";

export function tablaCargosHtml(d: DatosCorreoSoportes): string {
  const cargos = [...d.cargos].sort(ORDEN);
  const filas = cargos.map((c, i) => {
    const fondo = i % 2 ? "background:#f5f7fa;" : "";
    const enComercio = c.monedaOriginal && c.monedaOriginal !== c.monedaCuenta ? `${fmt(c.importeOriginal)} ${esc(c.monedaOriginal)}` : "—";
    // Una celda por línea: el correo no admite líneas de más de ~1000 caracteres.
    return [`<tr style="${fondo}">`,
      `<td style="${TD};text-align:center">${i + 1}</td>`,
      `<td style="${TD};white-space:nowrap">${fechaCorta(c.fecha)}</td>`,
      `<td style="${TD}">${esc(limpiarComercio(c.comercio))}</td>`,
      `<td style="${TD};text-align:right;white-space:nowrap"><b>${fmt(Math.abs(c.total))} ${esc(c.monedaCuenta)}</b></td>`,
      `<td style="${TD};text-align:right;white-space:nowrap">${enComercio}</td>`,
      `<td style="${TD};text-align:center">${c.tarjeta4 ? `···${esc(c.tarjeta4)}` : "—"}</td>`,
      `<td style="${TD};white-space:nowrap">☐ Pendiente</td></tr>`].join("\n");
  });
  const totales = totalesPorMoneda(cargos).map((t) =>
    [`<tr style="background:#eaf0f7"><td colspan="3" style="${TD};text-align:right"><b>Total ${esc(t.moneda)}</b></td>`,
      `<td style="${TD};text-align:right;white-space:nowrap"><b>${fmt(t.total)} ${esc(t.moneda)}</b></td>`,
      `<td colspan="3" style="${TD}"></td></tr>`].join("\n"));
  return `<table style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1b2530;margin:12px 0">\n` +
    `<thead><tr>\n${["Nº", "Fecha", "Comercio", "Importe cargado", "Importe en el comercio", "Tarjeta", "Soporte"].map((h) => `<th style="${TH}">${h}</th>`).join("\n")}\n</tr></thead>\n` +
    `<tbody>\n${[...filas, ...totales].join("\n")}\n</tbody></table>`;
}

/** Cuerpo HTML completo: los mismos párrafos que el texto plano, con el cuadro en lugar de la lista. */
export function redactarCorreoSoportesHtml(d: DatosCorreoSoportes): string {
  const p = (t: string) => `<p style="font:14px/1.5 Arial,sans-serif;color:#1b2530;margin:0 0 12px">${t}</p>`;
  const recordatorio = d.yaSolicitados && d.yaSolicitados > 0
    ? p(`<i>${d.yaSolicitados === d.cargos.length ? "Todos estos cargos ya te los habíamos pedido antes" : `${d.yaSolicitados} de estos cargos ya te los habíamos pedido antes`}; los incluimos de nuevo porque seguimos sin verlos conciliados.</i>`)
    : "";
  return [
    p(`Hola, ${esc(nombreDePila(d.titular) || d.titular)}:`),
    p(`Estamos desarrollando la habilidad de nuestro asistente para mejorar la conciliación de gastos y estabilizar la contabilidad mensual de ${esc(d.empresa)}. Por esa razón te escribimos: estos son los cargos hechos con tu tarjeta entre el ${fechaCorta(d.desde)} y el ${fechaCorta(d.hasta)} que todavía no tienen su soporte conciliado en nuestra contabilidad.`),
    p(`Por favor, <b>envía la factura o el recibo de cada uno respondiendo a este correo</b> (o escribiendo a <a href="mailto:${BUZON_SOPORTES}">${BUZON_SOPORTES}</a>).`),
    d.hojaUrl ? p(esc(TEXTO_YA_ENVIADOS_CON_HOJA)) : p("Si ya los habías enviado y te los pedimos de nuevo, te agradecemos que los reenvíes: por alguna razón nuestro sistema no reconoció lo que ya mandaste. Esto no debería volver a pasar en adelante, pero por ahora te pedimos este favor. Si todavía no los has enviado, te pedimos que lo hagas."),
    recordatorio,
    tablaCargosHtml(d),
    d.hojaUrl ? p(`${esc(TEXTO_HOJA_ANTES)}<a href="${esc(d.hojaUrl)}">${esc(d.hojaUrl)}</a>${esc(TEXTO_HOJA_DESPUES)}`) : p("Te adjuntamos esta misma lista en Excel, con una columna de estado, <b>solo para tu propio control</b>: no hace falta devolverla; lo que necesitamos son los soportes."),
    p("Si un mismo comprobante cubre varias operaciones, indícanos cuáles. Si algún cargo no lo reconoces o corresponde a otra persona, cuéntanoslo para revisarlo."),
    p("Gracias por tu ayuda."),
  ].filter(Boolean).join("\n");
}

export const nombreArchivoSeguimiento = (d: Pick<DatosCorreoSoportes, "empresa" | "titular" | "hasta">): string =>
  `Seguimiento_soportes_${d.empresa}_${d.titular.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30)}_${d.hasta}.xlsx`;

/** Hoja de seguimiento: misma lista, importes numéricos, estado desplegable y totales por moneda con fórmula. */
export async function generarSeguimientoXlsx(d: DatosCorreoSoportes): Promise<Buffer> {
  const cargos = [...d.cargos].sort(ORDEN);
  const libro = new ExcelJS.Workbook();
  libro.creator = "Asistente administrativo · WOBA";
  const hoja = libro.addWorksheet("Soportes pendientes", { views: [{ state: "frozen", ySplit: 1 }] });
  hoja.columns = [
    { header: "Nº", key: "n", width: 5 },
    { header: "Fecha", key: "fecha", width: 12 },
    { header: "Comercio", key: "comercio", width: 34 },
    { header: "Importe cargado", key: "importe", width: 16 },
    { header: "Moneda", key: "moneda", width: 9 },
    { header: "Importe en el comercio", key: "original", width: 20 },
    { header: "Moneda comercio", key: "monedaOriginal", width: 16 },
    { header: "Tarjeta", key: "tarjeta", width: 9 },
    { header: "Estado del soporte", key: "estado", width: 22 },
    { header: "Fecha en que lo enviaste", key: "enviado", width: 22 },
    { header: "Comentarios", key: "comentarios", width: 38 },
  ];
  const cab = hoja.getRow(1);
  cab.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
    c.alignment = { vertical: "middle", wrapText: true };
  });
  cab.height = 30;
  cargos.forEach((c, i) => {
    const fila = hoja.addRow({
      n: i + 1,
      fecha: new Date(`${c.fecha}T00:00:00Z`),
      comercio: limpiarComercio(c.comercio),
      importe: Math.abs(c.total),
      moneda: c.monedaCuenta,
      original: c.monedaOriginal && c.monedaOriginal !== c.monedaCuenta ? c.importeOriginal : null,
      monedaOriginal: c.monedaOriginal && c.monedaOriginal !== c.monedaCuenta ? c.monedaOriginal : null,
      tarjeta: c.tarjeta4 ? `···${c.tarjeta4}` : "",
      estado: "Pendiente",
      enviado: null,
      comentarios: "",
    });
    fila.getCell("fecha").numFmt = "dd/mm/yyyy";
    fila.getCell("enviado").numFmt = "dd/mm/yyyy";
    fila.getCell("importe").numFmt = "#,##0.00";
    fila.getCell("original").numFmt = "#,##0.00";
    fila.getCell("estado").dataValidation = { type: "list", allowBlank: false, formulae: ['"Pendiente,Enviado,No lo reconozco,Es de otra persona"'] };
  });
  const ultima = cargos.length + 1;
  hoja.autoFilter = { from: "A1", to: `K${ultima}` };
  hoja.addRow([]);
  for (const t of totalesPorMoneda(cargos)) {
    const fila = hoja.addRow({ comercio: `Total ${t.moneda}`, importe: { formula: `SUMIF(E2:E${ultima},"${t.moneda}",D2:D${ultima})`, result: t.total }, moneda: t.moneda });
    fila.font = { bold: true };
    fila.getCell("importe").numFmt = "#,##0.00";
  }
  return Buffer.from(await libro.xlsx.writeBuffer());
}
