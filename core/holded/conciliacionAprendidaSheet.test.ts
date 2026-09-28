import assert from "node:assert/strict";
import test from "node:test";
import {
  descriptorConfirmadoParaProveedor,
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

test("un descriptor ya confirmado por un humano para ese proveedor se reconoce aunque el nombre no coincida", () => {
  const confirmados = [registro({ proveedor: "Mi Cafetería", moneda: "USD", descripcionMovimiento: "Par*just B Cuz Luxury" })];
  assert.equal(descriptorConfirmadoParaProveedor(confirmados, "WOBA", "mi cafeteria", "USD", "PAR*JUST B CUZ LUXURY"), true);
  assert.equal(descriptorConfirmadoParaProveedor(confirmados, "WOBA", "Mi Cafetería", "usd", "Par*just B Cuz Luxury 2"), true);
  // Otra empresa, otra moneda, otro proveedor o un descriptor distinto no cuentan.
  assert.equal(descriptorConfirmadoParaProveedor(confirmados, "EWORKS", "Mi Cafetería", "USD", "Par*just B Cuz Luxury"), false);
  assert.equal(descriptorConfirmadoParaProveedor(confirmados, "WOBA", "Mi Cafetería", "EUR", "Par*just B Cuz Luxury"), false);
  assert.equal(descriptorConfirmadoParaProveedor(confirmados, "WOBA", "Otro Sitio", "USD", "Par*just B Cuz Luxury"), false);
  assert.equal(descriptorConfirmadoParaProveedor(confirmados, "WOBA", "Mi Cafetería", "USD", "PAYU*OTRA COSA"), false);
  assert.equal(descriptorConfirmadoParaProveedor([], "WOBA", "Mi Cafetería", "USD", "Par*just B Cuz Luxury"), false);
});
