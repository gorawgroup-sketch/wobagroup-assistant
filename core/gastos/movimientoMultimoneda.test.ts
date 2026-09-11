import assert from "node:assert/strict";
import test from "node:test";
import type { MovimientoBancarioCandidato } from "../holded/write";
import { buscarMovimientosPorTipoCambio, describirMovimientoMultimoneda } from "./movimientoMultimoneda";

function movimiento(id: string, monto: number, descripcion = "ANTHROPIC PBC"): MovimientoBancarioCandidato {
  return {
    accountId: "cuenta-eur",
    movementId: id,
    descripcion,
    monto,
    moneda: "EUR",
    fecha: "2026-09-10",
  };
}

test("encuentra en EUR una factura USD usando la tasa histórica y conserva evidencia", async () => {
  const consultas: Array<{ monto: number; moneda?: string; tolerancia?: number }> = [];
  const resultados = await buscarMovimientosPorTipoCambio(
    "WOBA",
    { monto: 24.2, moneda: "USD", fecha: "2026-09-10", proveedor: "Anthropic, PBC" },
    ["USD", "EUR"],
    {
      async obtenerTasa(fecha, origen, destino) {
        assert.deepEqual([fecha, origen, destino], ["2026-09-10", "USD", "EUR"]);
        return 0.85;
      },
      async buscarCercanos(_empresa, criterios, tolerancia) {
        consultas.push({ ...criterios, tolerancia });
        return [movimiento("mov-1", -20.61)];
      },
      async buscarPorNombre() {
        return [];
      },
    }
  );

  assert.equal(consultas.length, 1);
  assert.ok(Math.abs(consultas[0].monto - 20.57) < 1e-10);
  assert.equal(consultas[0].moneda, "EUR");
  assert.ok((consultas[0].tolerancia ?? 0) >= 0.61);
  assert.equal(resultados.length, 1);
  assert.equal(resultados[0].origenCoincidencia, "tipo_cambio");
  assert.equal(resultados[0].montoReferencia, 20.57);
  assert.equal(resultados[0].coincideProveedor, true);
  assert.match(describirMovimientoMultimoneda(resultados[0], 0), /referencia 20\.57 EUR/);
});

test("prioriza nombre coincidente, elimina duplicados y limita las sugerencias", async () => {
  const candidatos = Array.from({ length: 7 }, (_, i) =>
    movimiento(`mov-${i}`, -(85 + i / 10), i === 6 ? "ANTHROPIC CREDIT PURCHASE" : `OTRO CARGO ${i}`)
  );
  const resultados = await buscarMovimientosPorTipoCambio(
    "WOBA",
    { monto: 100, moneda: "USD", fecha: "2026-09-10", proveedor: "Anthropic" },
    ["EUR"],
    {
      async obtenerTasa() {
        return 0.85;
      },
      async buscarCercanos() {
        return candidatos;
      },
      async buscarPorNombre() {
        return [{ ...candidatos[6], diferenciaMonto: 0.6 }];
      },
    }
  );

  assert.equal(resultados.length, 5);
  assert.equal(resultados[0].movementId, "mov-6");
  assert.equal(new Set(resultados.map((r) => r.movementId)).size, resultados.length);
});

test("una tasa ausente no inventa candidatos ni llama al banco con una paridad ficticia", async () => {
  let busquedas = 0;
  const resultados = await buscarMovimientosPorTipoCambio(
    "WOBA",
    { monto: 24.2, moneda: "USD", fecha: "2026-09-10", proveedor: "Anthropic" },
    ["EUR"],
    {
      async obtenerTasa() {
        return undefined;
      },
      async buscarCercanos() {
        busquedas++;
        return [];
      },
      async buscarPorNombre() {
        busquedas++;
        return [];
      },
    }
  );

  assert.deepEqual(resultados, []);
  assert.equal(busquedas, 0);
});
