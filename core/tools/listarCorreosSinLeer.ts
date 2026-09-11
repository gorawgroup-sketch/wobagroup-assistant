import { buscarMensajes, obtenerResumenCorreo } from "../gmail/client";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos, tras un caso real: le pidió "verifica los dos
 * correos electrónicos que están sin leer" y el asistente no tenía forma de
 * saber cuáles eran — solo podía capturar un correo específico (por
 * remitente/asunto, o "el más reciente") con capturar_correo, nunca listar
 * qué había sin leer. Esta tool cierra ese hueco: lista los correos SIN
 * LEER reales de la bandeja de entrada, para que el asistente sepa de qué
 * se trata cada uno y decida qué hacer (ej. usar capturar_correo o el flujo
 * de gasto para uno específico que resulte ser una factura).
 * Solo lectura — segura para el modo rápido.
 */
export const listarCorreosSinLeerTool: ToolDefinition = {
  name: "listar_correos_sin_leer",
  seguraParaModoRapido: true,
  description:
    "Lista los correos SIN LEER de la bandeja de entrada (remitente, asunto, fecha, adjuntos, un " +
    "extracto breve), siempre ordenados del MÁS ANTIGUO al más nuevo. Es solo un inventario de lectura. " +
    "Si el usuario pide PROCESAR, REVISAR o EVACUAR los correos sin leer, no encadenes esta herramienta " +
    "con capturar_correo: usa revisar_cola_correo, que conserva el orden, la no duplicación y el marcado " +
    "como leído únicamente al terminar cada correo.",
  input_schema: {
    type: "object",
    properties: {
      limite: { type: "number", description: "Máximo de correos a listar (por defecto 20, tope 50)." },
    },
  },
  handler: async (input) => {
    const limiteInput = typeof input.limite === "number" ? input.limite : 20;
    const limite = Math.max(1, Math.min(limiteInput, 50));

    const ids = await buscarMensajes("is:unread in:inbox", limite);
    if (ids.length === 0) {
      return "No hay ningún correo sin leer en la bandeja de entrada.";
    }

    const resumenes = await Promise.all(ids.map((id) => obtenerResumenCorreo(id)));

    return resumenes
      .sort((a, b) => {
        const fechaA = Date.parse(a.fecha);
        const fechaB = Date.parse(b.fecha);
        return (Number.isFinite(fechaA) ? fechaA : Number.MAX_SAFE_INTEGER) -
          (Number.isFinite(fechaB) ? fechaB : Number.MAX_SAFE_INTEGER);
      })
      .map((r, i) => {
        const adjuntosTxt = r.adjuntos.length > 0 ? r.adjuntos.map((a) => a.filename).join(", ") : "ninguno";
        const extractoTxt = r.extracto ? r.extracto.slice(0, 200) : "(sin extracto)";
        return (
          `${i + 1}. De: ${r.de} | Asunto: ${r.asunto || "(sin asunto)"} | Fecha: ${r.fecha} | ` +
          `Adjuntos: ${adjuntosTxt} | Extracto: ${extractoTxt}`
        );
      })
      .join("\n");
  },
};
