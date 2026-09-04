import Anthropic from "@anthropic-ai/sdk";
import { executeTool, getToolDefinitions } from "../tools/registry";
import { formatDateLocal } from "../utils/dateFormat";
import { obtenerHistorial, guardarHistorial, limpiarHistorial } from "./conversationStore";
import { obtenerPropuestaClasificacionPendientePorChat } from "../documental/classificationStore";
import { obtenerResolucionContactoPendientePorChat } from "../gastos/contactoResolucionStore";
import { obtenerGastoPendienteDatosPorChat } from "../gastos/gastoPendienteDatosStore";
import { obtenerPendienteReclasificacionPorChat } from "../documental/pendienteReclasificacionStore";
import { registrarUsoIA } from "./costTracking";
import { registrarBusquedaWeb } from "./webSearchLog";

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

/**
 * Pedido explícito de Carlos: "si requieres debes ir a Internet y buscar la
 * información que necesites, los manuales que requieras... o cualquier otra
 * fuente que ayude para dar tus respuestas" — complementar (nunca
 * reemplazar) el conocimiento interno del grupo con información pública
 * real cuando haga falta. Tool NATIVA/hospedada de Anthropic (la ejecuta la
 * propia API, no hace falta implementar ni pagar un proveedor de búsqueda
 * aparte) — verificado en vivo contra la documentación oficial 2026-09-01:
 * disponible de forma general (sin beta header), $10 USD por cada 1.000
 * búsquedas además del costo normal de tokens (ver costTracking.ts, que
 * registra server_tool_use.web_search_requests para que ese costo no quede
 * invisible). Solo en el intento COMPLETO (Sonnet, o Haiku de respaldo si
 * Sonnet no está disponible) — nunca en el modo rápido/económico de Haiku,
 * para no disparar búsquedas pagas en cada mensaje rutinario sin que la
 * pregunta realmente lo justifique.
 */
