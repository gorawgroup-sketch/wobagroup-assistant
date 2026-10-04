import { estadoRealCompra } from "../holded/automatizacion/tickets";
import { crearPendienteEdicionCompraHolded, actualizarMessageIdEdicionCompraHolded } from "../holded/pendienteEdicionCompraHoldedStore";
import { buscarContactoHolded, buscarContactosParecidos, buscarDocumentosHolded, obtenerCompraHoldedPorId, tasaCambioParaEdicion } from "../holded/write";
import { normalizarNombreProveedor } from "../holded/cambioProveedorCompra";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

/**
 * Cambiar el PROVEEDOR (contacto) de un gasto YA CREADO en Holded (pedido de Carlos, caso real 2026-10-04: un recibo de
 * «Management Group Investors LLC», Puerto Rico, quedó a nombre de «Madrid Hotel 101 Spain Management, S.L.U.»). Como toda
 * escritura de este sistema, NUNCA edita por sí sola: valida, muestra el antes/después con botones y solo escribe tras
 * «Confirmar». Reutiliza los botones y la edición verificada de proponer_edicion_compra_holded (el contacto entra en la huella
 * de verificación); el contacto nuevo, si no existe, se crea DESPUÉS de la aprobación y con la creación durable e idempotente.
 */
export const cambiarProveedorCompraTool: ToolDefinition = {
  name: "proponer_cambio_proveedor_compra",
  description:
    "Propone cambiar el PROVEEDOR (contacto) de un gasto/compra YA CREADO en Holded (nunca lo cambia directo: muestra la " +
    "propuesta con botones Confirmar/Cancelar). Úsala cuando pidan corregir a qué proveedor está asignado un gasto " +
    "(ej. «el desayuno de Puerto Rico está a nombre del Madrid Hotel, el proveedor es Management Group Investors LLC»). " +
    "Si el proveedor correcto no existe en Holded y el usuario pide crearlo, pasa crear_si_no_existe=true: se crea solo tras " +
    "confirmar, sin NIF. Al confirmar, WOBI corrige el alias aprendido para que el error no se repita. Si el gasto es un ticket " +
    "(no sale en el listado) hay que dar su 'compra_id'. Si hay varias compras parecidas devuelve la lista; nunca adivines cuál.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa del grupo cuyo Holded se edita." },
      proveedor_nuevo: { type: "string", description: "Nombre exacto del proveedor correcto (el contacto de Holded, o el nombre con el que crearlo)." },
      compra_id: { type: "string", description: "Id de la compra en Holded, si se conoce (obligatorio para tickets)." },
      contacto_actual: { type: "string", description: "Nombre (o parte) del proveedor ACTUAL de la compra, para buscarla cuando no se da 'compra_id'." },
      monto_actual_aproximado: { type: "number", description: "Monto total actual, para acotar la búsqueda." },
      nombre_leido_del_comprobante: { type: "string", description: "Cómo aparece el proveedor en el comprobante, si difiere de proveedor_nuevo (para corregir el alias aprendido)." },
      crear_si_no_existe: { type: "boolean", description: "true solo si el usuario pidió expresamente crear el proveedor cuando no exista." },
    },
    required: ["empresa", "proveedor_nuevo"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram donde mostrar la propuesta.";
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    const nombreNuevo = typeof input.proveedor_nuevo === "string" ? input.proveedor_nuevo.trim() : "";
    if (nombreNuevo.length < 3) return "Error: falta el nombre del proveedor correcto.";
    const compraIdDado = typeof input.compra_id === "string" ? input.compra_id.trim() : "";
    const contactoActual = typeof input.contacto_actual === "string" ? input.contacto_actual.trim() : "";
    if (!compraIdDado && !contactoActual) return "Error: hace falta 'compra_id' o 'contacto_actual' para localizar el gasto.";
    const crearSiNoExiste = input.crear_si_no_existe === true;
    const nombreLeido = typeof input.nombre_leido_del_comprobante === "string" && input.nombre_leido_del_comprobante.trim()
      ? input.nombre_leido_del_comprobante.trim() : nombreNuevo;

    let compraId = compraIdDado;
    if (!compraId) {
      const montoAprox = typeof input.monto_actual_aproximado === "number" ? input.monto_actual_aproximado : undefined;
      const encontrados = await buscarDocumentosHolded(empresa, { contacto: contactoActual, monto: montoAprox, tipo: "gasto", dias: 365 });
      if (encontrados.length === 0) return `No encontré ninguna compra de "${contactoActual}" en Holded (${empresa}) en el último año. Si es un ticket no aparece en el listado: dame su id.`;
      if (encontrados.length > 1) {
        const lista = encontrados.map((d, i) => `${i + 1}. id ${d.id} — ${d.contactName}, ${d.total.toFixed(2)} ${d.moneda}, doc "${d.documentNumber || "(sin número)"}", ${d.fecha}`).join("\n");
        return `Encontré ${encontrados.length} compras de "${contactoActual}"; dime cuál es (con su id):\n${lista}`;
      }
      if (encontrados[0].coincidenciaSoloPorMonto) return `No encontré compras de "${contactoActual}" por nombre; la única que coincide por monto es de otro proveedor (${encontrados[0].contactName}). Dame el id si es esa.`;
      compraId = encontrados[0].id;
    }

    const compra = await obtenerCompraHoldedPorId(empresa, compraId);
    const moneda = (compra.currency ?? "EUR").toUpperCase();
    const viejoId = String(compra.contact_id ?? "");
    const viejoNombre = String((compra as unknown as { contact_name?: string }).contact_name ?? contactoActual ?? "");
    if (!viejoId) return "Ese gasto no tiene un proveedor asignado; no hay nada que corregir con esta herramienta.";

    // Solo se acepta un contacto existente con EXACTAMENTE ese nombre (sin tildes ni mayúsculas): nada de adivinar por parecido.
    const objetivo = normalizarNombreProveedor(nombreNuevo);
    let existente = await buscarContactoHolded(empresa, nombreNuevo).catch(() => undefined);
    if (!existente || normalizarNombreProveedor(existente.name ?? "") !== objetivo) {
      const parecidos = await buscarContactosParecidos(empresa, nombreNuevo, 8).catch(() => []);
      existente = parecidos.find((c) => normalizarNombreProveedor(c.name ?? "") === objetivo);
      if (!existente && parecidos.length > 0 && !crearSiNoExiste) {
        return `No hay un contacto llamado exactamente "${nombreNuevo}" en Holded (${empresa}). Hay nombres parecidos:\n` +
          parecidos.slice(0, 5).map((c) => `- ${c.name} (id ${c.id})`).join("\n") +
          `\n\nPregunta cuál es el correcto, o si hay que crearlo nuevo (crear_si_no_existe=true). No se cambió nada.`;
      }
    }
    if (!existente && !crearSiNoExiste) return `No existe un contacto llamado "${nombreNuevo}" en Holded (${empresa}). Si hay que crearlo, pídeselo al usuario y vuelve a llamar con crear_si_no_existe=true. No se cambió nada.`;
    if (existente && existente.id === viejoId) return `Ese gasto ya está a nombre de "${existente.name}"; no hay nada que cambiar.`;

    // Una edición de una compra pagada en divisa solo es segura si su tipo de cambio se puede preservar al céntimo.
    try { tasaCambioParaEdicion(compra); } catch (error) {
      return `No es seguro editar este gasto ahora: ${error instanceof Error ? error.message : String(error)} No se cambió nada.`;
    }

    const eraTicket = (await estadoRealCompra(empresa, compraId).catch(() => ({ estado: "factura" as const }))).estado === "ticket";
    const resumenAntes = `${viejoNombre} — ${String(compra.total ?? "")} ${moneda}, doc "${compra.document_number || "(sin número)"}", ${compra.date ?? ""}`;
    const pendiente = await crearPendienteEdicionCompraHolded({
      chatId, messageId: 0, empresa, purchaseId: compraId,
      cambios: {
        ...(existente ? { contactoIdNuevo: existente.id } : {}),
        meta: {
          proveedor: nombreNuevo, cuentaNombre: "", eraTicket,
          cambioProveedor: { contactoViejoId: viejoId, contactoViejoNombre: viejoNombre, nombreNuevo: existente?.name ?? nombreNuevo, nombreLeido, moneda, crearSiNoExiste: !existente },
        },
      },
      resumenAntes,
    });
    const texto =
      `✏️ *Cambio de proveedor en Holded* — ${resumenAntes}\n\n` +
      `Proveedor ahora: ${viejoNombre}\nProveedor nuevo: ${existente?.name ?? nombreNuevo}${existente ? "" : " (contacto NUEVO: se crea al confirmar, sin NIF)"}\n\n` +
      `Es el mismo documento (id ${compraId}); el importe, el comprobante, el cobro y la conciliación no se tocan.` +
      (eraTicket ? "\n\n🧾 Es un ticket: tras guardar comprobaré que siga siendo ticket." : "") +
      `\n\nAl confirmar, WOBI corrige el alias aprendido ("${nombreLeido}") para que el próximo comprobante vaya al proveedor correcto.`;
    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [[
      { text: "✅ Confirmar cambio", callback_data: `edicioncompra_confirmar:${pendiente.id}` },
      { text: "❌ Cancelar", callback_data: `edicioncompra_cancelar:${pendiente.id}` },
    ]]);
    await actualizarMessageIdEdicionCompraHolded(pendiente.id, messageId);
    return "Propuesta de cambio de proveedor mostrada por Telegram con botones — no se cambió nada todavía, falta la aprobación.";
  },
};
