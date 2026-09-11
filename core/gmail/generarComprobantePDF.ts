import { existsSync } from "node:fs";
import PDFDocument from "pdfkit";
import type { DatosFactura } from "../documental/extractInvoiceData";

export interface DatosCorreoParaComprobante {
  de: string;
  asunto: string;
  fecha: string;
  cuerpoCompleto: string;
  /** HTML original ya enriquecido con las imágenes cid: del mensaje. */
  htmlOriginal?: string;
}

const MAX_PDF_HOLDED_BYTES = 9_500_000;

export function configuracionComprobanteVisual(env: NodeJS.ProcessEnv = process.env) {
  return {
    habilitado: (env.WOBI_EMAIL_VISUAL_PDF_ENABLED ?? "true").trim().toLowerCase() !== "false",
    ejecutable: env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined,
  };
}

function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Mantiene estilos, tablas, colores e imágenes data: del correo, pero
 * elimina cualquier capacidad activa o navegación. Chromium también
 * bloquea toda petición externa durante el render: un email nunca puede
 * ejecutar scripts, rastrear la apertura ni consultar la red interna.
 */
export function prepararHtmlCorreoParaPDF(correo: DatosCorreoParaComprobante): string {
  const original = correo.htmlOriginal?.trim() ?? "";
  const seguro = original
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, "")
    .replace(/<embed\b[^>]*\/?\s*>/gi, "")
    .replace(/<base\b[^>]*\/?\s*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "")
    .replace(/\s(?:on[a-z]+|href|action|formaction)\s*=\s*(["'])[^"']*\1/gi, "")
    .replace(/\s(?:on[a-z]+|href|action|formaction)\s*=\s*[^\s>]+/gi, "")
    // Las data URI provienen de las partes MIME de Gmail. El resto se
    // bloquea para impedir tracking/SSRF; quitar el src evita además el
    // icono de imagen rota en el comprobante.
    .replace(/\ssrc\s*=\s*(["'])(?!data:)[^"']*\1/gi, "")
    .replace(/\ssrc\s*=\s*(?!["'])(?!data:)[^\s>]+/gi, "");

  const cabecera = `
    <section class="wobi-correo-origen" aria-label="Datos del correo original">
      <div class="wobi-correo-marca">Correo original</div>
      <div><strong>De:</strong> ${escaparHtml(correo.de)}</div>
      <div><strong>Asunto:</strong> ${escaparHtml(correo.asunto)}</div>
      <div><strong>Fecha:</strong> ${escaparHtml(correo.fecha)}</div>
    </section>`;
  const estilos = `
    <style id="wobi-pdf-style">
      @page { size: A4; margin: 10mm; }
      html, body { background: #fff !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      body { margin: 0 !important; min-width: 0 !important; }
      .wobi-correo-origen {
        box-sizing: border-box; margin: 0 auto 18px; padding: 12px 14px;
        max-width: 760px; border: 1px solid #d8dee8; border-radius: 8px;
        background: #f7f9fc; color: #202632; font: 12px/1.45 Arial, Helvetica, sans-serif;
        break-inside: avoid;
      }
      .wobi-correo-origen div { margin: 2px 0; overflow-wrap: anywhere; }
      .wobi-correo-origen .wobi-correo-marca {
        margin: 0 0 6px; color: #526174; font-size: 10px; font-weight: 700;
        letter-spacing: .08em; text-transform: uppercase;
      }
      img { max-width: 100% !important; }
      img:not([src]) { display: none !important; }
      table { max-width: 100% !important; }
      /* Gmail puede eliminar reglas de clase del remitente y dejar solo el
         fondo oscuro inline. En ese caso Chromium vuelve negro el texto
         heredado; esta regla conserva el contraste visual del comprobante. */
      [style*="background:#000"], [style*="background: #000"],
      [style*="background-color:#000"], [style*="background-color: #000"],
      [bgcolor="#000"], [bgcolor="#000000"] { color: #fff !important; }
      [style*="background:#000"] *, [style*="background: #000"] *,
      [style*="background-color:#000"] *, [style*="background-color: #000"] *,
      [bgcolor="#000"] *, [bgcolor="#000000"] * { color: #fff !important; }
      a { color: inherit !important; text-decoration: none !important; pointer-events: none !important; }
    </style>`;

  let documento = seguro;
  if (/<\/head\s*>/i.test(documento)) documento = documento.replace(/<\/head\s*>/i, `${estilos}</head>`);
  else if (/<html\b[^>]*>/i.test(documento)) documento = documento.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${estilos}</head>`);
  else documento = `<html><head>${estilos}</head><body>${documento}</body></html>`;

  if (/<body\b[^>]*>/i.test(documento)) {
    documento = documento.replace(/<body\b[^>]*>/i, (tag) => `${tag}${cabecera}`);
  } else {
    documento = documento.replace(/<\/head\s*>/i, `</head><body>${cabecera}`).replace(/<\/html\s*>/i, "</body></html>");
  }
  return documento;
}

async function rutaChrome(configurada?: string): Promise<{ executablePath: string; args: string[] }> {
  if (configurada) return { executablePath: configurada, args: ["--no-sandbox", "--disable-dev-shm-usage"] };

  if (process.platform === "darwin") {
    const candidatas = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    const encontrada = candidatas.find(existsSync);
    if (encontrada) return { executablePath: encontrada, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
  }

  const { default: chromium } = await import("@sparticuz/chromium");
  return { executablePath: await chromium.executablePath(), args: chromium.args };
}

async function generarComprobanteVisualPDF(correo: DatosCorreoParaComprobante): Promise<Buffer> {
  const { default: puppeteer } = await import("puppeteer-core");
  const config = configuracionComprobanteVisual();
  const chrome = await rutaChrome(config.ejecutable);
  const browser = await puppeteer.launch({
    executablePath: chrome.executablePath,
    args: chrome.args,
    headless: true,
    defaultViewport: { width: 1280, height: 1600, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(15_000);
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const protocolo = (() => {
        try { return new URL(request.url()).protocol; } catch { return ""; }
      })();
      const permitido = protocolo === "data:" || protocolo === "about:";
      void (permitido ? request.continue() : request.abort()).catch(() => undefined);
    });
    await page.emulateMediaType("screen");
    await page.setContent(prepararHtmlCorreoParaPDF(correo), { waitUntil: "domcontentloaded", timeout: 15_000 });
    // evaluate espera automáticamente la Promise devuelta por fonts.ready;
    // se usa una expresión string porque el proyecto Node no incluye tipos DOM.
    await page.evaluate("document.fonts && document.fonts.ready");
    const pdf = Buffer.from(await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
      timeout: 20_000,
    }));
    if (pdf.length > MAX_PDF_HOLDED_BYTES) {
      throw new Error(`El PDF visual supera el límite seguro para Holded (${pdf.length} bytes).`);
    }
    return pdf;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function generarComprobanteTextoPDF(
  correo: DatosCorreoParaComprobante,
  extraido: DatosFactura
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(14).text("Comprobante generado a partir del cuerpo de un correo", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor("#666").text(
      "El correo no contenía HTML visual utilizable; este documento conserva su texto completo como respaldo del gasto."
    );
    doc.moveDown();
    doc.fontSize(10).fillColor("#000");
    doc.text(`De: ${correo.de}`);
    doc.text(`Asunto: ${correo.asunto}`);
    doc.text(`Fecha del correo: ${correo.fecha}`);
    doc.moveDown();
    doc.fontSize(11).text("Datos del gasto:", { underline: true });
    doc.fontSize(10);
    if (extraido.proveedor) doc.text(`Proveedor: ${extraido.proveedor}`);
    doc.text(`Monto: ${extraido.monto} ${extraido.moneda}`);
    if (extraido.montoEquivalente !== undefined && extraido.monedaEquivalente) {
      doc.text(`Monto equivalente: ${extraido.montoEquivalente} ${extraido.monedaEquivalente}`);
    }
    if (extraido.fecha) doc.text(`Fecha del gasto: ${extraido.fecha}`);
    if (extraido.concepto) doc.text(`Concepto: ${extraido.concepto}`);
    doc.moveDown();
    doc.fontSize(11).text("Cuerpo completo del correo original:", { underline: true });
    doc.fontSize(9).fillColor("#333").text(correo.cuerpoCompleto || "(vacío)");
    doc.end();
  });
}

/**
 * Genera un comprobante fiel desde el HTML original. El PDF de texto se
 * conserva como respaldo reversible para correos sin HTML o si Chromium no
 * puede arrancar; nunca se pierde el soporte por un fallo visual.
 */
export async function generarComprobantePDF(correo: DatosCorreoParaComprobante, extraido: DatosFactura): Promise<Buffer> {
  if (configuracionComprobanteVisual().habilitado && correo.htmlOriginal?.trim()) {
    try {
      return await generarComprobanteVisualPDF(correo);
    } catch (error) {
      console.error(
        "[generarComprobantePDF] Falló el render visual seguro; se conserva el PDF de texto como respaldo:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return generarComprobanteTextoPDF(correo, extraido);
}
