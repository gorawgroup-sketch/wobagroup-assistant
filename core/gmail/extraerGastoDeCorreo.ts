import Anthropic from "@anthropic-ai/sdk";
import { knowledgeBaseTool } from "../tools/knowledgeBase";
import { obtenerClasificacionesAprendidas } from "../gastos/clasificacionAprendidaSheet";
import { registrarUsoIA } from "../claude/costTracking";
import type { DatosFactura } from "../documental/extractInvoiceData";

const MODEL = "claude-sonnet-4-6";
const MAX_ITERATIONS = 4;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY");
  }
  client = new Anthropic({ apiKey });
  return client;
}

const REPORTAR_TOOL_NAME = "reportar_datos_gasto_correo";

const REPORTAR_TOOL: Anthropic.Tool = {
  name: REPORTAR_TOOL_NAME,
  description:
    "Reporta los datos del gasto descrito en el cuerpo del correo (o que no describe ninguno). Debes " +
    "llamarla siempre al terminar — nunca respondas solo en texto.",
  input_schema: {
    type: "object",
    properties: {
      es_factura_o_gasto: {
        type: "boolean",
        description:
          "true SOLO si el cuerpo del correo describe un pago/cargo/recibo REAL ya ocurrido, con monto y " +
          "proveedor identificables (ej. una notificación de tarjeta pegada como texto/HTML, un recibo " +
          "incrustado en el cuerpo, una confirmación de pago de una plataforma). false para cualquier otra " +
          "cosa — incluida una simple MENCIÓN de un gasto sin datos concretos, una pregunta sobre gastos, o " +
          "una instrucción para hacer un pago en el futuro (eso no es un gasto YA ocurrido).",
      },
      proveedor: { type: "string", description: "Nombre del proveedor/comercio tal como aparece en el correo." },
      monto: { type: "number", description: "Importe TOTAL del gasto, tal como aparece en el correo." },
      moneda: { type: "string", description: "Código de moneda, ej. EUR, USD." },
      monto_equivalente: {
        type: "number",
        description:
          "El monto real que salió de la cuenta/tarjeta, SI el propio correo lo muestra explícitamente " +
          "(ej. '40.46 EUR | 148.346 COP', o un asunto de reenvío que solo menciona el equivalente: '11.98 " +
          "euros - Uber...'). Repórtalo si existe ese dato explícito, AUNQUE 'moneda' también sea una " +
          "moneda válida para el grupo — que el grupo tenga cuentas reales en varias monedas no significa " +
          "que ESTA tarjeta sea esa cuenta. Si no hay ningún equivalente explícito, omite este campo por " +
          "completo — NUNCA calcules ni inventes un tipo de cambio. Repórtalo SIEMPRE junto con " +
          "'moneda_equivalente'.",
      },
      moneda_equivalente: {
        type: "string",
        description:
          "Código de moneda ISO 4217 de 'monto_equivalente' — LITERALMENTE el que aparece junto a esa " +
          "cifra en el correo. NUNCA asumas que es EUR por defecto — algunas tarjetas están en USD.",
      },
      persona_asociada: {
        type: "string",
        description:
          "Nombre de la persona a la que corresponde ESTE gasto en concreto, SOLO si hay evidencia clara " +
          "— prioridad al remitente ORIGINAL de una cadena de reenvío ('---------- Forwarded message " +
          "---------- From: X'), no quien hizo el último reenvío. Omite si no hay evidencia clara.",
      },
      fecha: { type: "string", description: "Fecha del gasto en formato YYYY-MM-DD." },
      numero_documento: {
        type: "string",
        description:
          "Número de recibo/factura/autorización tal como aparece en el correo, EXCLUSIVAMENTE junto a una " +
          "etiqueta que lo identifique como tal (ej. 'Nº de recibo', 'Referencia', 'Authorization code'). " +
          "Cópialo literal. NO uses ningún otro número del correo aunque parezca un identificador (ej. " +
          "número de cliente, de pedido, teléfono, últimos dígitos de tarjeta) — eso NO es el número de " +
          "documento. Omite este campo si el correo no trae ninguno etiquetado con claridad — NUNCA " +
          "inventes ni adivines uno, y nunca uses un número parecido a falta de uno real.",
      },
      concepto: { type: "string", description: "Breve descripción de qué es el gasto." },
      empresa_probable: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint", "desconocida"],
        description: "A qué empresa del grupo pertenece este gasto, según el correo y el contexto conocido.",
      },
      confianza: { type: "string", enum: ["alta", "media", "baja"] },
      razon: { type: "string", description: "Explicación breve de la clasificación (o de por qué no es un gasto)." },
    },
    required: ["es_factura_o_gasto", "confianza", "razon"],
  },
};

