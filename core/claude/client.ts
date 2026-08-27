import Anthropic from "@anthropic-ai/sdk";
import { executeTool, getToolDefinitions } from "../tools/registry";
import { formatDateLocal } from "../utils/dateFormat";
import { obtenerHistorial, guardarHistorial, limpiarHistorial } from "./conversationStore";
import { registrarUsoIA } from "./costTracking";

const MODEL_SONNET = "claude-sonnet-5";
const MODEL_HAIKU = "claude-haiku-4-5";
const MAX_TOOL_ITERATIONS = 12;

// Palabra exacta que debe responder Haiku (y NADA más) cuando, en el primer
// intento "rápido" (modoRapido: true — solo herramientas de solo lectura),
// detecta que hace falta algo fuera de lo que tiene disponible: proponer o
// enviar un correo, proponer un evento, registrar una corrección, capturar
// un correo entrante, o verificar cashflow contra Holded con precisión
// real. Nunca se le muestra al usuario — se intercepta y dispara el
// reintento con Sonnet y el set de herramientas completo.
const MARCADOR_ESCALAR = "ESCALAR";

// Parte ESTÁTICA del system prompt — idéntica en absolutamente todas las
// llamadas, para CUALQUIER modelo (no depende de la fecha ni de quién
// escribe, y no depende de si está respondiendo Haiku o Sonnet). Esto es
// deliberado: las reglas de "nunca escribas sin aprobación" y de prioridad
// de fuentes son EXACTAMENTE las mismas sin importar qué modelo responda —
// lo único que cambia entre Haiku y Sonnet es qué herramientas tiene
// disponibles (ver getToolDefinitions(modoRapido) y buildInstruccionModoRapido
// abajo), nunca las reglas de negocio en sí. Se calcula una sola vez y se
// manda con cache_control para que Anthropic la cachee: se factura completa
// la primera vez (cache write, +25%) y ~90% más barata en cada llamada
// siguiente (cache read) mientras siga vigente (~5 min desde el último uso).
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
  "Para saldos bancarios reales (cuánto hay HOY en cada cuenta/banco) usa consultar_saldos_bancarios — " +
    "es un dato directo de Holded, no lo calcules sumando movimientos tú mismo. Para el balance o " +
    "pérdidas y ganancias (P&L) de una empresa, usa generar_reporte_contable — genera Excel y PDF reales " +
    "a partir de los datos contables de Holded (Holded no tiene un endpoint de API para su reporte " +
    "oficial exportable, así que esto es una reconstrucción propia, agrupada por las categorías que el " +
    "propio Holded le asigna a cada cuenta — nunca la presentes como si fuera el documento oficial de " +
    "Holded, siempre aclara que es una reconstrucción desde los datos reales). Si piden enviarlo por " +
    "correo, usa destino='correo' (crea una propuesta con botón, nunca se envía directo); si lo piden " +
    "aquí o no especifican, usa destino='chat'.",
  "Si te piden algo sobre Holded (o cualquier otra integración) que no puedes hacer con las herramientas " +
    "que tienes — un dato, una acción, un reporte que no existe como tool — NUNCA respondas simplemente " +
    "que no se puede. Dilo, y de inmediato pregunta si deberían activar esa capacidad en el sistema (ej. " +
    "'no tengo una herramienta para X — ¿quieres que lo agreguemos?'), para que quede como una mejora " +
    "concreta a considerar, no como un callejón sin salida.",
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

