const colasPorClave = new Map<string, Promise<void>>();

/**
 * Hallazgo real de auditoría xhigh (2026-09-08, sobre el propio fix de crearPropuestaGasto de esta
 * misma noche): calcular la fila libre de una hoja de Sheets y escribir ahí son dos llamadas HTTP
 * separadas, sin ninguna transacción real — el retry-con-verificación (ver crearPropuestaGasto)
 * detecta una colisión entre dos ESCRITURAS casi simultáneas, pero NUNCA una colisión con un BORRADO
 * concurrente: si una fila se elimina (deleteDimension, que desplaza todas las filas de abajo hacia
 * arriba) justo entre que una escritura calculó "fila libre = 10" y de verdad escribe ahí, esa
 * escritura puede terminar pisando una fila COMPLETAMENTE AJENA que el borrado desplazó hasta la
 * posición 10 — en silencio, sin ningún error, destruyendo una propuesta real que no tenía nada que
 * ver con la escritura que la pisó. Esto no es hipotético: consumirPropuestaGasto/
 * consumirConciliacionPendiente (que borran una fila) se disparan en cada tap de un botón de
 * Telegram, mientras el cron de correo o el vigilante de atascados pueden estar creando una
 * propuesta nueva al mismo tiempo.
 *
 * Dado que la app corre como un solo proceso Node de larga duración (mismo patrón que writeClient/
 * tabGridId, cacheados a nivel de módulo) y Sheets no ofrece compare-and-swap real, la corrección de
 * fondo es serializar en el propio proceso — nunca dos operaciones que calculan/mueven filas de la
 * MISMA hoja corren al mismo tiempo. `conMutex` encola cada llamada por clave (ej. el nombre de la
 * pestaña): la siguiente espera a que la anterior termine antes de empezar.
 */
export async function conMutex<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const previa = colasPorClave.get(clave) ?? Promise.resolve();
  let resolverTurno: () => void;
  const miTurno = new Promise<void>((resolve) => {
    resolverTurno = resolve;
  });
  colasPorClave.set(clave, previa.then(() => miTurno));

  await previa;
  try {
    return await tarea();
  } finally {
    resolverTurno!();
  }
}
