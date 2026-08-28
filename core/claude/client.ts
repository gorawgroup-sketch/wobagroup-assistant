import Anthropic from "@anthropic-ai/sdk";
import { executeTool, getToolDefinitions } from "../tools/registry";
import { formatDateLocal } from "../utils/dateFormat";
import { obtenerHistorial, guardarHistorial, limpiarHistorial } from "./conversationStore";
import { registrarUsoIA } from "./costTracking";

const MODEL_SONNET = "claude-sonnet-5";
const MODEL_HAIKU = "claude-haiku-4-5";
const MAX_TOOL_ITERATIONS = 12;

// Nombre de la tool "trampa" que se le da a Haiku en el primer intento
// (modoRapido) para que pida escalar a Sonnet. Antes esto se hacía
// pidiéndole que respondiera la palabra exacta "ESCALAR" y nada más — en la
// práctica, Haiku a veces escribía una explicación larga que TERMINABA en
// "ESCALAR" (en vez de responder solo esa palabra), y como la detección
// exigía una coincidencia exacta, esa explicación completa se le mostraba
// tal cual al usuario en vez de escalar de verdad (bug real visto en
// producción). Un tool_use es una señal estructurada — Haiku no puede
// "explicar antes" de invocar una tool, así que esto es 100% confiable sin
// depender de que seguir instrucciones de formato al pie de la letra.
const NOMBRE_TOOL_ESCALAR = "escalar_a_modelo_completo";

const TOOL_ESCALAR: Anthropic.Tool = {
  name: NOMBRE_TOOL_ESCALAR,
  description:
    "Úsala cuando, en este modo rápido/económico, necesites algo que NO tienes disponible entre tus " +
    "herramientas de solo lectura — proponer o enviar un correo, proponer un evento, registrar una " +
    "corrección, capturar un correo entrante, o cualquier verificación de precisión financiera real " +
    "(cashflow contra Holded, gastos sin movimiento bancario, etc.). Llámala de inmediato, sin intentar " +
    "responder primero con lo que tienes ni explicar por qué la necesitas — el sistema pasa la " +
    "conversación a un modelo con más herramientas y responde desde ahí.",
  input_schema: { type: "object", properties: {} },
};

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
  "Vas reconociendo personas solo, con el tiempo: cada vez que alguien se autoriza por Telegram o se " +
    "cruza un correo (entrante o saliente), queda en un directorio interno. Cuando mencionen a alguien " +
    "solo por su nombre (ej. 'avísale a Pep', 'envíaselo a Alejandra') y no tengas su email exacto en el " +
    "mensaje o la conversación, usa consultar_directorio_personas para resolverlo ANTES de proponer el " +
    "correo — nunca inventes ni adivines un email. Si el directorio no tiene a esa persona, dilo " +
    "explícitamente y pide el email en vez de adivinar.",
  "Sí puedes enviar correos: cuando te pidan enviar, mandar o contestar algo por correo, usa la " +
    "herramienta proponer_envio_correo para preparar un borrador. Nunca respondas que no tienes " +
    "capacidad de enviar correos — el envío real solo se dispara cuando el usuario aprueba el " +
    "borrador con un botón en Telegram, así que proponer uno es siempre seguro.",
  "Sí puedes consultar el calendario CRM de Holded: usa consultar_eventos_calendario. Nunca respondas " +
    "que no puedes verificar si algo quedó programado — después de que el usuario apruebe una actividad " +
    "con proponer_evento_calendario, si preguntan si de verdad quedó ahí, confírmalo con " +
    "consultar_eventos_calendario en vez de decir que no tienes visibilidad.",
  "Cuando te pregunten si el cashflow 'está actualizado', 'está al día', o si 'falta algo por " +
    "registrar', NO respondas solo con el resumen de consultar_cashflow_resumen (esos números pueden " +
    "estar completos en la hoja sin que reflejen la realidad del banco) — usa " +
    "verificar_cashflow_actualizado, que compara los movimientos reales de Holded contra lo ya " +
    "registrado y te dice específicamente qué falta, si falta algo. Reserva consultar_cashflow_resumen " +
    "para preguntas de balance/cifras sin pedir verificación contra Holded. Para el sentido CONTRARIO — " +
    "qué gasto ya está en el cashflow pero el banco todavía no refleja ninguna salida real de dinero — " +
    "usa verificar_gastos_sin_movimiento_bancario en vez de verificar_cashflow_actualizado. " +
    "verificar_cashflow_actualizado SOLO reporta texto, nunca escribe nada — si el usuario además pide " +
    "que lo registres/actualices/agregues, o dice que sí quiere verlos con botón (ej. tras preguntarle " +
    "'¿quieres que te los muestre uno a uno con botón?'), usa proponer_registro_cashflow, que sí manda " +
    "un mensaje con botones por cada movimiento para aprobar la categoría y registrarlo. Nunca digas que " +
    "no tienes forma de registrar directamente — sí la tienes, es proponer_registro_cashflow.",
  "Cuando busquen un concepto o proveedor específico dentro del cashflow (ej. '¿hay facturas de " +
    "limpieza pendientes?', '¿cuánto se ha pagado de Google?'), usa consultar_cashflow_detalle con el " +
    "filtro 'contraparte' — cubre TODAS las categorías (ingresos, pagos a proyectos, pagos extras, " +
    "aplazamientos, gastos fijos, pendientes de Alberto, deudas). Nunca respondas 'no encontré nada' o " +
    "'no hay movimientos' sin haber llamado a esa herramienta primero — decir que algo no existe sin " +
    "buscarlo primero es el error más costoso que puedes cometer aquí.",
  "Tienes memoria de los mensajes recientes de esta conversación — si el usuario hace referencia a " +
    "algo mencionado antes ('ese link', 'el correo del que hablamos'), interpreta la referencia usando " +
    "ese contexto en vez de pedir que lo repita.",
  "Si el usuario corrige algo que dijiste o asumiste (frases como 'eso no era así, en realidad...', " +
    "'corrección: ...', 'no, en realidad es...'), usa la herramienta registrar_correccion de inmediato " +
    "— no esperes a que lo pida explícitamente. Las correcciones ya registradas son SIEMPRE la fuente " +
    "de verdad: si algo que lees en consultar_base_conocimiento contradice una corrección registrada, " +
    "la corrección gana.",
  "Si el usuario te da una instrucción u observación sobre un gasto o ingreso ESPECÍFICO del cashflow " +
    "(con su concepto y monto — ej. 'el gasto de Robar 1076,90 se paga cuando haya plata, se va moviendo " +
    "semana a semana'), usa guardar_nota_cashflow de inmediato, igual que con las correcciones — no " +
    "esperes a que lo pida explícitamente. Cuando pregunten qué hacer, qué se dijo, o cualquier cosa " +
    "sobre un gasto/ingreso puntual del cashflow, usa consultar_notas_cashflow (por concepto y/o monto) " +
    "ANTES de responder solo con los datos crudos — la nota guardada es lo que de verdad importa ahí.",
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
  `calendario, registrar una corrección, capturar un correo entrante, o cualquier verificación de ` +
  `precisión financiera real — NO lo intentes con lo que tienes, no completes con una aproximación, y no ` +
  `expliques primero por qué hace falta: llama directo a la herramienta ${NOMBRE_TOOL_ESCALAR}. Para todo ` +
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

