import type { Empresa } from "../holded/client";
import { enviarInformeReintegro, rangoDeMes } from "../informes/reintegroTelegram";
import type { ToolDefinition } from "./types";

/**
 * Informe de reintegro de los gastos de una persona o proyecto (por su etiqueta de Holded) en un periodo. Pedido de
 * Carlos (2026-10-02): reclamar a MIMO los gastos de Nuria Ortiz con listado, totales de pagado y sin pagar en bancos
 * y los comprobantes descargables, todo desde Telegram.
 */
export const informeReintegroGastosTool: ToolDefinition = {
  name: "generar_informe_reintegro_gastos",
  description:
    "Genera y ENVÍA al chat un informe PDF ejecutivo de solicitud de reintegro con los gastos de una persona o " +
    "proyecto (por su etiqueta/hashtag de Holded) en un periodo: listado completo (fecha, proveedor, concepto, " +
    "categoría, pago en banco, importe), separado en PAGADOS en bancos y SIN PAGAR en bancos, con total pagado, total " +
    "sin pagar y total general, más un botón para descargar todos los comprobantes en un ZIP. Incluye los tickets, que " +
    "el listado normal de Holded no devuelve. Úsala cuando pidan los gastos de alguien para reclamarlos o refacturarlos " +
    "a otra empresa («gastos de Nuria de septiembre para pedir el reintegro a MIMO»), o un informe/listado descargable " +
    "de los gastos de una persona o proyecto. Para una consulta rápida sin documento usa " +
    "buscar_gastos_por_etiqueta_holded. Solo lee Holded; no crea ni modifica nada.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa cuyo Holded se consulta (la que soportó los gastos)." },
      etiqueta: { type: "string", description: "Etiqueta/hashtag de la persona o proyecto, sin #. Basta el nombre: 'nuria' encuentra también 'nuriaortiz'." },
      persona: { type: "string", description: "Nombre que aparece en el informe (ej. 'Nuria Ortiz'). Si se omite se usa la etiqueta." },
      mes: { type: "string", description: "Mes natural en formato YYYY-MM (ej. '2026-09'). Usa esto o desde/hasta." },
      desde: { type: "string", description: "Inicio del periodo YYYY-MM-DD, si no es un mes natural." },
      hasta: { type: "string", description: "Fin del periodo YYYY-MM-DD, si no es un mes natural." },
      destinatario: { type: "string", description: "Empresa a la que se pide el reintegro (ej. 'MIMO'). Opcional." },
    },
    required: ["empresa", "etiqueta"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram al que enviar el informe.";
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    const etiqueta = typeof input.etiqueta === "string" ? input.etiqueta.replace(/^#/, "").trim() : "";
    if (!etiqueta) return "Error: falta 'etiqueta'.";
    const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const rango = texto(input.mes) ? rangoDeMes(texto(input.mes)) : undefined;
    const desde = rango?.desde ?? texto(input.desde), hasta = rango?.hasta ?? texto(input.hasta);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || desde > hasta) {
      return "Error: indica el periodo con 'mes' (YYYY-MM) o con 'desde' y 'hasta' (YYYY-MM-DD).";
    }
    return enviarInformeReintegro(chatId, {
      empresa, etiqueta, desde, hasta,
      persona: texto(input.persona) || etiqueta.charAt(0).toUpperCase() + etiqueta.slice(1),
      destinatario: texto(input.destinatario) || undefined,
    });
  },
};