const WEB_SEARCH_TOOL: Anthropic.WebSearchTool20250305 = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
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
  "El envío automatizado (con botón de aprobación) es SOLO para correo — decisión explícita de Carlos. " +
    "Para cualquier otro canal (WhatsApp, SMS, una llamada, avisar a alguien en persona, o cuando una " +
    "recomendación tuya implica 'avisar al proveedor'/'avisar a X'), NUNCA intentes enviarlo ni digas " +
    "simplemente que no puedes — en su lugar, redacta el mensaje LISTO para copiar y pegar, directo en " +
    "tu respuesta de chat, para que la persona lo mande ella misma por el canal que use. Esto aplica " +
    "también dentro de las recomendaciones que das sobre anotaciones del cashflow u otros avisos: si " +
    "dices que hay que avisarle a alguien, incluye el texto exacto a enviar, no solo la instrucción de " +
    "que hay que avisar.",
  "Sí puedes consultar el calendario CRM de Holded: usa consultar_eventos_calendario. Nunca respondas " +
    "que no puedes verificar si algo quedó programado — después de que el usuario apruebe una actividad " +
    "con proponer_evento_calendario, si preguntan si de verdad quedó ahí, confírmalo con " +
    "consultar_eventos_calendario en vez de decir que no tienes visibilidad.",
  "Footprint NO tiene cashflow en la hoja de Sheets (consultar_cashflow_resumen, consultar_cashflow_detalle, " +
    "verificar_cashflow_actualizado, proponer_registro_cashflow) — ese cashflow es SOLO de WOBA y EWORKS. " +
    "Para Footprint todo se revisa y ejecuta directo en Holded (holded_movimientos, consultar_gastos_sin_" +
    "comprobante, etc.), nunca en el cashflow. NUNCA combines, sumes ni compares un concepto de Footprint " +
    "con el cashflow de WOBA/EWORKS, aunque el mismo concepto (ej. 'Seguridad Social', 'Google Workspace') " +
    "también aplique a Footprint por separado — son universos de datos distintos y cada empresa paga la " +
    "suya de forma independiente. Bug real que esto corrigió: se reportó 'Seguridad Social de WOBA más " +
    "Footprint' como una sola cifra a verificar contra el cashflow, cuando la porción de Footprint no " +
    "pertenece ahí en absoluto. Si una pregunta mezcla Footprint con WOBA/EWORKS, respóndelas por " +
    "separado — la de Footprint contra Holded, la de WOBA/EWORKS contra el cashflow.",
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
  "El cashflow de WOBA/EWORKS (hoja DATOS) tiene EXACTAMENTE 10 categorías reales, mapeadas en vivo y " +
    "verificadas contra el Sheet real el 2026-09-01 (Carlos las nombró explícitamente, no asumas que hay " +
    "más o menos): Ingresos, Pagos Proyectos, Pagos Extras, Gastos Fijos (nóminas/créditos/servicios — " +
    "'Impuestos'/'Créditos'/'Servicios' ahí dentro son subtítulos informales, no categorías propias), " +
    "Gastos Consultores Mes Actual, Gastos Consultores Próximo Mes (estas dos SÍ son categorías propias, " +
    "distintas de Gastos Fijos — viven en tablas propias con su propio título y encabezado), Impuestos " +
    "por Pagar, Aplazamiento Impuestos por Pagar (estas dos viven apiladas en la MISMA columna que Pagos " +
    "Proyectos, separadas por título de sección), Pagos Pendientes Alberto y Deudas Pendientes Otros. " +
    "Cuando busquen un concepto o proveedor específico (ej. '¿hay facturas de limpieza pendientes?', " +
    "'¿cuánto se ha pagado de Google?'), usa consultar_cashflow_detalle con el filtro 'contraparte' — " +
    "cubre las 10 categorías de una sola vez. Nunca respondas 'no encontré nada' o 'no hay movimientos' " +
    "sin haber llamado a esa herramienta primero — decir que algo no existe sin buscarlo primero es el " +
    "error más costoso que puedes cometer aquí. Si la estructura real del Sheet cambia otra vez (Carlos " +
    "edita esta hoja directamente), verifica en vivo antes de asumir que esta lista sigue vigente — nunca " +
    "confirmes que algo 'ya está reconocido' sin haberlo comprobado de verdad para ESE caso puntual.",
  "El calendario fiscal (consultar_base_conocimiento / alertas fiscales) dice CUÁNDO vence algo, pero " +
    "NUNCA tiene el monto exacto — esos datos solo viven en el cashflow real. Si te piden cuánto suma lo " +
    "que vence pronto, o el monto de un pago recurrente, NUNCA respondas 'cantidad sin especificar' o " +
    "'necesito que verifiques el monto' — para CADA concepto del calendario, llama a " +
    "consultar_cashflow_detalle con ese concepto como 'contraparte' (uno por uno si son varios) y usa el " +
    "valor real que te devuelva para sumar. Solo si esa búsqueda de verdad no encuentra nada (ni exacto " +
    "ni aproximado) dices que no tienes el monto — nunca lo digas sin haber buscado primero. Si el " +
    "concepto trae varias palabras clave o una barra ('créditos/préstamos', 'renovación/vencimiento'), " +
    "búscalas POR SEPARADO ('crédito' Y 'préstamo' cada uno con su propia llamada) — una sola búsqueda " +
    "con la palabra más corta puede devolver menos filas de las que realmente aplican, y sumarías de " +
    "menos sin darte cuenta. Suma TODO lo que encuentres entre las distintas búsquedas, no te quedes con " +
    "la primera.",
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
    "que ya ocurrieron, no explican el calendario ni las instrucciones de pago).",
  "Bug real corregido en vivo (2026-09-01): a una pregunta sobre 'claves de entrada a la oficina' y " +
    "luego 'control de accesos', el asistente respondió que no tenía información y se quedó ahí — cuando " +
    "en Drive SÍ existía un documento real ('guía rápida de control de accesos') con la respuesta, solo " +
    "que nunca se había transcrito a la base de conocimiento (archivar un documento en Drive y capturarlo " +
    "como conocimiento consultable son cosas DISTINTAS — un documento archivado no aparece en " +
    "consultar_base_conocimiento a menos que alguien lo haya capturado explícitamente). Por eso: si " +
    "consultar_base_conocimiento NO encuentra lo que buscas, antes de decir 'no tengo información' " +
    "intenta leer_documento_drive con palabras clave del tema (si no sabes en qué empresa, prueba con las " +
    "3) — busca Y LEE el contenido real de un documento archivado, no solo dice si existe. Si esa " +
    "herramienta sí encuentra y lee algo relevante, respondé con esa información real. Prueba también con " +
    "sinónimos o términos relacionados si la primera búsqueda no encuentra nada (ej. 'control de accesos' " +
    "también como 'acceso', 'llaves', 'entrada oficina', 'seguridad') — nunca te quedes con un solo " +
    "intento de una sola palabra exacta antes de responder que no hay información. Solo si de verdad no " +
    "aparece nada en ningún intento, dilo explícitamente en vez de inventar o completar con una suposición.",
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
  "Pedido explícito de Carlos: tienes acceso a búsqueda web real (web_search) para COMPLEMENTAR tus " +
    "respuestas con información pública — manuales de un dispositivo/sistema (ej. 'cómo se resetea el " +
    "panel 2N Access Unit M'), documentación técnica, normativa pública, o cualquier dato externo que no " +
    "sea información interna del grupo. Úsala cuando lo que preguntan claramente necesita eso y ni la " +
    "base de conocimiento interna ni los documentos de Drive lo tienen — no la uses para saludos, cálculos, " +
    "o cualquier cosa que ya puedas resolver directamente. NUNCA la uses para inventar o completar datos " +
    "INTERNOS del grupo (montos, contactos, contraseñas de sistemas internos, decisiones del equipo) — eso " +
    "siempre sale de las herramientas internas reales, nunca de una búsqueda externa. Cuando la uses, " +
    "cita la fuente (la API ya incluye las citas) en vez de presentar el dato como si lo supieras de " +
    "memoria — deja claro que viene de una búsqueda externa, no de conocimiento interno del grupo.",
].join("\n\n");

