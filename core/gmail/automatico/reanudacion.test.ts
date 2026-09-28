import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import {
  decidirReanudacion,
  instanciaActual,
  MAX_EDAD_REANUDACION_MS,
  MAX_REANUDACIONES_ENCADENADAS,
  type ReanudacionRevisionCorreo,
} from "./reanudacion";
import { SCHEMA_AUTO, cerrarPoolAuto } from "./postgres";

const registro = (parcial: Partial<ReanudacionRevisionCorreo> = {}): ReanudacionRevisionCorreo => ({
  chatId: 8731933107, interrumpidaEn: 1_000_000, reanudaciones: 0, progreso: "⏳ Mensajes analizados: 39/50.", ...parcial,
});

test("una reanudación reciente y no encadenada se retoma", () => {
  assert.equal(decidirReanudacion(registro(), 1_000_000 + 60_000).accion, "reanudar");
  assert.equal(decidirReanudacion(registro({ reanudaciones: MAX_REANUDACIONES_ENCADENADAS - 1 }), 1_000_000 + 60_000).accion, "reanudar");
});

test("una reanudación más antigua que el máximo caduca sin relanzar nada", () => {
  assert.equal(decidirReanudacion(registro(), 1_000_000 + MAX_EDAD_REANUDACION_MS + 1).accion, "caducada");
});

test("tras el máximo de reanudaciones encadenadas se avisa y no se relanza", () => {
  assert.equal(decidirReanudacion(registro({ reanudaciones: MAX_REANUDACIONES_ENCADENADAS }), 1_000_000 + 1).accion, "demasiadas");
});

test("la identidad del proceso prefiere la réplica de Railway y nunca queda vacía", () => {
  assert.equal(instanciaActual({ RAILWAY_REPLICA_ID: "rep-1", RAILWAY_DEPLOYMENT_ID: "dep-1" } as NodeJS.ProcessEnv), "rep-1");
  assert.equal(instanciaActual({ RAILWAY_DEPLOYMENT_ID: "dep-1" } as NodeJS.ProcessEnv), "dep-1");
  assert.match(instanciaActual({} as NodeJS.ProcessEnv), /:\d+$/);
});

// Base de pruebas desechable; jamás toma WOBI_MAIL_DATABASE_URL de producción.
const url = process.env.WOBI_MAIL_TEST_DATABASE_URL;
test("Postgres: en curso con latido fresco no se reclama; latido viejo de otra instancia sí (huérfana); pendiente siempre; cerrar borra", { skip: !url }, async () => {
  const previo = process.env.WOBI_MAIL_DATABASE_URL;
  process.env.WOBI_MAIL_DATABASE_URL = url;
  const pool = new Pool({ connectionString: url });
  const chatId = -Math.floor(Math.random() * 1_000_000_000);
  const mia = (r: { registro: ReanudacionRevisionCorreo }) => r.registro.chatId === chatId;
  try {
    await pool.query(SCHEMA_AUTO);
    const { iniciarRevisionEnCurso, latirRevisionEnCurso, registrarReanudacionPendiente,
      reclamarReanudacionesPendientes, cerrarRegistroRevision } = await import("./reanudacion");

    // En curso en la instancia A con latido fresco: ni A ni B la reclaman.
    await iniciarRevisionEnCurso(registro({ chatId, reanudaciones: 1 }), "A");
    assert.equal((await reclamarReanudacionesPendientes({ instancia: "A" })).filter(mia).length, 0);
    assert.equal((await reclamarReanudacionesPendientes({ instancia: "B" })).filter(mia).length, 0);
    // El latido actualiza el progreso sin cambiar el estado.
    await latirRevisionEnCurso(chatId, "⏳ Candidatos verificados: 8/30.");
    // Latido viejo: la propia instancia A sigue sin reclamarla; B sí, y la recibe como huérfana con el progreso del latido.
    await pool.query("UPDATE wobi_mail_resume SET heartbeat_at = now() - interval '5 minutes' WHERE chat_id=$1", [chatId]);
    assert.equal((await reclamarReanudacionesPendientes({ instancia: "A" })).filter(mia).length, 0);
    const huerfanas = (await reclamarReanudacionesPendientes({ instancia: "B" })).filter(mia);
    assert.equal(huerfanas.length, 1);
    assert.equal(huerfanas[0].huerfana, true);
    assert.equal(huerfanas[0].registro.reanudaciones, 1);
    assert.equal(huerfanas[0].registro.progreso, "⏳ Candidatos verificados: 8/30.");
    assert.ok(Date.now() - huerfanas[0].registro.interrumpidaEn > 4 * 60_000); // interrumpidaEn = último latido
    assert.equal((await reclamarReanudacionesPendientes({ instancia: "B" })).filter(mia).length, 0);

    // Un latido tardío de A tras el reclamo no resucita nada (la fila ya no existe).
    await latirRevisionEnCurso(chatId, "⏳ tarde");
    assert.equal((await pool.query("SELECT 1 FROM wobi_mail_resume WHERE chat_id=$1", [chatId])).rowCount, 0);

    // Pendiente (SIGTERM) sobre una fila en curso: la reclama cualquiera, también la misma instancia, y es idempotente.
    await iniciarRevisionEnCurso(registro({ chatId, reanudaciones: 0 }), "A");
    await registrarReanudacionPendiente(registro({ chatId, reanudaciones: 2 }));
    await latirRevisionEnCurso(chatId, "⏳ no debe tocar una pendiente");
    const pendientes = (await reclamarReanudacionesPendientes({ instancia: "A" })).filter(mia);
    assert.equal(pendientes.length, 1);
    assert.equal(pendientes[0].huerfana, false);
    assert.equal(pendientes[0].registro.reanudaciones, 2);
    assert.equal(pendientes[0].registro.progreso, "⏳ Mensajes analizados: 39/50.");

    // Cerrar borra sea cual sea el estado.
    await iniciarRevisionEnCurso(registro({ chatId }), "A");
    await cerrarRegistroRevision(chatId);
    assert.equal((await pool.query("SELECT 1 FROM wobi_mail_resume WHERE chat_id=$1", [chatId])).rowCount, 0);
  } finally {
    await cerrarPoolAuto();
    if (previo === undefined) delete process.env.WOBI_MAIL_DATABASE_URL; else process.env.WOBI_MAIL_DATABASE_URL = previo;
    await pool.query("DELETE FROM wobi_mail_resume WHERE chat_id=$1", [chatId]);
    await pool.end();
  }
});
