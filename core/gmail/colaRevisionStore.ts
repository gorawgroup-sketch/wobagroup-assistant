import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "./colaStorage";
import { conCoordinadorCorreo } from "./automatico/postgres";
import { conMutex } from "../utils/asyncMutex";

/**
 * Pedido explícito de Carlos: revisarCorreoNuevo.ts mandaba una propuesta
 * por CADA correo nuevo en la misma pasada — con varios correos a la vez,
 * eso significaba varias propuestas de golpe, imposibles de procesar todas
 * ("necesitamos organizar este proceso"). Ahora se revisa UN correo a la
 * vez, del más antiguo al más nuevo: este store es la cola — qué correos
 * (is:unread reales de Gmail) faltan por mostrar, y cuál está "activo"
 * (mostrado ahora mismo, esperando que se resuelva en el chat antes de
 * mostrar el siguiente).
 *
 * `pendientesRestantes` en la fila "activo" es cuántas decisiones
 * independientes hacen falta para dar ese correo por resuelto — 1 para la
 * mayoría (una propuesta de acción, o "guardar conocimiento"/"siguiente"),
 * o el número de adjuntos si el correo trae varios (cada uno con su propia
 * propuesta de clasificación de documento). Se decrementa desde CUALQUIER
 * punto terminal real del sistema (doc_confirm, doc_reroute, email_proceder/
 * descartar, continuarConOrientacion, capturaempresa_confirmar/cancelar,
 * correoinfo_siguiente) vía resolverUnoActivo — nunca hace falta que esos
 * lugares sepan que existe esta cola, solo "algo se resolvió para el correo
 * activo de este chat, si lo hay".
 *
 * Sin TTL a propósito: a diferencia de los "pendiente_*" normales (una
 * pregunta con botones que expira si nadie contesta), esto es la cola REAL
 * de correo sin leer — debe seguir ahí hasta que de verdad se resuelva,
 * por eso al final del día se manda un aviso con cuántos quedan en vez de
 * dejarlos vencer en silencio (ver revisarPendientesCorreo7pm.ts).
 */

export type EstadoColaCorreo = "cola" | "activo";

export interface ItemColaCorreo {
  /**
   * Gmail THREAD id, no de mensaje individual — bug real encontrado en
   * vivo: Gmail cuenta y muestra "correos sin leer" por hilo (conversación),
   * no por mensaje suelto (un hilo puede tener 2+ mensajes sin leer). Se usa
   * para marcar leído (marcarHiloComoLeido) y para deduplicar contra el
   * estado real de Gmail.
   */
  id: string;
  /** El mensaje MÁS RECIENTE de ese hilo — con éste se trabaja el contenido real (obtenerResumenCorreo, adjuntos, etc, que siguen operando por mensaje). */
  mensajeId: string;
  chatId: number;
  de: string;
  asunto: string;
  fechaOrden: number; // ms epoch — orden de llegada real del correo, para procesar del más antiguo al más nuevo
  estado: EstadoColaCorreo;
  pendientesRestantes: number;
  agregadoEn: number;
  /**
   * Claves de acciones terminales ya aplicadas al contador. Se persisten en
   * la misma fila que `pendientesRestantes`, de modo que reanudar un callback
   * tras un crash/ACK incierto no pueda descontar dos veces la misma decisión.
   * Columna añadida al final para conservar compatibles las filas antiguas.
   */
  accionesResueltas: string[];
}

/**
 * Identidad durable de la revisión que originó una acción asíncrona.
 *
 * Los botones de Telegram pueden responderse horas o días después. Para ese
 * momento el chat puede tener otro correo activo, por lo que `chatId` nunca
 * basta para decidir qué contador decrementar. Las filas históricas que solo
 * conservan uno de los ids siguen siendo legibles, pero no pueden mutar ni
 * cerrar la cola: toda transición exige threadId + mensajeId exactos.
 */
export interface IdentidadCorreoCola {
  /** Gmail thread id (`ItemColaCorreo.id`). */
  threadId?: string;
  /** Gmail message id interno (`ItemColaCorreo.mensajeId`). */
  mensajeId?: string;
}

function valorIdentidad(valor: string | undefined): string | undefined {
  const limpio = valor?.trim();
  return limpio || undefined;
}

/**
 * Comprueba la identidad sin aceptar un objeto vacío. Exportada para que los
 * contratos de los callbacks puedan probar exactamente la misma regla que
 * protege las escrituras del store.
 */
