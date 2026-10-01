import assert from "node:assert/strict";
import test from "node:test";
import { contextoCorreoCargoMayor, describirCargoMayor, elegirCargosMayores, evaluarCargoMayor, notaCargosMayores, restoLibreMovimiento } from "./cargoMayor";

// Caso real (Footprint, 2026-10-01): comprobante de Go Rent A Car por 354,62 USD; el banco descontó 744,87 USD el 25/09.
const cargoGoRent = { amount: "-744.87", reconciled_amount: "0.00" };
const margen = (monto: number) => Math.max(1, monto * 0.15);

test("un cargo claramente mayor que el gasto se ofrece y deja el resto pendiente", () => {
  assert.deepEqual(evaluarCargoMayor(cargoGoRent, 354.62, margen(354.62)), { resto: 744.87, restoTrasConciliar: 390.25 });
});

test("el segundo gasto encuentra el resto de un cargo ya conciliado en parte", () => {
  const parcial = { amount: "-744.87", reconciled_amount: "354.62" };
  assert.equal(restoLibreMovimiento(parcial), 390.25);
  assert.deepEqual(evaluarCargoMayor(parcial, 390.25, margen(390.25)), { resto: 390.25, restoTrasConciliar: 0 });
});

test("un gasto que no cabe en lo que queda libre no se ofrece", () => {
  assert.equal(evaluarCargoMayor({ amount: "-744.87", reconciled_amount: "354.62" }, 500, margen(500)), undefined);
  assert.equal(evaluarCargoMayor({ amount: "-100.00", reconciled_amount: "0" }, 354.62, margen(354.62)), undefined);
});

test("un cargo intacto de importe casi igual no es «mayor»: lo resuelven la búsqueda exacta y la aproximada", () => {
  assert.equal(evaluarCargoMayor({ amount: "-354.62", reconciled_amount: "0" }, 354.62, margen(354.62)), undefined);
  assert.equal(evaluarCargoMayor({ amount: "-380.00", reconciled_amount: "0" }, 354.62, margen(354.62)), undefined);
});

test("un ingreso o una devolución nunca paga un gasto", () => {
  assert.equal(evaluarCargoMayor({ amount: "744.87", reconciled_amount: "0" }, 354.62, margen(354.62)), undefined);
});

test("la propuesta nombra el cargo, lo que quedaría pendiente y cómo preguntar por la diferencia", () => {
  const cargo = { descripcion: "Go Rent A Car", monto: -744.87, moneda: "USD", fecha: "2026-09-25", restoDisponible: 744.87 };
  assert.match(describirCargoMayor(cargo, 354.62, 0), /1\. "Go Rent A Car" — -744\.87 USD \(2026-09-25\); .*quedarían 390\.25 USD/);
  const nota = notaCargosMayores([cargo], { monto: 354.62, moneda: "USD", proveedor: "Go Rent A Car" }, { hayCorreoOrigen: true });
  assert.match(nota, /un cargo MAYOR de "Go Rent A Car"/);
  assert.match(nota, /Conciliar con #N/);
  assert.match(nota, /Responder correo/);
  assert.match(contextoCorreoCargoMayor(cargo, 354.62), /744\.87 USD del 2026-09-25.*390\.25 USD sin justificar/);
  assert.equal(notaCargosMayores([], { monto: 1, moneda: "USD", proveedor: "x" }, { hayCorreoOrigen: false }), "");
});

test("al describir un cargo ya usado en parte se dice cuánto tiene conciliado y que quedaría completo", () => {
  const cargo = { descripcion: "Go Rent A Car", monto: -744.87, moneda: "USD", fecha: "2026-09-25", restoDisponible: 390.25 };
  const linea = describirCargoMayor(cargo, 390.25, 0);
  assert.match(linea, /ya tiene 354\.62 USD conciliados con otro gasto/);
  assert.match(linea, /quedaría conciliado por completo/);
});

test("varios cargos mayores intactos de un proveedor frecuente no se ofrecen (caso real Uber: tres viajes distintos)", () => {
  const uber = [-8.32, -10.55, -15.35].map((monto) => ({ monto, restoDisponible: Math.abs(monto) }));
  assert.deepEqual(elegirCargosMayores(uber), []);
  assert.deepEqual(elegirCargosMayores([{ monto: -744.87, restoDisponible: 744.87 }]).length, 1);
});

test("un cargo que ya espera su resto se ofrece aunque haya otros cargos mayores intactos", () => {
  const esperando = { monto: -744.87, restoDisponible: 390.25 };
  assert.deepEqual(elegirCargosMayores([{ monto: -900, restoDisponible: 900 }, esperando, { monto: -500, restoDisponible: 500 }]), [esperando]);
});
