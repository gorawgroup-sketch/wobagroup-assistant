import { hayCoordinacionDurable, poolAuto } from "../../gmail/automatico/postgres";

/**
 * Cola y registro duraderos de las automatizaciones de Holded. Cada fila es una unidad de trabajo con clave
 * idempotente (p. ej. `sync:2026-10-02:WOBA:<cuenta>` o `ticket:WOBA:<compra>`): repetirla nunca crea otra.
 */
export type TipoTrabajo = "sync_bancaria" | "ticket";
export type EstadoTrabajo =
  | "solicitado" // se decidió actuar; aún no hay acción confirmada
  | "en_curso" // la acción se lanzó; falta comprobar con evidencia de Holded
  | "completado" // verificado con evidencia leída de Holded
  | "fallido" // error definitivo tras los reintentos
  | "requiere_intervencion" // consentimiento/sesión/2FA/CAPTCHA/revisión humana
  | "no_confirmado" // se lanzó pero Holded no mostró evidencia a tiempo
  | "omitido" // no aplica (cuenta manual, ya convertido, etc.)
  | "simulado"; // modo simulación: solo registro de lo que haría

export interface Trabajo {
  clave: string;
  tipo: TipoTrabajo;
  empresa: string;
  objetivo: string;
  estado: EstadoTrabajo;
  intentos: number;
  creadoEn: number;
  actualizadoEn: number;
  /** Cuándo se lanzó la acción (ms). */
  solicitadoEn?: number;
  /** Cuándo se comprobó con evidencia de Holded (ms). */
  verificadoEn?: number;
  proximoIntentoEn?: number;
  ultimoError?: string;
  evidencia: Record<string, unknown>;
}

export interface EventoTrabajo { clave: string; en: number; tipo: string; datos: Record<string, unknown> }

export interface AlmacenTrabajos {
  obtener(clave: string): Promise<Trabajo | undefined>;
  guardar(trabajo: Trabajo): Promise<void>;
  listar(filtro?: { tipo?: TipoTrabajo; estados?: EstadoTrabajo[]; empresa?: string; desde?: number }): Promise<Trabajo[]>;
  evento(clave: string, tipo: string, datos?: Record<string, unknown>): Promise<void>;
  eventos(clave: string): Promise<EventoTrabajo[]>;
  /** Exclusión mutua entre instancias/ejecuciones solapadas del mismo trabajo. */
  conExclusion<T>(clave: string, tarea: () => Promise<T>): Promise<T | "ocupado">;
}

export const ESTADOS_TERMINALES: readonly EstadoTrabajo[] = ["completado", "fallido", "omitido", "simulado", "no_confirmado", "requiere_intervencion"];

function coincide(t: Trabajo, f: Parameters<AlmacenTrabajos["listar"]>[0] = {}): boolean {
  return (!f.tipo || t.tipo === f.tipo) && (!f.estados || f.estados.includes(t.estado)) &&
    (!f.empresa || t.empresa === f.empresa) && (f.desde === undefined || t.actualizadoEn >= f.desde);
}

export class AlmacenTrabajosMemoria implements AlmacenTrabajos {
  private trabajos = new Map<string, Trabajo>();
  private registro: EventoTrabajo[] = [];
  private ocupados = new Set<string>();
  constructor(private ahora: () => number = Date.now) {}
  async obtener(clave: string) { const t = this.trabajos.get(clave); return t ? structuredClone(t) : undefined; }
  async guardar(t: Trabajo) { this.trabajos.set(t.clave, structuredClone(t)); }
  async listar(f?: Parameters<AlmacenTrabajos["listar"]>[0]) { return [...this.trabajos.values()].filter((t) => coincide(t, f)).map((t) => structuredClone(t)); }
  async evento(clave: string, tipo: string, datos: Record<string, unknown> = {}) { this.registro.push({ clave, en: this.ahora(), tipo, datos }); }
  async eventos(clave: string) { return this.registro.filter((e) => e.clave === clave); }
  async conExclusion<T>(clave: string, tarea: () => Promise<T>): Promise<T | "ocupado"> {
    if (this.ocupados.has(clave)) return "ocupado";
    this.ocupados.add(clave);
    try { return await tarea(); } finally { this.ocupados.delete(clave); }
  }
}