export function coincideIdentidadCorreoCola(
  item: Pick<ItemColaCorreo, "id" | "mensajeId">,
  esperada: IdentidadCorreoCola
): boolean {
  const itemThreadId = valorIdentidad(item.id);
  const itemMensajeId = valorIdentidad(item.mensajeId);
  const threadId = valorIdentidad(esperada.threadId);
  const mensajeId = valorIdentidad(esperada.mensajeId);
  if (!itemThreadId || !itemMensajeId || !threadId || !mensajeId) return false;
  return itemThreadId === threadId && itemMensajeId === mensajeId;
}

/** Cálculo puro usado por la mutación persistente y sus pruebas de borde. */
export function calcularPendientesIncrementados(actual: number, incremento: number): number | undefined {
  if (!Number.isSafeInteger(actual) || actual < 0 ||
      !Number.isSafeInteger(incremento) || incremento <= 0) return undefined;
  const total = actual + incremento;
  return Number.isSafeInteger(total) ? total : undefined;
}

const TAB_NAME = "_cola_revision_correo";
// mensajeId al FINAL (no reordenado en el medio) — para que una fila ya
// escrita antes de este cambio (id = message id, no thread id) no quede
// desalineada al leerse; se limpia a mano cualquier fila vieja que quede.
const HEADERS = [
  "id",
  "chatId",
  "de",
  "asunto",
  "fechaOrden",
  "estado",
  "pendientesRestantes",
  "agregadoEn",
  "mensajeId",
  "accionesResueltasJSON",
];
const NUM_COLS = HEADERS.length;
const MUTEX_COLA = `colaRevisionStore:${TAB_NAME}`;

function filaAObjeto(valores: string[]): ItemColaCorreo {
  let accionesResueltas: string[] = [];
  try {
    const parsed = valores[9] ? JSON.parse(valores[9]) : [];
    if (Array.isArray(parsed)) {
      accionesResueltas = parsed.filter((valor): valor is string => typeof valor === "string" && valor.trim().length > 0);
    }
  } catch {
    accionesResueltas = [];
  }
  return {
    id: valores[0],
    chatId: Number(valores[1]) || 0,
    de: valores[2] || "",
    asunto: valores[3] || "",
    fechaOrden: Number(valores[4]) || 0,
    estado: valores[5] === "activo" ? "activo" : "cola",
    pendientesRestantes: Number(valores[6]) || 0,
    agregadoEn: Number(valores[7]) || 0,
    // Las filas legacy no conservan ambos ids. Se dejan legibles para que el
    // operador pueda ver/limpiar el atasco, pero el mensaje queda vacío a
    // propósito: fingir que id era a la vez thread y message permitiría que
    // una acción antigua cerrara o marcara leído otro mensaje del mismo hilo.
    mensajeId: valores[8] || "",
    accionesResueltas,
  };
}

function objetoAFila(item: ItemColaCorreo): (string | number)[] {
  return [
    item.id,
    item.chatId,
    item.de,
    item.asunto,
    item.fechaOrden,
    item.estado,
    item.pendientesRestantes,
    item.agregadoEn,
    item.mensajeId,
    JSON.stringify(item.accionesResueltas),
  ];
}

async function leerTodas(): Promise<{ rowIndex: number; item: ItemColaCorreo }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return filas.map((f) => ({ rowIndex: f.rowIndex, item: filaAObjeto(f.valores) }));
}

/**
 * Agrega correos nuevos a la cola (estado "cola") — omite en silencio los
 * que ya estén en la cola o activos, así una corrida del cron mientras hay
 * un backlog en curso no duplica nada. Devuelve cuántos se agregaron de
 * verdad (para decidir si avisar "tienes N correos nuevos").
 *
 * Pedido explícito de Carlos: Gmail (is:unread real) es SIEMPRE la única
 * fuente de verdad de qué correo hace falta revisar — si un hilo ya
 * resuelto vuelve a marcarse sin leer (a mano, o porque llegó un mensaje
 * nuevo en el mismo hilo), debe volver a aparecer y analizarse de nuevo,
 * sin ningún historial propio que lo bloquee. (Este store SÍ tuvo antes un
 * "ya resuelto, no lo repreguntes por 7 días" — se sacó a propósito: existía
 * solo para el período en que marcarHiloComoLeido todavía no tenía el scope
 * gmail.modify autorizado, ahora confirmado funcionando en vivo.)
 *
 * Caso real reportado por Carlos (2026-09-07): un hilo se encoló con el
 * mensaje más reciente de ESE momento (ej. "vie 4 sept"), pero con un
 * backlog grande esperó DÍAS en estado "cola" antes de activarse — mientras
 * tanto, el hilo real siguió recibiendo respuestas nuevas en Gmail (hasta
 * "hoy 12:27"). Como este store solo omitía re-agregar el hilo (nunca lo
 * actualizaba), la fila se quedó con el snapshot viejo — al activarse por
 * fin, Wobi mostró contenido de hace días como si fuera "lo próximo por
 * revisar", sin ninguna pista de que la conversación ya había avanzado.
 * Ahora, si el mensaje más reciente cambió desde que se encoló (mismo
 * thread id, mensajeId distinto), se REFRESCA la fila en vez de omitirla —
 * pero solo mientras sigue en "cola" (nunca toca una fila ya "activa": esa
 * ya se le está mostrando a Carlos, refrescarla a mitad de camino sería más
 * confuso, no menos).
 */
