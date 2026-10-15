import assert from "node:assert/strict";
import test from "node:test";
import { emparejarCargo, localizarMovimientosDeclarados, type MovimientoBanco } from "./localizarCargos";
import type { CargoDeclarado } from "./declaracionStore";

const c = (lugar: string, valor: number, fecha: string, moneda = "EUR"): CargoDeclarado => ({ id: lugar, fecha, lugar, valor, moneda });
const m = (id: string, descripcion: string, importe: number, fecha: string, extra: Partial<MovimientoBanco> = {}): MovimientoBanco =>
  ({ accountId: "acc", cuenta: "Euros EWKS", movementId: id, fecha, descripcion, importe, moneda: "EUR", estado: "pending", conciliado: 0, ...extra });

// Caso real German: la declaración dice 07/09 y el banco 06/09 (fecha de cargo vs. liquidación).
test("empareja por importe exacto y fecha cercana; desempata por el nombre del comercio; nunca elige entre iguales", () => {
  const banco = [m("a", "Avolta Aams K Comunal", -31.25, "2026-09-06"), m("b", "Airalo", -9, "2026-09-06"), m("c", "Rosso Brera", -80, "2026-09-07"), m("d", "Rist Pizz Tovo", -47.4, "2026-09-12"),
    m("e", "Otro comercio", -9, "2026-09-06"), m("x", "Abono", 9, "2026-09-06")];
  assert.equal(emparejarCargo(c("Avolta Aams K Comunal 220", 31.25, "2026-09-07"), banco).movimiento?.movementId, "a");
  assert.equal(emparejarCargo(c("Airalo", 9, "2026-09-07"), banco).movimiento?.movementId, "b", "dos de 9 € el mismo día: gana el que nombra el comercio");
  assert.equal(emparejarCargo(c("Rist Pizz Tovo", 47.4, "2026-09-13"), banco).movimiento?.movementId, "d");
  assert.equal(emparejarCargo(c("Rosso Brera", 80, "2026-09-20"), banco).situacion, "no_encontrado", "más de 3 días: no vale");
  assert.equal(emparejarCargo(c("Desconocido", 9, "2026-09-07"), banco).situacion, "ambiguo", "dos de 9 € y ninguno nombra el comercio");
  assert.equal(emparejarCargo(c("Rosso Brera", 80, "2026-09-07"), [m("c", "Rosso Brera", -80, "2026-09-07", { estado: "reconciled", conciliado: 80 })]).situacion, "ya_conciliado");
  assert.equal(emparejarCargo(c("Uber", 9, "2026-09-07", "USD"), banco).situacion, "no_encontrado", "otra moneda no se mezcla");
});

test("lee el banco una vez por moneda con la ventana que cubre todos los cargos", async () => {
  const lecturas: string[] = [];
  const r = await localizarMovimientosDeclarados("EWORKS" as never, [c("Airalo", 9, "2026-09-07"), c("Rist Pizz Tovo", 47.4, "2026-09-13")], {
    movimientos: async (_e, moneda, desde, hasta) => { lecturas.push(`${moneda} ${desde}..${hasta}`); return [m("b", "Airalo", -9, "2026-09-06"), m("d", "Rist Pizz Tovo", -47.4, "2026-09-12")]; },
  });
  assert.deepEqual(lecturas, ["EUR 2026-09-04..2026-09-16"]);
  assert.deepEqual(r.map((x) => x.movimiento?.movementId), ["b", "d"]);
});
