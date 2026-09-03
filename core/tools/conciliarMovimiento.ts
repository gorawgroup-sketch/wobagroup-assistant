import { buscarGastoSimilar } from "../holded/write";
import { guardarConciliacionPendiente } from "../gastos/conciliacionPendienteStore";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos, tras un caso real: le pidió al chat que
 * conciliara un movimiento bancario ("Cafe Vida", -42.46€) con un gasto ya
 * creado ("Almuerzo con Alejandro", 42.46 EUR) que el propio asistente había
 * identificado con las tools de consulta — pero no existía ninguna tool que
 * de verdad EJECUTARA la conciliación, solo las de solo lectura
 * (consultar_movimientos_sin_conciliar, consultar_estado_factura_holded).
 * "No tengo una herramienta que ejecute la conciliación directamente en
 * Holded" era honesto, no un bug, pero era una capacidad real que faltaba.
 *
 * Diseño corregido tras auditoría (2026-09-03): la primera versión buscaba
 * el movimiento y llamaba reconciliarMovimiento directo, sin ningún botón
 * de por medio — la auditoría encontró que esto rompía un invariante real
 * de TODO el resto del sistema (crear/adjuntar/conciliar un gasto SIEMPRE
 * pasa por un botón que muestra el match exacto antes de escribir en
 * Holded, nunca se ejecuta solo porque el modelo decidió que el match
 * alcanzaba) — más grave todavía para el caso de match APROXIMADO, que el
 * propio buscarMovimientoAproximado documenta como "nunca se concilia sola,
 * solo se sugiere". Ahora esta tool solo busca el GASTO (único paso que no
 * tiene ya un flujo con botón) y reutiliza el flujo de confirmación que YA
 * existe (preguntarSiConciliar/gasto_conciliar_si, protegido en
 * ACCIONES_SENSIBLES) para el resto — la búsqueda del movimiento, el
 * match aproximado, y la escritura real quedan exactamente donde ya
 * estaban probados, sin duplicar esa lógica ni saltarse el botón.
 */
export const conciliarMovimientoTool: ToolDefinition = {
  name: "conciliar_movimiento_bancario",
  description:
    "Prepara la conciliación de un gasto ya registrado en Holded con su movimiento bancario — manda una " +
    "pregunta con botones (Sí/No) para que el usuario confirme antes de escribir nada, igual que el resto " +
    "de las escrituras de este sistema. Úsala cuando el usuario pida conciliar/vincular/enlazar un gasto " +
    "con un movimiento (típicamente después de identificarlos con consultar_movimientos_sin_conciliar y/o " +
    "consultar_gastos_sin_comprobante, o porque el usuario ya te dio los datos). Necesita el proveedor/" +
    "concepto del gasto tal como aparece en Holded, su monto, su fecha y la empresa — busca el gasto por " +
    "su cuenta y, si es un match único y claro, manda la pregunta. Si hay varios gastos parecidos, NUNCA " +
    "elige solo — te dice exactamente cuáles encontró para que confirmes cuál es.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa del grupo." },
      proveedor: {
        type: "string",
        description: "Proveedor/contacto del gasto en Holded, tal como aparece ahí (ej. 'UBER COLOMBIA').",
      },
      monto: { type: "number", description: "Importe del gasto." },
      fecha: { type: "string", description: "Fecha del gasto en formato YYYY-MM-DD." },
      moneda: { type: "string", description: "Código de moneda, ej. EUR, USD. Opcional, por defecto EUR." },
    },
    required: ["empresa", "proveedor", "monto", "fecha"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede preparar ninguna conciliación.";
    }

    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const proveedor = typeof input.proveedor === "string" ? input.proveedor.trim() : "";
    const monto = typeof input.monto === "number" ? input.monto : NaN;
    const fecha = typeof input.fecha === "string" ? input.fecha.trim() : "";
    const moneda = typeof input.moneda === "string" && input.moneda.trim() ? input.moneda.trim().toUpperCase() : "EUR";

    if (!proveedor || !Number.isFinite(monto) || !fecha) {
      return "Error: faltan datos — hacen falta proveedor, monto (número) y fecha (YYYY-MM-DD) del gasto.";
    }

    let candidatosGasto: Awaited<ReturnType<typeof buscarGastoSimilar>>;
    try {
      candidatosGasto = await buscarGastoSimilar(empresa, { proveedor, monto, fecha });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error buscando el gasto en Holded: ${message}`;
    }

    if (candidatosGasto.length === 0) {
      return `No encontré ningún gasto de "${proveedor}" por ${monto} ${moneda} cerca del ${fecha} en Holded (${empresa}) — confirma esos datos antes de reintentar.`;
    }
    if (candidatosGasto.length > 1) {
      const lista = candidatosGasto
        .map((c) => `  • ${c.contactName} — ${c.total.toFixed(2)} € (${c.fecha}) — ${c.descripcion} [id: ${c.id}]`)
        .join("\n");
      return `Encontré ${candidatosGasto.length} gastos parecidos, no sé cuál conciliar — dime cuál es:\n${lista}`;
    }

    const gasto = candidatosGasto[0];
    const descripcionGasto = `${gasto.contactName} — ${gasto.total.toFixed(2)} ${moneda}`;

    try {
      const pendiente = await guardarConciliacionPendiente({
        empresa,
        monto: gasto.total,
        fecha: gasto.fecha || fecha,
        descripcionGasto,
        chatId,
        gastoId: gasto.id,
        moneda,
        proveedor,
      });
      await sendTelegramMessageWithButtons(chatId, `¿Quieres que intente conciliar el movimiento bancario correspondiente a "${descripcionGasto}"?`, [
        [
          { text: "🔗 Sí, conciliar", callback_data: `gasto_conciliar_si:${pendiente.id}` },
          { text: "❌ No, dejar así", callback_data: `gasto_conciliar_no:${pendiente.id}` },
        ],
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Encontré el gasto (${descripcionGasto}) pero hubo un error preparando la pregunta de confirmación: ${message}`;
    }

    return `Encontré el gasto (${descripcionGasto}) y ya le mandé al usuario la pregunta de confirmación por Telegram con botones — no hace falta que la repitas ni que digas que ya se concilió, todavía falta que confirme.`;
  },
};
