import * as sheets from "../google/sheetsKeyValueStore";
import { poolAuto, hayCoordinacionDurable, conCoordinadorCorreo } from "./automatico/postgres";

const TAB = "_cola_revision_correo";
const HEADERS = ["id", "chatId", "de", "asunto", "fechaOrden", "estado", "pendientesRestantes", "agregadoEn", "mensajeId", "accionesResueltasJSON"];
const namespace = () => `${process.env.CASHFLOW_SHEET_ID ?? ""}:${TAB}`;

/** Copia transaccional: conserva filas y acciones resueltas; Sheets queda intacto. */
export async function importarColaPostgres(
  pool: import("pg").Pool,
  espacio: string,
  cargar: () => Promise<sheets.FilaCruda[]>
): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout = '30s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [espacio]);
    const existe = await db.query("SELECT 1 FROM wobi_mail_queue_migrations WHERE namespace=$1", [espacio]);
    if (!existe.rowCount) {
      const filas = await cargar();
      for (const fila of filas) {
        if (!fila.valores[0] || !fila.valores[1] || !Number.isFinite(Number(fila.valores[1])) ||
            !["cola", "activo"].includes(fila.valores[5])) throw new Error("Cola histórica inválida; migración cancelada.");
        await db.query("INSERT INTO wobi_mail_queue_rows(namespace,data) VALUES($1,$2)", [espacio, JSON.stringify(fila.valores)]);
      }
      const copia = await db.query("SELECT data FROM wobi_mail_queue_rows WHERE namespace=$1 ORDER BY id", [espacio]);
      if (JSON.stringify(copia.rows.map(r => r.data)) !== JSON.stringify(filas.map(f => f.valores))) {
        throw new Error("Migración de cola incompleta; se conserva la fuente original.");
      }
      await db.query("INSERT INTO wobi_mail_queue_migrations(namespace,rows_imported) VALUES($1,$2)", [espacio, filas.length]);
      console.log(`[correo-cola] Migración PostgreSQL verificada: ${filas.length} filas; respaldo Sheets conservado.`);
    }
    await db.query("COMMIT");
  } catch (e) { await db.query("ROLLBACK"); throw e; }
  finally { db.release(); }
}
let espacioPreparado: string | undefined;
export async function prepararColaPostgres(): Promise<void> {
  if (!hayCoordinacionDurable() || espacioPreparado === namespace()) return;
  // Mismo orden de locks que los lectores/escritores; sin promesa compartida que pueda
  // esperar a un coordinador retenido por quien intenta leer la cola.
  await conCoordinadorCorreo(async () => {
    if (espacioPreparado === namespace()) return;
    await importarColaPostgres(poolAuto(), namespace(), () => sheets.leerFilas(TAB, HEADERS.length, HEADERS));
    espacioPreparado = namespace();
  });
}
function validar(tab: string) { if (tab !== TAB) throw new Error("Storage exclusivo de cola de correo."); }
export async function leerFilas(tab: string, cols: number, headers: string[]): Promise<sheets.FilaCruda[]> {
  validar(tab);
  if (!hayCoordinacionDurable()) return sheets.leerFilas(tab, cols, headers);
  await prepararColaPostgres();
  const r = await poolAuto().query("SELECT id,data FROM wobi_mail_queue_rows WHERE namespace=$1 ORDER BY id", [namespace()]);
  return r.rows.map(r => ({ rowIndex: Number(r.id), valores: r.data as string[] }));
}
export async function agregarFila(tab: string, cols: number, headers: string[], valores: (string | number)[]): Promise<number> {
  validar(tab);
  if (!hayCoordinacionDurable()) return sheets.agregarFila(tab, cols, headers, valores);
  await prepararColaPostgres();
  const r = await poolAuto().query("INSERT INTO wobi_mail_queue_rows(namespace,data) VALUES($1,$2) RETURNING id", [namespace(), JSON.stringify(valores.map(String))]);
  return Number(r.rows[0].id);
}
export async function actualizarFila(tab: string, id: number, cols: number, valores: (string | number)[]): Promise<void> {
  validar(tab);
  if (!hayCoordinacionDurable()) return sheets.actualizarFila(tab, id, cols, valores);
  await prepararColaPostgres();
  const r = await poolAuto().query("UPDATE wobi_mail_queue_rows SET data=$3 WHERE namespace=$1 AND id=$2", [namespace(), id, JSON.stringify(valores.map(String))]);
  if (r.rowCount !== 1) throw new Error("La entrada de cola ya no existe; no se modifica otro correo.");
}
export async function eliminarFila(tab: string, id: number, headers: string[]): Promise<void> {
  validar(tab);
  if (!hayCoordinacionDurable()) return sheets.eliminarFila(tab, id, headers);
  await prepararColaPostgres();
  await poolAuto().query("DELETE FROM wobi_mail_queue_rows WHERE namespace=$1 AND id=$2", [namespace(), id]);
}
