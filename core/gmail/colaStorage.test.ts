import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { importarColaPostgres } from "./colaStorage";
import { cerrarPoolAuto, SCHEMA_AUTO } from "./automatico/postgres";

// Base desechable explícita: nunca usa credenciales de producción.
const url = process.env.WOBI_TEST_DATABASE_URL;
test("cola PostgreSQL: importación concurrente exacta, una sola lectura y rollback recuperable", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  const espacio = `test-cola-${randomUUID()}`;
  const filas = [{ rowIndex: 2, valores: ["thread", "123", "José", "Factura", "2026-09-21", "activo", "1", "2026-09-21", "message", '["acción-resuelta"]'] }];
  let lecturas = 0;
  try {
    await pool.query(SCHEMA_AUTO);
    const cargar = async () => { lecturas++; return filas; };
    await Promise.all([importarColaPostgres(pool, espacio, cargar), importarColaPostgres(pool, espacio, cargar)]);
    assert.equal(lecturas, 1);
    const r = await pool.query("SELECT id,data FROM wobi_mail_queue_rows WHERE namespace=$1", [espacio]);
    assert.deepEqual(r.rows.map(r => r.data), filas.map(f => f.valores));
    // Una nueva instancia no lee Sheets ni repone entradas ya eliminadas.
    await pool.query("DELETE FROM wobi_mail_queue_rows WHERE namespace=$1", [espacio]);
    await importarColaPostgres(pool, espacio, async () => { throw new Error("Sheets no disponible"); });
    assert.equal((await pool.query("SELECT 1 FROM wobi_mail_queue_rows WHERE namespace=$1", [espacio])).rowCount, 0);
    // Fallar a mitad del lote no deja importaciones parciales ni marca migración completa.
    await assert.rejects(importarColaPostgres(pool, espacio + "-fallo", async () => [...filas, { rowIndex: 3, valores: ["invalida"] }]), /inválida/);
    assert.equal((await pool.query("SELECT 1 FROM wobi_mail_queue_rows WHERE namespace=$1", [espacio + "-fallo"])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM wobi_mail_queue_migrations WHERE namespace=$1", [espacio + "-fallo"])).rowCount, 0);
    await importarColaPostgres(pool, espacio + "-fallo", cargar);
    assert.equal((await pool.query("SELECT 1 FROM wobi_mail_queue_rows WHERE namespace=$1", [espacio + "-fallo"])).rowCount, 1);
  } finally {
    await pool.query("DELETE FROM wobi_mail_queue_rows WHERE namespace=ANY($1)", [[espacio, espacio + "-fallo"]]);
    await pool.query("DELETE FROM wobi_mail_queue_migrations WHERE namespace=ANY($1)", [[espacio, espacio + "-fallo"]]);
    await pool.end();
  }
});


test("cola real: callbacks concurrentes resuelven una sola vez y no eliminan otro mensaje", { skip: !url }, async () => {
  const { encolarCorreos, iniciarSiguienteActivo, establecerPendientesActivo,
    resolverUnoActivo, obtenerActivoActual, confirmarActivoResueltoTrasMarcarLeido } = await import("./colaRevisionStore");
  const pool = new Pool({ connectionString: url });
  const previo = { db: process.env.WOBI_MAIL_DATABASE_URL, sheet: process.env.CASHFLOW_SHEET_ID };
  process.env.WOBI_MAIL_DATABASE_URL = url;
  process.env.CASHFLOW_SHEET_ID = `test-${randomUUID()}`;
  const espacio = `${process.env.CASHFLOW_SHEET_ID}:_cola_revision_correo`;
  try {
    await pool.query(SCHEMA_AUTO);
    await importarColaPostgres(pool, espacio, async () => []);
    await encolarCorreos(123, [
      { id: "a", mensajeId: "ma", de: "A", asunto: "Uno", fechaOrden: 1 },
      { id: "b", mensajeId: "mb", de: "B", asunto: "Dos", fechaOrden: 2 },
    ]);
    assert.equal((await iniciarSiguienteActivo(123))?.mensajeId, "ma");
    const identidad = { threadId: "a", mensajeId: "ma" };
    await establecerPendientesActivo(123, identidad, 2);
    await Promise.all([resolverUnoActivo(123, identidad, "misma"), resolverUnoActivo(123, identidad, "misma")]);
    assert.equal((await obtenerActivoActual(123))?.pendientesRestantes, 1);
    await resolverUnoActivo(123, identidad, "otra");
    assert.equal(await confirmarActivoResueltoTrasMarcarLeido(123, { threadId: "b", mensajeId: "mb" }), false);
    assert.equal(await confirmarActivoResueltoTrasMarcarLeido(123, identidad), true);
    assert.equal((await iniciarSiguienteActivo(123))?.mensajeId, "mb");
  } finally {
    await cerrarPoolAuto();
    if (previo.db === undefined) delete process.env.WOBI_MAIL_DATABASE_URL; else process.env.WOBI_MAIL_DATABASE_URL = previo.db;
    if (previo.sheet === undefined) delete process.env.CASHFLOW_SHEET_ID; else process.env.CASHFLOW_SHEET_ID = previo.sheet;
    await pool.query("DELETE FROM wobi_mail_queue_rows WHERE namespace=$1", [espacio]);
    await pool.query("DELETE FROM wobi_mail_queue_migrations WHERE namespace=$1", [espacio]);
    await pool.end();
  }
});
