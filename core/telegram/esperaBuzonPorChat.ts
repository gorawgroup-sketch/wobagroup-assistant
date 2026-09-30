/**
 * Avisos de «buzón ocupado» por chat.
 *
 * Caso real (Carlos, 2026-09-30): un correo con cinco adjuntos mostró los botones del primero mientras el sistema
 * seguía leyendo los otros cuatro con el buzón reservado. Cada pulsación generó su propio «⏳ El buzón está ocupado…»
 * y, cuando por fin se aplicaron, nadie lo dijo: desde el chat parecía bloqueado.
 *
 * Aquí se lleva la cuenta de acciones en espera por chat para avisar UNA vez al empezar la espera y UNA vez al
 * terminar. No decide nada sobre candados: solo qué decirle al operador.
 */
interface Espera { enEspera: number; aplicadas: number; fallidas: number }

export class EsperaBuzonPorChat {
  private readonly chats = new Map<number, Espera>();

  /** Una acción del chat empieza a esperar. Devuelve true si hay que mostrar el aviso de espera (es la primera). */
  empezar(chatId: number): boolean {
    const actual = this.chats.get(chatId);
    if (actual) { actual.enEspera += 1; return false; }
    this.chats.set(chatId, { enEspera: 1, aplicadas: 0, fallidas: 0 });
    return true;
  }

  /**
   * Una acción que esperaba terminó. Devuelve el resumen cuando era la última en espera de ese chat (momento de
   * avisar), o undefined si quedan otras esperando.
   */
  terminar(chatId: number, aplicada: boolean): { aplicadas: number; fallidas: number } | undefined {
    const actual = this.chats.get(chatId);
    if (!actual) return undefined;
    actual.enEspera -= 1;
    if (aplicada) actual.aplicadas += 1; else actual.fallidas += 1;
    if (actual.enEspera > 0) return undefined;
    this.chats.delete(chatId);
    return { aplicadas: actual.aplicadas, fallidas: actual.fallidas };
  }
}

export function textoFinEsperaBuzon(resumen: { aplicadas: number; fallidas: number }): string | undefined {
  // Las fallidas ya tienen su propio aviso con la causa; aquí solo se confirma lo que sí se aplicó.
  if (resumen.aplicadas === 0) return undefined;
  return resumen.aplicadas === 1
    ? "✅ La revisión terminó y tu acción en espera ya quedó aplicada."
    : `✅ La revisión terminó y tus ${resumen.aplicadas} acciones en espera ya quedaron aplicadas.`;
}
