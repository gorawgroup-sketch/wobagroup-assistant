import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import {
  decidirReanudacion,
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

// Base de pruebas desechable; jamás toma WOBI_MAIL_DATABASE_URL de producción.
const url = process.env.WOBI_MAIL_TEST_DATABASE_URL;
test("Postgres: registrar es idempotente por chat y reclamar deja la tabla vacía para el siguiente proceso", { skip: !url }, async () => {
  const previo = process.env.WOBI_MAIL_DATABASE_URL;
  process.env.WOBI_MAIL_DATABASE_URL = url;
  const pool = new Pool({ connectionString: url });
  const chatId = -Math.floor(Math.random() * 1_000_000_000);
  try {
    await pool.query(SCHEMA_AUTO);
    const { registrarReanudacionPendiente, reclamarReanudacionesPendientes, cancelarReanudacionPendiente } = await import("./reanudacion");
    await registrarReanudacionPendiente(registro({ chatId, reanudaciones: 0 }));
    await registrarReanudacionPendiente(registro({ chatId, reanudaciones: 1 }));
    const reclamadas = (await reclamarReanudacionesPendientes()).filter(r => r.chatId === chatId);
    assert.equal(reclamadas.length, 1);
    assert.equal(reclamadas[0].reanudaciones, 1);
    assert.equal((await reclamarReanudacionesPendientes()).filter(r => r.chatId === chatId).length, 0);
    await registrarReanudacionPendiente(registro({ chatId }));
    await cancelarReanudacionPendiente(chatId);
    assert.equal((await reclamarReanudacionesPendientes()).filter(r => r.chatId === chatId).length, 0);
  } finally {
    await cerrarPoolAuto();
    if (previo === undefined) delete process.env.WOBI_MAIL_DATABASE_URL; else process.env.WOBI_MAIL_DATABASE_URL = previo;
    await pool.query("DELETE FROM wobi_mail_resume WHERE chat_id=$1", [chatId]);
    await pool.end();
  }
});