// Instrucción adicional SOLO para el primer intento (Haiku, herramientas
// restringidas a solo-lectura) — nunca cambia las reglas de negocio del
// prompt estático de arriba, solo le explica que está en modo económico y
// cuándo debe ceder el turno a Sonnet en vez de intentarlo con lo que
// tiene. También es texto fijo, así que también se cachea (breakpoint
// aparte) — Haiku recibe esta instrucción en TODAS sus llamadas.
const INSTRUCCION_MODO_RAPIDO =
  `Estás respondiendo en modo rápido/económico, con un set reducido de herramientas: solo las de ` +
  `consulta (lectura), ninguna que proponga, registre o escriba nada. Si para responder de verdad ` +
  `necesitas algo que no tienes disponible — enviar o proponer un correo, proponer un evento de ` +
  `calendario, registrar una corrección, capturar un correo entrante, o verificar el cashflow contra ` +
  `Holded con precisión real — NO lo intentes con lo que tienes ni completes con una aproximación. ` +
  `Responde ÚNICAMENTE con la palabra "${MARCADOR_ESCALAR}" (así, sin comillas, sin nada más alrededor, ` +
  `ni explicación) para que el sistema pase la conversación a un modelo con más herramientas. Para todo ` +
  `lo demás — saludos, consultas directas, cualquier cosa que sí puedas resolver con las herramientas ` +
  `que tienes — responde tú mismo con normalidad, sigues siendo Wobi de principio a fin.`;

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

interface ResultadoConversacion {
  respuesta: string;
  /** El array de mensajes completo de este intento (incluye tool_use/tool_result intermedios) — para persistir en el historial solo si el llamador decide que este es el resultado final real. */
  messages: Anthropic.MessageParam[];
}

/**
 * Motor genérico del loop de tool-use — parametrizado por modelo y set de
 * herramientas para poder correr tanto el intento rápido (Haiku, tools
 * restringidas) como el intento completo (Sonnet, todas las tools) con el
 * mismo código, sin duplicar la lógica de iteración.
 */
async function ejecutarConversacion(
  userText: string,
  chatId: number | undefined,
  nombreRemitente: string | undefined,
  usarHistorial: boolean,
  model: string,
  tools: Anthropic.Tool[],
  systemExtra: string | undefined
): Promise<ResultadoConversacion> {
  const anthropic = getClient();

  // Marca el último tool como punto de corte de caché — como las
  // definiciones de tools van justo antes del system prompt en el prompt
  // efectivo que arma Anthropic, este único breakpoint (más los del system
  // de abajo) cachea tools + system como un solo prefijo, sin necesidad de
  // marcar cada tool individualmente.
  if (tools.length > 0) {
    tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
  }

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT_ESTATICO, cache_control: { type: "ephemeral" } },
  ];
  if (systemExtra) {
    system.push({ type: "text", text: systemExtra, cache_control: { type: "ephemeral" } });
  }
  system.push({ type: "text", text: buildSystemPromptDinamico(nombreRemitente) });

  const historial = usarHistorial && chatId !== undefined ? obtenerHistorial(chatId) : [];
  const messages: Anthropic.MessageParam[] = [...historial, { role: "user", content: userText }];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system,
      tools,
      messages,
    });

    // "Fire and forget" — no bloquea la respuesta al usuario por la latencia
    // de escribir en Sheets. Cada llamada a la API se factura por separado,
    // así que se registra una fila por iteración, no solo la respuesta final.
    registrarUsoIA(chatId, model, response.usage).catch((error) =>
      console.error("[costTracking] Error registrando uso de IA:", error)
    );

    if (response.stop_reason !== "tool_use") {
      const textBlock = response.content.find((block) => block.type === "text");
      const respuestaFinal =
        textBlock && textBlock.type === "text" ? textBlock.text : "No he podido generar una respuesta.";

      messages.push({ role: "assistant", content: response.content });
      return { respuesta: respuestaFinal, messages };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      console.log(`[claude:${model}] tool_use -> ${block.name}(${JSON.stringify(block.input)})`);

      const result = await executeTool(block.name, block.input as Record<string, unknown>, { chatId });

      console.log(`[claude:${model}] tool_result <- ${block.name} (${result.length} caracteres)`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    respuesta: "No he podido completar la respuesta tras varios intentos de usar herramientas.",
    messages,
  };
}

function esRespuestaEscalar(respuesta: string): boolean {
  return respuesta.trim().toUpperCase() === MARCADOR_ESCALAR;
}

function esErrorDeDisponibilidad(error: unknown): boolean {
  // 5xx / overloaded / timeouts de red del SDK — errores de que la API
  // (o el modelo) no está disponible ahora mismo, a diferencia de un 400
  // (mensaje mal formado, no se arregla reintentando con otro modelo) o un
  // 401/403 (credenciales, tampoco se arregla cambiando de modelo).
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    return error.status >= 500 || error.status === 429;
  }
  return false;
}

