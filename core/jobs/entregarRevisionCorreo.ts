/** La cola manual puede fallar después de completar escrituras financieras.
 * Entrega primero el resultado, y permite recuperar solo la cola sin repetir la ejecución.
 *
 * Tampoco el envío del informe puede tumbar el resto: si falla (mensaje demasiado largo, red, límite de Telegram), el
 * trabajo financiero ya está hecho y la cola manual con los casos pendientes debe construirse igual. El informe pasa
 * entonces como «resumen pendiente» a la sincronización de la cola, que lo reintenta. Caso real 2026-09-28: un informe
 * de 4.540 caracteres fue rechazado por Telegram, la excepción cortó la revisión y nunca se armó la cola de los 33
 * casos restantes, aunque 14 gastos ya estaban creados y conciliados. */
export async function entregarRevisionCorreo<T extends { informePublicado?: boolean }>(opciones: {
  resumen: string;
  publicar: () => boolean;
  enviar: (resumen: string) => Promise<unknown>;
  sincronizar: (resumenPendiente: string) => Promise<T>;
  /** `informeEntregado` es false si el informe no llegó a publicarse: el aviso de recuperación debe decirlo. */
  recuperar: (error: unknown, informeEntregado: boolean) => Promise<T>;
}): Promise<T> {
  let entregado = false;
  if (opciones.resumen && opciones.publicar()) {
    try {
      await opciones.enviar(opciones.resumen);
      entregado = true;
    } catch (error) {
      console.error("[entregarRevisionCorreo] No se pudo enviar el informe; se reintenta al preparar la cola manual:",
        error instanceof Error ? error.message : String(error));
    }
  }
  let cola: T;
  try {
    cola = await opciones.sincronizar(entregado ? "" : opciones.resumen);
  } catch (error) {
    cola = await opciones.recuperar(error, entregado);
  }
  cola.informePublicado ||= entregado;
  return cola;
}
