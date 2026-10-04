import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";
import { conciliacionMultiple } from "../holded/conciliacionMultiple/runtime";
import { resumenPlan, estadoPlan, type ReferenciaMovimiento } from "../holded/conciliacionMultiple/model";


export const conciliarMultiplesMovimientosTool: ToolDefinition = {
  name: "conciliar_multiples_movimientos_bancarios",
  description: "Prepara una conciliación de VARIOS movimientos ya identificados contra UNA compra existente. " +
    "Úsala para pagos fraccionados como Gora: 1000 + 1000 + 200 + 1000 = 3200. Conserva los IDs de lo " +
    "identificado en el hilo; no vuelvas a buscar un movimiento por el total ni busques la compra por los importes parciales. " +
    "Obtén compra_id con consultar_estado_factura_holded y accountId/movementId/fecha con consultar_movimientos_sin_conciliar. " +
    "Nunca inventes IDs ni sustituyas el ID por el número de factura. Verifica por lectura la compra y todos los movimientos, " +
    "exige suma exacta del saldo pendiente, misma empresa y EUR, y presenta el desglose para aprobación por botón. " +
    "La suma por sí sola no demuestra la relación: explica la evidencia en motivo. No crea gastos ni escribe en Holded al proponer. " +
    "No afirmar conciliado/resuelto hasta estado completado. Si hay más de una selección plausible, pregunta cuál antes de proponer.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"] },
      compra_id: { type: "string", description: "ID real de la compra en Holded; no el número de documento." },
      movimientos: { type: "array", minItems: 2, maxItems: 20, items: {
        type: "object", properties: { accountId: { type: "string" }, movementId: { type: "string" }, fecha: { type: "string", description: "Fecha bancaria YYYY-MM-DD." } },
        required: ["accountId", "movementId", "fecha"], additionalProperties: false,
      } },
      motivo: { type: "string", maxLength: 500, description: "Evidencia de que los movimientos pagan esa compra: selección explícita, proveedor, referencia, etc." },
    },
    required: ["empresa", "compra_id", "movimientos", "motivo"], additionalProperties: false,
  },
  handler: async (input, context) => {
    if (context?.chatId === undefined) return "No se puede preparar la conciliación sin un chat de aprobación.";
    let planId: string | undefined;
    try {
      const p = await conciliacionMultiple.preparar({ empresa: input.empresa as Empresa, chatId: context.chatId,
        compraId: typeof input.compra_id === "string" ? input.compra_id : "", movimientos: input.movimientos as ReferenciaMovimiento[],
        motivo: typeof input.motivo === "string" ? input.motivo : "" });
      planId = p.id;
      const { sendTelegramMessage, sendTelegramMessageWithButtons } = await import("../telegram/client");
      const resumen = resumenPlan(p);
      // Mostrar siempre el desglose completo, incluso cuando excede un mensaje de Telegram.
      for (let i = 0; i < resumen.length; i += 3000) await sendTelegramMessage(p.chatId, resumen.slice(i, i + 3000));
      await sendTelegramMessageWithButtons(p.chatId,
        `Plan ${p.id}: ¿confirmas vincular estos ${p.movimientos.length} movimientos a la compra ${p.compra.numero || p.compra.id}? ` +
        "Se comprobarán otra vez los datos antes de escribir. Si un paso falla, se detendrá el lote y se informará del avance real.",
        [[{ text: "Confirmar conciliación múltiple", callback_data: `concilmulti_si:${p.id}` }],
          [{ text: "Cancelar", callback_data: `concilmulti_no:${p.id}` }]]);
      return `Plan ${p.id} guardado y desglose enviado para aprobación. No se ha conciliado ni resuelto todavía. La cola de correo debe esperar la resolución real.`;
    } catch (error) {
      return `${planId ? `Plan guardado: ${planId}. ` : ""}No se completó la preparación/envío: ${error instanceof Error ? error.message : String(error)}. No se envió ninguna conciliación a Holded.`;
    }
  },
};

export const consultarConciliacionMultipleTool: ToolDefinition = {
  name: "consultar_conciliacion_multiple",
  description: "Consulta el registro persistente de un plan de conciliación múltiple y su avance verificado. " +
    "Solo lectura del registro, no reintenta ni reanuda escrituras. Un estado incierto/ejecutando tras una interrupción requiere revisión; jamás decir resuelto.",
  input_schema: { type: "object", properties: { plan_id: { type: "string" } }, required: ["plan_id"] },
  handler: async (input, context) => {
    if (context?.chatId === undefined || typeof input.plan_id !== "string") return "Falta el chat o el ID del plan.";
    try { return estadoPlan(await conciliacionMultiple.consultar(input.plan_id, context.chatId)); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  },
};