/**
 * Orquesta un turno completo: primer intento con Haiku (rápido y barato,
 * solo herramientas de lectura — ver getToolDefinitions(true) y
 * ToolDefinition.seguraParaModoRapido). Si Haiku responde el marcador
 * ESCALAR (porque la petición necesita proponer/escribir algo o precisión
 * financiera real), se descarta esa respuesta sin guardarla en el
 * historial y se repite el turno con Sonnet y el set de herramientas
 * completo. Si Sonnet no está disponible (caída/sobrecarga de la API),
 * Haiku responde como respaldo — esta vez con el set completo de
 * herramientas, porque ya es la única opción que queda.
 *
 * Las reglas de "nunca escribas sin aprobación" son IDÉNTICAS sin importar
 * qué modelo termine respondiendo: (a) usan el mismo SYSTEM_PROMPT_ESTATICO,
 * nunca una versión relajada para Haiku; y (b) estructuralmente, ninguna
 * tool que Claude puede invocar — con cualquiera de los dos modelos —
 * ejecuta una escritura real por sí sola. Las que crean una propuesta
 * (proponer_envio_correo, proponer_evento_calendario) solo quedan
 * pendientes hasta que una persona presiona el botón correspondiente en
 * Telegram (ver core/gmail/emailCallbackHandler.ts, core/crm/eventoCallbackHandler.ts);
 * la única acción "irreversible" real que puede escribir directo
 * (registrar_correccion, capturar_correo) está deliberadamente fuera del
 * set de Haiku en el primer intento — pero incluso si Haiku la usa en el
 * modo de respaldo por caída de Sonnet, es la misma tool con la misma
 * definición y las mismas reglas, no una versión distinta por modelo.
 */
async function orquestarTurno(
  userText: string,
  chatId: number | undefined,
  nombreRemitente: string | undefined,
  usarHistorial: boolean
): Promise<string> {
  const intentoRapido = await ejecutarConversacion(
    userText,
    chatId,
    nombreRemitente,
    usarHistorial,
    MODEL_HAIKU,
    getToolDefinitions(true),
    INSTRUCCION_MODO_RAPIDO
  );

  if (!esRespuestaEscalar(intentoRapido.respuesta)) {
    if (chatId !== undefined) guardarHistorial(chatId, intentoRapido.messages);
    return intentoRapido.respuesta;
  }

  console.log(`[claude] Haiku escaló a Sonnet (chat ${chatId ?? "?"}).`);

  let resultadoFinal: ResultadoConversacion;
  try {
    resultadoFinal = await ejecutarConversacion(
      userText,
      chatId,
      nombreRemitente,
      usarHistorial,
      MODEL_SONNET,
      getToolDefinitions(false),
      undefined
    );
  } catch (error) {
    if (!esErrorDeDisponibilidad(error)) throw error;

    console.error("[claude] Sonnet no disponible, usando Haiku como respaldo de disponibilidad:", error);
    resultadoFinal = await ejecutarConversacion(
      userText,
      chatId,
      nombreRemitente,
      usarHistorial,
      MODEL_HAIKU,
      getToolDefinitions(false),
      undefined
    );
  }

  if (chatId !== undefined) guardarHistorial(chatId, resultadoFinal.messages);
  return resultadoFinal.respuesta;
}

/**
 * Envía el texto del usuario a Claude con las herramientas disponibles. Si Claude decide
 * invocar una o más, se ejecutan localmente y el resultado se le devuelve (tool_result)
 * hasta que produzca una respuesta final en texto. Ver orquestarTurno para el enrutamiento
 * entre Haiku (rápido/barato) y Sonnet (completo/preciso).
 */
export async function askClaude(userText: string, chatId?: number, nombreRemitente?: string): Promise<string> {
  try {
    return await orquestarTurno(userText, chatId, nombreRemitente, true);
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
    return orquestarTurno(userText, chatId, nombreRemitente, false);
  }
}