async function encolarCorreosInterno(
  chatId: number,
  items: Array<{ id: string; mensajeId: string; de: string; asunto: string; fechaOrden: number }>,
  opciones: { reconciliarAusentes?: boolean } = {}
): Promise<number> {
  let existentes = await leerTodas();
  const idsNoLeidos = new Set(items.map((item) => item.id));

  // Gmail es la fuente de verdad. Si un hilo que todavía esperaba en
  // "cola" ya no está sin leer, se retira antes de elegir el siguiente.
  // Nunca se toca una fila "activa": pudo generar propuestas visibles que
  // aún deben cerrarse de forma explícita.
  const obsoletos = opciones.reconciliarAusentes === false
    ? []
    : existentes
        .filter((f) => f.item.chatId === chatId && f.item.estado === "cola" && !idsNoLeidos.has(f.item.id))
        .sort((a, b) => b.rowIndex - a.rowIndex);
  for (const obsoleto of obsoletos) {
    await eliminarFila(TAB_NAME, obsoleto.rowIndex, HEADERS);
  }
  if (obsoletos.length > 0) existentes = await leerTodas();

  const delChat = existentes.filter((f) => f.item.chatId === chatId);
  const filaPorId = new Map(delChat.map((f) => [f.item.id, f]));

  let agregados = 0;
  for (const item of [...items].sort((a, b) => a.fechaOrden - b.fechaOrden)) {
    const existente = filaPorId.get(item.id);

    if (!existente) {
      await agregarFila(TAB_NAME, NUM_COLS, HEADERS, [
        item.id,
        chatId,
        item.de,
        item.asunto,
        item.fechaOrden,
        "cola",
        0,
        Date.now(),
        item.mensajeId,
        "[]",
      ]);
      agregados += 1;
      continue;
    }

    if (existente.item.estado === "cola" && existente.item.mensajeId !== item.mensajeId) {
      // El mensaje anterior pudo resolverse automáticamente o a mano. La
      // prioridad pasa a ser la fecha del mensaje que realmente sigue sin leer.
      const actualizado: ItemColaCorreo = {
        ...existente.item,
        mensajeId: item.mensajeId,
        de: item.de,
        asunto: item.asunto,
        fechaOrden: item.fechaOrden,
      };
      await actualizarFila(TAB_NAME, existente.rowIndex, NUM_COLS, objetoAFila(actualizado));
    }
  }
  return agregados;
}

export async function encolarCorreos(
  chatId: number,
  items: Array<{ id: string; mensajeId: string; de: string; asunto: string; fechaOrden: number }>,
  opciones: { reconciliarAusentes?: boolean } = {}
): Promise<number> {
  return conMutacionCola(() => encolarCorreosInterno(chatId, items, opciones));
}

/** true si hay un correo "activo" (mostrado, esperando resolución) para este chat. */
export async function hayActivo(chatId: number): Promise<boolean> {
  const todas = await leerTodas();
  return todas.some((f) => f.item.chatId === chatId && f.item.estado === "activo");
}

/**
 * Igual que hayActivo, pero devuelve el correo activo en sí (sin mutar nada)
 * — para poder avisar QUÉ es lo que está bloqueando el resto de la cola.
 * Pedido explícito de Carlos, tras un caso real: pidió /revisarcorreo con 9
 * correos reales sin leer en Gmail, y el sistema respondió "0 correos
 * revisados" sin explicación — el motivo real era que ya había un correo
 * "activo" esperando una respuesta (una pregunta de conciliación) desde
 * hacía horas, y sin este dato el aviso no tenía cómo decírselo.
 */
export async function obtenerActivoActual(chatId: number): Promise<ItemColaCorreo | undefined> {
  const todas = await leerTodas();
  return todas.find((f) => f.item.chatId === chatId && f.item.estado === "activo")?.item;
}

/** Cuántos correos quedan en total (en cola + el activo) — para el aviso de las 7pm. */
export async function contarPendientesTotal(chatId: number): Promise<number> {
  const todas = await leerTodas();
  return todas.filter((f) => f.item.chatId === chatId).length;
}

