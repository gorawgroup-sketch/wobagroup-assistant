import { buscarDocumentosHolded } from "../holded/write";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

/**
 * Responde "¿ya está esto registrado en Holded, aunque sea sin pagar?" —
 * consulta directamente /purchases (gastos) e /invoices (ingresos), no solo
 * los movimientos bancarios reales. Nace de un caso real: dos gastos del
 * cashflow sin salida bancaria todavía que en realidad SÍ ya estaban
 * cargados en Holded como facturas pendientes de pago — antes el asistente
 * no tenía forma de distinguir "no está registrado" de "está registrado
 * pero pendiente de pago", y lo decía explícitamente en vez de adivinar.
 */
export const consultarEstadoFacturaHoldedTool: ToolDefinition = {
  name: "consultar_estado_factura_holded",
  seguraParaModoRapido: true,
  description:
    "Busca si un pago/cargo concreto YA está registrado en Holded como factura (gasto vía /purchases o " +
    "ingreso vía /invoices) — aunque todavía no se haya pagado ni tenga movimiento bancario. Para cada " +
    "coincidencia devuelve el número de documento, fecha, vencimiento, total, y cuánto está pagado vs. " +
    "pendiente. Úsala cuando pregunten '¿ya está cargada esta factura?', '¿está pendiente de pago o falta " +
    "registrarla?', o para verificar un cargo del cashflow que no aparece todavía en los movimientos " +
    "bancarios (consultar_movimientos_holded) — antes de asumir que falta registrarlo, confirma acá si ya " +
    "existe como factura pendiente. No confundir con consultar_gastos_sin_comprobante (esa verifica si " +
    "falta el PDF/recibo adjunto, no el estado de pago).",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint"],
        description: "Empresa del grupo cuyo Holded se consulta.",
      },
      contacto: {
        type: "string",
        description: "Nombre (o parte del nombre) del proveedor o cliente a buscar — coincidencia parcial, no hace falta el nombre exacto de Holded.",
      },
      monto: {
        type: "number",
        description: "Monto total aproximado de la factura, para acotar la búsqueda si hay varios documentos del mismo contacto. Opcional.",
      },
      tipo: {
        type: "string",
        enum: ["gasto", "ingreso", "ambos"],
        description: "Busca solo en gastos (/purchases), solo en ingresos (/invoices), o ambos. Opcional, por defecto 'ambos'.",
      },
      dias: {
        type: "number",
        description: "Ventana de búsqueda hacia atrás, en días. Opcional, por defecto 120 (las facturas ya cargadas pueden ser de varias semanas atrás).",
      },
    },
    required: ["empresa", "contacto"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const contacto = typeof input.contacto === "string" ? input.contacto.trim() : "";
    if (!contacto) {
      return "Error: hace falta 'contacto' (nombre o parte del nombre del proveedor/cliente a buscar).";
    }

    const monto = typeof input.monto === "number" ? input.monto : undefined;
    const tipo =
      input.tipo === "gasto" || input.tipo === "ingreso" || input.tipo === "ambos"
        ? input.tipo
        : "ambos";
    const dias = typeof input.dias === "number" && input.dias > 0 ? input.dias : undefined;

    const resultados = await buscarDocumentosHolded(empresa, { contacto, monto, tipo, dias });

    if (resultados.length === 0) {
      const montoTexto = monto !== undefined ? ` con monto cercano a ${monto.toFixed(2)} €` : "";
      return (
        `No encontré ninguna factura de "${contacto}"${montoTexto} en Holded (${empresa}) en la ventana ` +
        `buscada — parece que todavía no se ha registrado, no solo que falte pagarla.`
      );
    }

    const lineas = resultados.map((r) => {
      const tipoTexto = r.tipo === "gasto" ? "Gasto" : "Ingreso";
      const vencimiento = r.dueDate ? `, vence ${r.dueDate}` : "";
      const borrador = r.draft ? " — borrador" : "";
      const estadoPago =
        r.pendiente > 0.01
          ? `PENDIENTE de pago (${r.pendiente.toFixed(2)} € sin pagar de ${r.total.toFixed(2)} €)`
          : `ya pagada (${r.total.toFixed(2)} €)`;
      return `- [${tipoTexto}] ${r.contactName} — doc ${r.documentNumber}, fecha ${r.fecha}${vencimiento} — ${estadoPago}${borrador}`;
    });

    const huboCoincidenciaSoloPorMonto = resultados.some((r) => r.coincidenciaSoloPorMonto);
    const nota = huboCoincidenciaSoloPorMonto
      ? `\n\n(No encontré coincidencia por nombre de "${contacto}" — esto(s) resultado(s) matchearon SOLO por el monto, confírmalo con el usuario antes de darlo por seguro.)`
      : "";

    return `${resultados.length} factura(s) encontrada(s) en Holded (${empresa}) para "${contacto}":\n\n${lineas.join("\n")}${nota}`;
  },
};
