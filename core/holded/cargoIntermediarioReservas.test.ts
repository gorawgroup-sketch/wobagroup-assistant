import assert from "node:assert/strict";
import test from "node:test";
import { esCargoDeIntermediarioDeReservas, movimientoCompatibleConGasto } from "./write";
import { evaluarCargoMayor } from "./cargoMayor";

/**
 * Caso real 2026-10-14 (Footprint): dos facturas de Queen Home Apartments (158,92 y 92,52 €) pagadas con UN cargo «Hotel At Booking.com» de
 * 251,44 €. El buscador de cargo mayor exigía el nombre del emisor en el banco y no lo ofrecía.
 */
test("un alojamiento pagado por una plataforma de reservas reconoce el cargo de la plataforma", () => {
  for (const cargo of ["Hotel At Booking.com", "Bkg*hotel At Booking.c", "AIRBNB * HM1234", "Expedia 7788", "Hotels.com", "Agoda Company"]) {
    assert.equal(esCargoDeIntermediarioDeReservas("Delia Stabile (Queen Apartments, vía Italianway S.p.A.)", "Hospedaje Queen Home Cinzia — Venecia — 2 noches", cargo), true, cargo);
  }
});

test("no es intermediario si el gasto no es un alojamiento o el cargo no es de una plataforma", () => {
  assert.equal(esCargoDeIntermediarioDeReservas("Uber", "Traslado Uber — Madrid", "Hotel At Booking.com"), false);
  assert.equal(esCargoDeIntermediarioDeReservas("Queen Home Apartments", "Hospedaje 2 noches", "Mercadona Madrid"), false);
  assert.equal(esCargoDeIntermediarioDeReservas("Queen Home Apartments", "Hospedaje 2 noches", "Flights By Booking.com"), true, "la plataforma sola no distingue vuelos de hoteles: el filtro de categoría del teclado decide");
});

test("el cargo del caso real cabe como cargo mayor de cada factura y su resto cuadra al segundo enlace", () => {
  const cargo = { amount: -251.44, reconciled_amount: 0 };
  assert.ok(evaluarCargoMayor(cargo, 92.52, 36.9));
  const trasPrimera = { amount: -251.44, reconciled_amount: -92.52 };
  const segunda = evaluarCargoMayor(trasPrimera, 158.92, 36.9);
  assert.ok(segunda); assert.equal(segunda?.restoTrasConciliar, 0);
});

test("el teclado acepta el cargo de la plataforma para ese alojamiento (misma categoría)", () => {
  assert.equal(movimientoCompatibleConGasto("Delia Stabile (Queen Apartments, vía Italianway S.p.A.)", "Hospedaje Queen Home Cinzia — Venecia — 2 noches", "Hotel At Booking.com", { nucleoDeMarca: true }), true);
});
