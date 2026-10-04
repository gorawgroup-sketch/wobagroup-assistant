import type { ToolDefinition } from "./types";
import type { Empresa } from "../holded/client";

export const revisarCuentaContableGastoTool: ToolDefinition = {
  name: "revisar_cuenta_contable_gasto",
  description: "Revisa por lectura la cuenta contable de una compra existente antes de conciliar. Consulta el catálogo real y el historial " +
    "del proveedor en la misma empresa, excluye la compra examinada y descarta precedentes incompatibles (por ejemplo viajes o " +
    "diferencias de cambio para créditos de Anthropic). Devuelve la cuenta actual, la sugerencia respaldada y los documentos usados. " +
    "No modifica Holded; si hay conflicto o falta evidencia, requiere revisión. No inventes una cuenta ni afirmes que ya quedó corregida.",
  input_schema: { type: "object", properties: {
    empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"] },
    compra_id: { type: "string", description: "ID real del documento en Holded." },
  }, required: ["empresa", "compra_id"], additionalProperties: false },
  handler: async (input) => {
    if (!["WOBA", "EWORKS", "Footprint"].includes(String(input.empresa)) || typeof input.compra_id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(input.compra_id)) return "Empresa o ID de compra inválido.";
    try {
      const { obtenerCompraHoldedPorId, obtenerCuentasContablesReales, evaluarCuentaGasto } = await import("../holded/write");
      const empresa = input.empresa as Empresa;
      const compra = await obtenerCompraHoldedPorId(empresa, input.compra_id);
      if (!compra.contact_id) return "Falta el proveedor de la compra; no se puede validar su clasificación.";
      const [cuentas, evaluacion] = await Promise.all([
        obtenerCuentasContablesReales(empresa),
        evaluarCuentaGasto(empresa, { contactId: compra.contact_id, proveedor: String(compra.contact_name ?? ""),
          concepto: [compra.description, ...(compra.lines ?? []).map((l) => l.name)].filter(Boolean).join(" "), excluirCompraId: compra.id }),
      ]);
      const actuales = [...new Set((compra.lines ?? []).map((l) => l.account))];
      const s = evaluacion.sugerencia;
      return `Compra ${compra.document_number || compra.id} — ${empresa}.\n` +
        `Cuenta(s) actual(es): ${actuales.map((id) => `${cuentas.find((c) => c.id === id)?.name ?? "desconocida"} [${id ?? "sin cuenta"}]`).join(", ")}.\n` +
        `${evaluacion.motivo}\n` + (s ? `Cuenta respaldada: ${s.nombreCuenta} [${s.accountId}].\n` +
          s.evidencia.map((e) => `• ${e.documento || e.compraId} — ${e.fecha} — ${e.concepto} [${e.compraId}]`).join("\n") : "No hay una cuenta confirmable; no conciliar.") +
        `\nPrecedentes descartados por incompatibilidad: ${evaluacion.descartados.length}.\nSolo revisión: no se ha modificado la compra.`;
    } catch (error) { return `Revisión incompleta; no conciliar: ${error instanceof Error ? error.message : String(error)}`; }
  },
};
