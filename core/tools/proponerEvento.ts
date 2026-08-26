import { sendTelegramMessageWithButtons } from "../telegram/client";
import { crearPropuestaEvento, actualizarMessageIdEvento } from "../crm/eventoProposalSheet";
import { buscarContactoHolded } from "../holded/write";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Suma minutos a "HH:mm" usando aritmética de calendario pura (Date.UTC como
 * calculadora, nunca como instante real) — evita cualquier conversión de
 * timezone del proceso, que es la clase de bug ya conocida en este proyecto. */
function sumarMinutos(fecha: string, hora: string, minutos: number): { fecha: string; hora: string } {
  const [y, m, d] = fecha.split("-").map(Number);
  const [hh, mm] = hora.split(":").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, hh, mm + minutos));
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    fecha: `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`,
    hora: `${pad(base.getUTCHours())}:${pad(base.getUTCMinutes())}`,
  };
}

export const proponerEventoCalendarioTool: ToolDefinition = {
  name: "proponer_evento_calendario",
  description:
    "Prepara una actividad (llamada, reunión, recordatorio, vencimiento, etc.) para el calendario CRM de " +
    "Holded (WOBA, EWORKS o Footprint) y la muestra por Telegram con botones para aprobar o cancelar. Úsala " +
    "cuando te pidan programar, agendar o poner algo en el calendario — nunca respondas que no puedes " +
    "acceder al calendario: en vez de eso, usa esta herramienta para proponerlo. NUNCA crea el evento al " +
    "llamar esta herramienta, solo cuando el usuario aprueba el botón '✅ Programar' después.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa cuyo calendario de Holded corresponde." },
      nombre: { type: "string", description: "Título corto de la actividad, ej. 'Llamada con Proveedor X'." },
      fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD, en hora local de Madrid (interpreta 'el jueves', 'mañana', etc. contra la fecha actual)." },
      hora_inicio: { type: "string", description: "Hora de inicio en formato HH:mm (24h), hora local de Madrid." },
      hora_fin: { type: "string", description: "Hora de fin en formato HH:mm (24h). Opcional — si no se indica, se asume 30 minutos después de hora_inicio." },
      tipo: {
        type: "string",
        description:
          "Tipo de actividad, texto libre (Holded no valida un catálogo fijo). Usa 'call' para llamadas, " +
          "'meeting' para reuniones, 'recordatorio' para avisos generales, o 'renovaciondecontrato' para " +
          "vencimientos/renovaciones de contrato — si no está claro, usa 'recordatorio'.",
      },
      descripcion: { type: "string", description: "Notas o detalle adicional de la actividad. Opcional." },
      proveedor_o_contacto: {
        type: "string",
        description: "Nombre del proveedor/cliente de Holded a vincular, si aplica (se busca por nombre parcial). Opcional.",
      },
      ubicacion: { type: "string", description: "Lugar de la actividad, si aplica. Opcional." },
    },
    required: ["empresa", "nombre", "fecha", "hora_inicio"],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) {
      return "Error: no se pudo determinar el chat de Telegram donde mostrar la propuesta.";
    }

    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const nombre = typeof input.nombre === "string" ? input.nombre.trim() : "";
    const fecha = typeof input.fecha === "string" ? input.fecha.trim() : "";
    const horaInicio = typeof input.hora_inicio === "string" ? input.hora_inicio.trim() : "";

    if (!nombre) return "Error: falta 'nombre' para la actividad.";
    if (!FECHA_RE.test(fecha)) return "Error: 'fecha' debe tener formato YYYY-MM-DD.";
    if (!HORA_RE.test(horaInicio)) return "Error: 'hora_inicio' debe tener formato HH:mm (24h).";

    let horaFinRaw = typeof input.hora_fin === "string" ? input.hora_fin.trim() : "";
    let fechaFin = fecha;
    if (horaFinRaw && !HORA_RE.test(horaFinRaw)) {
      return "Error: 'hora_fin' debe tener formato HH:mm (24h).";
    }
    if (!horaFinRaw) {
      const sumado = sumarMinutos(fecha, horaInicio, 30);
      fechaFin = sumado.fecha;
      horaFinRaw = sumado.hora;
    }

    const tipo = typeof input.tipo === "string" && input.tipo.trim() ? input.tipo.trim() : "recordatorio";
    const descripcion = typeof input.descripcion === "string" ? input.descripcion.trim() : "";
    const ubicacion = typeof input.ubicacion === "string" ? input.ubicacion.trim() : "";
    const proveedorBuscado = typeof input.proveedor_o_contacto === "string" ? input.proveedor_o_contacto.trim() : "";

    let contactId: string | undefined;
    let contactNombre: string | undefined;
    if (proveedorBuscado) {
      try {
        const contacto = await buscarContactoHolded(empresa, proveedorBuscado);
        if (contacto) {
          contactId = contacto.id;
          contactNombre = contacto.name;
        }
      } catch (error) {
        console.error("[proponerEventoCalendarioTool] Error buscando contacto en Holded:", error);
      }
    }

    const fechaInicioISO = `${fecha}T${horaInicio}:00`;
    const fechaFinISO = `${fechaFin}T${horaFinRaw}:00`;

    const propuesta = await crearPropuestaEvento({
      empresa,
      nombre,
      tipo,
      descripcion,
      fechaInicio: fechaInicioISO,
      fechaFin: fechaFinISO,
      contactId,
      contactNombre,
      ubicacion,
      chatId,
      messageId: 0,
    });

    const texto = [
      `📅 *Actividad propuesta para el calendario de ${empresa}*`,
      ``,
      `Título: ${nombre}`,
      `Tipo: ${tipo}`,
      `Fecha: ${fecha}, ${horaInicio}–${horaFinRaw}${fechaFin !== fecha ? ` (termina ${fechaFin})` : ""}`,
      ...(contactNombre ? [`Contacto vinculado: ${contactNombre}`] : proveedorBuscado ? [`⚠️ No encontré "${proveedorBuscado}" entre los contactos de Holded — se creará sin vincular.`] : []),
      ...(ubicacion ? [`Ubicación: ${ubicacion}`] : []),
      ...(descripcion ? [`Notas: ${descripcion}`] : []),
    ].join("\n");

    const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
      [
        { text: "✅ Programar", callback_data: `evento_confirmar:${propuesta.id}` },
        { text: "❌ Cancelar", callback_data: `evento_cancelar:${propuesta.id}` },
      ],
    ]);

    await actualizarMessageIdEvento(propuesta.id, messageId);

    return "Propuesta de actividad preparada y mostrada al usuario por Telegram con botones para aprobar o cancelar.";
  },
};
