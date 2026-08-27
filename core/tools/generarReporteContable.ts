import { generarReporteContable } from "../holded/accounting";
import { generarExcelContable, generarPDFContable } from "../reportes/generarReporteContable";
import { crearPropuestaReporteContable, actualizarMessageIdReporteContable } from "../reportes/reporteContableProposalStore";
import { sendTelegramDocument, sendTelegramMessageWithButtons } from "../telegram/client";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];

function formatoFechaValido(fecha: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(fecha);
}

/**
 * Genera un balance y P&L reconstruido desde los datos contables reales de
 * Holded (ver core/holded/accounting.ts — Holded no expone un endpoint de
 * reporte oficial, esto se arma desde el plan contable + diario del
 * período) y lo entrega en Excel y PDF. Por chat, se manda directo (no
 * requiere botón — es solo responder con un archivo en el mismo chat ya
 * autorizado). Por correo, SIEMPRE pasa por una propuesta con botón de
 * aprobación, igual que cualquier otro envío de correo del sistema — nunca
 * se envía un correo real sin que una persona lo confirme.
 */
export const generarReporteContableTool: ToolDefinition = {
  name: "generar_reporte_contable",
  description:
    "Genera el balance y pérdidas y ganancias (P&L) de una empresa del grupo para un rango de fechas, " +
    "reconstruido a partir de los datos contables reales de Holded, y lo entrega en Excel y PDF. Úsala " +
    "cuando pidan el balance, el P&L, o un reporte contable/financiero. Si piden enviarlo por correo, " +
    "usa destino='correo' — eso muestra una propuesta con botón de aprobación, nunca se envía directo. " +
    "Si no dicen destino, o piden verlo/mandarlo aquí mismo, usa destino='chat'.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: EMPRESAS, description: "Empresa del grupo." },
      desde: { type: "string", description: "Fecha inicial del período, formato 'YYYY-MM-DD'." },
      hasta: { type: "string", description: "Fecha final del período, formato 'YYYY-MM-DD'." },
      destino: {
        type: "string",
        enum: ["chat", "correo"],
        description: "'chat' para mandar el archivo directo en esta conversación, 'correo' para proponer un envío por email.",
      },
      correoDestino: {
        type: "string",
        description: "Dirección de correo del destinatario — obligatorio si destino es 'correo'.",
      },
    },
    required: ["empresa", "desde", "hasta", "destino"],
  },
  handler: async (input, context) => {
    const empresa = input.empresa as Empresa;
    if (!EMPRESAS.includes(empresa)) {
      return `Error: 'empresa' debe ser una de: ${EMPRESAS.join(", ")}.`;
    }

    const desde = typeof input.desde === "string" ? input.desde : "";
    const hasta = typeof input.hasta === "string" ? input.hasta : "";
    if (!formatoFechaValido(desde) || !formatoFechaValido(hasta)) {
      return "Error: 'desde' y 'hasta' deben tener formato YYYY-MM-DD.";
    }

    const destino = input.destino === "correo" ? "correo" : "chat";
    const chatId = context?.chatId;

    if (destino === "chat") {
      if (!chatId) return "Error: no se pudo determinar el chat de Telegram donde enviar el archivo.";

      let reporte;
      try {
        reporte = await generarReporteContable(empresa, desde, hasta);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error consultando los datos contables de Holded: ${message}`;
      }

      const [excel, pdf] = await Promise.all([generarExcelContable(reporte), generarPDFContable(reporte)]);

      await sendTelegramDocument(
        chatId,
        excel.buffer,
        excel.filename,
        `Balance y P&L de ${empresa} (${desde} a ${hasta}) — reconstruido desde datos contables reales de Holded.`
      );
      await sendTelegramDocument(chatId, pdf.buffer, pdf.filename);

      return (
        `Archivos enviados en el chat: ${excel.filename} y ${pdf.filename}. Resultado aproximado del ` +
        `período: ${reporte.resultadoAproximado.toFixed(2)} EUR.`
      );
    }

    // destino === "correo"
    const correoDestino = typeof input.correoDestino === "string" ? input.correoDestino.trim() : "";
    if (!correoDestino) return "Error: falta 'correoDestino' para proponer el envío por correo.";
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram donde mostrar la propuesta.";

    const propuesta = await crearPropuestaReporteContable({ chatId, messageId: 0, empresa, desde, hasta, correoDestino });

    const texto = [
      `📊 Propuesta: enviar por correo el balance y P&L de ${empresa} (${desde} a ${hasta}) a ${correoDestino}.`,
      `El archivo se genera recién al aprobar, con los datos contables más actuales de Holded en ese momento.`,
    ].join("\n");

    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "📤 Enviar así", callback_data: `reportecontable_enviar:${propuesta.id}` },
        { text: "❌ Cancelar", callback_data: `reportecontable_cancelar:${propuesta.id}` },
      ],
    ]);

    await actualizarMessageIdReporteContable(propuesta.id, messageId);

    return "Propuesta de envío mostrada al usuario por Telegram, esperando aprobación con el botón 'Enviar así'.";
  },
};