export class AlmacenTrabajosPostgres implements AlmacenTrabajos {
  async obtener(clave: string) {
    const r = await poolAuto().query("SELECT data FROM wobi_holded_jobs WHERE key=$1", [clave]);
    return r.rows[0]?.data as Trabajo | undefined;
  }
  async guardar(t: Trabajo) {
    await poolAuto().query(
      `INSERT INTO wobi_holded_jobs(key,kind,company,state,data,updated_at) VALUES($1,$2,$3,$4,$5,now())
       ON CONFLICT (key) DO UPDATE SET state=EXCLUDED.state, data=EXCLUDED.data, updated_at=now()`,
      [t.clave, t.tipo, t.empresa, t.estado, JSON.stringify(t)]);
  }
  async listar(f: Parameters<AlmacenTrabajos["listar"]>[0] = {}) {
    const r = await poolAuto().query(
      `SELECT data FROM wobi_holded_jobs WHERE ($1::text IS NULL OR kind=$1) AND ($2::text IS NULL OR company=$2)
       AND ($3::text[] IS NULL OR state=ANY($3)) AND ($4::timestamptz IS NULL OR updated_at>=$4) ORDER BY updated_at DESC LIMIT 5000`,
      [f.tipo ?? null, f.empresa ?? null, f.estados ?? null, f.desde === undefined ? null : new Date(f.desde)]);
    return r.rows.map((x) => x.data as Trabajo);
  }
  async evento(clave: string, tipo: string, datos: Record<string, unknown> = {}) {
    await poolAuto().query("INSERT INTO wobi_holded_job_events(key,kind,data) VALUES($1,$2,$3)", [clave, tipo, JSON.stringify(datos)]);
  }
  async eventos(clave: string) {
    const r = await poolAuto().query("SELECT kind,data,created_at FROM wobi_holded_job_events WHERE key=$1 ORDER BY id", [clave]);
    return r.rows.map((x) => ({ clave, en: new Date(x.created_at).getTime(), tipo: x.kind as string, datos: x.data as Record<string, unknown> }));
  }
  async conExclusion<T>(clave: string, tarea: () => Promise<T>): Promise<T | "ocupado"> {
    // Candado consultivo SIN espera: si otra instancia/ejecución ya tiene este trabajo, se devuelve «ocupado» y no se duplica.
    const cliente = await poolAuto().connect();
    let roto = false;
    const alError = () => { roto = true; };
    cliente.on("error", alError);
    let tomado = false;
    try {
      tomado = (await cliente.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [`holded-auto:${clave}`])).rows[0]?.ok === true;
      if (!tomado) return "ocupado";
      return await tarea();
    } finally {
      try { if (tomado && !roto) await cliente.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`holded-auto:${clave}`]); } catch { roto = true; }
      cliente.off("error", alError);
      cliente.release(roto);
    }
  }
}

// El esquema (wobi_holded_jobs, wobi_holded_job_events) vive en SCHEMA_AUTO: se aplica solo con el script de preparación.

let almacenPorDefecto: AlmacenTrabajos | undefined;
/** Con base de datos duradera usa PostgreSQL; sin ella, memoria (solo válido para simulación). */
export function almacenTrabajosHolded(): AlmacenTrabajos {
  almacenPorDefecto ??= hayCoordinacionDurable() ? new AlmacenTrabajosPostgres() : new AlmacenTrabajosMemoria();
  return almacenPorDefecto;
}
export function hayAlmacenDuradero(): boolean { return hayCoordinacionDurable(); }

export function nuevoTrabajo(base: Pick<Trabajo, "clave" | "tipo" | "empresa" | "objetivo">, ahora: number): Trabajo {
  return { ...base, estado: "solicitado", intentos: 0, creadoEn: ahora, actualizadoEn: ahora, evidencia: {} };
}
