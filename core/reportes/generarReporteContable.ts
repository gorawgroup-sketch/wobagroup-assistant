import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { ReporteContable, LineaReporteContable } from "../holded/accounting";

function nombreArchivoBase(reporte: ReporteContable): string {
  return `${reporte.empresa}_balance_pyg_${reporte.desde}_a_${reporte.hasta}`;
}

function formatoMoneda(n: number): string {
  return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function agruparPorGrupo(lineas: LineaReporteContable[]): Map<string, LineaReporteContable[]> {
  const mapa = new Map<string, LineaReporteContable[]>();
  for (const l of lineas) {
    const arr = mapa.get(l.grupo) ?? [];
    arr.push(l);
    mapa.set(l.grupo, arr);
  }
  return mapa;
}

/**
 * Genera un Excel con dos pestañas (Balance y Pérdidas y Ganancias), cada
 * una agrupada por la categoría que Holded le asigna a cada cuenta. No
 * replica el formato oficial de Holded (esa exportación no existe vía API,
 * ver core/holded/accounting.ts) — es una reconstrucción a partir de los
 * datos contables reales del período.
 */
export async function generarExcelContable(reporte: ReporteContable): Promise<{ buffer: Buffer; filename: string }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Wobi";
  workbook.created = new Date();

  function construirHoja(nombre: string, lineas: LineaReporteContable[], mostrarResultado?: number) {
    const hoja = workbook.addWorksheet(nombre);
    hoja.columns = [
      { header: "Cuenta", key: "numero", width: 12 },
      { header: "Nombre", key: "nombre", width: 40 },
      { header: "Debe", key: "debe", width: 15 },
      { header: "Haber", key: "haber", width: 15 },
      { header: "Saldo (Haber-Debe)", key: "saldo", width: 18 },
    ];
    hoja.getRow(1).font = { bold: true };

    const porGrupo = agruparPorGrupo(lineas);
    for (const [grupo, filas] of porGrupo) {
      const filaGrupo = hoja.addRow({ nombre: grupo });
      filaGrupo.font = { bold: true };
      filaGrupo.getCell("nombre").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8ECF3" } };

      for (const f of filas) {
        hoja.addRow({ numero: f.numero, nombre: f.nombre, debe: f.debe, haber: f.haber, saldo: f.saldo });
      }

      const subtotal = filas.reduce((acc, f) => acc + f.saldo, 0);
      const filaSubtotal = hoja.addRow({ nombre: `Subtotal ${grupo}`, saldo: Math.round(subtotal * 100) / 100 });
      filaSubtotal.font = { italic: true };
    }

    if (mostrarResultado !== undefined) {
      hoja.addRow({});
      const filaResultado = hoja.addRow({ nombre: "RESULTADO APROXIMADO DEL PERÍODO", saldo: mostrarResultado });
      filaResultado.font = { bold: true, size: 12 };
    }
  }

  construirHoja("Balance", reporte.balance);
  construirHoja("Pérdidas y Ganancias", reporte.perdidasGanancias, reporte.resultadoAproximado);

  const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  return { buffer, filename: `${nombreArchivoBase(reporte)}.xlsx` };
}

/**
 * Genera un PDF simple (una tabla por sección) con el mismo contenido que
 * el Excel — pensado para compartir rápido, no para maquetación formal tipo
 * PGC oficial.
 */
export async function generarPDFContable(reporte: ReporteContable): Promise<{ buffer: Buffer; filename: string }> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve({ buffer: Buffer.concat(chunks), filename: `${nombreArchivoBase(reporte)}.pdf` }));
    doc.on("error", reject);

    doc.fontSize(16).font("Helvetica-Bold").text(`Balance y Pérdidas y Ganancias — ${reporte.empresa}`);
    doc.fontSize(10).font("Helvetica").text(`Período: ${reporte.desde} a ${reporte.hasta}`);
    doc
      .fontSize(8)
      .fillColor("#666666")
      .text(
        "Reconstruido a partir de los datos contables reales de Holded (no es el reporte oficial exportable " +
          "de Holded, esa función no está disponible vía API). Saldo = Haber − Debe del período."
      );
    doc.fillColor("#000000");
    doc.moveDown(1);

    function seccion(titulo: string, lineas: LineaReporteContable[], resultado?: number) {
      doc.fontSize(13).font("Helvetica-Bold").text(titulo);
      doc.moveDown(0.3);

      const porGrupo = agruparPorGrupo(lineas);
      for (const [grupo, filas] of porGrupo) {
        doc.fontSize(10).font("Helvetica-Bold").text(grupo);
        for (const f of filas) {
          doc
            .fontSize(9)
            .font("Helvetica")
            .text(`  ${f.numero} — ${f.nombre}: ${formatoMoneda(f.saldo)} EUR`, { continued: false });
        }
        const subtotal = filas.reduce((acc, f) => acc + f.saldo, 0);
        doc.fontSize(9).font("Helvetica-Oblique").text(`  Subtotal ${grupo}: ${formatoMoneda(subtotal)} EUR`);
        doc.moveDown(0.3);
      }

      if (resultado !== undefined) {
        doc.moveDown(0.3);
        doc.fontSize(11).font("Helvetica-Bold").text(`RESULTADO APROXIMADO DEL PERÍODO: ${formatoMoneda(resultado)} EUR`);
      }
      doc.moveDown(1);
    }

    seccion("Balance", reporte.balance);
    seccion("Pérdidas y Ganancias", reporte.perdidasGanancias, reporte.resultadoAproximado);

    doc.end();
  });
}
