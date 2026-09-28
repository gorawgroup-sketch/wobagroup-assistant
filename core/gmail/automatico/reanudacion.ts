import { hayCoordinacionDurable, poolAuto } from "./postgres";

/**
 * Registro durable de «revisión manual de correo pendiente de reanudar».
 *
 * Caso real 2026-09-28 16:12: /revisarcorreo murió en «39/50» porque un despliegue mandó SIGTERM
 * y el proceso nuevo no sabía que había una revisión a medias. Al recibir SIGTERM, el servidor
 * escribe aquí una fila por chat con revisión manual en curso (antes de esperar nada, así queda
 * aunque el SIGKILL llegue antes del punto de control); al arrancar, el proceso nuevo reclama esas
 * filas de forma atómica (DELETE … RETURNING: solo un proceso puede retomar cada una) y relanza la
 * misma revisión. Es seguro repetirla: los análisis están cacheados por huella en
 * wobi_mail_analyses y cada escritura en Holded es una operación durable que no repite POST.
 */
export interface ReanudacionRevisionCorreo {
  chatId: number;
  /** Momento (ms) en que el SIGTERM interrumpió la revisión. */
  interrumpidaEn: number;
  /** Cuántas veces seguidas se ha reanudado ya esta misma revisión. */
  reanudaciones: number;
  /** Último progreso visible («Mensajes analizados: 39/50»), solo informativo. */
  progreso?: string;
}

/** Más allá de esto, encadenar reanudaciones ya no es «un despliegue inoportuno»: se avisa y se para. */
export const MAX_REANUDACIONES_ENCADENADAS = 3;
/** Una fila más antigua que esto ya no representa una revisión que alguien esté esperando. */
export const MAX_EDAD_REANUDACION_MS = 6 * 60 * 60 * 1000;

export type DecisionReanudacion =
  | { accion: "reanudar"; registro: ReanudacionRevisionCorreo }
  | { accion: "caducada"; registro: ReanudacionRevisionCorreo }
  | { accion: "demasiadas"; registro: ReanudacionRevisionCorreo };

/** Lógica pura, separada de Postgres para poder probarla sin base de datos. */
export function decidirReanudacion(registro: ReanudacionRevisionCorreo, ahora = Date.now()): DecisionReanudacion {
  if (ahora - registro.interrumpidaEn > MAX_EDAD_REANUDACION_MS) return { accion: "caducada", registro };
  if (registro.reanudaciones >= MAX_REANUDACIONES_ENCADENADAS) return { accion: "demasiadas", registro };
  return { accion: "reanudar", registro };
}

export async function registrarReanudacionPendiente(registro: ReanudacionRevisionCorreo): Promise<void> {
  if (!hayCoordinacionDurable()) throw new Error("Sin PostgreSQL no se puede dejar programada la reanudación.");
  await poolAuto().query(
    `INSERT INTO wobi_mail_resume(chat_id, data, created_at) VALUES($1, $2, now())
     ON CONFLICT (chat_id) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
    [registro.chatId, JSON.stringify(registro)]
  );
}

/** La revisión terminó por sí misma después del SIGTERM: no hay nada que retomar. */
export async function cancelarReanudacionPendiente(chatId: number): Promise<void> {
  if (!hayCoordinacionDurable()) return;
  await poolAuto().query("DELETE FROM wobi_mail_resume WHERE chat_id=$1", [chatId]);
}

/** Reclama (y borra) todas las reanudaciones pendientes; quien las recibe es el único que las retomará. */
export async function reclamarReanudacionesPendientes(): Promise<ReanudacionRevisionCorreo[]> {
  if (!hayCoordinacionDurable()) return [];
  const r = await poolAuto().query("DELETE FROM wobi_mail_resume RETURNING data");
  return r.rows
    .map(fila => fila.data as ReanudacionRevisionCorreo)
    .filter(registro => Number.isFinite(registro?.chatId) && Number.isFinite(registro?.interrumpidaEn));
}