interface EstadoClaude {
  ok: boolean;
  en: number;
  detalle?: string;
}

// Estado observado del ÚLTIMO turno real de chat — para el panel de
// conexiones. Deliberadamente pasivo (no dispara una llamada nueva en cada
// carga del panel): un ping sintético podría dar "ok" mientras el tráfico
// real está fallando por otra razón (límite de un modelo específico, etc.),
// y cuesta dinero en cada refresco. Ver verificarConexionClaude para el
// único caso en que SÍ se dispara una llamada real (botón "Reintentar").
let ultimoEstadoClaude: EstadoClaude | null = null;

function registrarEstadoClaude(ok: boolean, detalle?: string): void {
  ultimoEstadoClaude = { ok, en: Date.now(), detalle };
}

export function obtenerUltimoEstadoClaude(): EstadoClaude | null {
  return ultimoEstadoClaude;
}

/**
 * Único chequeo ACTIVO de este módulo: un mensaje real de 1 token
 * (fracción de céntimo) contra el modelo Haiku, solo para el botón
 * "Reintentar" del panel de conexiones — nunca se dispara solo.
 */
export async function verificarConexionClaude(): Promise<{ ok: boolean; detalle?: string }> {
  try {
    const anthropic = getClient();
    await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    registrarEstadoClaude(true);
    return { ok: true };
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    registrarEstadoClaude(false, detalle);
    return { ok: false, detalle };
  }
}

type ResultadoConversacion =
  | { tipo: "respuesta"; respuesta: string; messages: Anthropic.MessageParam[] }
  | { tipo: "escalar" };

/**
 * Motor genérico del loop de tool-use — parametrizado por modelo y set de
 * herramientas para poder correr tanto el intento rápido (Haiku, tools
 * restringidas + TOOL_ESCALAR) como el intento completo (Sonnet, todas las
 * tools reales) con el mismo código, sin duplicar la lógica de iteración.
 * `permiteEscalar` solo debe ser true en el intento rápido — activa tanto la
 * tool_use de escalar_a_modelo_completo como el fallback de "se agotaron las
 * iteraciones sin resolver" tratándose como escalación en vez de mostrarle
 * al usuario un mensaje de que no se pudo responder.
 */
