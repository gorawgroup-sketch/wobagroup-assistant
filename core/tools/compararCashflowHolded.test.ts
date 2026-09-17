import test from "node:test";
import assert from "node:assert/strict";
import { fuenteSolicitada, resolverFilasSinEmpresaConCobertura } from "./compararCashflowHolded";
import type { FilaCashflowCruce, MovimientoHoldedCruce } from "../cashflow/cruceHoldedCashflow";

const filaSinEmpresa: FilaCashflowCruce = {
  id: "PAGOS_EXTRAS:8",
  categoria: "PAGOS_EXTRAS",
  descripcion: "Iberdrola",
  semana: "S37",
  valorEur: 264.46,
  tipo: "gasto",
};

const movimiento: MovimientoHoldedCruce = {
  id: "mov-1",
  empresa: "WOBA",
  accountId: "main",
  cuenta: "Main",
  descripcion: "IBERDROLA CLIENTES",
  fecha: "2026-09-10",
  valorEur: -264.46,
  valorNativo: -264.46,
  moneda: "EUR",
  enPeriodo: true,
  toleranciaEur: 0.01,
};

function resultado(empresa: "WOBA" | "EWORKS", problemasCobertura: string[], conMovimiento: boolean) {
  return {
    filasSinEmpresa: [filaSinEmpresa],
    problemasCobertura,
    ambiguos: conMovimiento
      ? [{ movimiento: { ...movimiento, empresa }, alternativas: [filaSinEmpresa.id], motivo: "no tiene EMPRESA" }]
      : [],
  };
}

test("una dirección bancaria sin fuente explícita no agrega documentos ajenos", () => {
  assert.equal(fuenteSolicitada({ direccion: "cashflow_a_banco" }), "bancos");
  assert.equal(fuenteSolicitada({ direccion: "banco_a_cashflow" }), "bancos");
  assert.equal(fuenteSolicitada({}), "ambos");
  assert.equal(fuenteSolicitada({ direccion: "cashflow_a_banco", fuente: "gastos" }), "gastos");
});

test("no atribuye filas sin EMPRESA si una compañía tiene cobertura incompleta", () => {
  const resolucion = resolverFilasSinEmpresaConCobertura([
    resultado("WOBA", [], true),
    resultado("EWORKS", ["falló una cuenta"], false),
  ]);

  assert.equal(resolucion.atribuciones.length, 0);
  assert.equal(resolucion.filasSinResolver.length, 1);
});