/**
 * Combina contarPendientesTotal + obtenerActivoActual en una sola lectura de
 * la hoja — para el resumen diario (core/jobs/resumenPendientesDiario.ts),
 * que antes las llamaba por separado y leía la misma pestaña dos veces.
 */
export async function obtenerResumenColaPorChat(
  chatId: number
): Promise<{ total: number; activo: ItemColaCorreo | undefined; masAntiguo: ItemColaCorreo | undefined }> {
  const todas = await leerTodas();
  const deEsteChat = todas.filter((f) => f.item.chatId === chatId);
  const activo = deEsteChat.find((f) => f.item.estado === "activo")?.item;
  // Bug real encontrado en auditoría: con la cola en pausa (nada "activo",
  // esperando el botón "▶️ Sí, siguiente") no hay ningún item.agregadoEn
  // útil para calcular antigüedad real — masAntiguo (por fechaOrden, la
  // fecha REAL de llegada) cubre ese caso además del caso normal.
  const masAntiguo =
    deEsteChat.length > 0
      ? deEsteChat.reduce((a, b) => (a.item.fechaOrden <= b.item.fechaOrden ? a : b)).item
      : undefined;
  return { total: deEsteChat.length, activo, masAntiguo };
}

/**
 * Toma el correo más antiguo de la cola (fechaOrden ascendente) y lo pasa a
 * "activo" — el llamador todavía debe fijar pendientesRestantes (ver
 * establecerPendientesActivo) una vez que sepa cuántas decisiones hacen
 * falta para ese correo en concreto. undefined si la cola está vacía.
 */
async function iniciarSiguienteActivoInterno(chatId: number): Promise<ItemColaCorreo | undefined> {
  const todas = await leerTodas();

  // Defensa en profundidad encontrada en auditoría: si por algún motivo ya
  // hay un "activo" para este chat (ej. un doble tap del botón "▶️ Sí,
  // siguiente", o dos avisos de confirmación mandados por error), activar
  // OTRO más encima corrompería el estado — resolverUnoActivo/
  // establecerPendientesActivo usan .find() (primer match), así que
  // terminarían operando sobre el ítem equivocado. Devolver el ya-activo
  // (en vez de undefined) haría que procesarSiguienteCorreoActivo lo
  // reprocese desde cero — re-descargando adjuntos y mandando propuestas
  // NUEVAS duplicadas para un correo que ya las tiene — peor que el bug
  // original. undefined es el no-op seguro: no debería pasar nunca en el
  // flujo normal, pero es gratis blindarlo.
  const yaActivo = todas.some((f) => f.item.chatId === chatId && f.item.estado === "activo");
  if (yaActivo) return undefined;

  const enCola = todas.filter((f) => f.item.chatId === chatId && f.item.estado === "cola");
  if (enCola.length === 0) return undefined;

  const siguiente = enCola.reduce((a, b) => (a.item.fechaOrden <= b.item.fechaOrden ? a : b));
  // agregadoEn se reutiliza acá como "activado en" (no se usaba para nada
  // más una vez encolado) — necesario para detectar un correo activo
  // estancado (ver obtenerActivoEstancado) sin agregar una columna nueva.
  const actualizado: ItemColaCorreo = {
    ...siguiente.item,
    estado: "activo",
    pendientesRestantes: 0,
    accionesResueltas: [],
    agregadoEn: Date.now(),
  };
  await actualizarFila(TAB_NAME, siguiente.rowIndex, NUM_COLS, objetoAFila(actualizado));
  return actualizado;
}

export async function iniciarSiguienteActivo(chatId: number): Promise<ItemColaCorreo | undefined> {
  return conMutacionCola(() => iniciarSiguienteActivoInterno(chatId));
}

/**
 * Pedido implícito por el propio diseño de la cola: si el correo activo
 * queda esperando algo que nunca llega (ej. una pregunta de desambiguación
 * de 24h que expira sin respuesta, o un botón "Enseñar regla"/"Corregir
 * clasificación" que Carlos nunca termina de resolver), no hay ningún
 * mecanismo que lo destrabe — se queda "activo" para siempre y CUALQUIER
 * correo nuevo se acumula detrás de él en silencio. Esto detecta ese caso
 * (activo desde hace más de `umbralMs`) para que revisarCorreoNuevo.ts lo
 * salte con aviso en vez de bloquear la cola indefinidamente.
 */
export async function obtenerActivoEstancado(chatId: number, umbralMs: number): Promise<ItemColaCorreo | undefined> {
  const todas = await leerTodas();
  const activo = todas.find((f) => f.item.chatId === chatId && f.item.estado === "activo");
  if (!activo) return undefined;
  return Date.now() - activo.item.agregadoEn > umbralMs ? activo.item : undefined;
}

