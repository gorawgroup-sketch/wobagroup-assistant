import { buscarGastoSimilar, obtenerCompraHoldedPorId } from "../holded/write";
import { listBankMovements } from "../holded/client";
import { evaluarParElegido, numeroHolded } from "../gastos/parConciliacionElegida";
import { guardarConciliacionPendiente, obtenerConciliacionesPendientesPorChat, TTL_MS } from "../gastos/conciliacionPendienteStore";
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
    "elige solo — te dice exactamente cuáles encontró para que confirmes cuál es. Si en cambio piden " +
    "'conciliar/verificar el cashflow' de forma general (sin un gasto puntual en mente), esa es otra " +
    "pregunta — usa verificar_cashflow_actualizado. " +
    "TICKETS y gastos que no aparecen en el listado de compras (los que devuelve buscar_gastos_por_etiqueta_holded, " +
    "con su [id]): pasa `gasto_id` y se lee la compra directamente por id. Si el usuario YA identificó el par " +
    "(«concilia Transavia con Air France, es el mismo gasto»), pasa también `cuenta_id` y `movimiento_id` del cargo " +
    "(los da consultar_movimientos_sin_conciliar): se valida el par y se manda la pregunta «Conciliar con #1», aunque " +
    "el nombre, la fecha o la moneda del cargo sean distintos; al confirmar, el sistema alinea la moneda, concilia y aprende el par.",
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
      gasto_id: { type: "string", description: "Id de la compra/ticket en Holded (el [id] que devuelven las consultas). Con él no hacen falta proveedor, monto ni fecha." },
      cuenta_id: { type: "string", description: "Con movimiento_id: id de la cuenta bancaria del cargo elegido por el usuario." },
      movimiento_id: { type: "string", description: "Con cuenta_id: id del movimiento bancario que el usuario dice que corresponde a este gasto." },
      fecha_movimiento: { type: "string", description: "YYYY-MM-DD del cargo (opcional; ayuda a localizarlo si difiere de la fecha del gasto)." },
    },
    required: ["empresa"],
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

    let proveedor = typeof input.proveedor === "string" ? input.proveedor.trim() : "";
    const monto = typeof input.monto === "number" ? input.monto : NaN;
    const fecha = typeof input.fecha === "string" ? input.fecha.trim() : "";
    let moneda = typeof input.moneda === "string" && input.moneda.trim() ? input.moneda.trim().toUpperCase() : "EUR";
    const gastoId = typeof input.gasto_id === "string" ? input.gasto_id.trim() : "";
    const cuentaId = typeof input.cuenta_id === "string" ? input.cuenta_id.trim() : "";
    const movimientoId = typeof input.movimiento_id === "string" ? input.movimiento_id.trim() : "";
    const fechaMovimiento = typeof input.fecha_movimiento === "string" ? input.fecha_movimiento.trim() : "";

    let gasto: { id: string; contactName: string; total: number; fecha: string };
    if (gastoId) {
      // Por id: lee la compra directamente, así encuentra también los TICKETS (que /purchases no lista).
      let compra: Awaited<ReturnType<typeof obtenerCompraHoldedPorId>>;
      try {
        compra = await obtenerCompraHoldedPorId(empresa, gastoId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `No pude leer el gasto ${gastoId} en Holded (${empresa}): ${message}`;
      }
      const total = Math.abs(numeroHolded(compra.total));
      const contactName = (compra["contact_name"] as string | undefined) ?? proveedor ?? "";
      const fechaCompra = typeof compra.date === "string" ? compra.date.slice(0, 10) : fecha;
      if (!Number.isFinite(total) || total <= 0) return `El gasto ${gastoId} no tiene un total legible; no se prepara ninguna conciliación.`;
      moneda = (compra.currency || "EUR").toUpperCase().trim();
      proveedor = proveedor || contactName;
      gasto = { id: gastoId, contactName: contactName || proveedor, total, fecha: fechaCompra };

      if ((cuentaId && !movimientoId) || (!cuentaId && movimientoId)) {
        return "Error: para emparejar con un cargo concreto hacen falta cuenta_id y movimiento_id juntos.";
      }
      if (cuentaId && movimientoId) {
        // El usuario ya identificó el par: se valida y se manda «Conciliar con #1»; nunca se concilia sin el botón.
        const centro = fechaMovimiento || fechaCompra;
        const base = new Date(centro);
        if (Number.isNaN(base.getTime())) return "Error: fecha_movimiento no es una fecha válida (YYYY-MM-DD).";
        const desde = new Date(base.getTime() - 20 * 86_400_000).toISOString().slice(0, 10);
        const hasta = new Date(base.getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
        let movimiento: Awaited<ReturnType<typeof listBankMovements>>[number] | undefined;
        try {
          movimiento = (await listBankMovements(empresa, cuentaId, desde, hasta)).find((m) => m.id === movimientoId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `No pude leer el movimiento bancario en Holded (${empresa}): ${message}. No se preparó nada.`;
        }
        if (!movimiento) {
          return `No encontré el movimiento ${movimientoId} en la cuenta ${cuentaId} entre ${desde} y ${hasta}. Pasa fecha_movimiento con la fecha real del cargo.`;
        }
        const par = evaluarParElegido(compra, movimiento as never, cuentaId);
        if (par.estado === "rechazado") {
          return `No preparo esa conciliación: ${par.motivo}`;
        }
        try {
          const { ofrecerEleccionMovimientosAmbiguos } = await import("../gastos/gastoCallbackHandler");
          const descripcionPar = `${gasto.contactName} — ${gasto.total.toFixed(2)} ${moneda}`;
          const resultado = await ofrecerEleccionMovimientosAmbiguos(
            empresa, gastoId, descripcionPar, chatId, [par.candidato], false, true, proveedor, undefined, true, undefined
          );
          return `Preparé la conciliación elegida por el usuario: ${descripcionPar} ↔ «${par.candidato.descripcion}» ` +
            `(${(par.candidato.montoNativo ?? par.candidato.monto).toFixed(2)} ${par.candidato.monedaNativa ?? par.candidato.moneda}, ${par.candidato.fecha}). ` +
            `Ya le mandé por Telegram el botón «Conciliar con #1» — todavía falta que lo pulse; no digas que ya quedó conciliado. (${resultado.estado})`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `El par es válido pero hubo un error preparando la pregunta de confirmación: ${message}`;
        }
      }
    } else {
      if (!proveedor || !Number.isFinite(monto) || !fecha) {
        return "Error: faltan datos — hacen falta gasto_id, o bien proveedor, monto (número) y fecha (YYYY-MM-DD) del gasto.";
      }

      let candidatosGasto: Awaited<ReturnType<typeof buscarGastoSimilar>>;
      try {
        candidatosGasto = await buscarGastoSimilar(empresa, { proveedor, monto, fecha });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error buscando el gasto en Holded: ${message}`;
      }

      if (candidatosGasto.length === 0) {
        return `No encontré ningún gasto de "${proveedor}" por ${monto} ${moneda} cerca del ${fecha} en Holded (${empresa}) en el listado de compras. ` +
          `Si es un TICKET (no aparece en ese listado), búscalo con buscar_gastos_por_etiqueta_holded y vuelve a llamar con su gasto_id.`;
      }
      if (candidatosGasto.length > 1) {
        const lista = candidatosGasto
          .map((c) => `  • ${c.contactName} — ${c.total.toFixed(2)} € (${c.fecha}) — ${c.descripcion} [id: ${c.id}]`)
          .join("\n");
        return `Encontré ${candidatosGasto.length} gastos parecidos, no sé cuál conciliar — dime cuál es:\n${lista}`;
      }
      gasto = candidatosGasto[0];
    }
    const descripcionGasto = `${gasto.contactName} — ${gasto.total.toFixed(2)} ${moneda}`;

    try {
      // Hallazgo real de auditoría (2026-09-09, caso Anthropic/WOBA): esta tool creaba SIEMPRE una
      // fila nueva de conciliación pendiente, sin `deColaCorreo`/`mensajeIdGmail` (esta tool no tiene
      // forma de saber si el gasto viene de la cola de revisión de correo — solo lo busca por
      // proveedor/monto/fecha en Holded, sin ningún contexto de correo). Si el gasto YA tenía una
      // pregunta de conciliación pendiente real (creada por preguntarSiConciliar, que SÍ propaga esos
      // campos), esta tool generaba una SEGUNDA pregunta idéntica en apariencia — Carlos no tenía
      // forma de distinguir cuál tocar, y si tocaba esta segunda, la fila original (la que sí hace
      // avanzar la cola) quedaba huérfana para siempre: "te quedas pegado" sin preguntar por el
      // siguiente correo. Antes de crear una nueva, se reutiliza la que ya exista para este mismo
      // gasto — preserva sus campos reales (deColaCorreo/mensajeIdGmail) en vez de perderlos.
      // Hallazgo real de auditoría xhigh de este mismo fix: obtenerConciliacionesPendientesPorChat no
      // purga vencidas (esa purga solo ocurre, perezosa, dentro de guardarConciliacionPendiente) — sin
      // este chequeo, una pendiente vieja (>24h, aún no purgada) se reutilizaría igual, con su
      // deColaCorreo/mensajeIdGmail originales, resucitándola como mensaje nuevo. Si Carlos la
      // responde, avanzarColaCorreoSiActivo dispararía sobre lo que sea que esté activo en la cola EN
      // ESE MOMENTO — que puede no tener ninguna relación con el correo original de esa fila vieja,
      // exactamente el cross-wiring que TTL_MS (reducido de 3 días a 24h) ya existe para evitar.
      const pendientesDelChat = await obtenerConciliacionesPendientesPorChat(chatId);
      const yaPendiente = pendientesDelChat.find((p) => p.gastoId === gasto.id && Date.now() - p.creadoEn <= TTL_MS);

      const pendiente =
        yaPendiente ??
        (await guardarConciliacionPendiente({
          empresa,
          monto: gasto.total,
          fecha: gasto.fecha || fecha,
          descripcionGasto,
          chatId,
          gastoId: gasto.id,
          moneda,
          proveedor,
          // Esta herramienta parte de un gasto ya existente; no administra el soporte del correo.
          // El campo solo gobierna el cierre de la cola de email, que aquí siempre es false.
          comprobanteConfirmado: true,
        }));

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