/**
 * Parte DINÁMICA del system prompt — cambia por llamada (fecha de hoy,
 * quién escribe, propuestas pendientes de este chat), nunca se cachea.
 *
 * Pedido explícito de Carlos, tras un caso real: le mandamos una propuesta
 * de archivar un documento con botones, pero respondió en texto libre en
 * vez de tocarlos ("archívalo... y responde el correo con un link") — el
 * chat normal no tenía ningún contexto de esa propuesta (vive en un store
 * aparte, no en el historial de conversación) y le pidió de nuevo datos que
 * ya se le habían mostrado. Ahora se avisa acá cuando hay una propuesta de
 * archivo sin responder para este chat, con la tool confirmar_archivo_pendiente
 * (core/tools/confirmarArchivoPendiente.ts) disponible para actuar sobre
 * ella si el mensaje del usuario aplica.
 */
async function buildSystemPromptDinamico(
  chatId: number | undefined,
  nombreRemitente?: string,
  pendientesPrefetch?: PendientesSensibles
): Promise<string> {
  const hoy = formatDateLocal(new Date());

  const partes = [
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
  ];

  if (chatId !== undefined) {
    // Reutiliza la lectura ya hecha en orquestarTurno (obtenerPendientesSensibles) cuando
    // viene provista — evita repetir las mismas 4 lecturas de Sheets dos veces por turno.
    // Solo se vuelve a consultar acá si por algún motivo no llegó prefetch (defensivo).
    const pendientes = pendientesPrefetch ?? (await obtenerPendientesSensibles(chatId));
    const { propuesta, resolucionContacto, gastoPendiente, reclasificacionPendiente } = pendientes;
    if (propuesta) {
      const origenTxt = propuesta.correoOrigen
        ? ` Vino de un correo de ${propuesta.correoOrigen.de}, asunto "${propuesta.correoOrigen.asunto}".`
        : "";
      partes.push(
        `Hay una propuesta de archivo SIN RESPONDER en este chat: "${propuesta.nombreArchivoOriginal}" ` +
          `(empresa ${propuesta.clasificacion.empresa}, carpeta sugerida "${propuesta.clasificacion.carpetaSugerida}").` +
          `${origenTxt} Se le mandó al usuario con botones, pero si su mensaje actual es una respuesta en ` +
          "texto libre a esa propuesta (ej. 'archívalo ahí', 'sí, guárdalo', o una instrucción compuesta " +
          "como 'archívalo y responde el correo con el link'), usa la herramienta confirmar_archivo_pendiente " +
          "para confirmarla — no le vuelvas a preguntar datos que ya se le mostraron en esa propuesta " +
          "(incluyendo quién mandó el correo, si ya se sabe). Si su mensaje pide algo distinto (programar " +
          "un recordatorio, guardar algo en la memoria del sistema, o cualquier otra instrucción), atiende " +
          "esa petición con la herramienta que corresponda — no repitas esta pregunta de archivo ni " +
          "inventes una aclaración propia sobre el pendiente; los botones de la propuesta original siguen " +
          "arriba en el chat por si luego quiere usarlos."
      );
    }

    if (resolucionContacto) {
      partes.push(
        `Hay una pregunta SIN RESPONDER en este chat: se avisó que el proveedor ` +
          `"${resolucionContacto.propuesta.proveedor}" no se encontró en los contactos de Holded ` +
          `(${resolucionContacto.empresaFinal}) y se le pidió al usuario que lo creara y avisara. Si su ` +
          "mensaje actual confirma que ya lo creó (ej. 'ya lo creé', 'listo', 'ya está', 'dale, ya lo " +
          "agregué'), usa la herramienta reintentar_contacto_pendiente — nunca le vuelvas a pedir los datos " +
          "de la factura, ya se leyeron antes. Si su mensaje pide algo distinto (programar un recordatorio, " +
          "guardar algo en la memoria del sistema, o cualquier otra instrucción), atiende esa petición con " +
          "la herramienta que corresponda — no repitas esta pregunta ni inventes una aclaración propia " +
          "sobre el pendiente."
      );
    }

    if (gastoPendiente) {
      const queFalta =
        gastoPendiente.motivo === "empresa"
          ? "a qué empresa (WOBA, EWORKS o Footprint) pertenece"
          : "el monto y moneda EXACTOS que salieron de la cuenta (la factura está en moneda extranjera sin equivalente explícito)";
      partes.push(
        `Hay una pregunta SIN RESPONDER en este chat sobre una factura/gasto: se detectó "${gastoPendiente.datos.proveedor}" ` +
          `(${gastoPendiente.datos.monto} ${gastoPendiente.datos.moneda}) pero todavía NO se mandó ninguna propuesta con ` +
          `botón — falta que el usuario confirme ${queFalta}. Si su mensaje actual responde eso, usa la herramienta ` +
          "reintentar_gasto_pendiente con el dato que dio — nunca le pidas que reenvíe el documento, ya se leyó, y " +
          "nunca le digas que 'ya se la mandaste' hasta que esta herramienta confirme que la propuesta salió. Si su " +
          "mensaje pide algo distinto (programar un recordatorio, guardar algo en la memoria del sistema, o " +
          "cualquier otra instrucción), atiende esa petición con la herramienta que corresponda — no repitas " +
          "esta pregunta ni inventes una aclaración propia sobre el pendiente."
      );
    }

    if (reclasificacionPendiente) {
      partes.push(
        `Hay una pregunta SIN RESPONDER en este chat: se le pidió al usuario la empresa y carpeta correctas ` +
          `para archivar "${reclasificacionPendiente.nombreArchivoOriginal}" (pulsó "Elegir otra carpeta" en la ` +
          `propuesta original). Si su mensaje actual responde eso (ej. "EWORKS, en Colaboradores/Alejandra", ` +
          `"es de Footprint", "en la carpeta de Facturas"), usa la herramienta reclasificar_documento_pendiente ` +
          "con esos datos — el archivo ya está guardado localmente, nunca le pidas que lo reenvíe. Si su mensaje " +
          "pide algo distinto (programar un recordatorio, guardar algo en la memoria del sistema, o cualquier " +
          "otra instrucción), atiende esa petición con la herramienta que corresponda — no repitas esta " +
          "pregunta de carpeta ni inventes una aclaración propia sobre el pendiente."
      );
    }
  }

  return partes.join("\n\n");
}