/**
 * Elimina el correo activo sin marcarlo resuelto-normal (ver
 * obtenerActivoEstancado, y handleDescartarActivoCallback en
 * revisarCorreoNuevo.ts para el disparo manual) — no lo registra como "ya
 * resuelto", por si de verdad hace falta revisarlo a mano después.
 * Devuelve true si de verdad había algo que borrar — bug real de auditoría:
 * antes devolvía void y el llamador confirmaba "descartado" aunque la fila
 * ya no existiera (ej. dos taps seguidos del mismo botón, o resuelto por
 * otro camino justo antes).
 */
async function descartarActivoEstancadoInterno(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola
): Promise<boolean> {
  const todas = await leerTodas();
  const fila = todas.find((f) =>
    f.item.chatId === chatId &&
    f.item.estado === "activo" &&
    coincideIdentidadCorreoCola(f.item, identidadEsperada)
  );
  if (!fila) return false;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return true;
}

export async function descartarActivoEstancado(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola
): Promise<boolean> {
  return conMutacionCola(() => descartarActivoEstancadoInterno(chatId, identidadEsperada));
}

/**
 * Caso real reportado por Carlos: un correo se quedó "activo" varios minutos sin que Wobi mandara
 * nada, atascado a mitad de proceso (ver vigilarProcesamientoAtascado.ts) — para reintentarlo, hacía
 * falta sacarlo de "activo" y volver a encolarlo. Hallazgo real de auditoría: hacerlo en DOS pasos
 * (descartarActivoEstancado + encolarCorreos, como hacía la primera versión) deja una ventana real,
 * aunque breve, en la que la fila no existe en NINGÚN estado — si el cron horario de
 * revisarCorreoNuevo.ts corre justo en esa ventana, is:unread sigue viendo el hilo como sin leer y lo
 * vuelve a encolar por su cuenta, y al terminar este reintento se agregaría una SEGUNDA fila para el
 * mismo hilo. Esta función hace el mismo cambio en UN solo paso (actualizarFila sobre la misma fila,
 * nunca borra-y-recrea), así nunca hay un instante en que el hilo esté ausente de la cola.
 */
async function reencolarActivoParaReintentoInterno(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  actualizacion: { de: string; asunto: string }
): Promise<boolean> {
  const todas = await leerTodas();
  const fila = todas.find((f) =>
    f.item.chatId === chatId &&
    f.item.estado === "activo" &&
    coincideIdentidadCorreoCola(f.item, identidadEsperada)
  );
  if (!fila) return false;

  const actualizado: ItemColaCorreo = {
    ...fila.item,
    estado: "cola",
    pendientesRestantes: 0,
    accionesResueltas: [],
    // El reintento técnico pertenece al mensaje exacto que se activó. Nunca
    // lo sustituye por "el último del hilo": una respuesta nueva es otra
    // unidad sin leer y se encolará después por el flujo normal de Gmail.
    mensajeId: fila.item.mensajeId,
    de: actualizacion.de,
    asunto: actualizacion.asunto,
    // fechaOrden NUNCA se toca — sigue reflejando desde cuándo espera sin leer, para no perder su
    // lugar en la prioridad "más antiguo primero" (mismo criterio que encolarCorreos).
  };
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila(actualizado));
  return true;
}

export async function reencolarActivoParaReintento(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  actualizacion: { de: string; asunto: string }
): Promise<boolean> {
  return conMutacionCola(() =>
    reencolarActivoParaReintentoInterno(chatId, identidadEsperada, actualizacion)
  );
}

/**
 * Pedido explícito de Carlos, tras un caso real: "esto ya lo gestioné" — la
 * cola marcaba un correo como bloqueando la revisión, pero él ya lo había
 * resuelto por su cuenta (a mano, fuera del chat). Vacía TODA la cola de
 * este chat (activo + en cola) sin intentar resolver nada. Devuelve los ids
 * de hilo (Gmail thread id, ver ItemColaCorreo.id) de las filas eliminadas
 * — esto NO marca nada como leído en Gmail. Limpiar el resumen solo borra
 * el estado local; los hilos que continúen sin leer reaparecen en la
 * siguiente sincronización. Marcar como leído queda reservado al cierre
 * exitoso de cada correo individual.
 */
async function vaciarColaCorreoDelChatInterno(chatId: number): Promise<string[]> {
  const todas = await leerTodas();
  const delChat = todas.filter((f) => f.item.chatId === chatId);
  for (const { rowIndex } of delChat.slice().sort((a, b) => b.rowIndex - a.rowIndex)) {
    await eliminarFila(TAB_NAME, rowIndex, HEADERS);
  }
  return delChat.map((f) => f.item.id);
}

