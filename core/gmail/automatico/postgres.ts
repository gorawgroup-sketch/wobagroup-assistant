import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { VERSION_POLITICA, type AnalisisAuto, type EmpresaAuto, type OperacionAuto, type PlanAuto, type StoreAuto } from "./model";

// El esquema se aplica explícitamente con el script de preparación; nunca durante una escritura.
export const SCHEMA_AUTO = `
CREATE TABLE IF NOT EXISTS wobi_mail_operations (
  id text PRIMARY KEY, mailbox text NOT NULL, company text NOT NULL,
  state text NOT NULL, data jsonb NOT NULL, version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wobi_mail_operations ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS wobi_mail_claims (
  resource text PRIMARY KEY, operation_id text NOT NULL REFERENCES wobi_mail_operations(id)
);
CREATE TABLE IF NOT EXISTS wobi_mail_events (
  id bigserial PRIMARY KEY, mailbox text NOT NULL, message_id text, kind text NOT NULL,
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wobi_mail_analyses (
  mailbox text NOT NULL, message_id text NOT NULL, fingerprint text NOT NULL, policy text NOT NULL,
  data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox, message_id, fingerprint, policy)
);
CREATE INDEX IF NOT EXISTS wobi_mail_operations_pending ON wobi_mail_operations(mailbox, state);
CREATE INDEX IF NOT EXISTS wobi_mail_events_message ON wobi_mail_events(mailbox, message_id);
`;
let pool: Pool | undefined;
export function hayCoordinacionDurable(): boolean { return Boolean(process.env.WOBI_MAIL_DATABASE_URL); }
export function poolAuto(): Pool {
  if (!process.env.WOBI_MAIL_DATABASE_URL) throw new Error("Falta WOBI_MAIL_DATABASE_URL; no se permiten escrituras automáticas.");
  if (!pool) {
    pool = new Pool({ connectionString: process.env.WOBI_MAIL_DATABASE_URL, max: 8,
      connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
    pool.on("error", () => console.error("[correo-auto] Conexión PostgreSQL perdida; las operaciones siguen reservadas."));
  }
  return pool;
}
export async function cerrarPoolAuto(): Promise<void> { if (pool) await pool.end(); pool = undefined; }
export async function buscarAnalisisAutomaticoReciente(mensajeId: string): Promise<AnalisisAuto | undefined> {
  if (!hayCoordinacionDurable() || !mensajeId) return undefined;
  const r = await poolAuto().query(`SELECT data FROM wobi_mail_analyses
    WHERE mailbox=$1 AND message_id=$2 AND policy=$3 ORDER BY updated_at DESC LIMIT 1`,
    [process.env.GMAIL_IMPERSONATE_EMAIL ?? "", mensajeId, VERSION_POLITICA]);
  return r.rows[0]?.data as AnalisisAuto | undefined;
}
const contexto = new AsyncLocalStorage<{ locks: Set<string>; operacion?: string }>();

/** Bloqueo de sesión distribuido. El intento externo se persiste antes del POST, de modo que
 * perder la conexión del lock no autoriza repetir una escritura cuyo resultado es incierto. */
export async function conBloqueoAuto<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const actual = contexto.getStore();
  if (actual?.locks.has(clave)) return tarea();
  const client = await poolAuto().connect();
  let roto = false;
  const onError = () => { roto = true; };
  client.on("error", onError);
  try {
    await client.query("SET lock_timeout = '30s'");
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [clave]);
    const resultado = await contexto.run({ ...actual, locks: new Set([...(actual?.locks ?? []), clave]) }, tarea);
    if (roto) throw new Error("Se perdió el bloqueo distribuido; comprobar el registro antes de continuar.");
    return resultado;
  } finally {
    try { if (!roto) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [clave]); }
    catch { roto = true; }
    client.off("error", onError);
    client.release(roto);
  }
}
export const conOperacionAuto = <T>(id: string, tarea: () => Promise<T>): Promise<T> =>
  contexto.run({ locks: contexto.getStore()?.locks ?? new Set(), operacion: id }, tarea);

