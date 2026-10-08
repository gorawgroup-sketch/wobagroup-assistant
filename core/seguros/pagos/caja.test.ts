import assert from "node:assert/strict";
import test from "node:test";
import { evaluarCaja, necesarioEnLaCuenta, resolverCuenta, type CuentaCaja } from "./caja";
import { pago } from "./pruebas";

// Las cuentas REALES de WOBA del 06/10/2026 (nombres y saldos de Holded).
const WOBA: CuentaCaja[] = [
  { nombre: "BBVA ", moneda: "EUR", saldo: 654.81, tipo: "bank" },
  { nombre: "BBVA TC", moneda: "EUR", saldo: -150.04, tipo: "card" },
  { nombre: "Main", moneda: "EUR", saldo: 4097.45, tipo: "bank" },
  { nombre: "Main", moneda: "EUR", saldo: 240.14, tipo: "bank", archivada: true },
  { nombre: "Pocket USD", moneda: "USD", saldo: 0.43, tipo: "bank" },
  { nombre: "PASARELA COMPENSACION PROVEEDOR CLIENTE", moneda: "EUR", saldo: 0, tipo: "gateway" },
];

test("la cuenta se encuentra por su nombre exacto en Holded (sin mayúsculas, espacios ni acentos), activa y de la misma moneda", () => {
  assert.equal((resolverCuenta("bbva", "EUR", WOBA) as { cuenta: CuentaCaja }).cuenta.saldo, 654.81, "«BBVA » con espacio final");
  assert.equal((resolverCuenta("Main", "EUR", WOBA) as { cuenta: CuentaCaja }).cuenta.saldo, 4097.45, "la archivada no cuenta");
  assert.match((resolverCuenta("Qonto", "EUR", WOBA) as { motivo: string }).motivo, /no encuentro en Holded una cuenta activa en EUR llamada «Qonto»/);
  assert.match((resolverCuenta("", "EUR", WOBA) as { motivo: string }).motivo, /no tiene anotada la cuenta de cargo/);
  assert.match((resolverCuenta("Pocket USD", "EUR", WOBA) as { motivo: string }).motivo, /no encuentro/, "otra moneda no vale");
  assert.match((resolverCuenta("Main", "EUR", [...WOBA, { nombre: "main", moneda: "EUR", saldo: 1, tipo: "bank" }]) as { motivo: string }).motivo, /varias cuentas/);
});

test("lo necesario suma los pagos previstos de la misma cuenta desde hoy hasta la fecha del pago, y nada más", () => {
  const cuota = pago();
  const complemento = pago({ id: "c:2027-03-01", polizaId: "complemento", importe: 289.14 });
  const otraCuenta = pago({ id: "x", cuentaDeCargo: "Main", importe: 5000 });
  const otraEmpresa = pago({ id: "y", empresa: "EWORKS", importe: 5000 });
  const posterior = pago({ id: "z", fecha: "2027-03-02", importe: 700 });
  const yaPasado = pago({ id: "w", fecha: "2027-02-20", importe: 700 });
  const pagado = pago({ id: "v", estado: "pagado", importe: 700 });
  assert.equal(necesarioEnLaCuenta(cuota, [cuota, complemento, otraCuenta, otraEmpresa, posterior, yaPasado, pagado], "2027-02-26"), 1244.14);
  assert.equal(necesarioEnLaCuenta(cuota, [cuota], "2027-02-26"), 955);
});

test("el caso real del 01/03/2027: BBVA con 654,81 € no cubre la cuota y el complemento de Allianz (1.244,14 €); dice cuánto falta y de qué otra cuenta hay saldo", () => {
  const cuota = pago();
  const complemento = pago({ id: "c:2027-03-01", polizaId: "complemento", importe: 289.14 });
  const r = evaluarCaja(cuota, [cuota, complemento], WOBA, "2027-02-26");
  assert.equal(r.estado, "no_alcanza");
  if (r.estado !== "no_alcanza") return;
  assert.equal(r.cuenta, "BBVA");
  assert.equal(r.necesario, 1244.14);
  assert.equal(r.faltan, 589.33);
  assert.deepEqual(r.otras, [{ nombre: "Main", saldo: 4097.45 }], "solo cuentas bancarias activas con saldo suficiente; ni la tarjeta, ni la archivada, ni la pasarela");
});

test("si el saldo cubre, lo dice con lo que sobra; el saldo justo también alcanza", () => {
  const p = pago({ importe: 600 });
  const r = evaluarCaja(p, [p], WOBA, "2027-02-26");
  assert.equal(r.estado, "alcanza");
  if (r.estado === "alcanza") { assert.equal(r.sobra, 54.81); assert.equal(r.cuenta, "BBVA"); }
  assert.equal(evaluarCaja(pago({ importe: 654.81 }), [pago({ importe: 654.81 })], WOBA, "2027-02-26").estado, "alcanza");
});

test("un dato dudoso nunca se presenta como «alcanza» ni como «no alcanza»: cuenta no encontrada, saldo ausente o lectura fallida; y un saldo negativo se dice «descubierto»", () => {
  const eworks = pago({ empresa: "EWORKS", cuentaDeCargo: "CAIXA BANK EWORKS", importe: 840.74 });
  const caixa: CuentaCaja[] = [{ nombre: "CAIXA BANK EWORKS", moneda: "EUR", saldo: -20281.34, tipo: "bank" }];
  const negativa = evaluarCaja(eworks, [eworks], caixa, "2027-02-24");
  assert.deepEqual(negativa, { estado: "descubierto", cuenta: "CAIXA BANK EWORKS", saldo: -20281.34, necesario: 840.74 }, "el saldo es cierto (el del banco): se dice tal cual, sin afirmar si alcanza");
  assert.equal(evaluarCaja(eworks, [eworks], [{ nombre: "CAIXA BANK EWORKS", moneda: "EUR", saldo: Number.NaN, tipo: "bank" }], "2027-02-24").estado, "no_comprobable");
  assert.equal(evaluarCaja(eworks, [eworks], WOBA, "2027-02-24").estado, "no_comprobable", "sin cuenta con ese nombre");
  const fallo = evaluarCaja(eworks, [eworks], null, "2027-02-24");
  assert.equal(fallo.estado, "no_comprobable");
  if (fallo.estado === "no_comprobable") { assert.match(fallo.motivo, /no pude leer las cuentas de EWORKS en Holded/); assert.equal(fallo.necesario, 840.74); }
});
