import { BLOQUES_SECCION_COMPARTIDA, bloqueTieneColumnaEmpresa, type BloqueEscritura } from "../google/cashflowWrite";
import {
  crearPendienteRegistroManualCashflow,
  actualizarMessageIdRegistroManualCashflow,
} from "../google/pendienteRegistroManualCashflowStore";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import type { ToolDefinition } from "./types";

// Mismos bloques que cashflowEscrituraTool (registrar_movimiento_cashflow) — impuestos_por_pagar y
// aplazamiento_impuestos quedan fuera a propósito, ver el comentario junto a esa lista.
const BLOQUES_VALIDOS: BloqueEscritura[] = [
  "ingresos",
  "pagos_proyectos",
  "pagos_extras",
  "gastos_fijos",
  "pagos_pendientes_alberto",
  "deudas_pendientes",
];

/**
 * Pedido explícito de Carlos, tras un caso real (pidió agregar por chat una sanción AEAT y una
 * providencia de apremio al bloque "Pagos Extras" de EWORKS, y el sistema respondió que no podía crear
 * filas nuevas): la escritura de bajo nivel (registrarMovimientoEnSheet/registrarPendienteEnSheet,
 * cashflowWrite.ts) ya soporta TODOS estos bloques — lo que faltaba era una tool de chat que, igual que
 * proponerEdicionValorCashflowTool para editar, arme la propuesta y espere aprobación por botón antes
 * de escribir (nunca se conecta directo a la escritura real — ver cashflowEscrituraTool, que sí escribe
 * directo pero a propósito NUNCA se registra como tool de chat, solo se dispara tras aprobar una
 * propuesta AUTOMÁTICA del comparativo Holded-vs-cashflow).
 */
export const registrarManualCashflowTool: ToolDefinition = {
  name: "proponer_registro_manual_cashflow",
  description:
    "Propone registrar un movimiento NUEVO (nunca modifica uno existente) en un bloque del cashflow, a pedido " +
    "puntual del usuario en el chat (nunca lo escribe directo — solo muestra la propuesta con botones " +
    "Confirmar/Cancelar). Para movimientos que el sistema ya detectó automáticamente comparando Holded contra el " +
    "cashflow, usa el flujo normal de esa detección, no esta herramienta. 'semana' es opcional SOLO para " +
    "pagos_pendientes_alberto y deudas_pendientes (saldos sin fecha de pago conocida) — obligatoria en el resto.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS"],
        description: "Empresa dueña del movimiento — obligatoria en todos los bloques, incluidos pagos_pendientes_alberto/deudas_pendientes.",
      },
      bloque: {
        type: "string",
        enum: BLOQUES_VALIDOS,
        description: "Bloque de DATOS donde se propone la fila nueva.",
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
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) {
      return "Error: no se pudo determinar el chat de Telegram donde mostrar la propuesta.";
    }

    const empresa = input.empresa as "WOBA" | "EWORKS";
    const bloque = input.bloque as BloqueEscritura;

    if (empresa !== "WOBA" && empresa !== "EWORKS") {
      return "Error: 'empresa' debe ser WOBA o EWORKS.";
    }
    if (!BLOQUES_VALIDOS.includes(bloque)) {
      return `Error: 'bloque' debe ser uno de: ${BLOQUES_VALIDOS.join(", ")}.`;
    }

    const clienteOConcepto = typeof input.cliente_o_concepto === "string" ? input.cliente_o_concepto.trim() : "";
    const semana = typeof input.semana === "string" ? input.semana.trim().toUpperCase() : "";
    const valor = typeof input.valor === "number" ? input.valor : Number(input.valor);
    const proyecto = typeof input.proyecto === "string" && input.proyecto.trim() ? input.proyecto.trim() : undefined;
    const banco = typeof input.banco === "string" && input.banco.trim() ? input.banco.trim() : undefined;

    const esSeccionCompartida = (BLOQUES_SECCION_COMPARTIDA as string[]).includes(bloque);

    if (!clienteOConcepto) return "Error: falta 'cliente_o_concepto'.";
    if (!semana && !esSeccionCompartida) return "Error: falta 'semana'.";
    if (!Number.isFinite(valor)) return "Error: 'valor' debe ser un número válido.";

    // Hallazgo real de auditoría, caso real (sanción AEAT + providencia de apremio de Alberto Comolli,
    // pedidas para "Pagos Extras" de EWORKS): ese bloque no tiene columna propia de empresa en el Sheet
    // (ver BLOQUE_CONFIG en cashflowWrite.ts) — si se escribiera "EWORKS" tal cual como si esa columna
    // existiera, se perdería en silencio. En vez de eso, se deja constancia dentro del propio concepto,
    // y se avisa explícitamente en la propuesta para que Carlos decida si le sirve así o prefiere
    // corregirlo a mano.
    const tieneColumnaEmpresa = bloqueTieneColumnaEmpresa(bloque);
    const conceptoFinal = tieneColumnaEmpresa ? clienteOConcepto : `${empresa} — ${clienteOConcepto}`;

    const resumen = `${conceptoFinal}${semana ? ` — semana ${semana}` : ""}, ${valor.toFixed(2)} (bloque "${bloque}")`;
    const notaEmpresa = tieneColumnaEmpresa
      ? ""
      : `\n\n⚠️ El bloque "${bloque}" no tiene columna propia de empresa en el Sheet — se incluye "${empresa}" al inicio del concepto para que quede identificable.`;

    const texto =
      `🆕 **Propuesta de registro nuevo en cashflow** — ${resumen}${notaEmpresa}\n\n` +
      `Esto crea una fila NUEVA — no toca ninguna fila existente.`;

    const pendiente = await crearPendienteRegistroManualCashflow({
      chatId,
      messageId: 0,
      empresa,
      bloque,
      clienteOConcepto: conceptoFinal,
      proyecto,
      banco,
      semana: semana || undefined,
      valor,
      resumen,
    });

    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "✅ Confirmar registro", callback_data: `regmanualcf_confirmar:${pendiente.id}` },
        { text: "❌ Cancelar", callback_data: `regmanualcf_cancelar:${pendiente.id}` },
      ],
    ]);
    await actualizarMessageIdRegistroManualCashflow(pendiente.id, messageId);

    return "Propuesta de registro mostrada por Telegram con botones — no se escribió nada todavía, falta la aprobación.";
  },
};