function buildSystemPrompt(clasificacionesAprendidas: string | null): string {
  return [
    "Eres el lector de gastos entrantes del grupo (WOBA/BAE, Footprint, eWorks).",
    "Vas a recibir el CUERPO COMPLETO de un correo SIN ningún adjunto real. Si describe un pago/cargo/" +
      "recibo YA ocurrido, con monto y proveedor identificables (ej. una notificación de tarjeta pegada " +
      "como texto, un recibo en HTML incrustado en el cuerpo, una confirmación de pago), es un gasto real " +
      "y hay que extraer sus datos exactamente igual que si fuera un documento adjunto. Si el correo solo " +
      "MENCIONA un gasto sin datos concretos, o pide autorización para un pago futuro, o es cualquier otra " +
      "cosa, es_factura_o_gasto=false.",
    "Si sí es un gasto real, extrae proveedor, monto total, moneda, fecha y un concepto breve, tal como " +
      "aparecen en el correo — no inventes ni redondees.",
    "Para decidir la empresa probable (WOBA, EWORKS o Footprint), usa consultar_base_conocimiento si hace " +
      "falta contexto sobre qué proveedores/gastos son de cada empresa.",
    "Si el correo muestra un monto equivalente al que trae el propio gasto (típico en notificaciones de " +
      "tarjeta por gastos en el extranjero: '40.46 EUR | 148.346 COP', o un asunto de reenvío que solo " +
      "menciona el equivalente: '11.98 euros - Uber aeropuerto - Visa'), repórtalo SIEMPRE en " +
      "'monto_equivalente' + 'moneda_equivalente' — ese es el monto real que salió de la cuenta, no el de " +
      "la moneda local del comercio. Repórtalo aunque 'moneda' te parezca una moneda 'normal' o válida " +
      "para el grupo — el hecho de que el grupo tenga cuentas reales en varias monedas no significa que " +
      "ESTA tarjeta en particular sea esa cuenta. IMPORTANTE: 'moneda_equivalente' NUNCA se asume EUR por " +
      "defecto — lee literalmente el código/símbolo que acompaña a esa cifra. Si no hay ningún equivalente " +
      "explícito, omite ambos campos — nunca calcules tú un tipo de cambio.",
    "Para 'persona_asociada': mira si hay una cadena de reenvío en el cuerpo y usa el remitente ORIGINAL " +
      "(el 'From:' dentro del bloque 'Forwarded message', no quien hizo el último reenvío) como la persona " +
      "a la que corresponde el gasto. Omite si no hay evidencia clara.",
    clasificacionesAprendidas
      ? `Además, estas son clasificaciones aprendidas de facturas anteriores del mismo proveedor — dales ` +
        `prioridad sobre cualquier suposición genérica:\n\n${clasificacionesAprendidas}`
      : "",
    "Si no tienes certeza de la empresa o algún dato clave, usa confianza='baja' o 'media' en vez de " +
      "inventar — es preferible preguntar que asumir mal en un tema de dinero.",
    `SIEMPRE debes terminar llamando a la herramienta ${REPORTAR_TOOL_NAME} con tu conclusión final.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Sibling de extraerDatosFactura (core/documental/extractInvoiceData.ts) para
 * cuando el "comprobante" no es un adjunto real sino que está descrito en el
 * CUERPO del correo (ej. una notificación de tarjeta pegada como texto/HTML,
 * sin ningún PDF/imagen adjunto) — pedido explícito de Carlos: "solo te das
 * cuenta si es un gasto cuando no tiene anexo... si lees todos los correos,
 * cuando lo leas identificas, me preguntas". Mismos campos y misma lógica de
 * moneda equivalente que extraerDatosFactura — duplicada a propósito en vez
 * de compartida (ese prompt habla de "el documento", éste de "el correo";
 * forzar un solo prompt paramétrico para dos audiencias distintas complicaría
 * más de lo que ahorra) para no perder ninguno de los casos reales que ya
 * costó corregir ahí (Uber Colombia, Starbucks México).
 */
export async function extraerGastoDeCorreo(
  cuerpoCompleto: string,
  contexto: { de: string; asunto: string; fecha: string }
): Promise<DatosFactura> {
  const fallback: DatosFactura = {
    esFacturaOGasto: false,
    proveedor: "",
    monto: 0,
    moneda: "",
    fecha: "",
    concepto: "",
    lineas: [],
    empresaProbable: "desconocida",
    confianza: "baja",
    razon: "No fue posible analizar el correo.",
  };

  const cuerpoRecortado = cuerpoCompleto.trim().slice(0, 8000);
  if (!cuerpoRecortado) return fallback;

  const anthropic = getClient();
  const clasificacionesAprendidas = await obtenerClasificacionesAprendidas().catch(() => null);

  const tools: Anthropic.Tool[] = [
    { name: knowledgeBaseTool.name, description: knowledgeBaseTool.description, input_schema: knowledgeBaseTool.input_schema },
    REPORTAR_TOOL,
  ];

  const userText = [
    `De: ${contexto.de}`,
    `Asunto: ${contexto.asunto}`,
    `Fecha: ${contexto.fecha}`,
    `Cuerpo completo del correo:\n${cuerpoRecortado}`,
  ].join("\n");

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userText }];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      // Preventivo — mismo patrón que ya causó un bug real confirmado en vivo
      // en core/gmail/classifyEmail.ts (dos correos seguidos cayeron en el
      // fallback genérico porque el modelo se quedaba sin presupuesto antes
      // de llegar a llamar la tool de reportar). Este archivo comparte la
      // misma estructura (tool-calling con razonamiento) con un techo
      // igual de ajustado — 8192 es el estándar ya establecido en este
      // proyecto para este tipo de llamada (ver core/claude/client.ts). Acá
      // el riesgo es más serio todavía: esto detecta GASTOS reales en el
      // cuerpo del correo.
      max_tokens: 8192,
      system: buildSystemPrompt(clasificacionesAprendidas),
      tools,
      messages,
    });

    registrarUsoIA(undefined, MODEL, response.usage).catch((error) =>
      console.error("[extraerGastoDeCorreo] Error registrando uso de IA:", error)
    );

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const reportar = toolUseBlocks.find((b) => b.name === REPORTAR_TOOL_NAME);
    if (reportar) {
      const input = reportar.input as Record<string, unknown>;
      const monto = typeof input.monto === "number" ? input.monto : 0;
      const concepto = (input.concepto as string) ?? "";

      return {
        esFacturaOGasto: Boolean(input.es_factura_o_gasto),
        proveedor: (input.proveedor as string) ?? "",
        monto,
        moneda: (input.moneda as string) ?? "EUR",
        montoEquivalente: typeof input.monto_equivalente === "number" ? input.monto_equivalente : undefined,
        monedaEquivalente:
          typeof input.moneda_equivalente === "string" && input.moneda_equivalente.trim()
            ? input.moneda_equivalente.trim().toUpperCase()
            : undefined,
        personaAsociada:
          typeof input.persona_asociada === "string" && input.persona_asociada.trim()
            ? input.persona_asociada.trim()
            : undefined,
        fecha: (input.fecha as string) ?? "",
        numeroDocumento: typeof input.numero_documento === "string" && input.numero_documento.trim() ? input.numero_documento.trim() : undefined,
        concepto,
        // Un correo describiendo un gasto casi nunca trae un desglose de IVA
        // limpio por tipo — una sola línea con el total, igual que hace
        // extraerDatosFactura cuando el documento tampoco lo desglosa.
        lineas: [{ concepto, base: monto, tipoIvaPct: 0 }],
        empresaProbable: (input.empresa_probable as DatosFactura["empresaProbable"]) ?? "desconocida",
        confianza: (input.confianza as DatosFactura["confianza"]) ?? "baja",
        razon: (input.razon as string) ?? "",
      };
    }

    if (toolUseBlocks.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.name === knowledgeBaseTool.name) {
        const resultado = await knowledgeBaseTool.handler(block.input as Record<string, unknown>);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultado });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return fallback;
}
