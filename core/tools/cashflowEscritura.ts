import {
  registrarMovimientoEnSheet,
  registrarPendienteEnSheet,
  BLOQUES_SECCION_COMPARTIDA,
  type BloqueEscritura,
} from "../google/cashflowWrite";
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
const BLOQUES_VALIDOS: BloqueEscritura[] = [
  "ingresos",
  "pagos_proyectos",
  "pagos_extras",
  "gastos_fijos",
  "aplazamiento_impuestos",
  "pagos_pendientes_alberto",
  "deudas_pendientes",
];

export const cashflowEscrituraTool: ToolDefinition = {
  name: "registrar_movimiento_cashflow",
  description:
    "Registra un movimiento NUEVO (nunca modifica uno existente) en la hoja DATOS del cashflow, en " +
    "el bloque correspondiente. 'semana' es opcional SOLO para pagos_pendientes_alberto y " +
    "deudas_pendientes (saldos sin fecha de pago conocida) — obligatoria en el resto. Después de " +
    "escribir, verifica leyendo de vuelta la celda.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS"],
        description: "Empresa dueña del movimiento. Ignorado en pagos_pendientes_alberto/deudas_pendientes (no tienen columna de empresa).",
      },
      bloque: {
        type: "string",
        enum: BLOQUES_VALIDOS,
        description: "Bloque de DATOS donde se escribe la fila nueva.",
      },
      cliente_o_concepto: {
        type: "string",
        description: "Nombre del cliente/proveedor o concepto del movimiento.",
      },
      proyecto: {
        type: "string",
        description: "Nombre del proyecto. Solo aplica a 'ingresos' y 'pagos_proyectos'. Opcional.",
      },
      banco: {
        type: "string",
        description: "Banco desde el que se paga. Solo aplica a 'gastos_fijos'. Opcional.",
      },
      semana: {
        type: "string",
        description: "Semana del movimiento, formato 'S40'. Opcional solo para pagos_pendientes_alberto/deudas_pendientes.",
      },
      valor: {
        type: "number",
        description: "Importe del movimiento (positivo, como se almacena en la hoja).",
      },
    },
    required: ["empresa", "bloque", "cliente_o_concepto", "valor"],
  },
  handler: async (input) => {
    const empresa = input.empresa as "WOBA" | "EWORKS";
    const bloque = input.bloque as BloqueEscritura;

    if (empresa !== "WOBA" && empresa !== "EWORKS") {
      return "Error: 'empresa' debe ser WOBA o EWORKS.";
    }
    if (!BLOQUES_VALIDOS.includes(bloque)) {
      return `Error: 'bloque' debe ser uno de: ${BLOQUES_VALIDOS.join(", ")}.`;
    }

    const cliente_o_concepto = typeof input.cliente_o_concepto === "string" ? input.cliente_o_concepto.trim() : "";
    const semana = typeof input.semana === "string" ? input.semana.trim().toUpperCase() : "";
    const valor = typeof input.valor === "number" ? input.valor : Number(input.valor);
    const proyecto = typeof input.proyecto === "string" && input.proyecto.trim() ? input.proyecto.trim() : undefined;
    const banco = typeof input.banco === "string" && input.banco.trim() ? input.banco.trim() : undefined;

    const esSeccionCompartida = (BLOQUES_SECCION_COMPARTIDA as string[]).includes(bloque);

    if (!cliente_o_concepto) return "Error: falta 'cliente_o_concepto'.";
    if (!semana && !esSeccionCompartida) return "Error: falta 'semana'.";
    if (!Number.isFinite(valor)) return "Error: 'valor' debe ser un número válido.";

    if (esSeccionCompartida) {
      const resultado = await registrarPendienteEnSheet({
        seccion: bloque as "pagos_pendientes_alberto" | "deudas_pendientes",
        cliente: cliente_o_concepto,
        semana: semana || undefined,
        valor,
      });
      return resultado.mensaje;
    }

    const resultado = await registrarMovimientoEnSheet({
      bloque,
      cliente_o_concepto,
      proyecto,
      banco,
      semana,
      valor,
      empresa,
    });

    return resultado.mensaje;
  },
};