export async function vaciarColaCorreoDelChat(chatId: number): Promise<string[]> {
  return conMutacionCola(() => vaciarColaCorreoDelChatInterno(chatId));
}

/** Fija cuántas decisiones independientes hacen falta para dar por resuelto el correo activo. */
async function establecerPendientesActivoInterno(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  n: number
): Promise<boolean> {
  if (!Number.isSafeInteger(n) || n < 1) return false;
  const todas = await leerTodas();
  const fila = todas.find((f) =>
    f.item.chatId === chatId &&
    f.item.estado === "activo" &&
    coincideIdentidadCorreoCola(f.item, identidadEsperada)
  );
  if (!fila) return false;
  await actualizarFila(
    TAB_NAME,
    fila.rowIndex,
    NUM_COLS,
    objetoAFila({ ...fila.item, pendientesRestantes: n, accionesResueltas: [] })
  );
  return true;
}

export async function establecerPendientesActivo(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  n: number
): Promise<boolean> {
  return conMutacionCola(() => establecerPendientesActivoInterno(chatId, identidadEsperada, n));
}

/**
 * Suma decisiones a un correo que ya está activo, sin tocar jamás otro
 * correo del mismo chat. Es el caso de un mensaje con adjuntos que además
 * contiene una solicitud independiente en el cuerpo: los adjuntos ya
 * fijaron el contador base y la solicitud agrega una resolución más.
 *
 * Devuelve false si la identidad ya no es la activa o el incremento no es
 * un entero positivo. El llamador puede entonces evitar publicar una acción
 * que no tendría un contador propio.
 */
async function incrementarPendientesActivoInterno(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  incremento = 1
): Promise<boolean> {
  const todas = await leerTodas();
  const fila = todas.find((f) =>
    f.item.chatId === chatId &&
    f.item.estado === "activo" &&
    coincideIdentidadCorreoCola(f.item, identidadEsperada)
  );
  if (!fila) return false;
  const pendientes = calcularPendientesIncrementados(fila.item.pendientesRestantes, incremento);
  if (pendientes === undefined) return false;

  await actualizarFila(
    TAB_NAME,
    fila.rowIndex,
    NUM_COLS,
    objetoAFila({ ...fila.item, pendientesRestantes: pendientes })
  );
  return true;
}

export async function incrementarPendientesActivo(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  incremento = 1
): Promise<boolean> {
  return conMutacionCola(() => incrementarPendientesActivoInterno(chatId, identidadEsperada, incremento));
}

/** Compensa una reserva adicional que no llegó a producir una acción visible/persistida. Nunca cierra el correo. */
async function revertirIncrementoPendientesActivoInterno(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  decremento = 1
): Promise<boolean> {
  if (!Number.isSafeInteger(decremento) || decremento <= 0) return false;
  const todas = await leerTodas();
  const fila = todas.find((f) =>
    f.item.chatId === chatId &&
    f.item.estado === "activo" &&
    coincideIdentidadCorreoCola(f.item, identidadEsperada)
  );
  if (!fila || fila.item.pendientesRestantes < decremento) return false;
  await actualizarFila(
    TAB_NAME,
    fila.rowIndex,
    NUM_COLS,
    objetoAFila({ ...fila.item, pendientesRestantes: fila.item.pendientesRestantes - decremento })
  );
  return true;
}

export async function revertirIncrementoPendientesActivo(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  decremento = 1
): Promise<boolean> {
  return conMutacionCola(() => revertirIncrementoPendientesActivoInterno(chatId, identidadEsperada, decremento));
}

export interface ResultadoResolverActivo {
  /** false cuando no había activo o la identidad esperada ya no coincide. */
  aplicado: boolean;
  /** true si el correo activo quedó completamente resuelto (pendientesRestantes llegó a 0). */
  terminado: boolean;
  /** true cuando esa clave ya se había aplicado en un intento anterior. */
  yaAplicado?: boolean;
  /** El id del correo que quedó resuelto, cuando terminado=true — para marcarlo como leído en Gmail. */
  gmailIdResuelto?: string;
  /** Identidad exacta capturada en la misma lectura que actualizó el contador. */
  identidadResuelta?: Required<IdentidadCorreoCola>;
}

export interface CalculoResolucionIdempotente {
  pendientesRestantes: number;
  accionesResueltas: string[];
  aplicado: boolean;
  yaAplicado: boolean;
}

/**
 * Cálculo puro de un decremento terminal. Una clave vacía conserva el
 * comportamiento histórico; una clave estable se registra junto al contador
 * y una repetición devuelve el mismo estado sin volver a descontar.
 */