async function ejecutarConversacion(
  userText: string,
  chatId: number | undefined,
  nombreRemitente: string | undefined,
  usarHistorial: boolean,
  model: string,
  toolsBase: Anthropic.Tool[],
  systemExtra: string | undefined,
  permiteEscalar: boolean
): Promise<ResultadoConversacion> {
  const anthropic = getClient();

  const tools = permiteEscalar ? [...toolsBase, TOOL_ESCALAR] : toolsBase;
  const nombresDisponibles = new Set(tools.map((t) => t.name));

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
      return { tipo: "respuesta", respuesta: respuestaFinal, messages };
    }

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    // Bug real encontrado en producción: el modelo puede emitir un tool_use
    // con un nombre que NO estaba en el array `tools` de esta llamada — la
    // API de Anthropic no lo rechaza a nivel de protocolo, así que sin este
    // chequeo, executeTool() lo ejecutaría igual buscándolo en el registro
    // COMPLETO (sin filtrar), pasando por alto por completo la restricción
    // de modoRapido. Pasó de verdad: Haiku, viendo en el system prompt
    // (compartido con Sonnet) la instrucción de usar guardar_nota_cashflow
    // — una tool de escritura excluida de su set — la invocó de todas
    // formas aunque nunca se le ofreció su definición, y se ejecutó en
    // silencio. Cualquier tool_use fuera de lo realmente ofrecido en ESTA
    // llamada se trata como señal de escalación (en el intento rápido) o se
    // rechaza sin ejecutar (si ya no hay a dónde escalar).
    const nombreNoDisponible = toolUseBlocks.find(
      (b) => b.name !== NOMBRE_TOOL_ESCALAR && !nombresDisponibles.has(b.name)
    );

    // Señal ESTRUCTURADA de escalación — ver TOOL_ESCALAR — o un intento de
    // usar una tool que no tiene disponible (mismo efecto). Se corta de
    // inmediato sin ejecutar ni el resto de tools de esta misma respuesta ni
    // más iteraciones: el intento completo se descarta (nunca se guarda en
    // el historial) y orquestarTurno reinicia desde cero con Sonnet.
    if (permiteEscalar && (toolUseBlocks.some((b) => b.name === NOMBRE_TOOL_ESCALAR) || nombreNoDisponible)) {
      if (nombreNoDisponible) {
        console.error(
          `[claude:${model}] Pidió usar "${nombreNoDisponible.name}", que no estaba disponible en este modo — escalando en vez de ejecutarla.`
        );
      }
      return { tipo: "escalar" };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      if (!nombresDisponibles.has(block.name)) {
        // Defensa en profundidad — no debería llegar hasta acá (arriba ya
        // se escala cuando es posible), pero si de todas formas pasa (ej.
        // en el intento completo, donde ya no hay a dónde escalar), nunca
        // se ejecuta una tool que no estaba realmente ofrecida.
        console.error(`[claude:${model}] Tool "${block.name}" solicitada pero no disponible — no se ejecuta.`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: la herramienta "${block.name}" no está disponible en este contexto.`,
          is_error: true,
        });
        continue;
      }

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

  // Se agotaron las iteraciones sin que el modelo concluyera. En el intento
  // rápido esto casi siempre significa que Haiku se quedó dando vueltas con
  // herramientas insuficientes en vez de pedir escalar — mejor tratarlo como
  // escalación (Sonnet lo intenta de cero) que mostrarle al usuario un
  // mensaje de derrota que ni siquiera es su respuesta real.
  if (permiteEscalar) {
    return { tipo: "escalar" };
  }

  return {
    tipo: "respuesta",
    respuesta: "No he podido completar la respuesta tras varios intentos de usar herramientas.",
    messages,
  };
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
    INSTRUCCION_MODO_RAPIDO,
    true
  );

  if (intentoRapido.tipo === "respuesta") {
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
      undefined,
      false
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
      undefined,
      false
    );
  }

  // resultadoFinal siempre es tipo "respuesta" acá — permiteEscalar=false
  // garantiza que ejecutarConversacion nunca devuelva "escalar" en esta rama.
  if (resultadoFinal.tipo !== "respuesta") {
    throw new Error("Estado inesperado: el intento completo (Sonnet) no debería poder pedir escalar.");
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
    const respuesta = await orquestarTurno(userText, chatId, nombreRemitente, true);
    registrarEstadoClaude(true);
    return respuesta;
  } catch (error) {
    // Salvaguarda ante un historial en memoria que la API rechaza (400
    // invalid_request_error) — la causa raíz conocida ya está corregida en
    // guardarHistorial, pero esto cubre cualquier otro caso no previsto en
    // vez de tumbar la conversación entera del chat. Se reintenta UNA vez
    // sin historial (arranca "en limpio"); si eso también falla, el error
    // se deja propagar tal cual para que el llamador lo reporte.
    const esRechazoDeHistorial =
      error instanceof Anthropic.APIError && error.status === 400 && chatId !== undefined;

    if (!esRechazoDeHistorial) {
      registrarEstadoClaude(false, error instanceof Error ? error.message : String(error));
      throw error;
    }

    console.error(`[claude] Historial de chat ${chatId} rechazado por la API, reintentando sin historial:`, error);
    limpiarHistorial(chatId!);
    try {
      const respuesta = await orquestarTurno(userText, chatId, nombreRemitente, false);
      registrarEstadoClaude(true);
      return respuesta;
    } catch (segundoError) {
      registrarEstadoClaude(false, segundoError instanceof Error ? segundoError.message : String(segundoError));
      throw segundoError;
    }
  }
}
