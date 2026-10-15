import { leerSeccionImpuestos } from "../google/cashflowImpuestos";
import { planificarLote, type PeticionOperacionImpuestos } from "../google/loteImpuestosPlan";
import { actualizarMessageIdLoteImpuestos, crearPendienteLoteImpuestos } from "../google/pendienteLoteImpuestosStore";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import type { ToolDefinition } from "./types";

/**
 * Registrar o corregir impuestos en el cashflow a partir de lo que diga el usuario o de un documento (Carlos, 2026-10-14: la tabla de liquidaciones del 3T de la
 * gestoría). El escritor y el botón de aplicar ya existían (core/google/cashflowImpuestos.ts, loteImpuestosCallbackHandler.ts) pero ninguna herramienta del
 * chat los alcanzaba, y el asistente acababa proponiendo archivar el documento. Esta herramienta solo PROPONE el lote con su botón; no escribe nada en el cashflow.
 */
export const proponerLoteImpuestosCashflowTool: ToolDefinition = {
  name: "proponer_lote_impuestos_cashflow",
  description:
    "Propone, con un botón «Aplicar», un lote de altas y correcciones en las secciones de IMPUESTOS del cashflow (IMPUESTOS POR PAGAR y APLAZAMIENTO IMPUESTOS POR PAGAR): " +
    "cada impuesto con su empresa, trimestre, semana de pago y valor. Úsala cuando pidan registrar o corregir en el cashflow los impuestos a pagar (modelos 111, 115, 303, " +
    "202, cuotas de aplazamiento…), por ejemplo a partir de la tabla de liquidaciones que envía la gestoría: lee el documento con leer_adjuntos_de_correo, calcula " +
    "dónde va cada valor y llama a esta herramienta; NO propongas archivar el documento. La herramienta compara con lo que ya hay en el cashflow: para un impuesto que ya " +
    "existe usa accion=correccion (con el nombre exacto de la fila, p. ej. «MOD 115 WOBA Q3»), para uno nuevo accion=alta. Semana con formato «S43» (la del día de pago). " +
    "Convención de nombres: «MOD <número> <EMPRESA> <trimestre>», p. ej. «MOD 303 EWORKS Q3». No registres lo que no se paga (modelos a compensar o a devolver) ni " +
    "empresas sin cashflow (Footprint). Si algo no cuadra (fila no encontrada, duplicado, ambigüedad) devuelve el motivo y no propone nada: corrígelo y vuelve a llamarla. " +
    "No escribe en el cashflow: solo muestra el lote con «Aplicar» / «Cancelar»; cada fila se escribe y se verifica una a una al pulsar «Aplicar».",
  input_schema: {
    type: "object",
    properties: {
      titulo: { type: "string", description: "Título corto del lote (p. ej. «Impuestos 3T 2026 del Grupo WOBA — pago semana 43»)." },
      operaciones: {
        type: "array",
        items: {
          type: "object",
          properties: {
            accion: { type: "string", enum: ["alta", "correccion"] },
            impuesto: { type: "string", description: "Nombre del impuesto en el cashflow, p. ej. «MOD 111 EWORKS Q3»." },
            semana: { type: "string", description: "alta: semana de pago «S43». correccion: la NUEVA semana, si cambia." },
            valor: { type: "number", description: "alta: obligatorio. correccion: el NUEVO valor en euros, si cambia." },
            anio: { type: "string", description: "Año del pago (por defecto el actual)." },
            seccion: { type: "string", enum: ["impuestos_por_pagar", "aplazamiento_impuestos"], description: "Solo alta; por defecto impuestos_por_pagar." },
            semana_actual: { type: "string", description: "Solo correccion: semana ACTUAL de la fila, si hay varias con el mismo nombre (cuotas)." },
          },
          required: ["accion", "impuesto"],
        },
      },
    },
    required: ["titulo", "operaciones"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram donde mostrar el lote.";
    const titulo = typeof input.titulo === "string" && input.titulo.trim() ? input.titulo.trim() : "Impuestos en el cashflow";
    const peticiones = Array.isArray(input.operaciones) ? input.operaciones as PeticionOperacionImpuestos[] : [];
    if (peticiones.length === 0) return "Error: faltan las operaciones del lote.";
    const [porPagar, aplazamiento] = await Promise.all([leerSeccionImpuestos("impuestos_por_pagar"), leerSeccionImpuestos("aplazamiento_impuestos")]);
    const plan = planificarLote({ impuestos_por_pagar: porPagar, aplazamiento_impuestos: aplazamiento }, peticiones, String(new Date().getFullYear()));
    if (plan.errores.length > 0) return `No propongo nada todavía:\n${plan.errores.map((e) => `• ${e}`).join("\n")}`;
    if (plan.operaciones.length === 0) return `No hay nada que cambiar en el cashflow.${plan.avisos.length ? `\n${plan.avisos.join("\n")}` : ""}`;
    const pendiente = await crearPendienteLoteImpuestos({ chatId, messageId: 0, titulo, operaciones: plan.operaciones });
    const texto = [`🧾 ${titulo}`, "", ...plan.operaciones.map((o) => `• ${o.descripcion}`), ...(plan.avisos.length ? ["", ...plan.avisos.map((a) => `ℹ️ ${a}`)] : []), "", "No se escribe nada en el cashflow hasta que pulses «Aplicar»."].join("\n");
    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [[{ text: "✅ Aplicar en el cashflow", callback_data: `loteimpuestos_confirmar:${pendiente.id}` }, { text: "❌ Cancelar", callback_data: `loteimpuestos_cancelar:${pendiente.id}` }]]);
    await actualizarMessageIdLoteImpuestos(pendiente.id, messageId);
    return `Lote de ${plan.operaciones.length} operación(es) mostrado en el chat con su botón «Aplicar»; no se escribió nada en el cashflow todavía.`;
  },
};