// Instrucción adicional SOLO para el primer intento (Haiku, herramientas
// restringidas a solo-lectura) — nunca cambia las reglas de negocio del
// prompt estático de arriba, solo le explica que está en modo económico y
// cuándo debe ceder el turno a Sonnet en vez de intentarlo con lo que
// tiene. También es texto fijo, así que también se cachea (breakpoint
// aparte) — Haiku recibe esta instrucción en TODAS sus llamadas.
//
// Pedido explícito de Carlos: "todavía no me da por el chat respuestas
// inteligentes y robustas que ayuden a los usuarios". La versión anterior
// de esta instrucción solo hacía escalar por herramientas de ESCRITURA que
// faltaban (correo, evento, corrección) — cualquier "consulta directa" se
// quedaba en Haiku sin más criterio, aunque la pregunta en realidad pidiera
// análisis, recomendación o cruzar varias fuentes para llegar a una
// conclusión (el tipo de respuesta que sí demuestran los ejemplos reales de
// Sonnet en las anotaciones de cashflow — ver registrarMensajeSaliente).
// Como es el propio Haiku quien decide si escala, y Haiku es el modelo más
// débil de los dos, hay que ser explícito sobre CUÁNDO una "consulta"
// simple en realidad necesita razonamiento — y decirle que ante la duda
// escale, en vez de dejarle margen para decidir que sí puede solo.
const INSTRUCCION_MODO_RAPIDO =
  `Estás respondiendo en modo rápido/económico, con un set reducido de herramientas: solo las de ` +
  `consulta (lectura), ninguna que proponga, registre o escriba nada. Este modo es SOLO para preguntas de ` +
  `dato simple y directo — un saludo, un saldo, un estado, una fecha, "¿tengo algo pendiente de X" — que se ` +
  `responden con una o dos consultas de lectura y sin tener que interpretar ni razonar nada. Si para ` +
  `responder de verdad necesitas algo que no tienes disponible — enviar o proponer un correo, proponer un ` +
  `evento de calendario, registrar una corrección, capturar un correo entrante, o cualquier verificación de ` +
  `precisión financiera real — O si la pregunta en el fondo pide análisis, recomendación, opinión, comparar ` +
  `opciones, interpretar una situación o cruzar información de varias fuentes para llegar a una conclusión ` +
  `(no solo reportar un dato tal cual sale de la fuente) — NO lo intentes con lo que tienes, no completes ` +
  `con una aproximación superficial, y no expliques primero por qué hace falta: llama directo a la ` +
  `herramienta ${NOMBRE_TOOL_ESCALAR}. Ante la duda de si es un dato simple o si de verdad requiere ` +
  `razonamiento, ESCALA — cuesta un poco más, pero una respuesta superficial en algo que sí importaba sale ` +
  `más cara. Solo para lo que sí es puramente un dato — responde tú mismo con normalidad, sigues siendo ` +
  `Wobi de principio a fin.`;

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

