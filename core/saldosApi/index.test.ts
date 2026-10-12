import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluarSaldo, validarObservacion } from "./index";
const ahora = new Date("2026-10-12T20:00:00Z");
const o = { proveedor: "openai" as const, saldoUSD: 9.99, verificadoEn: "2026-10-12T19:00:00Z", umbralUSD: 5 };
test("consumo cruza el umbral antes de agotar la cuenta", () => {
 assert.equal(evaluarSaldo("openai", o, 5, ahora).estado, "bajo");
 assert.equal(evaluarSaldo("openai", o, 9, ahora).estado, "critico");
 assert.equal(evaluarSaldo("openai", o, 11, ahora).estimadoUSD, 0);
});
test("lectura ausente, antigua o consumo fallido no demuestra saldo normal ni cero", () => {
 assert.equal(evaluarSaldo("anthropic", null, null, ahora).estimadoUSD, null);
 assert.equal(evaluarSaldo("openai", o, null, ahora).estado, "verificar");
 assert.equal(evaluarSaldo("openai", {...o, verificadoEn: "2026-10-10T19:00:00Z"}, 0, ahora).estado, "verificar");
 assert.equal(evaluarSaldo("openai", o, 0, ahora).estado, "normal");
});
test("no acepta importes vacíos, negativos, infinitos ni fechas futuras", () => {
 for (const delta of [{saldoUSD: ""}, {saldoUSD: -1}, {saldoUSD: Infinity}, {umbralUSD: 0}, {proveedor: "otro"}, {verificadoEn: "2027-01-01"}]) assert.throws(() => validarObservacion({...o,...delta}, ahora));
 assert.equal(validarObservacion({...o, saldoUSD: 0}, ahora).saldoUSD, 0);
});
