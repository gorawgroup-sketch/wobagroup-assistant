import { registrarMovimientoEnSheet, type BloqueEscritura } from "../google/cashflowWrite";
import type { ToolDefinition } from "./types";

/**
 * Tool de escritura para registrar un movimiento nuevo en la hoja DATOS.
 *
 * ADVERTENCIA DE SEGURIDAD: este tool NO está registrado en core/tools/registry.ts
 * a propósito, así que Claude nunca lo ve en su lista de herramientas y no puede
 * invocarlo por su cuenta durante una conversación normal. El único camino de
 * código que lo invoca es el handler de callback_query en src/server.ts, y solo
 * después de que el usuario presiona el botón "✅ Agregar" en Telegram sobre una
 * propuesta concreta generada por el job de detección. Nunca lo agregues al
 * array `tools` de registry.ts ni lo llames desde ningún otro lugar.
 */
export const cashflowEscrituraTool: ToolDefinition = {
  name: "registrar_movimiento_cashflow",
  description:
    "Registra un movimiento NUEVO (nunca modifica uno existente) en la hoja DATOS del cashflow, en " +
    "el bloque correspondiente (ingresos, pagos_proyectos o pagos_extras — nunca gastos_fijos). " +
    "Después de escribir, verifica leyendo de vuelta la celda.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS"],
        description: "Empresa dueña del movimiento.",
      },
      bloque: {
        type: "string",
        enum: ["ingresos", "pagos_proyectos", "pagos_extras"],
        description: "Bloque de DATOS donde se escribe la fila nueva. Nunca 'gastos_fijos'.",
      },
      cliente_o_concepto: {
        type: "string",
        description: "Nombre del cliente/proveedor o concepto del movimiento.",
      },
      proyecto: {
        type: "string",
        description: "Nombre del proyecto. Solo aplica a 'ingresos' y 'pagos_proyectos'. Opcional.",
      },
      semana: {
        type: "string",
        description: "Semana del movimiento, formato 'S40'.",
      },
      valor: {
        type: "number",
        description: "Importe del movimiento (positivo, como se almacena en la hoja).",
      },
    },
    required: ["empresa", "bloque", "cliente_o_concepto", "semana", "valor"],
  },
  handler: async (input) => {
    const empresa = input.empresa as "WOBA" | "EWORKS";
    const bloque = input.bloque as BloqueEscritura;

    if (empresa !== "WOBA" && empresa !== "EWORKS") {
      return "Error: 'empresa' debe ser WOBA o EWORKS.";
    }
    if (bloque !== "ingresos" && bloque !== "pagos_proyectos" && bloque !== "pagos_extras") {
      return "Error: 'bloque' debe ser ingresos, pagos_proyectos o pagos_extras.";
    }

    const cliente_o_concepto = typeof input.cliente_o_concepto === "string" ? input.cliente_o_concepto.trim() : "";
    const semana = typeof input.semana === "string" ? input.semana.trim().toUpperCase() : "";
    const valor = typeof input.valor === "number" ? input.valor : Number(input.valor);
    const proyecto = typeof input.proyecto === "string" && input.proyecto.trim() ? input.proyecto.trim() : undefined;

    if (!cliente_o_concepto) return "Error: falta 'cliente_o_concepto'.";
    if (!semana) return "Error: falta 'semana'.";
    if (!Number.isFinite(valor)) return "Error: 'valor' debe ser un número válido.";

    const resultado = await registrarMovimientoEnSheet({
      bloque,
      cliente_o_concepto,
      proyecto,
      semana,
      valor,
      empresa,
    });

    return resultado.mensaje;
  },
};