// Mismo patrón pasivo que ultimoEstadoClaude, para el panel de conexiones
// (core/cerebro/conexiones.ts): web_search es una tool hospedada sin
// "conexión" propia que pingear (viaja dentro de una llamada normal a
// Claude) — nunca se dispara una búsqueda real solo para comprobar el
// panel, eso costaría dinero en cada carga. Se registra el resultado de la
// ÚLTIMA vez que de verdad se usó (éxito, o el error real que devolvió la
// API — org sin la tool habilitada, límite de uso, etc.), null si todavía
// no se ha necesitado ninguna.
interface EstadoBusquedaWeb {
  ok: boolean;
  en: number;
  detalle?: string;
}

let ultimoEstadoBusquedaWeb: EstadoBusquedaWeb | null = null;

function registrarEstadoBusquedaWeb(ok: boolean, detalle?: string): void {
  ultimoEstadoBusquedaWeb = { ok, en: Date.now(), detalle };
}

export function obtenerUltimoEstadoBusquedaWeb(): EstadoBusquedaWeb | null {
  return ultimoEstadoBusquedaWeb;
}

function extraerQueryDeInput(input: unknown): string {
  if (input && typeof input === "object" && "query" in input) {
    const query = (input as { query?: unknown }).query;
    if (typeof query === "string" && query.trim()) return query;
  }
  return "(consulta desconocida)";
}

/**
 * Detecta bloques reales de búsqueda web en una respuesta de Claude —
 * compartido entre el loop normal de tool-use (ejecutarConversacion) y
 * buscarEnInternet (el buscador directo del panel /cerebro), para no
 * duplicar esta lógica en dos lugares. Actualiza el estado pasivo del
 * panel de conexiones (ok/error) Y registra cada búsqueda real en
 * webSearchLog.ts (query exacta, cuántos resultados, costo) — pedido
 * explícito de Carlos: no solo "está conectado", sino qué se buscó y qué
 * costó, de forma independiente y consultable.
 */
