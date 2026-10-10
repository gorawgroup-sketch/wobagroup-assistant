// Respuestas de cortesía y orientación; nunca autorizan ni ejecutan destinos.
export function conversationReply(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(wobi|wobby|wovi)\s+/, '');
  if (/^(hola|buenos dias|buenas tardes|buenas noches)( como estas)?$/.test(normalized) || /^(como estas|que tal)$/.test(normalized)) return 'Hola, estoy aquí para ayudarte. ¿Qué quieres encontrar en WOBi?';
  if (/^(gracias|muchas gracias)$/.test(normalized)) return 'Con gusto. Dime qué más quieres encontrar.';
  if (/^(ayuda|que puedes (hacer|encontrar)|como puedes ayudarme|puedes (buscar|encontrar) algo( para mi)?|que puedo (preguntar|pedirte)|como funciona)$/.test(normalized)) return 'Puedo ayudarte a abrir las áreas de WOBi. Prueba: abre Seguros de eWorks, o abre Corporate de WOBA. Los permisos y la disponibilidad se comprueban al buscar. Por ahora no calculo cifras ni ejecuto operaciones desde aquí. ¿Qué área necesitas?';
  return null;
}
