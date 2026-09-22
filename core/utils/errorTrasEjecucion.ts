import { TurnoConEfectosError } from "../claude/turnSafety";

/**
 * Caso real de Carlos (2026-09-22, correo "Fwd: notificación hacienda B.A.E."): una instrucción de
 * texto libre YA se había ejecutado (resumen enviado, borrador a Mónica/Josep mostrado y luego
 * enviado, recordatorio programado) y un fallo POSTERIOR —solo al vincular el borrador con la cola—
 * hizo que el servidor restaurara la orientación y dijera "puedes reintentar enviando la instrucción
 * de nuevo". El pendiente quedó armado: el SIGUIENTE mensaje cualquiera de Carlos se habría tomado
 * como una nueva instrucción sobre Hacienda, repitiendo borrador y recordatorio. Para Carlos, el chat
 * "quedó bloqueado".
 *
 * Contrato: un flujo de texto libre que falla DESPUÉS de haber producido efectos (askClaude ya corrió
 * herramientas, o el texto ya se aplicó) lanza ErrorTrasEjecucion. Quien lo atrapa (ver
 * intentarResolverPendienteTextoLibre en src/server.ts) NUNCA restaura el pendiente para "reintentar":
 * lo relanza, y la entrega durable de Telegram lo declara incierta y muestra el aviso ya existente
 * "⚠️ Falta confirmar el resultado" con «Verificar resultado» (solo lecturas, nunca re-ejecuta) —
 * mismo aprendizaje que las solicitudes interrumpidas por un redeploy (core/telegram/interruptedNotice.ts).
 *
 * También cuenta como "tras ejecución" el TurnoConEfectosError que askClaude YA lanza cuando una
 * herramienta con efectos arrancó y el turno falló después (core/claude/turnSafety.ts) — hallazgo real
 * de auditoría: sin esto, un 529/timeout de Anthropic tras crear borrador y recordatorio volvía a
 * armar la instrucción igual que antes.
 */
export class ErrorTrasEjecucion extends Error {
  constructor(etapa: string, causa: unknown) {
    const detalle = causa instanceof Error ? causa.message : String(causa);
    super(`${etapa}: ${detalle}`, { cause: causa });
    this.name = "ErrorTrasEjecucion";
  }
}

export function esErrorTrasEjecucion(error: unknown): error is ErrorTrasEjecucion | TurnoConEfectosError {
  return error instanceof ErrorTrasEjecucion || error instanceof TurnoConEfectosError;
}

/** Texto para Carlos: qué pasó, que NO se re-armó nada y qué hacer — nunca "reintenta". */
export function mensajeFalloTrasEjecucion(error: ErrorTrasEjecucion | TurnoConEfectosError): string {
  const causa = error instanceof ErrorTrasEjecucion ? error.message : "la respuesta se cortó después de iniciar una acción";
  return (
    `⚠️ Tu instrucción ya se ejecutó (total o parcialmente), pero algo falló después: ${causa}.\n\n` +
    "No la dejé pendiente para repetirla, así que tu próximo mensaje NO la volverá a ejecutar. " +
    "Revisa arriba lo que quedó hecho (borradores, recordatorios, cambios) antes de pedir nada de nuevo."
  );
}
