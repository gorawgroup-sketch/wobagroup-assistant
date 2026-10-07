import assert from "node:assert/strict";
import test from "node:test";
import { esAccionSensible } from "../telegram/authorizedUsersSheet";
import { textoPropuestaGasto, textoPropuestaPar } from "./conciliarSinSoporte";

test("el cierre de cargo + reembolso dice qué cambia y que no se crea gasto", () => {
  const t = textoPropuestaPar("Footprint", { motivo: "reembolso total confirmado por Alejandro", descripcion: "Rappi* Verif", importe: 0.83, moneda: "USD", movimientos: [{ cuentaId: "c", movimientoId: "a", fecha: "2026-09-04" }, { cuentaId: "c", movimientoId: "b", fecha: "2026-09-05" }] });
  assert.match(t, /Cerrar cargo \+ reembolso sin gasto — Footprint/);
  assert.match(t, /0,83 USD de salida \(04\/09\/2026\) y 0,83 USD de entrada \(05\/09\/2026\)\. Suman cero/);
  assert.match(t, /Antes: los dos movimientos están pendientes/);
  assert.match(t, /No se crea gasto ni asiento: el efecto contable neto es cero/);
});

test("el gasto sin soporte dice proveedor, cuenta, etiquetas, que va SIN adjunto y que sí queda en la contabilidad", () => {
  const t = textoPropuestaGasto("Footprint", { motivo: "el recibo no existe", descripcion: "Payu*uber", importe: 7.37, moneda: "EUR", concepto: "Traslado Uber — Alejandro Florez — 23 sep 2026", movimiento: { cuentaId: "c", movimientoId: "m", fecha: "2026-09-23" }, plantilla: { compraId: "g", contactId: "k", proveedor: "Uber", cuentaId: "a", tags: ["alejandroflorez", "taxi", "transporte"] } }, "2026-09-23");
  assert.match(t, /Crear gasto SIN soporte y conciliarlo — Footprint/);
  assert.match(t, /Cargo: Payu\*uber · 7,37 EUR · 23\/09\/2026/);
  assert.match(t, /Antes: el cargo está pendiente de conciliar en Holded y no hay gasto/);
  assert.match(t, /SIN adjunto, con el proveedor Uber/);
  assert.match(t, /alejandroflorez, taxi, transporte/);
  assert.match(t, /«Traslado Uber — Alejandro Florez — 23 sep 2026 — SIN SOPORTE»/);
  assert.match(t, /Queda en la contabilidad/);
});

test("los botones son de superadmin y caben en el callback de Telegram", () => {
  assert.equal(esAccionSensible("sinsop_ok:ab12cd34"), true);
  assert.equal(esAccionSensible("sinsop_no:ab12cd34"), true);
  assert.ok(Buffer.byteLength("sinsop_ok:ab12cd34") <= 64);
});
