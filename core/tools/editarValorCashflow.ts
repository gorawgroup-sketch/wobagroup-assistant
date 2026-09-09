import { buscarFilaCashflowParaEditar, type BloqueEscritura } from "../google/cashflowWrite";
import { crearPendienteEdicionValorCashflow, actualizarMessageIdEdicionValorCashflow } from "../google/pendienteEdicionValorCashflowStore";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import { montosCercanos } from "../utils/montos";
import type { ToolDefinition } from "./types";

const BLOQUES_EDITABLES: BloqueEscritura[] = ["ingresos", "pagos_proyectos", "pagos_extras", "gastos_fijos"];

/**
 * Pedido explícito de Carlos, tras un caso real (el propio sistema le avisó
 * mid-conversación que solo podía registrar movimientos nuevos en el
 * cashflow, nunca corregir un valor ya escrito en una fila existente):
 * "puedes crear la herramienta para que el sistema edite en el cashflow lo
 * que sea necesario?". Igual que CUALQUIER otra escritura real de este
 * sistema, esto NUNCA edita nada por sí solo — solo identifica la fila,
 * arma la propuesta de edición, y la muestra con botones de aprobación (ver
 * edicionValorCashflowCallbackHandler.ts). Solo cubre los bloques de
 * columnas fijas (ingresos/pagos_proyectos/pagos_extras/gastos_fijos) —
 * pagos_pendientes_alberto/deudas_pendientes y las secciones sin escritor
 * quedan fuera por ahora (ver buscarFilaCashflowParaEditar).
 */
export const editarValorCashflowTool: ToolDefinition = {
  name: "proponer_edicion_valor_cashflow",
  description:
    "Propone corregir el VALOR de una fila YA EXISTENTE en la hoja DATOS del cashflow (nunca lo edita directo — solo " +
    "muestra la propuesta con botones Confirmar/Cancelar). Úsala cuando te pidan corregir un monto ya registrado en el " +
    "cashflow (no un movimiento nuevo por registrar — para eso está registrar_movimiento_cashflow). Identifica la fila " +
    "por bloque + cliente/proveedor/concepto + semana + el valor actual que se cree que tiene — si hay varias filas que " +
    "coinciden, en vez de proponer nada te devuelve la lista para que el usuario aclare cuál es; nunca adivines cuál es " +
    "si hay más de una coincidencia real.",
  input_schema: {
    type: "object",
    properties: {
      bloque: {
        type: "string",
        enum: BLOQUES_EDITABLES,
        description: "Bloque de DATOS donde está la fila a corregir.",
      },
      cliente_o_concepto: {
        type: "string",
        description: "Nombre del cliente/proveedor o concepto de la fila a corregir — ej. 'Alquiler oficina', 'Booking.com'.",
      },
      semana: {
        type: "string",
        description: "Semana de la fila a corregir, formato 'S40'.",
      },
      valor_actual_aproximado: {
        type: "number",
        description:
          "El valor EXACTO (al céntimo) que hoy tiene la fila en el Sheet — se usa para identificarla con seguridad, no solo por " +
          "nombre+semana. Debe coincidir casi exacto (tolerancia de un céntimo); si no se conoce el valor exacto, consulta primero el " +
          "cashflow antes de llamar a esta herramienta.",
      },
      valor_nuevo: {
        type: "number",
        description: "El valor correcto a dejar en esa fila.",
      },
    },
    required: ["bloque", "cliente_o_concepto", "semana", "valor_actual_aproximado", "valor_nuevo"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) {
      return "Error: no se pudo determinar el chat de Telegram donde mostrar la propuesta de edición.";
    }

    const bloque = input.bloque as BloqueEscritura;
    if (!BLOQUES_EDITABLES.includes(bloque)) {
      return `Error: 'bloque' debe ser uno de: ${BLOQUES_EDITABLES.join(", ")} (los demás bloques del cashflow todavía no admiten edición de valor).`;
    }

    const clienteOConcepto = typeof input.cliente_o_concepto === "string" ? input.cliente_o_concepto.trim() : "";
    if (!clienteOConcepto) return "Error: falta 'cliente_o_concepto'.";

    const semana = typeof input.semana === "string" ? input.semana.trim().toUpperCase() : "";
    if (!semana) return "Error: falta 'semana'.";

    const valorActual = typeof input.valor_actual_aproximado === "number" ? input.valor_actual_aproximado : Number(input.valor_actual_aproximado);
    if (!Number.isFinite(valorActual)) return "Error: 'valor_actual_aproximado' debe ser un número válido.";

    const valorNuevo = typeof input.valor_nuevo === "number" ? input.valor_nuevo : Number(input.valor_nuevo);
    if (!Number.isFinite(valorNuevo)) return "Error: 'valor_nuevo' debe ser un número válido.";

    // montosCercanos (nunca resta floats a mano) — hallazgo real de auditoría:
    // Math.abs(a-b) < 0.01 puede rechazar una corrección real de un céntimo
    // por el mismo error de precisión de punto flotante ya documentado en
    // montosCercanos (ej. 7964.17-7964.16 ≈ 0.010000000000218 en JS).
    if (montosCercanos(valorNuevo, valorActual, 0.001)) {
      return "Error: el valor nuevo es igual al actual — no hay nada que corregir.";
    }

    const encontradas = await buscarFilaCashflowParaEditar({ bloque, cliente_o_concepto: clienteOConcepto, semana, valorActual });

    if (encontradas.length === 0) {
      return (
        `No encontré ninguna fila en "${bloque}" que coincida con "${clienteOConcepto}", semana ${semana} y valor actual ~${valorActual.toFixed(2)} — ` +
        `verifica el nombre, la semana o el monto exacto (o si es de otro bloque).`
      );
    }

    if (encontradas.length > 1) {
      const listado = encontradas
        .map((f, i) => `${i + 1}. fila ${f.fila} — ${f.clienteOConcepto}, semana ${f.semana}, valor ${f.valorActual.toFixed(2)}${f.banco ? `, banco ${f.banco}` : ""}`)
        .join("\n");
      return `Encontré ${encontradas.length} filas que coinciden — dime cuál corresponde (dame más detalle, ej. el banco o el proyecto):\n${listado}`;
    }

    const f = encontradas[0];
    const resumenAntes = `${f.clienteOConcepto} — semana ${f.semana}, ${f.valorActual.toFixed(2)}`;
    const texto =
      `✏️ *Propuesta de edición en cashflow* — ${resumenAntes} (fila ${f.fila}, bloque "${bloque}")\n\n` +
      `Cambiar valor → ${valorNuevo.toFixed(2)}.\n\n` +
      `Esto corrige SOLO el valor de esa fila — nada más se toca.`;

    const pendiente = await crearPendienteEdicionValorCashflow({
      chatId,
      messageId: 0,
      bloque,
      fila: f.fila,
      clienteOConcepto: f.clienteOConcepto,
      semana: f.semana,
      valorActual: f.valorActual,
      valorNuevo,
      resumenAntes,
    });

    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "✅ Confirmar edición", callback_data: `edicioncashflow_confirmar:${pendiente.id}` },
        { text: "❌ Cancelar", callback_data: `edicioncashflow_cancelar:${pendiente.id}` },
      ],
    ]);
    await actualizarMessageIdEdicionValorCashflow(pendiente.id, messageId);

    return "Propuesta de edición mostrada por Telegram con botones — no se editó nada todavía, falta la aprobación.";
  },
};
