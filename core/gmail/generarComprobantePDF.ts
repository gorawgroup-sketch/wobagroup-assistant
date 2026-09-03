import PDFDocument from "pdfkit";
import type { DatosFactura } from "../documental/extractInvoiceData";

export interface DatosCorreoParaComprobante {
  de: string;
  asunto: string;
  fecha: string;
  cuerpoCompleto: string;
}

/**
 * Genera un PDF simple con los datos extraídos + el cuerpo completo del
 * correo, para usarlo como comprobante adjunto en Holded cuando el gasto no
 * traía ningún archivo real adjunto (ver extraerGastoDeCorreo.ts) — pedido
 * explícito de Carlos: "deberíamos copiar el cuerpo del correo y anexarlo
 * como un documento independiente como prueba en Holded". Nunca se inventa
 * nada: solo se listan los campos que Claude sí extrajo, y el cuerpo
 * completo real queda íntegro al final por si hace falta revisar el
 * original.
 */
export async function generarComprobantePDF(correo: DatosCorreoParaComprobante, extraido: DatosFactura): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(14).text("Comprobante generado a partir del cuerpo de un correo", { underline: true });
    doc.moveDown(0.5);
    doc
      .fontSize(9)
      .fillColor("#666")
      .text(
        "No había ningún archivo adjunto en el correo original — este documento reconstruye el contenido " +
          "relevante como respaldo del gasto."
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
    doc
      .fontSize(9)
      .fillColor("#333")
      .text(correo.cuerpoCompleto || "(vacío)");

    doc.end();
  });
}
