import { unlink } from "node:fs/promises";
import { consumirGastoPendienteDatosPorChat, guardarGastoPendienteDatos } from "../gastos/gastoPendienteDatosStore";
import { procesarGastoEntrante } from "../gastos/procesarGastoEntrante";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import type { ToolDefinition } from "./types";

const EMPRESAS = ["WOBA", "EWORKS", "Footprint"] as const;

/**
 * Pedido explícito de Carlos, tras un caso real: una factura de Panamá
 * (MERA AEROPUERTO DE PANAMA SA, 17.95 USD) llegó en dólares sin un
 * equivalente explícito en el documento — procesarGastoEntrante le
 * preguntó a Carlos el monto/moneda real, pero antes de esta tool esa
 * pregunta no quedaba guardada en ningún lado, así que su respuesta en
 * texto libre ("el documento trae el valor exacto en dolares de 17.95") no
 * podía retomar el proceso: cada intento releía el documento desde cero y
 * volvía a hacer la misma pregunta — dos veces seguidas, sin nunca llegar
 * a mandar la propuesta con botón que Carlos esperaba. Esta tool cierra
 * ese hueco, igual que reintentar_contacto_pendiente lo hace para
 * proveedores no encontrados.
 */
export const reintentarGastoPendienteTool: ToolDefinition = {
  name: "reintentar_gasto_pendiente",
  description:
    "Retoma el procesamiento de una factura/gasto que quedó pendiente porque faltaba un dato (la empresa o " +
    "el monto/moneda equivalente) o porque falló la verificación estricta de duplicados en Holded. Úsala cuando el usuario responda " +
    "en texto libre a esa pregunta pendiente (ej. 'son 17.95 USD', 'es de Footprint', 'son 40 euros'). Nunca " +
    "vuelvas a pedir que reenvíen el documento — ya se leyó, solo falta el dato puntual que el usuario acaba " +
    "de dar. Si el dato que falta era la empresa, pásala en 'empresa'. Si era el monto/moneda equivalente, " +
    "pasa ambos en 'monto_equivalente' y 'moneda_equivalente'.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: [...EMPRESAS], description: "La empresa que el usuario acaba de confirmar, si eso era lo que faltaba." },
      monto_equivalente: {
        type: "number",
        description: "El monto exacto en la moneda real de la tarjeta/cuenta, tal como lo acaba de confirmar el usuario.",
      },
      moneda_equivalente: {
        type: "string",
        description: "La moneda (ej. EUR, USD) de monto_equivalente, tal como la confirmó el usuario.",
      },
    },
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede reintentar ningún gasto pendiente.";
    }

    const pendiente = await consumirGastoPendienteDatosPorChat(chatId);
    if (!pendiente) {
      return "No hay ninguna pregunta de factura/gasto sin responder pendiente para este chat (puede que ya se haya procesado, o que haya expirado).";
    }

    const datos = { ...pendiente.datos };
    const empresa = typeof input.empresa === "string" ? input.empresa : undefined;
    const montoEquivalente = typeof input.monto_equivalente === "number" ? input.monto_equivalente : undefined;
    const monedaEquivalente = typeof input.moneda_equivalente === "string" ? input.moneda_equivalente : undefined;

    if (pendiente.motivo === "empresa" && empresa && (EMPRESAS as readonly string[]).includes(empresa)) {
      datos.empresaProbable = empresa as (typeof EMPRESAS)[number];
    }
    if (pendiente.motivo === "moneda" && montoEquivalente !== undefined && monedaEquivalente) {
      datos.montoEquivalente = montoEquivalente;
      datos.monedaEquivalente = monedaEquivalente;
    }

    let resultado: Awaited<ReturnType<typeof procesarGastoEntrante>>;
    try {
      resultado = await procesarGastoEntrante({
        chatId,
        rutaLocal: pendiente.rutaLocal,
        nombreArchivoOriginal: pendiente.nombreArchivoOriginal,
        mimeType: pendiente.mimeType,
        datos,
        deColaCorreo: pendiente.deColaCorreo,
        correoOrigen: pendiente.correoOrigen,
        origenAdjuntoGmail: pendiente.origenAdjuntoGmail,
      });
    } catch (error) {
      // Se reinserta el pendiente para no perderlo por un error transitorio.
      await guardarGastoPendienteDatos({ ...pendiente }).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      return `Error procesando el gasto: ${message}. La pregunta sigue pendiente, se puede reintentar.`;
    }

    if (resultado === "pendiente_datos") {
      // Seguía faltando el mismo dato (o el usuario no dio lo que hacía
      // falta) — procesarGastoEntrante ya volvió a preguntar y a persistir
      // el pendiente, así que no hay que hacer nada más acá.
      return pendiente.motivo === "verificacion_duplicado"
        ? "La verificación estricta de duplicados todavía no pudo completarse. No se propuso ni creó el gasto y el reintento quedó guardado."
        : "El dato dado no era suficiente (o no correspondía a lo que faltaba) — se le volvió a preguntar al usuario y la pregunta sigue pendiente.";
    }

    if (resultado === "propuesta_duplicada" && pendiente.deColaCorreo) {
      await avanzarColaCorreoSiActivo(chatId, {
        threadId: pendiente.correoOrigen?.threadId,
        mensajeId: pendiente.correoOrigen?.mensajeIdGmail,
      }, `gasto-pendiente-datos:${pendiente.id}:resolver`);
    }

    if (resultado === "propuesta_pendiente_existente") {
      return "La factura ya tiene una propuesta pendiente de decisión. No se creó otra y el correo seguirá sin leer hasta que esa propuesta se resuelva.";
    }

    return resultado === "propuesta_duplicada"
      ? "Listo — la revisión encontró evidencia de que el gasto ya existe o está conciliado. No se creó ni se propuso otro gasto."
      : "Listo — con el dato que dio el usuario, ya se mandó la propuesta con botón para crear el gasto en Holded. No hace falta que lo repitas, ya se le mostró por Telegram.";
  },
};

