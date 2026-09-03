import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "../google/sheetsKeyValueStore";

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
}

const TAB_NAME = "_cola_revision_correo";
// mensajeId al FINAL (no reordenado en el medio) — para que una fila ya
// escrita antes de este cambio (id = message id, no thread id) no quede
// desalineada al leerse; se limpia a mano cualquier fila vieja que quede.
const HEADERS = ["id", "chatId", "de", "asunto", "fechaOrden", "estado", "pendientesRestantes", "agregadoEn", "mensajeId"];
const NUM_COLS = HEADERS.length;

function filaAObjeto(valores: string[]): ItemColaCorreo {
  return {
    id: valores[0],
    chatId: Number(valores[1]) || 0,
    de: valores[2] || "",
    asunto: valores[3] || "",
    fechaOrden: Number(valores[4]) || 0,
    estado: valores[5] === "activo" ? "activo" : "cola",
    pendientesRestantes: Number(valores[6]) || 0,
    agregadoEn: Number(valores[7]) || 0,
    // Filas de antes de este cambio no tienen mensajeId — se cae al id
    // (antes era un message id) para no dejar el campo vacío.
    mensajeId: valores[8] || valores[0],
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
 */
export async function encolarCorreos(
  chatId: number,
  items: Array<{ id: string; mensajeId: string; de: string; asunto: string; fechaOrden: number }>
): Promise<number> {
  const existentes = await leerTodas();
  const idsExistentes = new Set(existentes.filter((f) => f.item.chatId === chatId).map((f) => f.item.id));

  const nuevos = items.filter((i) => !idsExistentes.has(i.id));
  for (const item of nuevos) {
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
    ]);
  }
  return nuevos.length;
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
 * Toma el correo más antiguo de la cola (fechaOrden ascendente) y lo pasa a
 * "activo" — el llamador todavía debe fijar pendientesRestantes (ver
 * establecerPendientesActivo) una vez que sepa cuántas decisiones hacen
 * falta para ese correo en concreto. undefined si la cola está vacía.
 */
export async function iniciarSiguienteActivo(chatId: number): Promise<ItemColaCorreo | undefined> {
  const todas = await leerTodas();
  const enCola = todas.filter((f) => f.item.chatId === chatId && f.item.estado === "cola");
  if (enCola.length === 0) return undefined;

  const siguiente = enCola.reduce((a, b) => (a.item.fechaOrden <= b.item.fechaOrden ? a : b));
  // agregadoEn se reutiliza acá como "activado en" (no se usaba para nada
  // más una vez encolado) — necesario para detectar un correo activo
  // estancado (ver obtenerActivoEstancado) sin agregar una columna nueva.
  const actualizado: ItemColaCorreo = { ...siguiente.item, estado: "activo", pendientesRestantes: 0, agregadoEn: Date.now() };
  await actualizarFila(TAB_NAME, siguiente.rowIndex, NUM_COLS, objetoAFila(actualizado));
  return actualizado;
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

/** Elimina el correo activo sin marcarlo resuelto-normal (ver obtenerActivoEstancado) — no lo registra como "ya resuelto", por si de verdad hace falta revisarlo a mano después. */
export async function descartarActivoEstancado(chatId: number, gmailId: string): Promise<void> {
  const todas = await leerTodas();
  const fila = todas.find((f) => f.item.chatId === chatId && f.item.id === gmailId && f.item.estado === "activo");
  if (!fila) return;
  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
}

/** Fija cuántas decisiones independientes hacen falta para dar por resuelto el correo activo. */
export async function establecerPendientesActivo(chatId: number, gmailId: string, n: number): Promise<void> {
  const todas = await leerTodas();
  const fila = todas.find((f) => f.item.chatId === chatId && f.item.id === gmailId && f.item.estado === "activo");
  if (!fila) return;
  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila({ ...fila.item, pendientesRestantes: Math.max(1, n) }));
}

export interface ResultadoResolverActivo {
  /** true si el correo activo quedó completamente resuelto (pendientesRestantes llegó a 0). */
  terminado: boolean;
  /** El id del correo que quedó resuelto, cuando terminado=true — para marcarlo como leído en Gmail. */
  gmailIdResuelto?: string;
}

/**
 * Señal genérica de "algo se resolvió para el correo activo de este chat,
 * si lo hay" — decrementa pendientesRestantes en 1. Se puede llamar desde
 * CUALQUIER punto terminal del sistema (ver comentario arriba del archivo)
 * sin que ese código necesite saber si en verdad hay una revisión de correo
 * en curso: si no hay ningún correo activo para este chat, esto es un no-op
 * seguro. NUNCA marca como leído por sí sola — eso es responsabilidad del
 * llamador (revisarCorreoNuevo.ts), que además debe llamar a
 * iniciarSiguienteActivo si terminado=true y quiere seguir con la cola.
 */
export async function resolverUnoActivo(chatId: number): Promise<ResultadoResolverActivo> {
  const todas = await leerTodas();
  const fila = todas.find((f) => f.item.chatId === chatId && f.item.estado === "activo");
  if (!fila) return { terminado: false };

  const restantes = fila.item.pendientesRestantes - 1;
  if (restantes <= 0) {
    await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
    return { terminado: true, gmailIdResuelto: fila.item.id };
  }

  await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila({ ...fila.item, pendientesRestantes: restantes }));
  return { terminado: false };
}
