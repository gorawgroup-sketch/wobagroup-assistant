import { proponerGastoSinSoporte, proponerParCompensado } from "../holded/conciliarSinSoporte";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

export const proponerConciliarSinSoporteTool: ToolDefinition = {
  name: "proponer_cerrar_cargo_sin_soporte",
  description:
    "Propone cerrar un cargo del banco SIN soporte, solo cuando el usuario lo pida expresamente. Dos modos: " +
    "(1) modo='par': un cargo y su reembolso TOTAL (suman cero, misma cuenta y moneda; pasa dos movimientos) — se marcan ambos conciliados sin gasto. " +
    "(2) modo='gasto': un cargo real sin recibo — se CREA un gasto en Holded sin adjunto, clonando proveedor, cuenta contable y etiquetas de un gasto " +
    "ya registrado de la misma persona (plantilla_compra_id), y se concilia con el cargo. Nunca marques un cargo con gasto real como conciliado " +
    "sin documento. Los ids salen de consultar_movimientos_sin_conciliar. No escribe nada: muestra el antes/ahora con botones y solo un " +
    "superadministrador puede confirmar.",
  input_schema: {
    type: "object",
    properties: {
      modo: { type: "string", enum: ["par", "gasto"] },
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"] },
      motivo: { type: "string", description: "Por qué se cierra sin soporte, con las palabras del usuario." },
      movimientos: {
        type: "array",
        description: "Modo 'par': exactamente dos movimientos (cargo y reembolso) de la misma cuenta. Modo 'gasto': uno solo.",
        items: {
          type: "object",
          properties: { cuenta_id: { type: "string" }, movimiento_id: { type: "string" }, fecha: { type: "string", description: "YYYY-MM-DD" } },
          required: ["cuenta_id", "movimiento_id", "fecha"],
        },
      },
      plantilla_compra_id: { type: "string", description: "Modo 'gasto': id de un gasto ya registrado de la misma persona y proveedor, para copiar proveedor, cuenta y etiquetas." },
      concepto: { type: "string", description: "Modo 'gasto': qué fue el gasto (ej. «Traslado Uber — Alejandro Florez — 23 sep 2026»)." },
      descripcion: { type: "string", description: "Cómo aparece el cargo en el banco (opcional)." },
    },
    required: ["modo", "empresa", "motivo", "movimientos"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat donde mostrar la propuesta.";
    const empresa = input.empresa as Empresa;
    if (!["WOBA", "EWORKS", "Footprint"].includes(empresa)) return "Error: empresa no válida.";
    const movimientos = (Array.isArray(input.movimientos) ? input.movimientos : []).map((m) => {
      const o = m as Record<string, unknown>;
      return { cuentaId: String(o.cuenta_id ?? "").trim(), movimientoId: String(o.movimiento_id ?? "").trim(), fecha: String(o.fecha ?? "").trim() };
    });
    if (movimientos.some((m) => !m.cuentaId || !m.movimientoId || !/^\d{4}-\d{2}-\d{2}$/.test(m.fecha))) return "Error: cada movimiento necesita cuenta_id, movimiento_id y fecha YYYY-MM-DD.";
    const motivo = typeof input.motivo === "string" ? input.motivo : "";
    const descripcion = typeof input.descripcion === "string" ? input.descripcion : undefined;
    if (input.modo === "par") return proponerParCompensado(chatId, { empresa, movimientos, motivo, descripcion });
    if (input.modo === "gasto") {
      const plantilla = typeof input.plantilla_compra_id === "string" ? input.plantilla_compra_id.trim() : "";
      if (movimientos.length !== 1 || !plantilla) return "Error: el modo 'gasto' necesita un solo movimiento y plantilla_compra_id.";
      return proponerGastoSinSoporte(chatId, { empresa, movimiento: movimientos[0], plantillaCompraId: plantilla, concepto: typeof input.concepto === "string" ? input.concepto : "", motivo, descripcion });
    }
    return "Error: modo debe ser 'par' o 'gasto'.";
  },
};