export function calcularResolucionIdempotente(
  pendientesRestantes: number,
  accionesResueltas: readonly string[],
  claveIdempotencia?: string
): CalculoResolucionIdempotente {
  const clave = claveIdempotencia?.trim() || undefined;
  const normalizadas = [...new Set(accionesResueltas.map((valor) => valor.trim()).filter(Boolean))];
  if (clave && normalizadas.includes(clave)) {
    return {
      pendientesRestantes: Math.max(0, pendientesRestantes),
      accionesResueltas: normalizadas,
      aplicado: false,
      yaAplicado: true,
    };
  }

  return {
    pendientesRestantes: Math.max(0, pendientesRestantes - 1),
    accionesResueltas: clave ? [...normalizadas, clave] : normalizadas,
    aplicado: true,
    yaAplicado: false,
  };
}

/**
 * Señal genérica de "algo se resolvió para el correo activo de este chat,
 * si lo hay" — decrementa pendientesRestantes en 1. Se puede llamar desde
 * CUALQUIER punto terminal del sistema (ver comentario arriba del archivo)
 * sin que ese código necesite saber si en verdad hay una revisión de correo
 * en curso: si no hay ningún correo activo para este chat, esto es un no-op
 * seguro.
 *
 * Hallazgo real de auditoría (Carlos, caso real "Eurohotel Gran Via Fira" — mismo síntoma ya
 * documentado antes sin causa confirmada como "caso Avianca/Larrauri" en revisarCorreoNuevo.ts): un
 * correo ya resuelto (evidencia real: Holded ya tenía el movimiento bancario conciliado) volvía a
 * aparecer como "sin leer" y se reprocesaba entero. Causa real encontrada: esta función BORRABA la
 * fila (dando la cola por resuelta) ANTES de que el llamador marcara el hilo como leído en Gmail —
 * si esa llamada a Gmail fallaba o el proceso se interrumpía justo en el medio (confirmado en vivo:
 * logs reales de producción muestran fallos recurrentes de cuota de Sheets — "Quota exceeded... Read
 * requests per minute" — en este mismo archivo y en otros stores, 9 veces en una sola ventana de 500
 * líneas de log), la cola ya no bloqueaba nada (fila borrada) pero el hilo real de Gmail seguía sin
 * leer — la próxima revisión lo encontraba "nuevo" y repetía todo el trabajo desde cero, sin ningún
 * aviso de que algo había fallado. Ahora esta función NUNCA borra la fila por sí sola cuando queda
 * resuelta — solo la deja en pendientesRestantes=0 (sigue "activo", sigue bloqueando) y deja que el
 * llamador (revisarCorreoNuevo.ts) confirme el borrado vía confirmarActivoResueltoTrasMarcarLeido,
 * SOLO después de que marcarHiloComoLeido en Gmail haya devuelto éxito de verdad — así un fallo deja
 * el correo visiblemente trabado (con el mismo mecanismo ya existente para cualquier correo activo
 * atascado: aviso, reintento, 48h de auto-salto) en vez de perder el rastro en silencio.
 */
async function resolverUnoActivoInterno(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  claveIdempotencia?: string
): Promise<ResultadoResolverActivo> {
  const todas = await leerTodas();
  const fila = todas.find((f) =>
    f.item.chatId === chatId &&
    f.item.estado === "activo" &&
    coincideIdentidadCorreoCola(f.item, identidadEsperada)
  );
  if (!fila) return { aplicado: false, terminado: false };

  const identidadResuelta = { threadId: fila.item.id, mensajeId: fila.item.mensajeId };
  const calculo = calcularResolucionIdempotente(
    fila.item.pendientesRestantes,
    fila.item.accionesResueltas,
    claveIdempotencia
  );

  if (calculo.aplicado) {
    await actualizarFila(
      TAB_NAME,
      fila.rowIndex,
      NUM_COLS,
      objetoAFila({
        ...fila.item,
        pendientesRestantes: calculo.pendientesRestantes,
        accionesResueltas: calculo.accionesResueltas,
      })
    );
  }

  if (calculo.pendientesRestantes === 0) {
    return {
      aplicado: calculo.aplicado,
      yaAplicado: calculo.yaAplicado,
      terminado: true,
      gmailIdResuelto: fila.item.id,
      identidadResuelta,
    };
  }

  return { aplicado: calculo.aplicado, yaAplicado: calculo.yaAplicado, terminado: false };
}

export async function resolverUnoActivo(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  claveIdempotencia?: string
): Promise<ResultadoResolverActivo> {
  return conMutacionCola(() => resolverUnoActivoInterno(chatId, identidadEsperada, claveIdempotencia));
}