/** Compartido por cron, comandos y activación manual de correos. */
export async function conCoordinadorCorreo<T>(tarea: () => Promise<T>): Promise<T> {
  const clave = `correo:${process.env.GMAIL_IMPERSONATE_EMAIL ?? ""}`;
  const actual = contexto.getStore();
  if (actual?.locks.has(clave)) return tarea();
  if (!hayCoordinacionDurable()) {
    if (process.env.WOBI_MAIL_AUTO_MODE && process.env.WOBI_MAIL_AUTO_MODE !== "off") throw new Error("Configura PostgreSQL antes de activar la revisión automática.");
    const { conMutex } = await import("../../utils/asyncMutex");
    return conMutex(clave, () => contexto.run({ ...actual, locks: new Set([...(actual?.locks ?? []), clave]) }, tarea));
  }
  return conBloqueoAuto(clave, tarea);
}

/** Las rutas manuales y múltiples respetan las operaciones automáticas incompletas. */
export async function protegerEscrituraHolded<T>(empresa: EmpresaAuto, tarea: () => Promise<T>, objetivo?: { path: string; body?: unknown }): Promise<T> {
  if (!hayCoordinacionDurable()) {
    if (process.env.WOBI_MAIL_AUTO_MODE === "execute") throw new Error("Coordinación durable no disponible.");
    return tarea();
  }
  return conBloqueoAuto(`holded:${empresa}`, async () => {
    const propias = contexto.getStore()?.operacion ?? "";
    if (propias) {
      // Una operación incierta conserva sus propios recursos, pero no debe congelar toda la empresa.
      // El advisory lock sigue serializando las escrituras y los claims impiden que dos operaciones
      // distintas usen el mismo comprobante, documento o movimiento bancario.
      const conflicto = await poolAuto().query(`SELECT DISTINCT otra.id FROM wobi_mail_claims propia
        JOIN wobi_mail_claims compartida ON compartida.resource=propia.resource AND compartida.operation_id<>propia.operation_id
        JOIN wobi_mail_operations otra ON otra.id=compartida.operation_id
        WHERE propia.operation_id=$1 AND otra.company=$2 AND otra.state NOT IN ('completada','rechazada') LIMIT 1`,
      [propias, empresa]);
      if (conflicto.rowCount) throw new Error(`Recurso reservado por la operación automática ${conflicto.rows[0].id}.`);
    } else {
      // Las rutas manuales no tienen claims propios con los que demostrar independencia; conservan
      // el bloqueo cerrado hasta que el operador resuelva la operación automática incierta.
      const pendiente = await poolAuto().query("SELECT id FROM wobi_mail_operations WHERE company=$1 AND state NOT IN ('completada','rechazada') LIMIT 1", [empresa]);
      if (pendiente.rowCount) throw new Error(`Holded reservado por la operación automática ${pendiente.rows[0].id}. Resolverla antes de otra escritura.`);
    }
    const movimiento = objetivo?.path.match(/\/bank-movements\/([^/]+)\/reconcile$/)?.[1];
    const body = objetivo?.body && typeof objetivo.body === "object" ? objetivo.body as Record<string, unknown> : {};
    const numero = objetivo?.path === "/purchases" && typeof body.number === "string" && body.number !== "00000"
      ? body.number.trim().toUpperCase().replace(/\s+/g, " ") : null;
    if (movimiento || numero) {
      const anteriores = await poolAuto().query(`SELECT id FROM wobi_mail_operations WHERE company=$1 AND id<>$2 AND state='completada'
        AND (($3::text IS NOT NULL AND data->'plan'->'movimiento'->>'id'=$3)
          OR ($4::text IS NOT NULL AND data->'plan'->>'contactoId'=$5 AND upper(trim(data->'plan'->'recibo'->>'numero'))=$4)) LIMIT 1`,
        [empresa, propias, movimiento ? decodeURIComponent(movimiento) : null, numero, typeof body.contact_id === "string" ? body.contact_id : null]);
      if (anteriores.rowCount) throw new Error(`Esta operación ya fue completada por la revisión automática (${anteriores.rows[0].id}); el botón antiguo no la repetirá.`);
    }
    return tarea();
  });
}

