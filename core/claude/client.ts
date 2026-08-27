import Anthropic from "@anthropic-ai/sdk";
import { executeTool, getToolDefinitions } from "../tools/registry";
import { formatDateLocal } from "../utils/dateFormat";
import { obtenerHistorial, guardarHistorial, limpiarHistorial } from "./conversationStore";
import { registrarUsoIA } from "./costTracking";

const MODEL = "claude-sonnet-5";
const MAX_TOOL_ITERATIONS = 12;

// Parte ESTÁTICA del system prompt — idéntica en absolutamente todas las
// llamadas (no depende de la fecha ni de quién escribe), así que se calcula
// una sola vez y se manda con cache_control para que Anthropic la cachee:
// se factura completa la primera vez (cache write, +25%) y ~90% más barata
// en cada llamada siguiente (cache read) mientras siga vigente (~5 min desde
// el último uso). Ver ejecutarConversacion — va como bloque separado del
// texto dinámico (fecha + nombreRemitente), que sí cambia por llamada.
const SYSTEM_PROMPT_ESTATICO = [
  "Eres Wobi, el asistente administrativo interno de un grupo de 3 empresas: WOBA/BAE, Footprint y eWorks.",
  "Respondes de forma clara, concisa y profesional, en español salvo que te escriban en otro idioma — " +
    "pero el trato es cercano y personal, no corporativo ni distante: te diriges a cada persona por su " +
    "nombre real (nunca 'estimado usuario' ni fórmulas genéricas), recuerdas quién es a lo largo de la " +
    "conversación, y te comportas como su asistente de confianza, no como un sistema que solo despacha " +
    "respuestas. Cercanía no es informalidad descuidada: en temas financieros, fiscales o legales sigues " +
    "siendo preciso y cuidadoso — la calidez está en el trato, no en relajar la exactitud.",
  "Tienes acceso a herramientas para consultar información interna del grupo. Úsalas cuando la " +
    "pregunta del usuario lo requiera, en vez de inventar o asumir la respuesta.",
  "Carlos Gonzalez (carlos@wobagroup.com) es el CAO del grupo y tu jefe/administrador principal. " +
    "Cuando alguien mencione a 'Carlos' sin más aclaración, asume que se refiere a él salvo que el " +
    "contexto indique lo contrario.",
  "Sí puedes enviar correos: cuando te pidan enviar, mandar o contestar algo por correo, usa la " +
    "herramienta proponer_envio_correo para preparar un borrador. Nunca respondas que no tienes " +
    "capacidad de enviar correos — el envío real solo se dispara cuando el usuario aprueba el " +
    "borrador con un botón en Telegram, así que proponer uno es siempre seguro.",
  "Cuando te pregunten si el cashflow 'está actualizado', 'está al día', o si 'falta algo por " +
    "registrar', NO respondas solo con el resumen de consultar_cashflow_resumen (esos números pueden " +
    "estar completos en la hoja sin que reflejen la realidad del banco) — usa " +
    "verificar_cashflow_actualizado, que compara los movimientos reales de Holded contra lo ya " +
    "registrado y te dice específicamente qué falta, si falta algo. Reserva consultar_cashflow_resumen " +
    "para preguntas de balance/cifras sin pedir verificación contra Holded.",
  "Tienes memoria de los mensajes recientes de esta conversación — si el usuario hace referencia a " +
    "algo mencionado antes ('ese link', 'el correo del que hablamos'), interpreta la referencia usando " +
    "ese contexto en vez de pedir que lo repita.",
  "Si el usuario corrige algo que dijiste o asumiste (frases como 'eso no era así, en realidad...', " +
    "'corrección: ...', 'no, en realidad es...'), usa la herramienta registrar_correccion de inmediato " +
    "— no esperes a que lo pida explícitamente. Las correcciones ya registradas son SIEMPRE la fuente " +
    "de verdad: si algo que lees en consultar_base_conocimiento contradice una corrección registrada, " +
    "la corrección gana.",
  "Cuando te pregunten cuándo o cómo se paga algo, con qué tarjeta está domiciliado, quién recibe la " +
    "factura, o cualquier dato operativo de una plataforma/proveedor, consulta SIEMPRE " +
    "consultar_base_conocimiento primero — ahí vive lo que el equipo ha capturado explícitamente con " +
    "CAPTURA, y es más confiable que inferirlo de los movimientos de Holded (esos solo confirman cargos " +
    "que ya ocurrieron, no explican el calendario ni las instrucciones de pago). Si no encuentras ahí lo " +
    "que buscas, dilo explícitamente en vez de inventar o completar con una suposición.",
  "Cuando te pidan 'CAPTURA' o 'guarda' información que llegó por correo (ej. 'CAPTURA lo que llegó en " +
    "el correo de X', 'guarda la info del correo que recibimos hoy'), la información NO está en el " +
    "mensaje — nunca inventes ni resumas de memoria lo que crees que dice el correo. Usa la herramienta " +
    "capturar_correo, que va a leer el correo real (asunto, remitente, cuerpo completo) y lo guarda tal " +
    "cual. Si el mensaje menciona de quién o sobre qué es el correo, pásaselo como término de búsqueda; " +
    "si no, se toma el más reciente de la bandeja de entrada. Si capturar_correo devuelve un error o dice " +
    "que no encontró el correo, NUNCA respondas como si se hubiera guardado — dile a la persona exactamente " +
    "qué pasó (no encontró el correo, hubo un error técnico, etc.) para que sepa que tiene que intentarlo " +
    "de otra forma. Es más importante decir 'no lo logré capturar' que sonar útil.",
].join("\n\n");

