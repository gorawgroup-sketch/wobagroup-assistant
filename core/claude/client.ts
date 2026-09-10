import Anthropic from "@anthropic-ai/sdk";
import { executeTool, executeToolBatch, getToolDefinitions } from "../tools/registry";
import { formatDateLocal } from "../utils/dateFormat";
import { obtenerHistorial, guardarHistorial } from "./conversationStore";
import { ColaTurnos } from "./turnQueue";
import { impedirReinicioConEfectos, MENSAJE_ACCION_INCIERTA, TurnoConEfectosError } from "./turnSafety";
import { TiempoMaximoExcedidoError } from "../utils/asyncTimeout";
import { obtenerPropuestaClasificacionPendientePorChat } from "../documental/classificationStore";
import { obtenerResolucionContactoPendientePorChat } from "../gastos/contactoResolucionStore";
import { obtenerGastoPendienteDatosPorChat } from "../gastos/gastoPendienteDatosStore";
import { obtenerPendienteReclasificacionPorChat } from "../documental/pendienteReclasificacionStore";
import { registrarBusquedaWeb } from "./webSearchLog";
import { crearMensajeAnthropic } from "../ai/anthropicGateway";
import { crearEjecucionIA, type EjecucionIA } from "../ai/policy";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";

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
    "herramientas de solo lectura — proponer o enviar un correo, marcar un correo como leído, proponer " +
    "un evento, registrar una corrección, capturar un correo entrante, o cualquier verificación de " +
    "precisión financiera real (cashflow contra Holded, gastos sin movimiento bancario, etc.). También " +
    "úsala si te preguntan directamente si YA TIENES una herramienta o capacidad concreta — nunca " +
    "respondas 'no la tengo' solo porque no está en tu set reducido de este modo: puede que sí exista " +
    "para el modelo completo, así que escala en vez de dar una respuesta que podría ser falsa. Llámala " +
    "de inmediato, sin intentar responder primero con lo que tienes ni explicar por qué la necesitas — " +
    "el sistema pasa la conversación a un modelo con más herramientas y responde desde ahí.",
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
  "Cuando una herramienta incluya una nota [Frescura: ...], conserva esa nota en tu respuesta — " +
    "especialmente si indica caché o lectura compartida. Nunca presentes una lectura reutilizada como " +
    "si acabara de consultarse en la fuente.",
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
  "Cuando te pregunten si el cashflow 'está actualizado', 'está al día', si 'falta algo por " +
    "registrar', o pidan 'conciliar/verificar el cashflow' (aunque digan 'conciliar', NO es " +
    "consultar_movimientos_sin_conciliar — esa mira el estado interno de reconciliación bancaria de " +
    "Holded, no la hoja de cashflow; caso real que esto corrigió: reportó un pago de 500€ como " +
    "'faltante' que ya estaba en el cashflow, y mezcló movimientos de semanas anteriores por no " +
    "entender 'semana'), NO respondas solo con el resumen de consultar_cashflow_resumen (esos números " +
    "pueden estar completos en la hoja sin que reflejen la realidad del banco) — usa " +
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
  pendientesPrefetch?: PendientesSensibles,
  presentacion: "telegram" | "web" = "telegram"
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

  if (presentacion === "web") {
    partes.push(
      "Esta respuesta se mostrará en el chat web de Wobi. Responde de forma clara y escaneable. " +
        "Cuando existan tres o más valores comparables, usa una tabla Markdown con encabezados breves; " +
        "el front la convertirá de forma determinista en tabla y gráfico. No inventes valores para llenar " +
        "una visualización. Las acciones que requieran confirmación siguen usando los controles seguros " +
        "existentes y nunca deben darse por ejecutadas antes de recibir confirmación real."
    );
  }

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
  `responder de verdad necesitas algo que no tienes disponible — enviar o proponer un correo, marcar un ` +
  `correo como leído, proponer un evento de calendario, registrar una corrección, capturar un correo ` +
  `entrante, o cualquier verificación de precisión financiera real (ej. "concilia/verifica si el cashflow ` +
  `está al día" — aunque la palabra "conciliar" se parezca al nombre de consultar_movimientos_sin_conciliar, ` +
  `esa tool responde una pregunta DISTINTA — estado interno de Holded, no la hoja de cashflow — usarla acá ` +
  `da una respuesta con datos reales pero de la pregunta equivocada, tan mala como inventarla) — ` +
  `O si la pregunta en el fondo pide ` +
  `análisis, recomendación, opinión, comparar opciones, interpretar una situación o cruzar información de ` +
  `varias fuentes para llegar a una conclusión (no solo reportar un dato tal cual sale de la fuente) — NO ` +
  `lo intentes con lo que tienes, no completes con una aproximación superficial, y no expliques primero ` +
  `por qué hace falta: llama directo a la herramienta ${NOMBRE_TOOL_ESCALAR}. Esto incluye si te ` +
  `preguntan directamente si YA TIENES alguna herramienta o capacidad concreta — nunca respondas "no la ` +
  `tengo" solo porque no está en tu set reducido de este modo, puede que sí exista para el modelo ` +
  `completo: escala en vez de arriesgarte a dar una respuesta falsa. Ante la duda de si es un dato simple ` +
  `o si de verdad requiere razonamiento, ESCALA — cuesta un poco más, pero una respuesta superficial (o ` +
  `falsa) en algo que sí importaba sale más cara. Solo para lo que sí es puramente un dato — responde tú ` +
  `mismo con normalidad, sigues siendo Wobi de principio a fin.`;