/**
 * Registra una decisión explícita que resuelve el correo completo (por
 * ejemplo, "esto ya lo gestioné / saltar"). Primero deja la fila durable en
 * pendientes=0 y solo después el llamador puede marcar el mensaje exacto
 * como leído. Si Gmail falla, la fila permanece activa y el reintento normal
 * completa el cierre sin repetir ni olvidar la decisión del operador.
 */
async function prepararCierreExplicitoActivoInterno(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  claveIdempotencia: string
): Promise<ResultadoResolverActivo> {
  const clave = claveIdempotencia.trim();
  if (!clave) return { aplicado: false, terminado: false };

  const todas = await leerTodas();
  const fila = todas.find((f) =>
    f.item.chatId === chatId &&
    f.item.estado === "activo" &&
    coincideIdentidadCorreoCola(f.item, identidadEsperada)
  );
  if (!fila) return { aplicado: false, terminado: false };

  const identidadResuelta = { threadId: fila.item.id, mensajeId: fila.item.mensajeId };
  const yaAplicado = fila.item.accionesResueltas.includes(clave) && fila.item.pendientesRestantes === 0;
  if (!yaAplicado) {
    await actualizarFila(
      TAB_NAME,
      fila.rowIndex,
      NUM_COLS,
      objetoAFila({
        ...fila.item,
        pendientesRestantes: 0,
        accionesResueltas: [...new Set([...fila.item.accionesResueltas, clave])],
      })
    );
  }

  return {
    aplicado: !yaAplicado,
    yaAplicado,
    terminado: true,
    gmailIdResuelto: fila.item.id,
    identidadResuelta,
  };
}

export async function prepararCierreExplicitoActivo(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola,
  claveIdempotencia: string
): Promise<ResultadoResolverActivo> {
  return conMutacionCola(() =>
    prepararCierreExplicitoActivoInterno(chatId, identidadEsperada, claveIdempotencia)
  );
}

/**
 * Confirma que el correo activo (con pendientesRestantes ya en 0, ver resolverUnoActivo) quedó de
 * verdad resuelto — se llama SOLO después de que marcarHiloComoLeido en Gmail devolvió éxito real,
 * nunca antes. Recién acá se borra la fila; si esto nunca se llama (porque Gmail falló), la fila
 * sigue viva y "activa" — visible, bloqueando, y recuperable con los mecanismos que ya existen para
 * cualquier correo activo atascado (48h de auto-salto, "🗑️ Descartar y liberar", saltarCorreoActivo).
 */
async function confirmarActivoResueltoTrasMarcarLeidoInterno(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola
): Promise<boolean> {
  const todas = await leerTodas();
  const fila = todas.find((f) =>
    f.item.chatId === chatId &&
    f.item.estado === "activo" &&
    f.item.pendientesRestantes === 0 &&
    coincideIdentidadCorreoCola(f.item, identidadEsperada)
  );
  if (!fila) return false;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return true;
}

export async function confirmarActivoResueltoTrasMarcarLeido(
  chatId: number,
  identidadEsperada: IdentidadCorreoCola
): Promise<boolean> {
  return conMutacionCola(() => confirmarActivoResueltoTrasMarcarLeidoInterno(chatId, identidadEsperada));
}

/**
 * Reintenta confirmar un correo que ya quedó resuelto (pendientesRestantes=0) pero cuyo hilo de
 * Gmail no se pudo marcar como leído la vez anterior — ver el hallazgo real arriba. Se llama al
 * principio de cada revisión (revisarCorreoNuevo.ts), ANTES de decidir si hay algo "activo"
 * bloqueando la cola, para que un fallo transitorio (ej. cuota de Sheets/Gmail agotada por unos
 * minutos) se resuelva solo en la siguiente pasada normal, sin esperar el auto-salto de 48h ni
 * requerir que Carlos lo destrabe a mano.
 */
export async function reintentarActivoPendienteDeMarcarLeido(chatId: number): Promise<ItemColaCorreo | undefined> {
  const fila = await obtenerActivoActual(chatId);
  if (!fila || fila.pendientesRestantes > 0) return undefined;
  // Una fila legacy puede estar visible con un solo id, pero nunca autoriza
  // una llamada a Gmail. Solo una identidad compuesta verificable llega al
  // paso que marca el mensaje como leído.
  if (!coincideIdentidadCorreoCola(fila, { threadId: fila.id, mensajeId: fila.mensajeId })) return undefined;
  return fila;
}

function conMutacionCola<T>(tarea: () => Promise<T>): Promise<T> {
  return conCoordinadorCorreo(() => conMutex(MUTEX_COLA, tarea));
}
