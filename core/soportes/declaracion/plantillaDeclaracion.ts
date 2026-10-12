import JSZip from "jszip";

/**
 * Rellena la plantilla «GASTOS SIN SOPORTE» de una empresa (docx de Drive) con la persona, su cargo y la relación de cargos
 * sin comprobante. Lógica pura sobre el XML del documento: sin IA, sin red. La plantilla (ver plantillas.ts) trae los
 * marcadores «[NOMBRE Y APELLIDOS]» (título y firma) y «[CARGO]», una tabla FECHA/LUGAR/VALOR con filas vacías y un
 * párrafo «TOTAL 0,00€». Caso real: German Robles (eWorks), 12-10-2026, cuatro cargos sin soporte.
 */
export interface LineaDeclaracion { fecha: string; lugar: string; valor: number }
export interface DatosDeclaracion { nombre: string; cargo: string; moneda?: string; lineas: LineaDeclaracion[] }

const escapar = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const importe = (n: number): string => `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}€`;
export const fechaCorta = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);
const RUN = (texto: string) =>
  `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${escapar(texto)}</w:t></w:r>`;

/** Mete un texto en la primera celda-párrafo de cada <w:tc> de la fila (plantilla de fila vacía). */
function filaConValores(filaPlantilla: string, valores: string[]): string {
  let i = 0;
  return filaPlantilla.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (celda) => {
    const texto = valores[i++] ?? "";
    // Primer párrafo de la celda: se le añade un run con el texto antes de cerrar el párrafo.
    return celda.replace(/<\/w:p>/, `${RUN(texto)}</w:p>`);
  });
}

export function rellenarDocumentoXml(xml: string, d: DatosDeclaracion): string {
  if (!d.lineas.length) throw new Error("La declaración necesita al menos un cargo.");
  let salida = xml.replace(/\[NOMBRE Y APELLIDOS\]/g, escapar(d.nombre)).replace(/\[CARGO\]/g, escapar(d.cargo));
  const filas = salida.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? [];
  if (filas.length < 2) throw new Error("La plantilla no tiene la tabla FECHA/LUGAR/VALOR esperada.");
  const [cabecera, plantillaFila, ...resto] = filas;
  const nuevas = d.lineas.map((l) => filaConValores(plantillaFila, [fechaCorta(l.fecha), l.lugar, importe(l.valor)]));
  // Se sustituye el bloque de filas de datos (plantilla + sobrantes) por las filas reales, conservando la cabecera.
  const inicio = salida.indexOf(plantillaFila);
  const ultimaVieja = resto.length ? resto[resto.length - 1] : plantillaFila;
  const fin = salida.indexOf(ultimaVieja, inicio) + ultimaVieja.length;
  salida = salida.slice(0, inicio) + nuevas.join("") + salida.slice(fin);
  const total = d.lineas.reduce((s, l) => s + l.valor, 0);
  if (!/TOTAL\s+0,00€/.test(salida)) throw new Error("La plantilla no tiene el párrafo «TOTAL 0,00€» esperado.");
  salida = salida.replace(/(TOTAL\s+)0,00€/, `$1${escapar(importe(total))}`);
  void cabecera;
  return salida;
}

/** Devuelve el docx rellenado (bytes) a partir de la plantilla (bytes). */
export async function rellenarPlantillaDeclaracion(plantilla: Buffer, d: DatosDeclaracion): Promise<Buffer> {
  const zip = await JSZip.loadAsync(plantilla);
  const archivo = zip.file("word/document.xml");
  if (!archivo) throw new Error("La plantilla no es un documento Word válido (falta word/document.xml).");
  const xml = await archivo.async("string");
  zip.file("word/document.xml", rellenarDocumentoXml(xml, d));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
