import test from "node:test";
import assert from "node:assert/strict";
import { construirTecladoGasto, movimientoRecomendadoPropuesta, opcionesTecladoDesdePropuesta } from "./gastoTeclado";
import type { PropuestaGasto } from "./gastoProposalSheet";

function propuestaBase(): PropuestaGasto {
  return {
    id: "propuesta",
    empresa: "Footprint",
    proveedor: "ESSO Minderhout",
    monto: 87.9,
    moneda: "EUR",
    fecha: "2026-08-30",
    concepto: "Gasolina",
    rutaLocal: "/tmp/esso.pdf",
    nombreArchivoOriginal: "esso.pdf",
    candidatos: [],
    lineas: [],
    chatId: 1,
    messageId: 2,
    creadoEn: 3,
  };
}

test("un único movimiento recomendado conserva Crear y conciliar sin presentarlo como ambiguo", () => {
  const propuesta: PropuestaGasto = {
    ...propuestaBase(),
    hayMovimientoBancario: true,
    movimientosAmbiguos: [{
      accountId: "cuenta",
      movementId: "movimiento-esso",
      descripcion: "Esso Minderhout",
      monto: -88.69,
      moneda: "EUR",
      fecha: "2026-08-30",
      origenCoincidencia: "aproximada",
    }],
  };

  assert.equal(movimientoRecomendadoPropuesta(propuesta)?.movementId, "movimiento-esso");
  const opciones = opcionesTecladoDesdePropuesta(propuesta);
  assert.equal(opciones.hayMovimientoBancario, true);
  assert.equal(opciones.numMovimientosAmbiguos, undefined);
  const textos = construirTecladoGasto(propuesta, opciones).flat().map((b) => b.text);
  assert.ok(textos.some((t) => t.includes("Crear y conciliar")));
  assert.equal(textos.some((t) => t.includes("Conciliar con #1")), false);
});

test("varios movimientos siguen exigiendo elegir uno explícitamente", () => {
  const base = propuestaBase();
  const propuesta: PropuestaGasto = {
    ...base,
    hayMovimientoBancario: false,
    movimientosAmbiguos: [1, 2].map((n) => ({
      accountId: "cuenta",
      movementId: `movimiento-${n}`,
      descripcion: `Movimiento ${n}`,
      monto: -87.9,
      moneda: "EUR",
      fecha: "2026-08-30",
    })),
  };
  const opciones = opcionesTecladoDesdePropuesta(propuesta);
  assert.equal(opciones.numMovimientosAmbiguos, 2);
  const textos = construirTecladoGasto(propuesta, opciones).flat().map((b) => b.text);
  assert.ok(textos.some((t) => t.includes("Conciliar con #1")));
  assert.ok(textos.some((t) => t.includes("Conciliar con #2")));
});