function procesarResultadosBusquedaWeb(
  content: Anthropic.ContentBlock[],
  chatId: number | undefined,
  origen: "chat" | "panel"
): void {
  const usosDeBusqueda = content.filter(
    (b): b is Anthropic.ServerToolUseBlock => b.type === "server_tool_use" && b.name === "web_search"
  );
  const resultados = content.filter(
    (b): b is Anthropic.WebSearchToolResultBlock => b.type === "web_search_tool_result"
  );

  for (const resultado of resultados) {
    if (Array.isArray(resultado.content)) {
      registrarEstadoBusquedaWeb(true);
      const query = extraerQueryDeInput(usosDeBusqueda.find((u) => u.id === resultado.tool_use_id)?.input);
      registrarBusquedaWeb(chatId, origen, query, resultado.content.length).catch((error) =>
        console.error("[webSearchLog] Error registrando búsqueda web (no crítico):", error)
      );
    } else {
      registrarEstadoBusquedaWeb(false, `Error de búsqueda web: ${resultado.content.error_code}`);
    }
  }
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
  | { tipo: "respuesta"; respuesta: string; messages: Anthropic.MessageParam[]; historialInicialLength: number }
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
  permiteEscalar: boolean,
  incluirBusquedaWeb: boolean,
  pendientesPrefetch?: PendientesSensibles
): Promise<ResultadoConversacion> {
  const anthropic = getClient();

  // web_search es una tool HOSPEDADA (la ejecuta la API de Anthropic, no
  // executeTool()) — nunca produce un bloque "tool_use" normal (produce
  // "server_tool_use"/"web_search_tool_result", tipos distintos), así que el
  // loop de abajo (que solo filtra block.type === "tool_use") la ignora
  // automáticamente sin necesitar ningún caso especial: cuando Claude solo
  // usa web_search, la búsqueda y la respuesta final llegan en la MISMA
  // respuesta con stop_reason "end_turn", tratada igual que cualquier
  // respuesta final de texto. Verificado contra la documentación oficial.
  const tools: Anthropic.ToolUnion[] = permiteEscalar ? [...toolsBase, TOOL_ESCALAR] : [...toolsBase];
  if (incluirBusquedaWeb) tools.push(WEB_SEARCH_TOOL);
  const nombresDisponibles = new Set(toolsBase.map((t) => t.name).concat(permiteEscalar ? [NOMBRE_TOOL_ESCALAR] : []));

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
  system.push({ type: "text", text: await buildSystemPromptDinamico(chatId, nombreRemitente, pendientesPrefetch) });

  const historial = usarHistorial && chatId !== undefined ? await obtenerHistorial(chatId) : [];
  const messages: Anthropic.MessageParam[] = [...historial, { role: "user", content: userText }];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model,
      // Verificado en vivo: claude-sonnet-5 emite "thinking" por defecto
      // (sin pedirlo explícitamente) y ese consumo cuenta contra max_tokens
      // — con 1024 se agotaba solo con el thinking en preguntas de análisis
      // financiero (varias empresas/semanas), dejando la respuesta real sin
      // texto y devolviendo "No he podido generar una respuesta" sin ningún
      // error visible en los logs (stop_reason "max_tokens", content solo
      // con un bloque "thinking"). 8192 da margen de sobra sin costo extra
      // real, ya que solo se factura lo que el modelo realmente genera.
      max_tokens: 8192,
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

    // Registra estado + historial de cada búsqueda web real de esta
    // respuesta (si hubo alguna) — ver procesarResultadosBusquedaWeb arriba.
    procesarResultadosBusquedaWeb(response.content, chatId, "chat");

    if (response.stop_reason !== "tool_use") {
      const textBlock = response.content.find((block) => block.type === "text");
      // Si de verdad se corta por longitud (raro con max_tokens=8192, pero
      // posible en un análisis muy largo) se lo decimos al usuario en vez
      // de un mensaje genérico sin explicación — antes esto pasaba en
      // silencio (sin ningún error en los logs) por el "thinking" implícito
      // de claude-sonnet-5 consumiendo el budget entero.
      const sinTextoPorLongitud = !textBlock && response.stop_reason === "max_tokens";
      const respuestaFinal =
        textBlock && textBlock.type === "text"
          ? textBlock.text
          : sinTextoPorLongitud
            ? "La respuesta se cortó por longitud antes de generar texto — intenta con una pregunta más puntual (por ejemplo, una sola empresa o semana a la vez)."
            : "No he podido generar una respuesta.";

      messages.push({ role: "assistant", content: response.content });
      return { tipo: "respuesta", respuesta: respuestaFinal, messages, historialInicialLength: historial.length };
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
    historialInicialLength: historial.length,
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
 * ToolDefinition.seguraParaModoRapido) — EXCEPTO si el chat tiene alguna de
 * las cuatro preguntas sensibles pendientes (ver obtenerPendientesSensibles),
 * en cuyo caso el intento con Haiku se salta directo y se va a Sonnet (ver
 * el comentario sobre obtenerPendientesSensibles para el porqué). Si Haiku sí
 * corre y responde el marcador ESCALAR (porque la petición necesita
 * proponer/escribir algo o precisión financiera real), se descarta esa
 * respuesta sin guardarla en el historial y se repite el turno con Sonnet y
 * el set de herramientas completo. Si Sonnet no está disponible (caída/
 * sobrecarga de la API), Haiku responde como respaldo — esta vez con el set
 * completo de herramientas, porque ya es la única opción que queda.
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

/**
 * Bug real encontrado en vivo (2026-09-03): con una reclasificación de
 * documento pendiente ("Elegir otra carpeta" sin terminar), Carlos escribió
 * una instrucción totalmente distinta y sin relación ("programa en el
 * calendario un correo de seguimiento para el lunes") — Haiku, en modo
 * rápido, la vio junto con el aviso de "pregunta sin responder" del system
 * prompt dinámico y respondió en texto plano insistiendo en la pregunta de
 * carpeta, en vez de reconocer que necesitaba programar_accion_futura (una
 * tool de escritura fuera de su set) y escalar — el propio
 * INSTRUCCION_MODO_RAPIDO le dice "ante la duda, escala", pero Haiku no
 * "dudó": entendió mal la relación y contestó directo, sin pasar por
 * ninguna tool (así que el chequeo de nombreNoDisponible en
 * ejecutarConversacion nunca se activó). Estas cuatro preguntas pendientes
 * son las únicas que dependen de que el modelo interprete texto libre para
 * decidir una acción real (a diferencia de otros pendientes, que Server.ts
 * intercepta directo sin pasar por Claude) — así que en vez de otro parche
 * de texto en el prompt, se salta Haiku por completo en esos turnos y se va
 * directo a Sonnet: más caro solo en esos casos puntuales, pero confiable.
 *
 * Se lee UNA sola vez por turno (acá) y el resultado se reutiliza tanto para
 * decidir si saltar el modo rápido como para construir el aviso en
 * buildSystemPromptDinamico — evita leer las mismas 4 hojas de Sheets dos
 * veces (bug encontrado en la auditoría de este mismo cambio). A diferencia
 * del chequeo anterior, los errores de lectura SÍ se registran (antes se
 * descartaban en silencio con .catch(() => undefined), lo que podía hacer
 * que un error transitorio de Sheets se interpretara como "no hay nada
 * pendiente" y dejara pasar el turno por Haiku sin ningún rastro en los logs
 * de por qué el chequeo no se activó).
 */
export interface PendientesSensibles {
  propuesta: Awaited<ReturnType<typeof obtenerPropuestaClasificacionPendientePorChat>>;
  resolucionContacto: Awaited<ReturnType<typeof obtenerResolucionContactoPendientePorChat>>;
  gastoPendiente: Awaited<ReturnType<typeof obtenerGastoPendienteDatosPorChat>>;
  reclasificacionPendiente: Awaited<ReturnType<typeof obtenerPendienteReclasificacionPorChat>>;
}

async function obtenerPendientesSensibles(chatId: number): Promise<PendientesSensibles> {
  const [propuesta, resolucionContacto, gastoPendiente, reclasificacionPendiente] = await Promise.all([
    obtenerPropuestaClasificacionPendientePorChat(chatId).catch((error) => {
      console.error("[claude/client] Error consultando propuesta de archivo pendiente (no crítico):", error);
      return undefined;
    }),
    obtenerResolucionContactoPendientePorChat(chatId).catch((error) => {
      console.error("[claude/client] Error consultando resolución de contacto pendiente (no crítico):", error);
      return undefined;
    }),
    obtenerGastoPendienteDatosPorChat(chatId).catch((error) => {
      console.error("[claude/client] Error consultando gasto pendiente de datos (no crítico):", error);
      return undefined;
    }),
    obtenerPendienteReclasificacionPorChat(chatId).catch((error) => {
      console.error("[claude/client] Error consultando reclasificación de documento pendiente (no crítico):", error);
      return undefined;
    }),
  ]);
  return { propuesta, resolucionContacto, gastoPendiente, reclasificacionPendiente };
}

function haySensiblePendiente(p: PendientesSensibles): boolean {
  return Boolean(p.propuesta || p.resolucionContacto || p.gastoPendiente || p.reclasificacionPendiente);
}

async function orquestarTurno(
  userText: string,
  chatId: number | undefined,
  nombreRemitente: string | undefined,
  usarHistorial: boolean
): Promise<string> {
  const pendientes = chatId !== undefined ? await obtenerPendientesSensibles(chatId) : undefined;
  const saltarModoRapido = pendientes !== undefined && haySensiblePendiente(pendientes);

  if (!saltarModoRapido) {
    const intentoRapido = await ejecutarConversacion(
      userText,
      chatId,
      nombreRemitente,
      usarHistorial,
      MODEL_HAIKU,
      getToolDefinitions(true),
      INSTRUCCION_MODO_RAPIDO,
      true,
      false, // sin búsqueda web en el modo rápido/económico — ver WEB_SEARCH_TOOL
      pendientes
    );

    if (intentoRapido.tipo === "respuesta") {
      // Solo los mensajes NUEVOS de este turno (no el array completo, que arranca con un historial
      // leído al empezar y quedaría stale para cuando esto se guarda) — ver el comentario de
      // guardarHistorial en conversationStore.ts.
      if (chatId !== undefined) {
        await guardarHistorial(chatId, intentoRapido.messages.slice(intentoRapido.historialInicialLength));
      }
      return intentoRapido.respuesta;
    }

    console.log(`[claude] Haiku escaló a Sonnet (chat ${chatId ?? "?"}).`);
  } else {
    console.log(
      `[claude] Se salta el modo rápido (chat ${chatId ?? "?"}) — hay una pregunta sin responder que necesita razonamiento completo.`
    );
  }

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
      false,
      true, // intento completo — búsqueda web disponible, ver WEB_SEARCH_TOOL
      pendientes
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
      false,
      true, // sigue siendo el intento "completo" (solo cambió el modelo por disponibilidad)
      pendientes
    );
  }

  // resultadoFinal siempre es tipo "respuesta" acá — permiteEscalar=false
  // garantiza que ejecutarConversacion nunca devuelva "escalar" en esta rama.
  if (resultadoFinal.tipo !== "respuesta") {
    throw new Error("Estado inesperado: el intento completo (Sonnet) no debería poder pedir escalar.");
  }

  if (chatId !== undefined) {
    await guardarHistorial(chatId, resultadoFinal.messages.slice(resultadoFinal.historialInicialLength));
  }
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
    await limpiarHistorial(chatId!);
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

