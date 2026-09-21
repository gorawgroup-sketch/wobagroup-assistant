import assert from "node:assert/strict";
import test from "node:test";
import {
  sugerirCandidatoDesdeRegistros,
  type ConciliacionVerificadaAprendida,
  type MovimientoParaAprendizajeConciliacion,
} from "./conciliacionAprendidaSheet";

function registro(cambios: Partial<ConciliacionVerificadaAprendida> = {}): ConciliacionVerificadaAprendida {
  return {
    rowIndex: 2,
    clave: "k",
    empresa: "WOBA",
    proveedor: "DHL EXPRESS SPAIN SLU",
    moneda: "EUR",
    accountId: "bank-eur",
    descripcionMovimiento: "DHL EXPRESS MADRID",
    ultimoMonto: 503.86,
    vecesConfirmado: 3,
    primeraConfirmacionEn: "2026-09-01T00:00:00.000Z",
    ultimaConfirmacionEn: "2026-09-18T00:00:00.000Z",
    gastoIdUltimo: "purchase-1",
    origenCoincidencia: "exacta",
    ...cambios,
  };
}

function movimiento(cambios: Partial<MovimientoParaAprendizajeConciliacion> = {}): MovimientoParaAprendizajeConciliacion {
  return {
    accountId: "bank-eur",
    descripcion: "DHL EXPRESS MADRID TARJETA",
    monto: 503.86,
    moneda: "EUR",
    ...cambios,
  };
}

test("sugiere solo el candidato con evidencia histórica verificable", () => {
  const sugerencia = sugerirCandidatoDesdeRegistros(
    "DHL EXPRESS SPAIN SLU",
    "WOBA",
    [movimiento({ descripcion: "SUPERMERCADO CENTRAL" }), movimiento()],
    [registro()]
  );
  assert.equal(sugerencia?.indice, 1);
  assert.equal(sugerencia?.vecesConfirmado, 3);
});

test("no transfiere aprendizaje entre empresas, proveedores ni monedas", () => {
  const candidatos = [movimiento()];
  assert.equal(sugerirCandidatoDesdeRegistros("DHL EXPRESS SPAIN SLU", "EWORKS", candidatos, [registro()]), undefined);
  assert.equal(sugerirCandidatoDesdeRegistros("OTRO PROVEEDOR", "WOBA", candidatos, [registro()]), undefined);
  assert.equal(
    sugerirCandidatoDesdeRegistros("DHL EXPRESS SPAIN SLU", "WOBA", [movimiento({ moneda: "USD" })], [registro()]),
    undefined
  );
});

test("una cuenta coincidente sin texto del proveedor no basta para sugerir", () => {
  const sugerencia = sugerirCandidatoDesdeRegistros(
    "DHL EXPRESS SPAIN SLU",
    "WOBA",
    [movimiento({ descripcion: "RESTAURANTE SIN RELACION" })],
    [registro()]
  );
  assert.equal(sugerencia, undefined);
});

test("ante empate conserva la ambigüedad y no destaca una opción", () => {
  const sugerencia = sugerirCandidatoDesdeRegistros(
    "DHL EXPRESS SPAIN SLU",
    "WOBA",
    [movimiento(), movimiento({ accountId: "bank-eur", monto: 510 })],
    [registro()]
  );
  assert.equal(sugerencia, undefined);
});
