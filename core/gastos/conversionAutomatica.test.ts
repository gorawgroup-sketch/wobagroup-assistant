import test from "node:test";
import assert from "node:assert/strict";
import { convertirATasa, mejorCargoPorCercania, monedaDestinoPreferida, type CargoCandidato } from "./conversionAutomatica";

const c = (id: string, monto: number, fecha: string, ref = 6.43): CargoCandidato & { id: string } => ({ id, monto, fecha, montoReferencia: ref });

test("caso Taxi 129,94 MXN: de cinco cargos, el del mismo día que coincide con la conversión", () => {
  const cargos = [c("a", -6.43, "2026-10-06"), c("p1", -6.34, "2026-10-07"), c("b", -5.99, "2026-10-06"), c("d", -5.94, "2026-10-06"), c("p2", -5.65, "2026-10-07")];
  assert.equal(mejorCargoPorCercania(cargos, "2026-10-06")?.id, "a");
});

test("caso Taxi 119,95 MXN (5,93 €): el más cercano al importe entre los del mismo día", () => {
  const cargos = [c("a", -5.94, "2026-10-06", 5.93), c("b", -5.99, "2026-10-06", 5.93), c("p", -5.65, "2026-10-07", 5.93), c("x", -6.43, "2026-10-06", 5.93)];
  assert.equal(mejorCargoPorCercania(cargos, "2026-10-06")?.id, "a");
});

test("dos cargos igual de cercanos (mismo día, misma distancia) no se adivinan", () => {
  assert.equal(mejorCargoPorCercania([c("a", -6.43, "2026-10-06"), c("b", -6.43, "2026-10-06")], "2026-10-06"), undefined);
});

test("fuera de ±1 día o a más del 8 % de la conversión no cuenta", () => {
  assert.equal(mejorCargoPorCercania([c("lejos", -6.43, "2026-10-09")], "2026-10-06"), undefined);
  assert.equal(mejorCargoPorCercania([c("caro", -9.0, "2026-10-06")], "2026-10-06"), undefined);
  assert.equal(mejorCargoPorCercania([{ monto: -6.43, fecha: "2026-10-06" }], "2026-10-06"), undefined);
});

test("el mismo día gana a otro día aunque este último coincida más al céntimo", () => {
  const r = mejorCargoPorCercania([c("hoy", -6.5, "2026-10-06"), c("ayer", -6.43, "2026-10-05")], "2026-10-06");
  assert.equal((r as { id: string }).id, "hoy");
});

test("moneda destino: EUR si existe, si no USD, si no la primera", () => {
  assert.equal(monedaDestinoPreferida(["COP", "EUR", "USD"]), "EUR");
  assert.equal(monedaDestinoPreferida(["COP", "USD"]), "USD");
  assert.equal(monedaDestinoPreferida(["cop"]), "COP");
  assert.equal(monedaDestinoPreferida([]), undefined);
});

test("conversión a la tasa del día con dos decimales; sin tasa o datos inválidos, nada", () => {
  assert.equal(convertirATasa(129.94, 0.0495), 6.43);
  assert.equal(convertirATasa(70, 0.0494), 3.46);
  assert.equal(convertirATasa(100, undefined), undefined);
  assert.equal(convertirATasa(100, 0), undefined);
  assert.equal(convertirATasa(0, 0.05), undefined);
});