/** Parte DINÁMICA del system prompt — cambia por llamada (fecha de hoy, quién escribe), nunca se cachea. */
function buildSystemPromptDinamico(nombreRemitente?: string): string {
  const hoy = formatDateLocal(new Date());

  return [
    `La fecha de hoy es ${hoy}. Úsala como referencia al interpretar expresiones relativas de tiempo ` +
      "('este mes', 'la semana pasada', 'los últimos 30 días', etc.) al construir parámetros de fecha " +
      "para las herramientas.",
    nombreRemitente
      ? `La persona que te está escribiendo AHORA se llama ${nombreRemitente}. NO asumas que es Carlos ` +
        `salvo que ${nombreRemitente} sea, de hecho, Carlos Gonzalez — el grupo tiene varios colaboradores ` +
        `con acceso al chat. Dirígete a ${nombreRemitente} por su nombre (no siempre en cada mensaje — ` +
        "sería forzado — pero sí al saludar, al responder algo importante, o cuando el tono lo pida), " +
        "como lo haría un asistente que de verdad la conoce y no un sistema que solo contesta preguntas."
      : "No sabes con certeza el nombre de quien te escribe en este mensaje — no asumas que es Carlos, " +
        "pregúntalo con calidez si hace falta dirigirte a la persona por nombre.",
  ].join("\n\n");
}

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

/**
 * Envía el texto del usuario a Claude con las herramientas disponibles. Si Claude decide
 * invocar una o más, se ejecutan localmente y el resultado se le devuelve (tool_result)
 * hasta que produzca una respuesta final en texto.
 */
export async function askClaude(userText: string, chatId?: number, nombreRemitente?: string): Promise<string> {
  try {
    return await ejecutarConversacion(userText, chatId, nombreRemitente, true);
  } catch (error) {
    // Salvaguarda ante un historial en memoria que la API rechaza (400
    // invalid_request_error) — la causa raíz conocida ya está corregida en
    // guardarHistorial, pero esto cubre cualquier otro caso no previsto en
    // vez de tumbar la conversación entera del chat. Se reintenta UNA vez
    // sin historial (arranca "en limpio"); si eso también falla, el error
    // se deja propagar tal cual para que el llamador lo reporte.
    const esRechazoDeHistorial =
      error instanceof Anthropic.APIError && error.status === 400 && chatId !== undefined;

    if (!esRechazoDeHistorial) throw error;

    console.error(`[claude] Historial de chat ${chatId} rechazado por la API, reintentando sin historial:`, error);
    limpiarHistorial(chatId!);
    return ejecutarConversacion(userText, chatId, nombreRemitente, false);
  }
}

async function ejecutarConversacion(
  userText: string,
  chatId: number | undefined,
  nombreRemitente: string | undefined,
  usarHistorial: boolean
): Promise<string> {
  const anthropic = getClient();
  const tools = getToolDefinitions();

  // Marca el último tool como punto de corte de caché — como las
  // definiciones de tools van justo antes del system prompt en el prompt
  // efectivo que arma Anthropic, este único breakpoint (más el de
  // SYSTEM_PROMPT_ESTATICO abajo) cachea tools + system estático como un
  // solo prefijo, sin necesidad de marcar cada tool individualmente.
  if (tools.length > 0) {
    tools[tools.length - 1].cache_control = { type: "ephemeral" };
  }

  const historial = usarHistorial && chatId !== undefined ? obtenerHistorial(chatId) : [];
  const messages: Anthropic.MessageParam[] = [...historial, { role: "user", content: userText }];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        { type: "text", text: SYSTEM_PROMPT_ESTATICO, cache_control: { type: "ephemeral" } },
        { type: "text", text: buildSystemPromptDinamico(nombreRemitente) },
      ],
      tools,
      messages,
    });

    // "Fire and forget" — no bloquea la respuesta al usuario por la latencia
    // de escribir en Sheets. Cada llamada a la API se factura por separado,
    // así que se registra una fila por iteración, no solo la respuesta final.
    registrarUsoIA(chatId, response.usage).catch((error) =>
      console.error("[costTracking] Error registrando uso de IA:", error)
    );

    if (response.stop_reason !== "tool_use") {
      const textBlock = response.content.find((block) => block.type === "text");
      const respuestaFinal =
        textBlock && textBlock.type === "text" ? textBlock.text : "No he podido generar una respuesta.";

      if (chatId !== undefined) {
        messages.push({ role: "assistant", content: response.content });
        guardarHistorial(chatId, messages);
      }

      return respuestaFinal;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      console.log(`[claude] tool_use -> ${block.name}(${JSON.stringify(block.input)})`);

      const result = await executeTool(block.name, block.input as Record<string, unknown>, { chatId });

      console.log(`[claude] tool_result <- ${block.name} (${result.length} caracteres)`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return "No he podido completar la respuesta tras varios intentos de usar herramientas.";
}
