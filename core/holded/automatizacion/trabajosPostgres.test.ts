import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { cerrarPoolAuto, poolAuto, SCHEMA_AUTO } from "../../gmail/automatico/postgres";
import { AlmacenTrabajosPostgres, nuevoTrabajo } from "./trabajos";

// Base desechable explícita: nunca usa credenciales de producción.
const url = process.env.WOBI_TEST_DATABASE_URL;
test("almacén PostgreSQL: upsert idempotente, filtros, eventos y exclusión entre ejecuciones simultáneas", { skip: !url }, async () => {
  process.env.WOBI_MAIL_DATABASE_URL = url;
  const almacen = new AlmacenTrabajosPostgres();
  const clave = `test:${randomUUID()}`;
  try {
    await poolAuto().query(SCHEMA_AUTO);
    const t = nuevoTrabajo({ clave, tipo: "ticket", empresa: "Footprint", objetivo: "c1" }, Date.now());
    await almacen.guardar(t);
    await almacen.guardar({ ...t, estado: "completado", intentos: 1 });
    assert.equal((await almacen.obtener(clave))?.estado, "completado");
    assert.equal((await almacen.listar({ tipo: "ticket", estados: ["completado"], empresa: "Footprint" })).filter((x) => x.clave === clave).length, 1);
    assert.equal((await almacen.listar({ tipo: "sync_bancaria" })).filter((x) => x.clave === clave).length, 0);
    await almacen.evento(clave, "x", { a: 1 });
    assert.equal((await almacen.eventos(clave)).length, 1);
    let dentro = 0, maxDentro = 0;
    const tarea = async () => { dentro++; maxDentro = Math.max(maxDentro, dentro); await new Promise((r) => setTimeout(r, 150)); dentro--; return "hecho"; };
    const [a, b] = await Promise.all([almacen.conExclusion(clave, tarea), almacen.conExclusion(clave, tarea)]);
    assert.deepEqual([a, b].sort(), ["hecho", "ocupado"]);
    assert.equal(maxDentro, 1);
  } finally {
    await poolAuto().query("DELETE FROM wobi_holded_job_events WHERE key=$1", [clave]).catch(() => undefined);
    await poolAuto().query("DELETE FROM wobi_holded_jobs WHERE key=$1", [clave]).catch(() => undefined);
    await cerrarPoolAuto();
  }
});
