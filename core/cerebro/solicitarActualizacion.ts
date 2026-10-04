/** Accept a refresh immediately; its eventual result is delivered by normal state reads/SSE. */
export function solicitarActualizacion(
  actualizar: () => Promise<unknown>,
  registrarError: (error: unknown) => void,
): { actualizacionSolicitada: true } {
  void Promise.resolve().then(actualizar).catch(registrarError);
  return { actualizacionSolicitada: true };
}
