import ExcelJS from "exceljs";
import JSZip from "jszip";

const MAX_CARACTERES = 120_000;

const MIMES_TEXTO = new Set([
  "application/csv",
  "application/json",
  "application/ld+json",
  "application/rtf",
  "application/sql",
  "application/xml",
  "application/yaml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/rtf",
  "text/tab-separated-values",
  "text/x-markdown",
  "text/xml",
  "text/yaml",
]);

const MIMES_EXCEL = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const MIMES_DOCX = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const MIMES_PPTX = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const MIMES_ODF = new Set([
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

function acotar(texto: string): string {
  const limpio = texto.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (limpio.length <= MAX_CARACTERES) return limpio;
  return `${limpio.slice(0, MAX_CARACTERES)}\n\n[...contenido acotado por seguridad...]`;
}

function decodificarEntidadesXml(texto: string): string {
  return texto
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function xmlATexto(xml: string): string {
  return acotar(
    decodificarEntidadesXml(
      xml
        .replace(/<w:tab\b[^>]*\/>/gi, "\t")
        .replace(/<w:br\b[^>]*\/>/gi, "\n")
        .replace(/<\/(w:p|a:p|text:p|table:table-row)>/gi, "\n")
        .replace(/<\/(w:tr|a:tr|table:table)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
    )
  );
}

function htmlATexto(html: string): string {
  return acotar(
    decodificarEntidadesXml(
      html
        .replace(/<(br|hr)\b[^>]*>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, "")
    )
  );
}

function rtfATexto(rtf: string): string {
  return acotar(
    rtf
      .replace(/\\par\b/g, "\n")
      .replace(/\\'[0-9a-f]{2}/gi, (hex) => String.fromCharCode(Number.parseInt(hex.slice(2), 16)))
      .replace(/\\[a-z]+-?\d* ?/gi, "")
      .replace(/[{}]/g, "")
  );
}

async function extraerXmlsZip(bytes: Buffer, patrones: RegExp[]): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(bytes);
  const nombres = Object.keys(zip.files)
    .filter((nombre) => patrones.some((patron) => patron.test(nombre)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (nombres.length === 0) return undefined;
  const textos: string[] = [];
  for (const nombre of nombres) {
    const entrada = zip.file(nombre);
    if (!entrada) continue;
    const contenido = xmlATexto(await entrada.async("string"));
    if (contenido) textos.push(contenido);
    if (textos.join("\n\n").length >= MAX_CARACTERES) break;
  }
  return textos.length > 0 ? acotar(textos.join("\n\n")) : undefined;
}

async function extraerExcel(bytes: Buffer): Promise<string | undefined> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const hojas: string[] = [];
  workbook.eachSheet((sheet) => {
    const filas: string[] = [`## Hoja: ${sheet.name}`];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const valores = row.values as ExcelJS.CellValue[];
      filas.push(valores.slice(1).map((valor) => {
        if (valor == null) return "";
        if (typeof valor === "object") {
          if ("text" in valor && typeof valor.text === "string") return valor.text;
          if ("result" in valor && valor.result != null) return String(valor.result);
          if ("richText" in valor && Array.isArray(valor.richText)) {
            return valor.richText.map((parte) => parte.text).join("");
          }
        }
        return String(valor);
      }).join("\t"));
    });
    hojas.push(filas.join("\n"));
  });
  return hojas.length > 0 ? acotar(hojas.join("\n\n")) : undefined;
}

function pareceTexto(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  const muestra = bytes.subarray(0, Math.min(bytes.length, 8_192));
  let imprimibles = 0;
  for (const byte of muestra) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127)) imprimibles += 1;
  }
  return imprimibles / muestra.length >= 0.9;
}

/**
 * Extrae texto sin invocar IA. Es la primera etapa barata del lector universal:
 * texto/HTML/CSV/JSON, Word moderno, Excel, PowerPoint y OpenDocument. PDF e
 * imágenes devuelven undefined para que el llamador active visión/OCR solo si
 * de verdad hace falta.
 */
export async function extraerTextoDeterminista(
  bytes: Buffer,
  mimeType: string | undefined,
  nombre: string
): Promise<string | undefined> {
  const mime = mimeType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const extension = nombre.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";

  if (mime.startsWith("text/") || MIMES_TEXTO.has(mime) || [".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".sql", ".log"].includes(extension)) {
    const texto = bytes.toString("utf-8");
    if (mime.includes("html") || extension === ".html" || extension === ".htm") return htmlATexto(texto);
    if (mime.includes("rtf") || extension === ".rtf") return rtfATexto(texto);
    return acotar(texto);
  }

  if (MIMES_EXCEL.has(mime) || extension === ".xlsx") return extraerExcel(bytes);
  if (MIMES_DOCX.has(mime) || extension === ".docx") {
    return extraerXmlsZip(bytes, [/^word\/document\.xml$/, /^word\/(header|footer)\d+\.xml$/]);
  }
  if (MIMES_PPTX.has(mime) || extension === ".pptx") {
    return extraerXmlsZip(bytes, [/^ppt\/slides\/slide\d+\.xml$/]);
  }
  if (MIMES_ODF.has(mime) || [".odt", ".ods", ".odp"].includes(extension)) {
    return extraerXmlsZip(bytes, [/^content\.xml$/]);
  }

  // Algunos proveedores etiquetan texto real como octet-stream. Solo se acepta
  // si la muestra es inequívocamente textual; nunca se interpretan binarios al azar.
  if ((!mime || mime === "application/octet-stream") && pareceTexto(bytes)) {
    return acotar(bytes.toString("utf-8"));
  }
  return undefined;
}

export function esFormatoVisual(mimeType: string | undefined): boolean {
  const mime = mimeType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  return mime === "application/pdf" || mime.startsWith("image/");
}
