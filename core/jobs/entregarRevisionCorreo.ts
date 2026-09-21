/** La cola manual puede fallar después de completar escrituras financieras.
 * Entrega primero el resultado, y permite recuperar solo la cola sin repetir la ejecución. */
export async function entregarRevisionCorreo<T extends { informePublicado?: boolean }>(opciones: {
  resumen: string;
  publicar: () => boolean;
  enviar: (resumen: string) => Promise<unknown>;
  sincronizar: (resumenPendiente: string) => Promise<T>;
  recuperar: (error: unknown) => Promise<T>;
}): Promise<T> {
  let entregado = false;
  if (opciones.resumen && opciones.publicar()) {
    await opciones.enviar(opciones.resumen);
    entregado = true;
  }
  let cola: T;
  try {
    cola = await opciones.sincronizar(entregado ? "" : opciones.resumen);
  } catch (error) {
    cola = await opciones.recuperar(error);
  }
  cola.informePublicado ||= entregado;
  return cola;
}
