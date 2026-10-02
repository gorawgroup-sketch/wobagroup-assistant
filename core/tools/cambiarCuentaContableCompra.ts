import { obtenerPlanContable } from "../holded/accounting";
import { estadoRealCompra } from "../holded/automatizacion/tickets";
import { crearPendienteEdicionCompraHolded, actualizarMessageIdEdicionCompraHolded } from "../holded/pendienteEdicionCompraHoldedStore";
import { resolverCuentaContable } from "../holded/resolverCuentaContable";
import { buscarDocumentosHolded, obtenerCompraHoldedPorId } from "../holded/write";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

/**
 * Cambiar la cuenta contable de un gasto YA CREADO en Holded (pedido de Carlos, caso real 2026-10-02: un gasto de
 * Anthropic quedó en «Gastos de Viaje» en vez de «Otros servicios»). Igual que toda escritura de este sistema, NUNCA
 * edita por sí sola: valida la cuenta contra el plan contable real, muestra el antes/después con botones y solo
 * escribe tras «Confirmar». Reutiliza los botones y la edición verificada de proponer_edicion_compra_holded; al
 * confirmar, la corrección se aprende para ese proveedor (ver edicionCompraHoldedCallbackHandler.ts).
 */
export const cambiarCuentaContableCompraTool: ToolDefinition = {
  name: "proponer_cambio_cuenta_contable_compra",
  description:
    "Propone cambiar la CUENTA CONTABLE de un gasto/compra YA CREADO en Holded (nunca lo cambia directo: muestra la " +
    "propuesta con botones Confirmar/Cancelar). Úsala cuando pidan corregir la cuenta contable de un gasto " +
    "(ej. «este gasto de Anthropic no es gasto de viaje, es Otros servicios»). Al confirmar, WOBI aprende esa cuenta " +
    "para ese proveedor. Si el gasto es un ticket (no aparece en el listado de compras) hay que dar su 'compra_id'. " +
    "Si hay varias compras parecidas te devuelve la lista para que el usuario aclare cuál es; nunca adivines.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa del grupo cuyo Holded se edita." },
      cuenta_contable_nueva: { type: "string", description: "Cuenta contable correcta: nombre exacto («Otros servicios») o número («62900000»)." },
      compra_id: { type: "string", description: "Id de la compra en Holded, si se conoce (obligatorio para tickets). Con él no hace falta 'contacto'." },
      contacto: { type: "string", description: "Nombre (o parte) del proveedor, para buscar la compra cuando no se da 'compra_id'." },
      monto_actual_aproximado: { type: "number", description: "Monto total actual de la compra, para acotar la búsqueda por proveedor." },
    },
    required: ["empresa", "cuenta_contable_nueva"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram donde mostrar la propuesta.";
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    const textoCuenta = typeof input.cuenta_contable_nueva === "string" ? input.cuenta_contable_nueva : "";
    const compraIdDado = typeof input.compra_id === "string" ? input.compra_id.trim() : "";
    const contacto = typeof input.contacto === "string" ? input.contacto.trim() : "";
    if (!compraIdDado && !contacto) return "Error: hace falta 'compra_id' o 'contacto' para localizar el gasto.";

    const plan = await obtenerPlanContable(empresa);
    const resuelta = resolverCuentaContable(plan, textoCuenta);
    if (!resuelta.ok) return resuelta.motivo;
    const cuentaNueva = resuelta.cuenta;

    // Localizar el gasto: por id (sirve también para tickets) o por proveedor (solo compras visibles en el listado).
    let compraId = compraIdDado;
    if (!compraId) {
      const montoAprox = typeof input.monto_actual_aproximado === "number" ? input.monto_actual_aproximado : undefined;
      const encontrados = await buscarDocumentosHolded(empresa, { contacto, monto: montoAprox, tipo: "gasto", dias: 365 });
      if (encontrados.length === 0) return `No encontré ninguna compra de "${contacto}" en Holded (${empresa}) en el último año. Si es un ticket no aparece en el listado: dame su id.`;
      if (encontrados.length > 1) {
        const lista = encontrados.map((d, i) => `${i + 1}. id ${d.id} — ${d.contactName}, ${d.total.toFixed(2)} ${d.moneda}, doc "${d.documentNumber || "(sin número)"}", ${d.fecha}`).join("\n");
        return `Encontré ${encontrados.length} compras de "${contacto}"; dime cuál es (con su id):\n${lista}`;
      }
      if (encontrados[0].coincidenciaSoloPorMonto) return `No encontré compras de "${contacto}" por nombre; la única que coincide por monto es de otro proveedor (${encontrados[0].contactName}). Dame el id exacto.`;
      compraId = encontrados[0].id;
    }

    const compra = await obtenerCompraHoldedPorId(empresa, compraId);
    const lineas = compra.lines ?? [];
    if (lineas.length === 0) return "El gasto no tiene líneas; no hay cuenta que cambiar.";
    const cuentasActuales = [...new Set(lineas.map((l) => String((l as { account?: string }).account ?? "")))];
    if (cuentasActuales.length === 1 && cuentasActuales[0] === cuentaNueva.id) return `Ese gasto ya está en la cuenta ${cuentaNueva.number} ${cuentaNueva.name}; no hay nada que cambiar.`;
    const nombreCuenta = (id: string) => { const c = plan.find((x) => x.id === id); return c ? `${c.number} ${c.name}` : "(cuenta desconocida)"; };
    const antesTexto = cuentasActuales.map(nombreCuenta).join(" + ");
    const proveedor = String((compra as unknown as { contact_name?: string }).contact_name ?? contacto ?? "");
    const moneda = (compra.currency ?? "EUR").toUpperCase();
    const resumenAntes = `${proveedor} — ${Number(String(compra.total ?? 0).replace(",", ".")).toFixed(2)} ${moneda}, doc "${compra.document_number || "(sin número)"}", ${compra.date ?? ""} · cuenta ${antesTexto}`;
    const eraTicket = (await estadoRealCompra(empresa, compraId).catch(() => ({ estado: "factura" as const }))).estado === "ticket";

    const pendiente = await crearPendienteEdicionCompraHolded({
      chatId, messageId: 0, empresa, purchaseId: compraId,
      cambios: { cuentaIdNueva: cuentaNueva.id, meta: { proveedor, cuentaNombre: `${cuentaNueva.number} ${cuentaNueva.name}`, eraTicket } },
      resumenAntes,
    });
    const texto =
      `✏️ *Cambio de cuenta contable en Holded* — ${resumenAntes}\n\n` +
      `Cambiar la cuenta de TODAS las líneas a: ${cuentaNueva.number} ${cuentaNueva.name}.\n\n` +
      `Es el mismo documento (id ${compraId}); el comprobante, el cobro y la conciliación no se tocan.` +
      (eraTicket ? "\n\n🧾 Es un ticket: tras guardar comprobaré que siga siendo ticket." : "") +
      "\n\nAl confirmar, WOBI aprenderá esta cuenta para este proveedor.";
    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [[
      { text: "✅ Confirmar cambio", callback_data: `edicioncompra_confirmar:${pendiente.id}` },
      { text: "❌ Cancelar", callback_data: `edicioncompra_cancelar:${pendiente.id}` },
    ]]);
    await actualizarMessageIdEdicionCompraHolded(pendiente.id, messageId);
    return "Propuesta de cambio de cuenta mostrada por Telegram con botones — no se cambió nada todavía, falta la aprobación.";
  },
};
