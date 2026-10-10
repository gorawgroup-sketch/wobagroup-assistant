// Respuestas de cortesía y orientación; nunca autorizan ni ejecutan destinos.
export function conversationReply(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b(wobi|wobby|wovi|bobi|bobby)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches)( como estas| que tal| estas ahi)?$/.test(normalized) || /^(como estas|que tal|estas ahi)$/.test(normalized)) return 'Hola, estoy aquí para ayudarte. ¿Qué quieres encontrar en WOBi?';
  if (/^(quien eres|que eres)$/.test(normalized)) return 'Soy WOBi, tu asistente para orientarte dentro del sistema. Puedo abrir las vistas disponibles y decirte cuando una consulta todavía no está implementada.';
  if (/^(gracias|muchas gracias)$/.test(normalized)) return 'Con gusto. Dime qué más quieres encontrar.';
  if (/^(ayuda|necesito ayuda|puedes ayudarme|me puedes ayudar|que puedes (hacer|encontrar|buscar)( para mi)?|como puedes ayudarme|puedes (buscar|encontrar) algo( para mi)?|que puedo (preguntar|pedirte)|como funciona)$/.test(normalized)) return 'Puedo ayudarte a abrir las áreas de WOBi. Prueba: pagos pendientes de seguros de WOBA, próximas renovaciones de eWorks, o actividad de Wobi Seguros. Los permisos y la disponibilidad se comprueban al buscar. Por ahora no calculo cifras ni ejecuto operaciones desde aquí. ¿Qué área necesitas?';
  return null;
}
