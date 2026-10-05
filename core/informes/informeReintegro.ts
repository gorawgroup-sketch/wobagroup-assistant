import { existsSync } from "node:fs";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import type { CoberturaBusqueda, GastoEtiquetado } from "../holded/gastosPorEtiqueta";

/**
 * Informe ejecutivo de solicitud de reintegro: los gastos de una persona (por su etiqueta de Holded) en un periodo,
 * separados en PAGADOS en bancos y SIN PAGAR en bancos, con sus totales. Pedido de Carlos (2026-10-02) para reclamar
 * a MIMO los gastos de Nuria Ortiz. Aquí solo se calcula y se dibuja; los datos vienen de gastosPorEtiqueta.ts.
 */

export interface DatosInformeReintegro {
  empresa: string;
  persona: string;
  etiqueta: string;
  desde: string;
  hasta: string;
  destinatario?: string;
  gastos: GastoEtiquetado[];
  cobertura: CoberturaBusqueda;
  emitido?: Date;
  /** Informe solo con lo pagado en bancos: sin la tarjeta, columna ni sección de «sin pagar». */
  soloPagados?: boolean;
  /** Proveedores excluidos a petición (se cobran por separado), tal como los dijo el operador; solo para la nota. */
  exclusiones?: string[];
}

const ETIQUETAS_CATEGORIA: Array<[RegExp, string]> = [
  [/^(avion|vuelo|vuelos)$/, "Avión"],
  [/^(hospedaje|alojamiento|hotel)$/, "Hospedaje"],
  [/^(alimentacion|comida|restaurante)$/, "Alimentación"],
  [/^(taxi|uber|bolt|cabify)$/, "Taxi"],
  [/^(tren|metro|bus)$/, "Tren y transporte público"],
  [/^(parking|peaje|peajes)$/, "Parking y peajes"],
  [/^(renting|alquilercoche|coche)$/, "Vehículo (renting / alquiler)"],
  [/^(combustible|gasolina)$/, "Combustible"],
  [/^transporte$/, "Transporte"],
];

const normalizar = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Categoría del gasto a partir de sus etiquetas (la más específica gana; «transporte» solo si no hay otra). */
export function categoriaDeGasto(tags: string[]): string {
  const normalizadas = tags.map(normalizar);
  for (const [patron, nombre] of ETIQUETAS_CATEGORIA) if (normalizadas.some((t) => patron.test(t))) return nombre;
  return "Otros";
}

export interface ResumenReintegro {
  pagados: GastoEtiquetado[];
  sinPagar: GastoEtiquetado[];
  moneda: string;
  totalPagado: number;
  /** Lo que todavía no ha salido del banco (saldo pendiente de los gastos no pagados o pagados a medias). */
  totalSinPagar: number;
  total: number;
  porCategoria: Array<{ categoria: string; cantidad: number; pagado: number; sinPagar: number; total: number }>;
  /** Gastos en una moneda distinta de la principal: se listan pero no se suman a los totales. */
  otrasMonedas: GastoEtiquetado[];
}

const redondear = (n: number) => Math.round(n * 100) / 100;

/**
 * Un gasto «pagado» cuenta entero como pagado. Uno «parcial» reparte: lo ya pagado va a pagado y su saldo a sin pagar.
 * Los importes en otra moneda no se mezclan en los totales.
 */
export function resumirReintegro(gastos: GastoEtiquetado[]): ResumenReintegro {
  const cuenta = new Map<string, number>();
  for (const g of gastos) cuenta.set(g.moneda, (cuenta.get(g.moneda) ?? 0) + 1);
  const moneda = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "EUR";
  const propios = gastos.filter((g) => g.moneda === moneda);
  const sinPagarDe = (g: GastoEtiquetado) => (g.estado === "pagado" ? 0 : g.estado === "parcial" ? Math.max(0, g.pendiente) : g.total);
  const categorias = new Map<string, { cantidad: number; pagado: number; sinPagar: number; total: number }>();
  for (const g of propios) {
    const c = categorias.get(categoriaDeGasto(g.tags)) ?? { cantidad: 0, pagado: 0, sinPagar: 0, total: 0 };
    c.cantidad++; c.sinPagar += sinPagarDe(g); c.pagado += g.total - sinPagarDe(g); c.total += g.total;
    categorias.set(categoriaDeGasto(g.tags), c);
  }
  const totalSinPagar = redondear(propios.reduce((s, g) => s + sinPagarDe(g), 0));
  const total = redondear(propios.reduce((s, g) => s + g.total, 0));
  return {
    pagados: propios.filter((g) => g.estado === "pagado"),
    sinPagar: propios.filter((g) => g.estado !== "pagado"),
    moneda,
    totalPagado: redondear(total - totalSinPagar),
    totalSinPagar,
    total,
    porCategoria: [...categorias.entries()]
      .map(([categoria, c]) => ({ categoria, cantidad: c.cantidad, pagado: redondear(c.pagado), sinPagar: redondear(c.sinPagar), total: redondear(c.total) }))
      .sort((a, b) => b.total - a.total),
    otrasMonedas: gastos.filter((g) => g.moneda !== moneda),
  };
}

