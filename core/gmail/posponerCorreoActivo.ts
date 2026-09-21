import type { IdentidadCorreoCola, ItemColaCorreo } from './colaRevisionStore';

export interface DependenciasPosponerCorreo {
  coordinar<T>(tarea: () => Promise<T>): Promise<T>;
  activo(chat: number): Promise<ItemColaCorreo | undefined>;
  retirar(chat: number, identidad: IdentidadCorreoCola): Promise<boolean>;
  avisar(chat: number, texto: string): Promise<unknown>;
  siguiente(chat: number): Promise<void>;
}
async function dependencias(): Promise<DependenciasPosponerCorreo> {
  const [cola, pg, telegram, jobs] = await Promise.all([
    import('./colaRevisionStore'), import('./automatico/postgres'),
    import('../telegram/client'), import('../jobs/revisarCorreoNuevo'),
  ]);
  return { coordinar: pg.conCoordinadorCorreo, activo: cola.obtenerActivoActual,
    retirar: cola.descartarActivoEstancado, avisar: telegram.sendTelegramMessage,
    siguiente: jobs.procesarSiguienteCorreoActivoYaCoordinado };
}
/** Explicit deferral for this pass. Gmail remains unread and the saved expense
 * decisions remain intact. A future requested scan can include the message again.
 * No Gmail mutation or Holded operation is performed here.
 */
export async function posponerCorreoActivoYContinuar(
  chat: number, esperada?: IdentidadCorreoCola, deps?: DependenciasPosponerCorreo
): Promise<string> {
  const d = deps ?? await dependencias();
  return d.coordinar(async () => {
    const actual = await d.activo(chat);
    if (esperada && (!actual || actual.id !== esperada.threadId || actual.mensajeId !== esperada.mensajeId)) {
      return 'Este botón corresponde a otro correo o a una revisión anterior. No se cambió el correo activo.';
    }
    if (actual) {
      const identidad = { threadId: actual.id, mensajeId: actual.mensajeId };
      if (!await d.retirar(chat, identidad)) return 'No pude liberar este correo; sigue pendiente y sin leer.';
      await d.avisar(chat, `➡️ Dejo pendiente y sin leer «${actual.asunto}» para otra revisión. Continúo con el siguiente correo.`).catch(() => {});
    }
    await d.siguiente(chat);
    return actual ? 'Correo aplazado sin marcarlo leído. Se ejecutó la revisión del siguiente correo de la cola, sin repetir el gasto aplazado.' : 'Se ejecutó la revisión del siguiente correo de la cola.';
  });
}
