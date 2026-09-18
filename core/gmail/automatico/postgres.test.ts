import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { PostgresAutoStore, SCHEMA_AUTO, conBloqueoAuto, conOperacionAuto, protegerEscrituraHolded, cerrarPoolAuto } from "./postgres";
import { evaluarAuto } from "./model";
import { analisisFixture, configFixture, correoFixture, evidenciaFixture, reciboFixture } from "./fixtures";

// Base de pruebas desechable; jamás toma WOBI_MAIL_DATABASE_URL ni DATABASE_URL de producción.
const url = process.env.WOBI_MAIL_TEST_DATABASE_URL;
test("PostgreSQL: reservas concurrentes, reinicio, auditoría y bloqueo de rutas manuales", { skip: !url }, async () => {
  process.env.WOBI_MAIL_DATABASE_URL = url;
  const db = new Pool({ connectionString: url });
  try {
    await db.query(SCHEMA_AUTO);
    await db.query("TRUNCATE wobi_mail_analyses,wobi_mail_events,wobi_mail_claims,wobi_mail_operations RESTART IDENTITY CASCADE");
    await new PostgresAutoStore(db).guardarAnalisis(configFixture.buzon, "m1", "huella", "v1", analisisFixture());
    assert.equal((await new PostgresAutoStore(db).buscarAnalisis(configFixture.buzon, "m1", "huella", "v1"))?.resumen, "Recibo");
    const decision = evaluarAuto(correoFixture(), analisisFixture(), reciboFixture(), evidenciaFixture(), configFixture);
    assert.ok(decision.apto);
    const a = new PostgresAutoStore(db), b = new PostgresAutoStore(db);
    const resultados = await Promise.allSettled([a.reservar(decision.plan), b.reservar(decision.plan)]);
    assert.ok(resultados.some(r => r.status === "fulfilled"));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM wobi_mail_operations")).rows[0].n, 1);
    const op = (await b.pendientes(configFixture.buzon))[0];
    assert.ok(op);
    await assert.rejects(() => protegerEscrituraHolded("WOBA", async () => "POST"), /reservado/);
    assert.equal(await conOperacionAuto(op.id, () => protegerEscrituraHolded("WOBA", async () => "propia")), "propia");
    op.estado = "creando"; await a.guardar(op);
    assert.equal((await new PostgresAutoStore(db).pendientes(configFixture.buzon))[0].estado, "creando");
    const orden: number[] = [];
    let avisar!: () => void;
    const dentro = new Promise<void>(r => { avisar = r; });
    const primera = conBloqueoAuto("test-exclusion", async () => { orden.push(1); avisar(); await new Promise(r => setTimeout(r, 30)); orden.push(2); });
    await dentro;
    await Promise.all([primera, conBloqueoAuto("test-exclusion", async () => { orden.push(3); })]);
    assert.deepEqual(orden, [1, 2, 3]);
    const copiaAntigua = structuredClone(op);
    op.estado = "completada"; op.compraId = "c"; await b.guardar(op);
    await assert.rejects(() => a.guardar(copiaAntigua), /otra ejecución/);
    await assert.rejects(() => protegerEscrituraHolded("WOBA", async () => "POST", { path: "/treasury/accounts/a1/bank-movements/b1/reconcile" }), /ya fue completada/);
    assert.equal((await a.buscarFuente(configFixture.buzon, "m1", "cuerpo"))?.compraId, "c");
    const otro = { ...decision.plan, correo: { ...decision.plan.correo, id: "reenviado" } };
    await assert.rejects(() => b.reservar(otro), /duplicado/);
    assert.ok((await db.query("SELECT count(*)::int AS n FROM wobi_mail_events")).rows[0].n >= 3);
  } finally { await db.end(); await cerrarPoolAuto(); delete process.env.WOBI_MAIL_DATABASE_URL; }
});
