import assert from "node:assert/strict";
import test from "node:test";
import type { MovimientoBancarioCandidato } from "../holded/write";
import {
  obtenerPoliticaMonedaLiquidacion,
  seleccionarMovimientoLiquidacionSeguro,
} from "./monedaLiquidacionProveedor";

function movimiento(
  id: string,
  monto: number,
  fecha = "2026-09-11",
  descripcion = "Anthropic",
  coincideProveedor = descripcion.toLowerCase().includes("anthropic")
): MovimientoBancarioCandidato {
  return {
    accountId: "main",
    movementId: id,
    descripcion,
    monto,
    moneda: "EUR",
    fecha,
    coincideProveedor,
  };
}

test("Anthropic USD se liquida en EUR sin afectar otras monedas o proveedores", () => {
  assert.equal(obtenerPoliticaMonedaLiquidacion("WOBA", "Anthropic, PBC", "USD")?.moneda, "EUR");
  assert.equal(obtenerPoliticaMonedaLiquidacion("Footprint", "ANTHROPIC PBC", "usd")?.moneda, "EUR");
  assert.equal(obtenerPoliticaMonedaLiquidacion("WOBA", "Anthropic, PBC", "EUR"), undefined);
  assert.equal(obtenerPoliticaMonedaLiquidacion("WOBA", "Otro proveedor", "USD"), undefined);
});

test("elige solo el único cargo EUR de Anthropic del mismo día", () => {
  const elegido = seleccionarMovimientoLiquidacionSeguro(
    [movimiento("mov-1", -20.88), movimiento("mov-viejo", -20.86, "2026-09-10")],
    "Anthropic, PBC",
    "2026-09-11",
    "EUR"
  );
  assert.equal(elegido?.movementId, "mov-1");
  assert.equal(Math.abs(elegido?.monto ?? 0), 20.88);
});

test("no decide si hay dos cargos posibles o si el nombre no coincide", () => {
  assert.equal(
    seleccionarMovimientoLiquidacionSeguro(
      [movimiento("a", -20.88), movimiento("b", -20.89)],
      "Anthropic",
      "2026-09-11",
      "EUR"
    ),
    undefined
  );
  assert.equal(
    seleccionarMovimientoLiquidacionSeguro(
      [movimiento("otro", -20.88, "2026-09-11", "Otro comercio")],
      "Anthropic",
      "2026-09-11",
      "EUR"
    ),
    undefined
  );
});
