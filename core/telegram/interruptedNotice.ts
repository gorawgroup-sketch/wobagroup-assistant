import type { EntregaTelegramDurable } from './durableDelivery';
import type { TelegramUpdate } from './types';

/** Guarda contexto de diagnóstico, nunca archivos ni un update reutilizable. */
export function resumirSolicitudInterrumpida(payload: string): string {
  try {
    const u = JSON.parse(payload);
    if (u.diagnostico === true) return payload;
    const update = u as TelegramUpdate;
    const m = update.callback_query?.message ?? update.message;
    return JSON.stringify({ diagnostico: true, mensajeId: m?.message_id,
      accion: update.callback_query?.data,
      texto: (m?.text ?? m?.caption ?? m?.document?.file_name ?? 'Solicitud sin texto').slice(0, 1500) });
  } catch { return ''; }
}
export function contextoSolicitudInterrumpida(entrega: EntregaTelegramDurable): string {
  const fecha = new Date(entrega.creadoEn).toLocaleString('es-ES', { timeZone: 'Europe/Lisbon' });
  let detalle = 'El registro antiguo no conservó la operación. No es posible atribuirla con certeza.';
  try {
    const c = JSON.parse(resumirSolicitudInterrumpida(entrega.payload));
    const accion = typeof c.accion === 'string' ? c.accion : '';
    const nombre = accion.startsWith('gasto_conciliar') ? 'Conciliar gasto'
      : accion.startsWith('gasto_') ? 'Procesar gasto'
      : accion.startsWith('email_') ? 'Procesar correo'
      : accion.startsWith('draft_') ? 'Gestionar borrador de correo'
      : accion.startsWith('colacorreo_') ? 'Continuar revisión de correo'
      : accion ? 'Aplicar selección' : 'Consulta del chat';
    detalle = `${nombre}\nMensaje de origen del botón (no es el resultado de esta solicitud):\n${c.texto}`;
  } catch { /* Entregas históricas sin contexto. */ }
  return `Solicitud del ${fecha}\n${detalle}`;
}
export function claveAviso(clave: string): string { return Buffer.from(clave, 'hex').toString('base64url'); }
export function decodificarClaveAviso(valor: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(valor)) return undefined;
  const b = Buffer.from(valor, 'base64url');
  return b.length === 32 && b.toString('base64url') === valor ? b.toString('hex') : undefined;
}
export function avisoInterrumpido(entrega: EntregaTelegramDurable) {
  const token = claveAviso(entrega.clave);
  return { texto: `⚠️ Falta confirmar el resultado\n\n${contextoSolicitudInterrumpida(entrega)}\n\nLa solicitud pudo completar parte o toda la operación. Pulsa «Verificar resultado» para comprobar qué ocurrió y qué falta, sin volver a crear ni conciliar. «Cerrar aviso» solo oculta este aviso; no cancela la operación.`,
    botones: [[{ text: '🔎 Verificar resultado', callback_data: `ent_ver:${token}` }],
      [{ text: 'Cerrar aviso', callback_data: `ent_cerrar:${token}` }]] };
}

export function esContinuacionCorreo(entrega: EntregaTelegramDurable): boolean {
  try {
    return JSON.parse(resumirSolicitudInterrumpida(entrega.payload)).accion === 'colacorreo_siguiente';
  } catch { return false; }
}

/** Estado actual, no atribución de efectos a un callback antiguo. Solo lectura. */
export function avisoEstadoCola(entrega: EntregaTelegramDurable, estado: {
  total: number; activo?: { asunto: string; pendientesRestantes: number };
}) {
  const texto = estado.activo
    ? `Correo activo: «${estado.activo.asunto}».\nDecisiones pendientes para ese correo: ${estado.activo.pendientesRestantes}.\nUsa la propuesta de ese correo para continuar.`
    : estado.total > 0 ? 'No hay un correo activo. Puedes continuar con el siguiente.'
    : 'No quedan correos en esta cola de revisión.';
  return { texto: `📬 Estado de la revisión comprobado\n\n${texto}\nCorreos en la cola, incluido el activo: ${estado.total}.\n\nEsta comprobación no repitió acciones ni confirma gastos o conciliaciones.`,
    botones: [
      ...(!estado.activo && estado.total > 0 ? [[{ text: '▶️ Continuar con el siguiente', callback_data: 'colacorreo_siguiente' }]] : []),
      [{ text: 'Actualizar estado', callback_data: `ent_ver:${claveAviso(entrega.clave)}` }],
    ] };
}
