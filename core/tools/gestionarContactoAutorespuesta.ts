import {
  agregarContactoAutorespuesta,
  quitarContactoAutorespuesta,
  listarContactosAutorespuesta,
} from "../gmail/autorespuestaContactoStore";
import type { ToolDefinition } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pedido explícito de Carlos: gestionar por chat la lista de contactos
 * ELEGIBLES para conversación automática por correo (Wobi les puede
 * responder solo, sin pedir aprobación por mensaje — a diferencia de todo el
 * resto de correo). Agregar a alguien acá NO activa automáticamente todos
 * sus correos: cada HILO/conversación de ese contacto todavía se pregunta
 * una sola vez (ver hiloAutorespuestaStore.ts / revisarConversacionesAutomaticas.ts)
 * antes de tratarse como automático — pedido explícito de Carlos, tras
 * usarlo: "puedes recibir varios e-mails de la misma persona y no en todos
 * debes responder automáticamente". Cada agregado a esta lista es una
 * decisión explícita y consciente de Carlos — esta tool nunca decide sola a
 * quién agregar, solo ejecuta lo que él pida literalmente.
 */
export const gestionarContactoAutorespuestaTool: ToolDefinition = {
  name: "gestionar_contacto_autorespuesta",
  seguraParaModoRapido: true,
  description:
    "Agrega, quita o lista los contactos ELEGIBLES para conversación automática por correo. Agregar a " +
    "alguien no responde automáticamente TODOS sus correos — cada conversación/hilo específico de ese " +
    "contacto se pregunta una sola vez por Telegram antes de volverse automática, así que un mismo " +
    "contacto puede tener algunos hilos automáticos y otros no. Úsala SOLO cuando el usuario pida " +
    "explícitamente agregar/quitar a alguien de esta lista o preguntar quién está en ella — nunca " +
    "agregues a nadie por tu cuenta ni infieras que alguien debería estar. Si el usuario da un nombre " +
    "sin el email exacto, pídeselo antes de llamar esta herramienta (no adivines el dominio/dirección).",
  input_schema: {
    type: "object",
    properties: {
      accion: { type: "string", enum: ["agregar", "quitar", "listar"], description: "Qué hacer." },
      email: { type: "string", description: "Email exacto del contacto. Requerido para 'agregar'/'quitar'." },
      nombre: { type: "string", description: "Nombre del contacto, para identificarlo en avisos. Solo para 'agregar'." },
    },
    required: ["accion"],
  },
  handler: async (input) => {
    const accion = input.accion as string;

    if (accion === "listar") {
      const contactos = await listarContactosAutorespuesta();
      if (contactos.length === 0) return "No hay ningún contacto en la lista de conversación automática todavía.";
      return `Contactos con conversación automática (${contactos.length}):\n${contactos.map((c) => `- ${c.nombre || "(sin nombre)"} — ${c.email}`).join("\n")}`;
    }

    const email = typeof input.email === "string" ? input.email.trim() : "";
    if (!email) return "Error: falta 'email'.";
    if (!EMAIL_RE.test(email)) return `Error: "${email}" no parece un email válido.`;

    if (accion === "agregar") {
      const nombre = typeof input.nombre === "string" ? input.nombre.trim() : "";
      await agregarContactoAutorespuesta(email, nombre);
      return `✅ Agregado — ${nombre || email} (${email}) ya es elegible. Cuando llegue una conversación nueva de esta persona, te pregunto una sola vez si esa conversación en particular debe ser automática (con la leyenda de respuesta automática al final) — no se activa todo de una.`;
    }

    if (accion === "quitar") {
      const quitado = await quitarContactoAutorespuesta(email);
      return quitado
        ? `✅ Quitado — ${email} ya no tiene conversación automática, vuelve al flujo normal de correo.`
        : `${email} no estaba en la lista de conversación automática.`;
    }

    return "Error: 'accion' debe ser 'agregar', 'quitar' o 'listar'.";
  },
};
