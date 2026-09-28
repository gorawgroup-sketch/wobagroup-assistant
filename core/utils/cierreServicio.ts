/**
 * Señal de cierre del proceso, compartida por todo el servicio.
 *
 * Caso real (2026-09-28 16:12): Carlos lanzó /revisarcorreo y un segundo después Railway mandó
 * SIGTERM porque se fusionó otro PR. El servidor esperó 55 s y salió con la revisión en «39/50»:
 * nadie avisó, nada se reanudó y el chat quedó sin cierre. La revisión solo entendía de
 * `fechaLimite`; no tenía forma de saber que la estaban cerrando.
 *
 * `solicitarCierre()` la activa (el manejador de SIGTERM en src/server.ts); los trabajos largos
 * consultan `cierreSolicitado()` en sus puntos de control y paran limpiamente, dejando lo hecho en
 * estado durable para que el proceso nuevo lo retome (ver core/gmail/automatico/reanudacion.ts).
 */
let cierre = false;
const oyentes = new Set<() => void>();

export function solicitarCierre(): void {
  if (cierre) return;
  cierre = true;
  for (const oyente of oyentes) {
    try { oyente(); } catch (error) { console.error("[cierre] Un oyente de cierre falló:", error); }
  }
}

export function cierreSolicitado(): boolean {
  return cierre;
}

/** Devuelve la función para darse de baja. */
export function alSolicitarCierre(oyente: () => void): () => void {
  oyentes.add(oyente);
  return () => { oyentes.delete(oyente); };
}

/** Solo para pruebas: el proceso real nunca vuelve atrás una vez pedido el cierre. */
export function reiniciarCierreParaPruebas(): void {
  cierre = false;
  oyentes.clear();
}
