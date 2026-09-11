const PALABRAS_GENERICAS = new Set([
  "correo", "correos", "email", "emails", "mail", "mails", "mensaje", "mensajes",
  "el", "la", "los", "las", "un", "una", "de", "del", "que", "me", "mi",
  "primer", "primero", "primera", "ultimo", "ultima", "nuevo", "nueva", "reciente",
  "hoy", "ayer", "manana", "semana", "mas",
  "anterior", "siguiente", "pendiente", "pendientes", "factura", "facturas",
  "comprobante", "comprobantes", "recibo", "recibos", "ticket", "tickets", "proveedor",
  "leer", "lee", "leeme", "leido", "revisar", "revisa", "revisame", "procesar", "procesa",
  "procesame", "reprocesar", "reprocesa", "reprocesame", "capturar", "captura", "capturame",
  "buscar", "busca", "recibido", "recibida", "llegado", "llegada", "llego",
]);

/**
 * Impide que una frase vaga abra el historial leído. Solo una referencia
 * con remitente, asunto, operador de Gmail o palabra distintiva habilita la
 * excepción puntual; el resto debe ir por la cola de no leídos.
 */
export function esReferenciaCorreoConcreta(texto: string): boolean {
  const limpio = texto.trim();
  if (!limpio) return false;
  if (/\b(from|to|subject):\S+/i.test(limpio) || /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(limpio)) return true;
  const tokens = limpio
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  return tokens.some((token) => token.length >= 3 && !PALABRAS_GENERICAS.has(token));
}
