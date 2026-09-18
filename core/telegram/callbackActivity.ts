const activasPorChat = new Map<number, number>();
const ultimaFinalizacionPorChat = new Map<number, number>();

/**
 * Registra una interacción de botón mientras su handler sigue ejecutándose.
 *
 * La cola de correo conserva un ítem "activo" mientras espera la decisión del
 * usuario. Algunos handlers consumen la propuesta antes de completar la
 * escritura y, durante esa ventana, el vigilante ya no encuentra la propuesta
 * pendiente. Esta señal evita que interprete esa transición como un atasco y
 * vuelva a procesar el mismo correo en paralelo.
 */
export function iniciarActividadCallback(chatId: number): () => void {
  activasPorChat.set(chatId, (activasPorChat.get(chatId) ?? 0) + 1);
  let terminada = false;
  return () => {
    if (terminada) return;
    terminada = true;
    const restantes = Math.max(0, (activasPorChat.get(chatId) ?? 1) - 1);
    if (restantes === 0) activasPorChat.delete(chatId);
    else activasPorChat.set(chatId, restantes);
    ultimaFinalizacionPorChat.set(chatId, Date.now());
  };
}

/**
 * Mantiene un margen corto después de terminar el callback. El cierre de la
 * cola usa Gmail, Sheets y PostgreSQL; aunque la acción ya acabara, esas
 * confirmaciones pueden tardar unos segundos en quedar visibles para el
 * vigilante. Retrasar un ciclo del vigilante es seguro: el correo sigue
 * durablemente activo y la siguiente corrida vuelve a comprobarlo.
 */
export function hayActividadCallbackReciente(
  chatId: number,
  ahora = Date.now(),
  margenMs = 3 * 60 * 1000
): boolean {
  if ((activasPorChat.get(chatId) ?? 0) > 0) return true;
  const ultima = ultimaFinalizacionPorChat.get(chatId);
  if (ultima === undefined) return false;
  if (ahora - ultima <= margenMs) return true;
  ultimaFinalizacionPorChat.delete(chatId);
  return false;
}