const INSTRUCCION_SOLO_LECTURA_WEB =
  "Este dispositivo web todavía no está vinculado de forma verificable con una cuenta de Telegram. " +
  "Puedes consultar y analizar información, pero no puedes registrar, proponer ni ejecutar cambios. " +
  "Si la persona pide una acción de escritura, explica brevemente que debe vincular Telegram desde el " +
  "panel del chat para habilitar los mismos controles y confirmaciones del canal principal.";

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

/**
 * Pedido explícito de Carlos, tras un caso real (2026-09-09): el saldo de la cuenta de Anthropic se
 * agotó en pleno chat, y el único síntoma visible fue el mensaje genérico "Lo siento, ha ocurrido un
 * error procesando tu mensaje" repetido — nada le dijo a Carlos qué pasaba de verdad, ni acá ni en
 * ningún otro lado, hasta que se investigaron los logs a mano. Anthropic no expone ninguna API para
 * consultar el saldo restante ANTES de que se agote (investigado en vivo — no existe ese endpoint,
 * verificado contra la documentación oficial), así que no hay forma de avisar con anticipación real
 * desde el código — lo único posible es reconocer el error EXACTO en el momento en que ocurre y avisar
 * de inmediato, de la forma más clara posible, en vez de dejar que se vea como un error genérico más.
 */
export function esErrorSaldoAnthropicAgotado(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError) || typeof error.message !== "string") return false;
  const mensaje = error.message.toLowerCase();
  // Hallazgo real de auditoría: "credit balance is too low" (el caso real de Carlos) siempre llega como
  // 400 — pero Anthropic documenta un 402 "billing_error" aparte para otros problemas de facturación
  // (ej. una tarjeta de auto-recarga rechazada) que también deberían avisar igual, aunque el mensaje sea
  // distinto — se cubre por status, no solo por texto exacto, para no quedar corto ante ese otro caso.
  return (error.status === 400 && mensaje.includes("credit balance is too low")) || error.status === 402;
}

const COOLDOWN_AVISO_SALDO_MS = 30 * 60 * 1000; // no más de 1 aviso cada 30 min, para no saturar el chat con la misma alerta.
let ultimoAvisoSaldoEn = 0;

/**
 * Avisa a TODOS los admins (no solo a quien mandó el mensaje que disparó el error) — con enfriamiento
 * para no repetir el mismo aviso en cada mensaje fallido mientras dure la interrupción real.
 *
 * Hallazgo real de auditoría: el enfriamiento se marcaba ANTES de intentar avisar — si obtenerAdmins()
 * o TODOS los sendTelegramMessage fallaban (ej. un error transitorio de Sheets/Telegram justo en ese
 * momento), el aviso real nunca llegaba a nadie pero el enfriamiento igual quedaba consumido, dejando a
 * Carlos sin ningún aviso durante los siguientes 30 minutos — exactamente el escenario que esta función
 * existe para evitar. Ahora el enfriamiento solo se marca si de verdad se le avisó a AL MENOS un admin.
 */