/** 1862.99 → «1.862,99 €» (separador de miles siempre, también por debajo de 10.000). */
export const importe = (n: number, moneda = "EUR") => {
  const [entero, decimales] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decimales} ${moneda === "EUR" ? "€" : moneda}`;
};
const fechaCorta = (f: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f); return m ? `${m[3]}/${m[2]}/${m[1]}` : f; };
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** «septiembre de 2026» si el rango es un mes natural completo; si no, «01/09/2026 – 15/09/2026». */
export function describirPeriodo(desde: string, hasta: string): string {
  const d = /^(\d{4})-(\d{2})-01$/.exec(desde);
  if (d) {
    const ultimo = new Date(Date.UTC(Number(d[1]), Number(d[2]), 0)).toISOString().slice(0, 10);
    if (ultimo === hasta) return `${MESES[Number(d[2]) - 1]} de ${d[1]}`;
  }
  return `${fechaCorta(desde)} – ${fechaCorta(hasta)}`;
}

/** pdfkit con las fuentes estándar solo dibuja Latin-1: lo demás (flechas, emojis) se sustituye para no ensuciar. */
const limpio = (t: string) => t.replace(/[→➜➔]/g, "-").replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  .replace(/[^ -ÿ€]/g, "").replace(/\s+/g, " ").trim();

const COLOR = { tinta: "#14213D", gris: "#5B6472", linea: "#D9DEE5", fondo: "#F4F6F9", verde: "#1E7F4F", ambar: "#B4540A" };

/**
 * Identidad de cada empresa en sus informes: color oscuro de la cabecera y color de acento. Los logos viven en
 * `assets/marcas/<empresa>-blanco.png` (para la cabecera oscura) y `<empresa>.png`; sin logo se escribe el nombre.
 * Footprint: azul y azul noche de su logotipo (enviado por Carlos el 2026-10-02).
 */
const MARCAS: Record<string, { oscuro: string; acento: string; suave: string }> = {
  footprint: { oscuro: "#0B1C24", acento: "#0066FC", suave: "#B9D2FE" },
};
const MARCA_NEUTRA = { oscuro: "#14213D", acento: "#2F4B7C", suave: "#C9D3E6" };
const MARGEN = 40;

interface Columna { titulo: string; ancho: number; alinear?: "left" | "right"; valor: (g: GastoEtiquetado) => string }

export async function generarInformeReintegroPDF(datos: DatosInformeReintegro): Promise<Buffer> {
  const resumen = resumirReintegro(datos.gastos);
  const emitido = datos.emitido ?? new Date();
  const doc = new PDFDocument({ size: "A4", margin: MARGEN, bufferPages: true, info: { Title: `Solicitud de reintegro - ${datos.persona}`, Author: datos.empresa } });
  const trozos: Buffer[] = [];
  doc.on("data", (c: Buffer) => trozos.push(c));
  const fin = new Promise<Buffer>((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(trozos))); doc.on("error", reject); });

  const ancho = doc.page.width - MARGEN * 2;
  const pie = doc.page.height - MARGEN - 18;
  const m = resumen.moneda;

  // ---------- cabecera ----------
  const marca = MARCAS[datos.empresa.toLowerCase()] ?? MARCA_NEUTRA;
  doc.rect(0, 0, doc.page.width, 92).fill(marca.oscuro);
  doc.rect(0, 92, doc.page.width, 3).fill(marca.acento);
  const logo = join(process.cwd(), "assets", "marcas", `${datos.empresa.toLowerCase()}-blanco.png`);
  if (existsSync(logo)) doc.image(logo, MARGEN, 12, { fit: [150, 68] });
  else doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(24).text(limpio(datos.empresa).toUpperCase(), MARGEN, 32, { characterSpacing: 3 });
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(13).text("SOLICITUD DE REINTEGRO DE GASTOS", MARGEN, 32, { width: ancho, align: "right" });
  doc.font("Helvetica").fontSize(9).fillColor(marca.suave).text(`Emitido el ${fechaCorta(emitido.toISOString().slice(0, 10))}`, MARGEN, 52, { width: ancho, align: "right" });

  // ---------- datos del informe ----------
  let y = 116;
  doc.fillColor(COLOR.tinta).font("Helvetica-Bold").fontSize(18).text(limpio(datos.persona), MARGEN, y);
  y += 26;
  const ficha: Array<[string, string]> = [
    ["Periodo", describirPeriodo(datos.desde, datos.hasta)],
    ["Sociedad que soportó el gasto", datos.empresa],
    ["Se solicita el reintegro a", datos.destinatario || "-"],
    ["Fuente", `Holded (${datos.empresa}), etiqueta #${datos.etiqueta}`],
  ];
  ficha.forEach(([k, v], i) => {
    const x = MARGEN + (i % 2) * (ancho / 2), fila = y + Math.floor(i / 2) * 26;
    doc.font("Helvetica").fontSize(7.5).fillColor(COLOR.gris).text(k.toUpperCase(), x, fila, { characterSpacing: 0.6 });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COLOR.tinta).text(limpio(v), x, fila + 10, { width: ancho / 2 - 10 });
  });
  y += 62;

  // ---------- tres totales ----------
  const soloPagados = datos.soloPagados === true;
  const tarjetas: Array<[string, string, string, string]> = soloPagados
    ? [
      ["PAGADO EN BANCOS", importe(resumen.totalPagado, m), `${resumen.pagados.length} gasto(s)`, COLOR.verde],
      ["TOTAL A REINTEGRAR", importe(resumen.total, m), `${resumen.pagados.length} gasto(s)`, marca.acento],
    ]
    : [
      ["PAGADO EN BANCOS", importe(resumen.totalPagado, m), `${resumen.pagados.length} gasto(s)`, COLOR.verde],
      ["SIN PAGAR EN BANCOS", importe(resumen.totalSinPagar, m), `${resumen.sinPagar.length} gasto(s)`, COLOR.ambar],
      ["TOTAL A REINTEGRAR", importe(resumen.total, m), `${resumen.pagados.length + resumen.sinPagar.length} gasto(s)`, marca.acento],
    ];
  const anchoTarjeta = (ancho - 10 * (tarjetas.length - 1)) / tarjetas.length;
  tarjetas.forEach(([titulo, valor, detalle, color], i) => {
    const x = MARGEN + i * (anchoTarjeta + 10);
    doc.roundedRect(x, y, anchoTarjeta, 64, 5).fill(COLOR.fondo);
    doc.rect(x, y, 4, 64).fill(color);
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLOR.gris).text(titulo, x + 14, y + 10, { characterSpacing: 0.6 });
    doc.font("Helvetica-Bold").fontSize(17).fillColor(color).text(valor, x + 14, y + 23);
    doc.font("Helvetica").fontSize(8.5).fillColor(COLOR.gris).text(detalle, x + 14, y + 46);
  });
  y += 84;

  const saltoSiHaceFalta = (alto: number) => { if (y + alto > pie) { doc.addPage(); y = MARGEN; } };
  const titulo = (texto: string) => {
    saltoSiHaceFalta(60);
    doc.font("Helvetica-Bold").fontSize(11.5).fillColor(COLOR.tinta).text(texto, MARGEN, y);
    y += 17;
    doc.moveTo(MARGEN, y).lineTo(MARGEN + ancho, y).lineWidth(1.2).strokeColor(marca.acento).stroke();
    y += 8;
  };

  // ---------- resumen por categoría ----------
  titulo("Resumen por categoría");
  const colsCat = soloPagados ? [275, 80, 160] : [200, 60, 85, 85, 85];
  const cabeceraCat = soloPagados ? ["Categoría", "Gastos", "Total"] : ["Categoría", "Gastos", "Pagado", "Sin pagar", "Total"];
  const filaCat = (celdas: string[], negrita: boolean) => {
    let x = MARGEN;
    celdas.forEach((c, i) => {
      doc.font(negrita ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(COLOR.tinta)
        .text(c, x + 4, y, { width: colsCat[i] - 8, align: i === 0 ? "left" : "right" });
      x += colsCat[i];
    });
    y += 15;
  };
  doc.rect(MARGEN, y - 3, ancho, 16).fill(COLOR.fondo);
  filaCat(cabeceraCat, true);
  for (const c of resumen.porCategoria) {
    filaCat(soloPagados ? [c.categoria, String(c.cantidad), importe(c.total, m)] : [c.categoria, String(c.cantidad), importe(c.pagado, m), importe(c.sinPagar, m), importe(c.total, m)], false);
  }
  doc.moveTo(MARGEN, y - 2).lineTo(MARGEN + ancho, y - 2).lineWidth(0.6).strokeColor(COLOR.linea).stroke();
  y += 2;
  filaCat(soloPagados
    ? ["Total", String(resumen.pagados.length), importe(resumen.total, m)]
    : ["Total", String(resumen.pagados.length + resumen.sinPagar.length), importe(resumen.totalPagado, m), importe(resumen.totalSinPagar, m), importe(resumen.total, m)], true);
  y += 12;

  // ---------- tablas de detalle ----------
  const tabla = (columnas: Columna[], filas: GastoEtiquetado[], subtotal: string) => {
    const cabecera = () => {
      doc.rect(MARGEN, y - 3, ancho, 16).fill(COLOR.fondo);
      let x = MARGEN;
      for (const c of columnas) {
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLOR.gris).text(c.titulo.toUpperCase(), x + 3, y + 1, { width: c.ancho - 6, align: c.alinear ?? "left" });
        x += c.ancho;
      }
      y += 17;
    };
    cabecera();
    filas.forEach((g, n) => {
      const textos = columnas.map((c) => limpio(c.valor(g)));
      doc.font("Helvetica").fontSize(8);
      const alto = Math.max(...textos.map((t, i) => doc.heightOfString(t, { width: columnas[i].ancho - 6 }))) + 7;
      if (y + alto > pie) { doc.addPage(); y = MARGEN; cabecera(); }
      let x = MARGEN;
      textos.forEach((t, i) => {
        doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor(COLOR.tinta)
          .text(t, x + 3, y, { width: columnas[i].ancho - 6, align: columnas[i].alinear ?? "left" });
        x += columnas[i].ancho;
      });
      y += alto;
      doc.moveTo(MARGEN, y - 4).lineTo(MARGEN + ancho, y - 4).lineWidth(0.4).strokeColor(COLOR.linea).stroke();
      if (n === filas.length - 1) {
        saltoSiHaceFalta(20);
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COLOR.tinta).text(subtotal, MARGEN, y + 2, { width: ancho - 3, align: "right" });
        y += 24;
      }
    });
  };
  const recortar = (t: string, max: number) => (t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")}...` : t);
  // «[Proveedor real: X]» es una nota interna del alta del gasto; al destinatario no le aporta nada.
  const concepto = (g: GastoEtiquetado) => {
    const texto = recortar(g.descripcion.replace(/\[Proveedor real:[^\]]*\]\s*/i, "") || "-", 170);
    return g.numeroDocumento && !/^0+$/.test(g.numeroDocumento) ? `${texto} · Doc. ${g.numeroDocumento}` : texto;
  };
  const base: Columna[] = [
    { titulo: "N.º", ancho: 22, valor: () => "" },
    { titulo: "Fecha", ancho: 50, valor: (g) => fechaCorta(g.fecha) },
    { titulo: "Proveedor", ancho: 98, valor: (g) => recortar(g.proveedor, 60) },
    { titulo: "Concepto", ancho: 133, valor: concepto },
    { titulo: "Categoría", ancho: 62, valor: (g) => categoriaDeGasto(g.tags) },
  ];
  const numerar = (filas: GastoEtiquetado[], inicio: number): Columna =>
    ({ ...base[0], valor: (g) => String(inicio + filas.indexOf(g)) });

  titulo(`1. Gastos pagados en bancos (${resumen.pagados.length})`);
  if (resumen.pagados.length === 0) { doc.font("Helvetica").fontSize(9).fillColor(COLOR.gris).text("No hay gastos pagados en este periodo.", MARGEN, y); y += 22; }
  else tabla([
    numerar(resumen.pagados, 1), ...base.slice(1),
    { titulo: "Pago en banco", ancho: 88, valor: (g) => g.pagos.map((p) => `${fechaCorta(p.fecha)} · ${p.cuenta}`).join("; ") || "-" },
    { titulo: "Importe", ancho: 62, alinear: "right", valor: (g) => importe(g.total, g.moneda) },
  ], resumen.pagados, `Total pagado en bancos: ${importe(resumen.pagados.reduce((s, g) => s + g.total, 0), m)}`);

  if (!soloPagados) titulo(`2. Gastos sin pagar en bancos (${resumen.sinPagar.length})`);
  if (soloPagados) { /* sin sección de «sin pagar» */ }
  else if (resumen.sinPagar.length === 0) { doc.font("Helvetica").fontSize(9).fillColor(COLOR.gris).text("Todos los gastos del periodo están pagados.", MARGEN, y); y += 22; }
  else tabla([
    numerar(resumen.sinPagar, resumen.pagados.length + 1), ...base.slice(1),
    { titulo: "Situación", ancho: 88, valor: (g) => g.estado === "parcial" ? `Pago parcial; pendiente ${importe(g.pendiente, g.moneda)}` : "Registrado; sin cargo en banco" },
    { titulo: "Importe", ancho: 62, alinear: "right", valor: (g) => importe(g.total, g.moneda) },
  ], resumen.sinPagar, `Total de estos gastos: ${importe(resumen.sinPagar.reduce((s, g) => s + g.total, 0), m)} · pendiente en bancos: ${importe(resumen.totalSinPagar, m)}`);

  // ---------- cierre ----------
  saltoSiHaceFalta(120);
  doc.roundedRect(MARGEN, y, ancho, 58, 5).fill(marca.oscuro);
  doc.rect(MARGEN, y, 5, 58).fill(marca.acento);
  doc.font("Helvetica").fontSize(9).fillColor(marca.suave)
    .text(soloPagados
      ? `${resumen.pagados.length} gasto(s) pagados en bancos`
      : `Pagado en bancos  ${importe(resumen.totalPagado, m)}      Sin pagar en bancos  ${importe(resumen.totalSinPagar, m)}`, MARGEN + 16, y + 12);
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#FFFFFF").text(`TOTAL A REINTEGRAR  ${importe(resumen.total, m)}`, MARGEN + 16, y + 30);
  y += 72;

  const notas = [
    soloPagados
      ? "Criterio: este informe incluye únicamente los gastos pagados en bancos: los que Holded tiene sin saldo pendiente y con el pago registrado desde una cuenta bancaria."
      : "Criterio: «pagado en bancos» es el gasto que Holded tiene sin saldo pendiente y con el pago registrado desde una cuenta bancaria; «sin pagar en bancos» es el gasto registrado cuyo cargo todavía no consta.",
    ...(datos.exclusiones && datos.exclusiones.length > 0 ? [`No incluye: ${datos.exclusiones.join(", ")} (se cobra por separado).`] : []),
    `Alcance: gastos con una etiqueta de la persona (#${datos.etiqueta} y sus variantes) con fecha dentro del periodo. Se revisaron ${datos.cobertura.facturasListadas} factura(s) del periodo y ${datos.cobertura.comprasPropiasLeidas} gasto(s) registrado(s) por el asistente (incluye tickets).` +
      (datos.cobertura.lecturasFallidas > 0 ? ` ${datos.cobertura.lecturasFallidas} registro(s) no se pudieron leer en Holded y podrían faltar.` : "") +
      " Un ticket introducido a mano en Holded, fuera del asistente, puede no figurar.",
    ...(resumen.otrasMonedas.length > 0 ? [`No se suman a los totales ${resumen.otrasMonedas.length} gasto(s) en otra moneda: ` + resumen.otrasMonedas.map((g) => `${g.proveedor} ${importe(g.total, g.moneda)} (${fechaCorta(g.fecha)})`).join("; ") + "."] : []),
    "Los comprobantes de cada gasto están disponibles en un archivo aparte, numerados igual que en este informe.",
  ];
  for (const nota of notas) {
    doc.font("Helvetica").fontSize(7.8).fillColor(COLOR.gris);
    const alto = doc.heightOfString(limpio(nota), { width: ancho }) + 5;
    saltoSiHaceFalta(alto);
    doc.text(limpio(nota), MARGEN, y, { width: ancho });
    y += alto;
  }

  // ---------- pie con numeración ----------
  const paginas = doc.bufferedPageRange();
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(paginas.start + i);
    // Sin margen inferior mientras se escribe el pie: si no, pdfkit añade una página en blanco por cada línea.
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7.5).fillColor(COLOR.gris)
      .text(`${limpio(datos.empresa)} · Solicitud de reintegro · ${limpio(datos.persona)} · ${describirPeriodo(datos.desde, datos.hasta)}`, MARGEN, doc.page.height - 30, { width: ancho - 60, lineBreak: false })
      .text(`Página ${i + 1} de ${paginas.count}`, MARGEN, doc.page.height - 30, { width: ancho, align: "right", lineBreak: false });
  }
  doc.end();
  return fin;
}