export class PostgresAutoStore implements StoreAuto {
  constructor(private readonly db: Pool = poolAuto()) {}
  async buscarAnalisis(buzon: string, mensajeId: string, huella: string, version: string): Promise<AnalisisAuto | undefined> {
    const r = await this.db.query("SELECT data FROM wobi_mail_analyses WHERE mailbox=$1 AND message_id=$2 AND fingerprint=$3 AND policy=$4",
      [buzon, mensajeId, huella, version]);
    return r.rows[0]?.data as AnalisisAuto | undefined;
  }
  async guardarAnalisis(buzon: string, mensajeId: string, huella: string, version: string, analisis: AnalisisAuto): Promise<void> {
    await this.db.query(`INSERT INTO wobi_mail_analyses(mailbox,message_id,fingerprint,policy,data) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (mailbox,message_id,fingerprint,policy) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
      [buzon, mensajeId, huella, version, JSON.stringify(analisis)]);
  }
  async reservar(plan: PlanAuto): Promise<OperacionAuto> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const existentes = await client.query("SELECT DISTINCT o.data FROM wobi_mail_claims c JOIN wobi_mail_operations o ON o.id=c.operation_id WHERE c.resource=ANY($1::text[])", [plan.claves]);
      if (existentes.rowCount) {
        const op = existentes.rows[0].data as OperacionAuto;
        if (existentes.rowCount !== 1 || op.plan.correo.id !== plan.correo.id || op.plan.recibo.fuente !== plan.recibo.fuente) {
          throw new Error("Comprobante o movimiento reservado por otra operación; posible duplicado.");
        }
        await client.query("COMMIT");
        return op;
      }
      const op: OperacionAuto = { id: randomUUID(), revision: 0, plan, estado: "reservada" };
      await client.query("INSERT INTO wobi_mail_operations(id,mailbox,company,state,data) VALUES($1,$2,$3,$4,$5)",
        [op.id, plan.correo.buzon, plan.empresa, op.estado, JSON.stringify(op)]);
      for (const clave of [...plan.claves].sort()) await client.query("INSERT INTO wobi_mail_claims(resource,operation_id) VALUES($1,$2)", [clave, op.id]);
      await client.query("INSERT INTO wobi_mail_events(mailbox,message_id,kind,data) VALUES($1,$2,$3,$4)",
        [plan.correo.buzon, plan.correo.id, "reservada", JSON.stringify(op)]);
      await client.query("COMMIT");
      return op;
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  }
  async guardar(op: OperacionAuto): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const esperada = op.revision ?? 0;
      const siguiente = { ...op, revision: esperada + 1 };
      const r = await client.query("UPDATE wobi_mail_operations SET state=$2,data=$3,version=version+1,updated_at=now() WHERE id=$1 AND version=$4 RETURNING id", [op.id, op.estado, JSON.stringify(siguiente), esperada]);
      if (r.rowCount !== 1) throw new Error("Operación modificada por otra ejecución; no se autoriza repetir la escritura.");
      if (op.estado === "rechazada") await client.query("DELETE FROM wobi_mail_claims WHERE operation_id=$1", [op.id]);
      await client.query("INSERT INTO wobi_mail_events(mailbox,message_id,kind,data) VALUES($1,$2,$3,$4)",
        [op.plan.correo.buzon, op.plan.correo.id, op.estado, JSON.stringify(siguiente)]);
      await client.query("COMMIT");
      op.revision = siguiente.revision;
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  }
  async buscarFuente(buzon: string, mensajeId: string, fuente: string): Promise<OperacionAuto | undefined> {
    const r = await this.db.query("SELECT data FROM wobi_mail_operations WHERE mailbox=$1 AND data->'plan'->'correo'->>'id'=$2 AND data->'plan'->'recibo'->>'fuente'=$3 AND state <> 'rechazada' ORDER BY updated_at DESC LIMIT 1", [buzon, mensajeId, fuente]);
    return r.rows[0]?.data as OperacionAuto | undefined;
  }
  async pendientes(buzon: string): Promise<OperacionAuto[]> {
    const r = await this.db.query("SELECT data FROM wobi_mail_operations WHERE mailbox=$1 AND state NOT IN ('completada','rechazada') ORDER BY updated_at", [buzon]);
    return r.rows.map(x => x.data as OperacionAuto);
  }
  async auditar(e: { buzon: string; mensajeId?: string; tipo: string; datos: unknown }): Promise<void> {
    await this.db.query("INSERT INTO wobi_mail_events(mailbox,message_id,kind,data) VALUES($1,$2,$3,$4)", [e.buzon, e.mensajeId ?? null, e.tipo, JSON.stringify(e.datos)]);
  }
}
