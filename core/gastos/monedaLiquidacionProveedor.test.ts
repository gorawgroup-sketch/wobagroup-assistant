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

test("elige el único cargo EUR de Anthropic dentro de la ventana de fecha, ignorando uno muy lejano", () => {
  const elegido = seleccionarMovimientoLiquidacionSeguro(
    // Más de 90 días antes de la factura — fuera de la ventana reutilizada (movimientoEnVentanaAuto).
    [movimiento("mov-1", -20.88), movimiento("mov-lejano", -20.86, "2026-05-01")],
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

// Caso real de auditoría (Carlos, WOBA, factura Anthropic de 24,20 USD fechada 2026-09-28, verificado
// en vivo): el único cargo bancario real ("Anthropic", −21,23 EUR) estaba fechado 2026-09-25 — 3 días
// antes que la factura, porque Anthropic ahora factura créditos de uso frecuente con demora respecto
// al cargo real, no solo la suscripción mensual (que sí liquidaba el mismo día). Antes de este fix,
// exigir el mismo día calendario exacto dejaba el gasto indefinidamente "pendiente de comprobación
// bancaria" aunque el cargo real, inequívoco, ya existiera.
test("caso real WOBA/Anthropic: un cargo real 3 días antes de la fecha de la factura ya no se rechaza", () => {
  const elegido = seleccionarMovimientoLiquidacionSeguro(
    [movimiento("mov-real", -21.23, "2026-09-25")],
    "Anthropic, PBC",
    "2026-09-28",
    "EUR"
  );
  assert.equal(elegido?.movementId, "mov-real");
});

test("la ventana reutilizada nunca elige entre dos cargos reales distintos dentro del margen — sigue preguntando", () => {
  // Mismo caso real: si además del cargo del 25 hubiera otro cargo real de Anthropic el 23 (como
  // ocurrió de verdad en el banco de WOBA esa semana), ambos caen dentro del margen — la función debe
  // seguir sin adivinar entre los dos, nunca elegir el más cercano por su cuenta.
  const elegido = seleccionarMovimientoLiquidacionSeguro(
    [movimiento("mov-25", -21.23, "2026-09-25"), movimiento("mov-23", -18.0, "2026-09-23", "Anthropic* Claude Sub")],
    "Anthropic, PBC",
    "2026-09-28",
    "EUR"
  );
  assert.equal(elegido, undefined);
});

// La ventana reutilizada (movimientoEnVentanaAuto, gmail/automatico/model.ts) es ASIMÉTRICA a
// propósito: el cargo puede haber ocurrido mucho antes de la factura (hasta 90 días — viajes/reservas
// cuyo comprobante se emite después), pero solo un poco después (hasta 5 días — no se aceptan cargos
// futuros poco plausibles).
test("el margen hacia atrás llega a 90 días; 91 días antes queda fuera", () => {
  assert.equal(
    seleccionarMovimientoLiquidacionSeguro(
      [movimiento("mov-90", -20.88, "2026-06-13")], // exactamente 90 días antes del 2026-09-11
      "Anthropic, PBC",
      "2026-09-11",
      "EUR"
    )?.movementId,
    "mov-90"
  );
  assert.equal(
    seleccionarMovimientoLiquidacionSeguro(
      [movimiento("mov-91", -20.88, "2026-06-12")], // 91 días antes
      "Anthropic, PBC",
      "2026-09-11",
      "EUR"
    ),
    undefined
  );
});

test("el margen hacia adelante llega a 5 días; 6 días después queda fuera", () => {
  assert.equal(
    seleccionarMovimientoLiquidacionSeguro(
      [movimiento("mov-mas5", -20.88, "2026-09-16")], // 5 días después del 2026-09-11
      "Anthropic, PBC",
      "2026-09-11",
      "EUR"
    )?.movementId,
    "mov-mas5"
  );
  assert.equal(
    seleccionarMovimientoLiquidacionSeguro(
      [movimiento("mov-mas6", -20.88, "2026-09-17")], // 6 días después
      "Anthropic, PBC",
      "2026-09-11",
      "EUR"
    ),
    undefined
  );
});
