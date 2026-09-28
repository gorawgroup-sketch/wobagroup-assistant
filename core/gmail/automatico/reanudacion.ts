import { hayCoordinacionDurable, poolAuto } from "./postgres";

/**
 * Registro durable de las revisiones manuales de correo, para retomarlas en otro proceso.
 *
 * Caso real 2026-09-28 16:12: /revisarcorreo murió en «39/50» porque un despliegue mandó SIGTERM
 * y el proceso nuevo no sabía que había una revisión a medias. Primera versión (PR #234): al
 * recibir SIGTERM se escribía una fila «pendiente» y el proceso nuevo la reclamaba.
 *
 * Segunda versión (misma tarde): verificando en vivo se vio que un contenedor arrancado con
 * `npm start` (lo que hace `railway redeploy`) NUNCA recibe el SIGTERM — npm es el PID 1 y el
 * kernel ignora la señal — y muere por SIGKILL sin escribir nada. Ninguna solución basada en
 * «avisar al cerrar» cubre eso, ni un crash, ni un OOM. Por eso ahora la fila existe desde que
 * la revisión EMPIEZA (`en_curso`), con un latido periódico; el proceso nuevo retoma tanto las
 * filas `pendiente` (cierre ordenado) como las `en_curso` cuyo latido se quedó viejo (muerte sin
 * aviso). Reclamar es un DELETE … RETURNING: solo un proceso retoma cada una, y un proceso nunca
 * reclama las suyas propias. Repetir la revisión es seguro: análisis cacheados por huella y
 * escrituras durables en Holded.
 */
export interface ReanudacionRevisionCorreo {
  chatId: number;
  /** Momento (ms) en que se interrumpió (SIGTERM) o del último latido (muerte sin aviso). */
  interrumpidaEn: number;
  /** Cuántas veces seguidas se ha reanudado ya esta misma revisión. */
  reanudaciones: number;
  /** Último progreso visible («Mensajes analizados: 39/50»), solo informativo. */
  progreso?: string;
}

export interface ReanudacionReclamada {
  registro: ReanudacionRevisionCorreo;
  /** true: el proceso anterior murió sin avisar (latido viejo); false: cierre ordenado por SIGTERM. */
  huerfana: boolean;
}

/** Más allá de esto, encadenar reanudaciones ya no es «un despliegue inoportuno»: se avisa y se para. */
export const MAX_REANUDACIONES_ENCADENADAS = 3;
/** Una fila más antigua que esto ya no representa una revisión que alguien esté esperando. */
export const MAX_EDAD_REANUDACION_MS = 6 * 60 * 60 * 1000;
/** Cada cuánto late una revisión en curso, y a partir de cuánto silencio se la da por muerta. */
export const INTERVALO_LATIDO_MS = 15_000;
export const LATIDO_MAXIMO_MS = 60_000;

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

/** Identidad de este proceso, para no reclamar nunca una revisión propia. */
export function instanciaActual(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAILWAY_REPLICA_ID || env.RAILWAY_DEPLOYMENT_ID || `${env.HOSTNAME ?? "local"}:${process.pid}`;
}

const sinPostgres = () => new Error("Sin PostgreSQL no se puede registrar la revisión para reanudarla.");

/** La revisión acaba de empezar en este proceso: fila `en_curso` con latido fresco. */
export async function iniciarRevisionEnCurso(registro: ReanudacionRevisionCorreo, instancia = instanciaActual()): Promise<void> {
  if (!hayCoordinacionDurable()) throw sinPostgres();
  await poolAuto().query(
    `INSERT INTO wobi_mail_resume(chat_id, data, state, instance, heartbeat_at, created_at) VALUES($1, $2, 'en_curso', $3, now(), now())
     ON CONFLICT (chat_id) DO UPDATE SET data = EXCLUDED.data, state = 'en_curso', instance = EXCLUDED.instance, heartbeat_at = now(), created_at = now()`,
    [registro.chatId, JSON.stringify(registro), instancia]
  );
}

/** Latido periódico; solo toca una fila `en_curso` (una ya convertida en `pendiente` por el SIGTERM se respeta). */
export async function latirRevisionEnCurso(chatId: number, progreso?: string): Promise<void> {
  if (!hayCoordinacionDurable()) return;
  await poolAuto().query(
    `UPDATE wobi_mail_resume SET heartbeat_at = now(),
       data = CASE WHEN $2::text IS NULL THEN data ELSE jsonb_set(data, '{progreso}', to_jsonb($2::text)) END
     WHERE chat_id = $1 AND state = 'en_curso'`,
    [chatId, progreso ?? null]
  );
}

/** Cierre ordenado (SIGTERM): la fila pasa a `pendiente` para que el siguiente proceso la retome ya. */
export async function registrarReanudacionPendiente(registro: ReanudacionRevisionCorreo): Promise<void> {
  if (!hayCoordinacionDurable()) throw sinPostgres();
  await poolAuto().query(
    `INSERT INTO wobi_mail_resume(chat_id, data, state, instance, heartbeat_at, created_at) VALUES($1, $2, 'pendiente', '', now(), now())
     ON CONFLICT (chat_id) DO UPDATE SET data = EXCLUDED.data, state = 'pendiente', heartbeat_at = now(), created_at = now()`,
    [registro.chatId, JSON.stringify(registro)]
  );
}

/** La revisión terminó (bien o con error) en este proceso: no hay nada que retomar. */
export async function cerrarRegistroRevision(chatId: number): Promise<void> {
  if (!hayCoordinacionDurable()) return;
  await poolAuto().query("DELETE FROM wobi_mail_resume WHERE chat_id=$1", [chatId]);
}

/**
 * Reclama (y borra) lo que haya que retomar: filas `pendiente` y filas `en_curso` de OTRO proceso
 * con el latido más viejo que `latidoMaximoMs`. Quien las recibe es el único que las retomará.
 */
export async function reclamarReanudacionesPendientes(
  opciones: { instancia?: string; latidoMaximoMs?: number } = {}
): Promise<ReanudacionReclamada[]> {
  if (!hayCoordinacionDurable()) return [];
  const instancia = opciones.instancia ?? instanciaActual();
  const latidoMaximoMs = opciones.latidoMaximoMs ?? LATIDO_MAXIMO_MS;
  const r = await poolAuto().query(
    `DELETE FROM wobi_mail_resume
     WHERE state = 'pendiente'
        OR (state = 'en_curso' AND instance <> $1 AND heartbeat_at < now() - ($2::int * interval '1 millisecond'))
     RETURNING data, state, heartbeat_at`,
    [instancia, latidoMaximoMs]
  );
  return r.rows
    .map(fila => {
      const registro = fila.data as ReanudacionRevisionCorreo;
      const huerfana = fila.state === "en_curso";
      if (huerfana) registro.interrumpidaEn = new Date(fila.heartbeat_at).getTime();
      return { registro, huerfana };
    })
    .filter(({ registro }) => Number.isFinite(registro?.chatId) && Number.isFinite(registro?.interrumpidaEn));
}