async function avisarSaldoAnthropicAgotado(): Promise<void> {
  if (Date.now() - ultimoAvisoSaldoEn < COOLDOWN_AVISO_SALDO_MS) return;

  const admins = await obtenerAdmins().catch((error) => {
    console.error("[claude] Error obteniendo admins para avisar del saldo agotado:", error);
    return [];
  });
  const texto =
    "🚨 El saldo de la cuenta de Anthropic (la que usa WOBI para responder) se agotó — el chat no puede " +
    "responder hasta que se recargue crédito. Entra a console.anthropic.com → Plans & Billing → agrega " +
    "crédito. También conviene activar ahí un \"Usage Alert\" (aviso por email a un saldo mínimo) para que " +
    "esto avise ANTES de agotarse la próxima vez — no existe ninguna forma de que WOBI lo detecte con " +
    "anticipación, solo en el momento en que ya falló.";

  let algunoAvisado = false;
  for (const admin of admins) {
    await sendTelegramMessage(admin.userId, texto)
      .then(() => {
        algunoAvisado = true;
      })
      .catch((error) => console.error(`[claude] Error avisando a admin ${admin.userId} del saldo agotado:`, error));
  }

  if (algunoAvisado) {
    ultimoAvisoSaldoEn = Date.now();
  } else {
    console.error("[claude] No se pudo avisar a NINGÚN admin del saldo agotado — no se consume el enfriamiento, se reintentará en el próximo mensaje fallido.");
  }
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
    await crearMensajeAnthropic(anthropic, crearEjecucionIA("healthcheck_claude_manual"), {
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
  ejecucion: EjecucionIA,
  pendientesPrefetch?: PendientesSensibles,
  presentacion: "telegram" | "web" = "telegram"
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
  system.push({
    type: "text",
    text: await buildSystemPromptDinamico(chatId, nombreRemitente, pendientesPrefetch, presentacion),
  });

  const historial = usarHistorial && chatId !== undefined ? await obtenerHistorial(chatId) : [];
  const messages: Anthropic.MessageParam[] = [...historial, { role: "user", content: userText }];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await crearMensajeAnthropic(anthropic, ejecucion, {
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
    }, chatId);

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

    const inicioLote = Date.now();
    const toolResults = await executeToolBatch(toolUseBlocks, nombresDisponibles, {
      chatId,
      ejecucionId: ejecucion.id,
      antesDeEfecto: () => { ejecucion.efectosIniciados = true; },
    });
    console.log("[tools/batch]", JSON.stringify({
      ejecucionId: ejecucion.id, cantidad: toolUseBlocks.length,
      duracionMs: Date.now() - inicioLote,
    }));

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
  if (error instanceof TiempoMaximoExcedidoError) return error.operacion === "solicitud_modelo";
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
  usarHistorial: boolean,
  ejecucion: EjecucionIA,
  opciones: OpcionesAskClaude
): Promise<string> {
  const pendientes = chatId !== undefined ? await obtenerPendientesSensibles(chatId) : undefined;
  const saltarModoRapido = pendientes !== undefined && haySensiblePendiente(pendientes);
  let haikuNoDisponible = false;

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
      ejecucion,
      pendientes,
      opciones.presentacion ?? "telegram"
    ).catch((error): ResultadoConversacion => {
      impedirReinicioConEfectos(ejecucion, error);
      if (!esErrorDeDisponibilidad(error)) throw error;
      haikuNoDisponible = true;
      console.warn("[claude] Modo rápido no disponible; se intenta el modelo principal una vez.");
      return { tipo: "escalar" };
    });

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
      getToolDefinitions(opciones.soloLectura ?? false),
      opciones.soloLectura ? INSTRUCCION_SOLO_LECTURA_WEB : undefined,
      false,
      true, // intento completo — búsqueda web disponible, ver WEB_SEARCH_TOOL
      ejecucion,
      pendientes,
      opciones.presentacion ?? "telegram"
    );
  } catch (error) {
    impedirReinicioConEfectos(ejecucion, error);
    if (!esErrorDeDisponibilidad(error) || haikuNoDisponible) throw error;

    console.warn("[claude] Sonnet no disponible; respaldo sin acciones previas.");
    resultadoFinal = await ejecutarConversacion(
      userText,
      chatId,
      nombreRemitente,
      usarHistorial,
      MODEL_HAIKU,
      getToolDefinitions(opciones.soloLectura ?? false),
      opciones.soloLectura ? INSTRUCCION_SOLO_LECTURA_WEB : undefined,
      false,
      true, // sigue siendo el intento "completo" (solo cambió el modelo por disponibilidad)
      ejecucion,
      pendientes,
      opciones.presentacion ?? "telegram"
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
export interface OpcionesAskClaude {
  soloLectura?: boolean;
  presentacion?: "telegram" | "web";
}

const colaTurnos = new ColaTurnos();

async function askClaudeInterno(
  userText: string,
  chatId?: number,
  nombreRemitente?: string,
  proceso = "chat_conversacional",
  opciones: OpcionesAskClaude = {}
): Promise<string> {
  const ejecucion = crearEjecucionIA(proceso);
  try {
    const respuesta = await orquestarTurno(userText, chatId, nombreRemitente, true, ejecucion, opciones);
    registrarEstadoClaude(true);
    return respuesta;
  } catch (error) {
    registrarEstadoClaude(false, error instanceof Error ? error.message : String(error));

    if (ejecucion.efectosIniciados) {
      // Conserva el pedido y la incertidumbre; nunca reinicia ni borra la memoria tras una acción.
      if (chatId !== undefined) {
        await guardarHistorial(chatId, [
          { role: "user", content: userText },
          { role: "assistant", content: MENSAJE_ACCION_INCIERTA },
        ]).catch(() => console.warn("[claude] No se pudo guardar el aviso de acción incierta."));
      }
      throw error instanceof TurnoConEfectosError ? error : new TurnoConEfectosError(error);
    }

    // Hallazgo real de auditoría (caso real, Carlos, 2026-09-09): un saldo de Anthropic agotado
    // también es un 400 invalid_request_error — antes caía en la salvaguarda de "historial rechazado"
    // de abajo y se reintentaba SIN HISTORIAL, un segundo intento inútil (el saldo sigue en cero,
    // vuelve a fallar exactamente igual) que solo demoraba más la respuesta y ensuciaba los logs. Se
    // detecta primero y aparte: nunca tiene sentido reintentar, y sí tiene sentido avisar de inmediato
    // (ver avisarSaldoAnthropicAgotado) en vez de dejarlo pasar como un error genérico más.
    if (esErrorSaldoAnthropicAgotado(error)) {
      await avisarSaldoAnthropicAgotado();
      throw error;
    }

    // Salvaguarda ante un historial en memoria que la API rechaza (400
    // invalid_request_error) — la causa raíz conocida ya está corregida en
    // guardarHistorial, pero esto cubre cualquier otro caso no previsto en
    // vez de tumbar la conversación entera del chat. Se reintenta UNA vez
    // sin historial en la solicitud (NO borra la memoria persistida); si también falla, el error
    // se deja propagar tal cual para que el llamador lo reporte.
    const esRechazoDeHistorial =
      error instanceof Anthropic.APIError && error.status === 400 && chatId !== undefined &&
      /tool_result|tool_use|messages\.[0-9]|messages\[[0-9]/i.test(error.message);

    if (!esRechazoDeHistorial) {
      throw error;
    }

    console.warn("[claude] Formato de historial rechazado; intento aislado sin borrar memoria.");
    try {
      const respuesta = await orquestarTurno(userText, chatId, nombreRemitente, false, ejecucion, opciones);
      registrarEstadoClaude(true);
      return respuesta;
    } catch (segundoError) {
      registrarEstadoClaude(false, segundoError instanceof Error ? segundoError.message : String(segundoError));
      impedirReinicioConEfectos(ejecucion, segundoError);
      throw segundoError;
    }
  }
}

/**
 * Punto único de entrada conversacional para Telegram y web. Los turnos de
 * una misma identidad se serializan antes de leer el historial: así un
 * mensaje enviado desde cada canal casi al mismo tiempo no puede leer el
 * mismo contexto antiguo ni guardar respuestas fuera de orden.
 */
export function askClaude(
  userText: string,
  chatId?: number,
  nombreRemitente?: string,
  proceso = "chat_conversacional",
  opciones: OpcionesAskClaude = {}
): Promise<string> {
  const tarea = () => askClaudeInterno(userText, chatId, nombreRemitente, proceso, opciones);
  return chatId === undefined ? tarea() : colaTurnos.ejecutar(chatId, tarea);
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
  const ejecucion = crearEjecucionIA("busqueda_web_panel");

  const response = await crearMensajeAnthropic(anthropic, ejecucion, {
    model: MODEL_SONNET,
    max_tokens: 2048,
    system:
      "Eres un buscador. Responde la consulta del usuario buscando información real y actual en internet " +
      "(usa la herramienta web_search) — nunca inventes ni respondas solo de memoria. Sé breve y directo, " +
      "en español salvo que la consulta esté en otro idioma.",
    messages: [{ role: "user", content: query }],
    tools: [WEB_SEARCH_TOOL],
  });

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

const SYSTEM_PROMPT_RESPUESTA_AUTOMATICA =
  "Eres Wobi, el asistente de WOBA Group, respondiendo AUTOMÁTICAMENTE (sin que Carlos González, CAO, " +
  "revise ni apruebe este mensaje antes de enviarse) un correo de una conversación con un contacto que " +
  "Carlos aprobó de antemano, uno por uno, para este trato. Tu única tarea es redactar el cuerpo de la " +
  "respuesta que continúa esta conversación con fluidez y naturalidad, como lo haría alguien del equipo " +
  "que conoce el contexto.\n\n" +
  "Tienes SOLO herramientas de consulta (lectura) — Drive, cashflow, Holded, base de conocimiento, etc. " +
  "Úsalas para verificar cualquier dato real (montos, fechas, estados) antes de mencionarlo — nunca " +
  "inventes ni asumas una cifra. NO tienes ninguna herramienta que escriba, cree, envíe dinero o " +
  "modifique nada — si la respuesta correcta a esta persona requeriría una acción real de ese tipo, " +
  "NUNCA la des por hecha ni prometas que ya se hizo: dilo con honestidad ('lo reviso con el equipo y te " +
  "confirmo', 'dejo esto anotado para gestionarlo') y sigue con el resto de la respuesta con naturalidad.\n\n" +
  "Responde en el mismo idioma del hilo. No reveles información interna que no sea directamente " +
  "relevante para esta persona o este tema. Devuelve ÚNICAMENTE el cuerpo del correo de respuesta, listo " +
  "para enviar — sin firma (se agrega aparte), sin asunto, sin explicarle a nadie que eres una IA dentro " +
  "del cuerpo (eso ya lo indica una leyenda que se agrega al final del correo, aparte de tu texto).";

/**
 * Redacta la respuesta de un correo para la conversación automática con un
 * contacto pre-aprobado (ver revisarConversacionesAutomaticas.ts) — pedido
 * explícito de Carlos: "solo toca Drive, cashflow u otros para revisar y
 * extrae información... pero no debes cambiar nada sin mi autorización".
 * Por eso esta función SOLO expone las tools marcadas seguraParaModoRapido
 * (de solo lectura, sin ningún efecto secundario — mismo criterio ya usado
 * para el primer intento económico con Haiku) — nunca las de escritura,
 * aunque el registro completo las tenga. Mismo chequeo de defensa en
 * profundidad que ejecutarConversacion: si el modelo pide una tool que no
 * estaba en el set ofrecido, nunca se ejecuta.
 */
export async function responderCorreoAutomatico(params: {
  remitente: string;
  asunto: string;
  hiloTexto: string;
}): Promise<string> {
  const anthropic = getClient();
  const ejecucion = crearEjecucionIA("respuesta_correo_automatica");
  const tools = getToolDefinitions(true); // solo las de solo lectura — ver comentario arriba
  const nombresDisponibles = new Set(tools.map((t) => t.name));

  const userText =
    `Remitente: ${params.remitente}\nAsunto: ${params.asunto}\n\n` +
    `Hilo completo de la conversación (más antiguo primero):\n\n${params.hiloTexto}\n\n` +
    `Redacta la respuesta a enviar ahora, continuando la conversación.`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userText }];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await crearMensajeAnthropic(anthropic, ejecucion, {
      model: MODEL_SONNET,
      max_tokens: 4096,
      system: SYSTEM_PROMPT_RESPUESTA_AUTOMATICA,
      tools,
      messages,
    });

    if (response.stop_reason !== "tool_use") {
      const textBlock = response.content.find((block) => block.type === "text");
      return textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
    }

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (!nombresDisponibles.has(block.name)) {
        // Defensa en profundidad — igual que ejecutarConversacion: nunca ejecutar una tool que no
        // estaba realmente ofrecida en esta llamada, aunque exista en el registro completo.
        console.error(`[claude:respuesta-automatica] Tool "${block.name}" solicitada pero no disponible — no se ejecuta.`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: la herramienta "${block.name}" no está disponible en este contexto.`,
          is_error: true,
        });
        continue;
      }
      const result = await executeTool(block.name, block.input as Record<string, unknown>, {});
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return "";
}

const REPORTAR_HALLAZGO_TOOL_NAME = "reportar_hallazgo_autorrevision";

const REPORTAR_HALLAZGO_TOOL: Anthropic.Tool = {
  name: REPORTAR_HALLAZGO_TOOL_NAME,
  description: "Reporta el resultado de la revisión de este archivo. Debes llamarla siempre al terminar — nunca respondas solo en texto.",
  input_schema: {
    type: "object",
    properties: {
      encontro_problema: {
        type: "boolean",
        description:
          "true SOLO si encontraste un bug real y concreto (no una preferencia de estilo, no una " +
          "posible mejora, no una duda) — algo que produce un resultado incorrecto, un crash, o un " +
          "comportamiento distinto al que el resto del código claramente pretende. Si tienes cualquier " +
          "duda razonable de que sea un bug real, reporta false.",
      },
      resumen: {
        type: "string",
        description: "Una frase breve (para un mensaje de Telegram) describiendo el bug encontrado. Omite si encontro_problema es false.",
      },
      diagnostico: {
        type: "string",
        description:
          "2-4 frases: qué línea(s), qué entrada/estado dispara el bug, y qué arreglaste. Omite si encontro_problema es false.",
      },
      contenido_nuevo_completo: {
        type: "string",
        description:
          "El archivo COMPLETO ya corregido, de la primera a la última línea — nunca un fragmento ni un " +
          "diff. El arreglo debe ser MÍNIMO (solo lo necesario para corregir el bug reportado, sin " +
          "refactors, sin cambiar estilo/nombres/comentarios ajenos al bug). Omite este campo por " +
          "completo si encontro_problema es false.",
      },
    },
    required: ["encontro_problema"],
  },
};

const SYSTEM_PROMPT_AUTORREVISION_CODIGO =
  "Eres un revisor de código sénior haciendo la autorrevisión nocturna, desatendida, de un archivo " +
  "TypeScript de este proyecto (WOBA Copilot / Wobi) — NADIE va a curar tu resultado antes de que se " +
  "convierta en un Pull Request real con un botón de un solo tap para desplegarlo, así que tu prioridad " +
  "es NUNCA reportar un falso positivo. Es preferible reportar 'sin problema' diez veces de más que " +
  "proponer un arreglo de algo que en realidad no es un bug, o un arreglo que cambia el comportamiento " +
  "más allá del bug concreto.\n\n" +
  "Solo reporta un problema si puedes nombrar la entrada/estado exacto que lo dispara y el resultado " +
  "incorrecto o crash que produce — el mismo estándar que 'CONFIRMED' en una auditoría de código de " +
  "este proyecto. Ignora: preferencias de estilo, posibles mejoras, abstracciones, manejo de errores " +
  "adicional 'por si acaso', o cualquier cosa que no sea un bug real y concreto ya presente en el código.\n\n" +
  "Si encuentras un bug real, tu arreglo debe ser el mínimo cambio que lo corrige — preserva el resto " +
  "del archivo EXACTAMENTE igual (mismo estilo, mismos nombres, mismos comentarios, sin refactors ni " +
  "limpieza adicional), y devuelve el archivo COMPLETO corregido.";

/**
 * Revisión autónoma de un solo archivo (ver core/jobs/autorrevisionCodigo.ts) — pedido explícito de
 * Carlos: "que el sistema se autorrevise y autorrepare lo necesario de manera inteligente". Nunca
 * usa herramientas (no necesita leer nada más: recibe el archivo completo) y nunca decide desplegar
 * nada por sí sola — solo diagnostica y, si encuentra un bug real, redacta el arreglo; desplegarlo
 * siempre pasa por la aprobación de un tap en Telegram (ver autorrepairCallbackHandler.ts).
 */
export async function revisarCodigoAutonomamente(params: {
  ruta: string;
  contenidoActual: string;
}): Promise<{ encontroProblema: boolean; resumen?: string; diagnostico?: string; contenidoNuevoCompleto?: string }> {
  const anthropic = getClient();
  const ejecucion = crearEjecucionIA("autorrevision_codigo");

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Archivo: ${params.ruta}\n\n\`\`\`typescript\n${params.contenidoActual}\n\`\`\`\n\nRevisa este archivo y reporta tu conclusión.`,
    },
  ];

  const response = await crearMensajeAnthropic(anthropic, ejecucion, {
    model: MODEL_SONNET,
    // Más alto que el estándar del proyecto (8192): acá la respuesta no es solo texto, es el ARCHIVO
    // COMPLETO reescrito (hasta 400 líneas, ver MAX_LINEAS_ARCHIVO en autorrevisionCodigo.ts) más el
    // resumen/diagnóstico — un techo ajustado cortaría la reescritura a mitad de archivo.
    max_tokens: 16384,
    // El trabajo nocturno revisa tres archivos seguidos con las mismas
    // instrucciones y el mismo esquema de salida. El breakpoint cubre
    // tools + system, pero deja fuera el archivo (contenido único), por lo
    // que reduce coste/latencia sin cambiar la revisión ni su contexto.
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT_AUTORREVISION_CODIGO,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [REPORTAR_HALLAZGO_TOOL],
    // Forzado (no "auto"): sin esto, el modelo podría responder solo en texto y quedaría
    // indistinguible de un "sin problema" real — hallazgo real de auditoría.
    tool_choice: { type: "tool", name: REPORTAR_HALLAZGO_TOOL_NAME },
    messages,
  });

  // Si la respuesta se cortó por el límite de tokens, el "archivo completo" que reporte puede estar
  // truncado a mitad de línea aunque pase el chequeo de longitud del llamador — hallazgo real de
  // auditoría. Mejor perder este hallazgo que abrir un PR con TypeScript inválido.
  if (response.stop_reason === "max_tokens") {
    console.error(`[revisarCodigoAutonomamente] Respuesta cortada por max_tokens revisando ${params.ruta} — se descarta.`);
    return { encontroProblema: false };
  }

  const reportar = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === REPORTAR_HALLAZGO_TOOL_NAME
  );
  if (!reportar) return { encontroProblema: false };

  const input = reportar.input as Record<string, unknown>;
  if (input.encontro_problema !== true) return { encontroProblema: false };

  const contenidoNuevoCompleto = typeof input.contenido_nuevo_completo === "string" ? input.contenido_nuevo_completo : "";
  if (!contenidoNuevoCompleto.trim()) return { encontroProblema: false };

  return {
    encontroProblema: true,
    resumen: typeof input.resumen === "string" ? input.resumen : "Bug encontrado durante la autorrevisión.",
    diagnostico: typeof input.diagnostico === "string" ? input.diagnostico : "",
    contenidoNuevoCompleto,
  };
}

const NOMBRE_TOOL_CORRECCION_GASTO = "reportar_correccion_gasto";

const TOOL_CORRECCION_GASTO: Anthropic.Tool = {
  name: NOMBRE_TOOL_CORRECCION_GASTO,
  description:
    "Reporta cómo interpretar la respuesta del usuario a 'dime el monto real a registrar' para " +
    "corregir un gasto. Llámala siempre al terminar, nunca respondas solo en texto.",
  input_schema: {
    type: "object",
    properties: {
      tipo: {
        type: "string",
        enum: ["monto_nuevo", "fraccion", "moneda_incorrecta", "no_entendido"],
        description:
          "monto_nuevo: dio un número absoluto nuevo, en la MISMA moneda que ya tenía el gasto. " +
          "fraccion: dio una fracción/porcentaje del monto original (ej. 'la mitad', '30%'), " +
          "también en la misma moneda. moneda_incorrecta: dijo explícitamente que la MONEDA " +
          "original estaba mal e indicó cuál es la correcta — el número puede quedarse igual (el " +
          "caso típico: dijeron un monto en la moneda equivocada por error) o también cambiar si lo " +
          "dio explícito. no_entendido: no puedes interpretar con confianza real ninguno de los " +
          "anteriores — ante cualquier duda genuina usa esto, NUNCA inventes ni asumas.",
      },
      monto: {
        type: "number",
        description:
          "El número EXACTO que escribió el usuario — solo si tipo es monto_nuevo, o si tipo es " +
          "moneda_incorrecta Y además dio un monto nuevo explícito (no el que ya tenía la propuesta). " +
          "Nunca inventado, nunca convertido entre monedas.",
      },
      fraccion: {
        type: "number",
        description: "Solo si tipo es fraccion — de 0 a 1 (ej. 0.5 para 'la mitad', 0.3 para '30%').",
      },
      monedaCorrecta: {
        type: "string",
        description:
          "Solo si tipo es moneda_incorrecta — código ISO de 3 letras (EUR, USD, GBP, MXN, COP, etc.) " +
          "de la moneda que el usuario dice que es la correcta, tal como se puede inferir de sus " +
          "palabras (ej. 'euros'→EUR, 'dólares'→USD, 'libras'→GBP).",
      },
    },
    required: ["tipo"],
  },
};

const SYSTEM_PROMPT_CORRECCION_GASTO =
  "Interpretas la respuesta de un usuario a la pregunta 'dime el monto real a registrar' para " +
  "corregir un gasto pendiente de aprobar. El usuario puede estar corrigiendo el MONTO (un número " +
  "nuevo, una fracción del original como 'la mitad', o un porcentaje) — o corrigiendo la MONEDA " +
  "(diciendo que la moneda original estaba mal y cuál es la correcta, con o sin repetir el monto). " +
  "NUNCA inventes ni conviertas un valor que el usuario no dio explícitamente — si tienes cualquier " +
  "duda real de qué quiso decir, reporta 'no_entendido' en vez de adivinar. Reporta SIEMPRE con la " +
  "tool, nunca en texto plano.";

export type CorreccionGasto =
  | { tipo: "monto_nuevo"; monto: number }
  | { tipo: "fraccion"; fraccion: number }
  | { tipo: "moneda_incorrecta"; monedaCorrecta: string; monto?: number }
  | { tipo: "no_entendido" };

/**
 * Fallback inteligente para "💰 Ajustar monto" (ver gastoCallbackHandler.ts) — cuando el parser
 * rápido/determinista (interpretarNuevoMonto, solo entiende un número literal o "la mitad"/"N%") no
 * reconoce el texto, esto intenta interpretarlo con Claude antes de rendirse. Pedido explícito de
 * Carlos, tras un caso real: el correo de Kelly decía "$12.71" pero el cargo real había sido en
 * euros — Carlos respondió "12.71 Euros, en lugar de dólares, la moneda estaba equivocada" y el
 * parser rígido nunca lo entendió como una corrección de moneda, solo como un intento fallido de dar
 * un número ("No entendí... dime un número"). Un solo mensaje de texto libre, sin herramientas — solo
 * clasifica, nunca inventa ni convierte un valor no dado explícitamente (ver TOOL_CORRECCION_GASTO).
 */
export async function interpretarCorreccionGasto(params: {
  textoUsuario: string;
  montoOriginal: number;
  monedaOriginal: string;
}): Promise<CorreccionGasto> {
  const anthropic = getClient();
  const ejecucion = crearEjecucionIA("interpretar_correccion_gasto");

  const userText =
    `El gasto original es ${params.montoOriginal} ${params.monedaOriginal}. El usuario respondió a ` +
    `"dime el monto real a registrar" con: "${params.textoUsuario}". ¿Qué quiso decir?`;

  const response = await crearMensajeAnthropic(anthropic, ejecucion, {
    model: MODEL_HAIKU,
    max_tokens: 512,
    system: SYSTEM_PROMPT_CORRECCION_GASTO,
    tools: [TOOL_CORRECCION_GASTO],
    tool_choice: { type: "tool", name: NOMBRE_TOOL_CORRECCION_GASTO },
    messages: [{ role: "user", content: userText }],
  });

  const reportar = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === NOMBRE_TOOL_CORRECCION_GASTO
  );
  if (!reportar) return { tipo: "no_entendido" };

  const input = reportar.input as Record<string, unknown>;

  if (input.tipo === "monto_nuevo" && typeof input.monto === "number" && input.monto > 0) {
    return { tipo: "monto_nuevo", monto: input.monto };
  }
  if (input.tipo === "fraccion" && typeof input.fraccion === "number" && input.fraccion > 0) {
    return { tipo: "fraccion", fraccion: input.fraccion };
  }
  if (input.tipo === "moneda_incorrecta" && typeof input.monedaCorrecta === "string" && input.monedaCorrecta.trim()) {
    return {
      tipo: "moneda_incorrecta",
      monedaCorrecta: input.monedaCorrecta.trim().toUpperCase(),
      monto: typeof input.monto === "number" && input.monto > 0 ? input.monto : undefined,
    };
  }
  return { tipo: "no_entendido" };
}