export interface CitaBusquedaWeb {
  url: string;
  title: string;
}

export interface ResultadoBusquedaWeb {
  respuesta: string;
  citas: CitaBusquedaWeb[];
}

/**
 * Buscador directo, sin las herramientas internas del grupo — pedido
 * explícito de Carlos: "un pequeño panel... como un pequeño buscador
 * opcional desde el mismo sistema" en el front /cerebro. A diferencia de
 * askClaude (que pasa por todo el enrutamiento Haiku/Sonnet + herramientas
 * internas + historial de chat), esto es una sola llamada directa a Sonnet
 * con SOLO web_search — más simple y más barata para un uso puntual de
 * "busca esto en internet" sin necesitar nada del contexto del grupo.
 * Nunca toca el historial de ningún chat de Telegram.
 */
export async function buscarEnInternet(query: string): Promise<ResultadoBusquedaWeb> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: MODEL_SONNET,
    max_tokens: 2048,
    system:
      "Eres un buscador. Responde la consulta del usuario buscando información real y actual en internet " +
      "(usa la herramienta web_search) — nunca inventes ni respondas solo de memoria. Sé breve y directo, " +
      "en español salvo que la consulta esté en otro idioma.",
    messages: [{ role: "user", content: query }],
    tools: [WEB_SEARCH_TOOL],
  });

  registrarUsoIA(undefined, MODEL_SONNET, response.usage).catch((error) =>
    console.error("[costTracking] Error registrando uso de IA (buscarEnInternet):", error)
  );
  procesarResultadosBusquedaWeb(response.content, undefined, "panel");

  const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
  const respuesta = textBlocks.map((b) => b.text).join("\n\n").trim() || "No se obtuvo una respuesta de texto.";

  const citasPorUrl = new Map<string, CitaBusquedaWeb>();
  for (const block of textBlocks) {
    for (const cita of block.citations ?? []) {
      if (cita.type === "web_search_result_location" && !citasPorUrl.has(cita.url)) {
        citasPorUrl.set(cita.url, { url: cita.url, title: cita.title ?? cita.url });
      }
    }
  }

  return { respuesta, citas: Array.from(citasPorUrl.values()) };
}