/**
 * Caso real reportado por Carlos (Footprint, factura de Uber por 5690 CRC sin equivalente en EUR/USD
 * en el correo): este tipo de pendiente (falta empresa, o falta el monto/moneda exacto de la
 * tarjeta) nunca genera una propuesta con botones, así que "🗑️ Descartar todo" del resumen de fin de
 * día lo excluye a propósito (ver resumenPendientesDiario.ts — mismo criterio que resolucionContacto/
 * edicionCompraHolded, que sí traen dinero real). Pero hasta esta tool no existía NINGUNA forma de
 * cerrarlo cuando el usuario confirma que no tiene el dato que falta y no lo va a conseguir (ni
 * releyendo el correo/adjunto original, ni encontrando un cargo bancario real que calce) — el
 * pendiente se quedaba acumulado sin ninguna vía real de cierre desde el chat. Mismo patrón que
 * descartar_documento_pendiente: nunca crea el gasto, solo limpia la pregunta y la copia local.
 */
export const descartarGastoPendienteDatosTool: ToolDefinition = {
  name: "descartar_gasto_pendiente_datos",
  description:
    "Descarta (sin crear ni proponer ningún gasto) una factura/gasto que quedó pendiente porque faltaba " +
    "un dato (la empresa, o el monto/moneda exacto de la tarjeta/cuenta en una factura de moneda " +
    "extranjera) — úsala SOLO cuando el usuario confirme explícitamente que no tiene ese dato y no lo va " +
    "a conseguir (ej. 'no lo tengo', 'no lo voy a conseguir', 'los datos son los que tú mismo lees en el " +
    "mail, si ahí no está, no lo conozco', 'descártalo'), o cuando una búsqueda proactiva en los " +
    "movimientos bancarios reales (holded_movimientos / movimientos_sin_conciliar) no encontró ningún " +
    "cargo sin conciliar que calce razonablemente y el usuario acepta cerrarlo así. No la uses solo " +
    "porque tú no encontraste el dato — primero pregúntale al usuario si lo tiene o si quiere que se " +
    "descarte.",
  input_schema: { type: "object", properties: {} },
  handler: async (_input, context) => {
    const chatId = context?.chatId;
    if (chatId === undefined) {
      return "Error: no se pudo determinar el chat — no se puede descartar ningún gasto pendiente.";
    }

    const pendiente = await consumirGastoPendienteDatosPorChat(chatId);
    if (!pendiente) {
      return "No hay ninguna pregunta de factura/gasto sin responder pendiente para este chat (puede que ya se haya procesado, o que haya expirado).";
    }

    await unlink(pendiente.rutaLocal).catch(() => {});

    if (pendiente.deColaCorreo) {
      await avanzarColaCorreoSiActivo(chatId, {
        threadId: pendiente.correoOrigen?.threadId,
        mensajeId: pendiente.correoOrigen?.mensajeIdGmail,
      }, `gasto-pendiente-datos:${pendiente.id}:resolver`);
    }

    return (
      `Descartado: "${pendiente.datos.proveedor}" (${pendiente.datos.monto} ${pendiente.datos.moneda}) — no se creó ni ` +
      "se propuso ningún gasto en Holded. No hace falta que lo repitas, ya se le puede confirmar al usuario."
    );
  },
};
