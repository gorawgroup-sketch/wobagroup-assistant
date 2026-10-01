import assert from "node:assert/strict";
import test from "node:test";
import { buscarCargoParaPropuesta } from "./buscarCargoParaPropuesta";
import type { MovimientoBancarioCandidato } from "../holded/write";

const cargo = (id: string, descripcion: string, extra: Partial<MovimientoBancarioCandidato> = {}): MovimientoBancarioCandidato =>
  ({ accountId: "a", movementId: id, descripcion, monto: -9.74, moneda: "EUR", fecha: "2026-09-10", ...extra });
const c = { empresa: "Footprint" as const, proveedor: "Uber", concepto: "Traslado", monto: 9.74, moneda: "EUR", fecha: "2026-09-10" };
const deps = (exactos: MovimientoBancarioCandidato[], aproximados: Array<MovimientoBancarioCandidato & { diferenciaMonto: number }> = []) => ({
  similar: (async () => exactos) as never,
  aproximado: (async () => aproximados) as never,
});

test("un cargo exacto compatible único se recomienda como exacto", async () => {
  const r = await buscarCargoParaPropuesta(c, deps([cargo("m1", "Uber Pending")]));
  assert.equal(r.movimientoEncontrado, true);
  assert.equal(r.movimientoRecomendado?.origenCoincidencia, "exacta");
  assert.deepEqual(r.movimientosPersistidos.map((m) => m.movementId), ["m1"]);
});

test("varios exactos compatibles se dejan para elegir con «Conciliar con #N»", async () => {
  const r = await buscarCargoParaPropuesta(c, deps([cargo("m1", "Uber Pending"), cargo("m2", "Dl *uberrides")]));
  assert.equal(r.movimientoEncontrado, false);
  assert.deepEqual(r.movimientosAmbiguos.map((m) => m.movementId), ["m1", "m2"]);
  assert.deepEqual(r.movimientosPersistidos.map((m) => m.movementId), ["m1", "m2"]);
});

test("sin exactos se prueba el aproximado por nombre (caso real: 9,74 estimado frente a «Dlo Uberrides» de 9,24)", async () => {
  const r = await buscarCargoParaPropuesta(c, deps([], [{ ...cargo("m-uber", "Dlo Uberrides", { monto: -9.24 }), diferenciaMonto: 0.5 }]));
  assert.equal(r.movimientoEncontrado, true);
  assert.equal(r.movimientoRecomendado?.origenCoincidencia, "aproximada");
  assert.equal(r.movimientoRecomendado?.movementId, "m-uber");
});

test("un exacto solo «por confirmar» NO tapa a un aproximado que sí coincide por nombre", async () => {
  const porConfirmar = cargo("m-otro", "SQ *XYZ 88", { compatibilidad: "por_confirmar" });
  const r = await buscarCargoParaPropuesta(c, deps([porConfirmar], [{ ...cargo("m-uber", "Dlo Uberrides", { monto: -9.24 }), diferenciaMonto: 0.5 }]));
  assert.equal(r.movimientoRecomendado?.movementId, "m-uber");
});

test("sin aproximado por nombre, el exacto por confirmar sigue ofreciéndose (último recurso)", async () => {
  const porConfirmar = cargo("m-otro", "SQ *XYZ 88", { compatibilidad: "por_confirmar" });
  const r = await buscarCargoParaPropuesta(c, deps([porConfirmar], []));
  assert.equal(r.movimientoRecomendado?.movementId, "m-otro");
  assert.equal(r.movimientoRecomendado?.compatibilidad, "por_confirmar");
});

test("con proveedor sin identificar no se busca por nombre aproximado", async () => {
  let llamadas = 0;
  const r = await buscarCargoParaPropuesta({ ...c, proveedor: "Establecimiento no identificado" }, {
    similar: (async () => []) as never,
    aproximado: (async () => { llamadas++; return []; }) as never,
  });
  assert.equal(llamadas, 0);
  assert.equal(r.movimientoEncontrado, false);
  assert.deepEqual(r.movimientosPersistidos, []);
});

test("si falla la pasada del aproximado, los exactos ya encontrados no se pierden", async () => {
  const porConfirmar = cargo("m-otro", "SQ *XYZ 88", { compatibilidad: "por_confirmar" });
  const r = await buscarCargoParaPropuesta(c, {
    similar: (async () => [porConfirmar]) as never,
    aproximado: (async () => { throw new Error("Error de la API de Holded (503)"); }) as never,
  });
  assert.equal(r.movimientoRecomendado?.movementId, "m-otro");
});

test("sin cargo exacto ni aproximado se ofrecen los cargos MAYORES del proveedor, solo para elegir (caso Go Rent A Car)", async () => {
  const mayor = cargo("m-go", "Go Rent A Car", { monto: -744.87, moneda: "USD", origenCoincidencia: "cargo_mayor", restoDisponible: 744.87 });
  const r = await buscarCargoParaPropuesta(
    { ...c, proveedor: "Go Rent A Car", monto: 354.62, moneda: "USD" },
    { ...deps([]), cargoMayor: (async () => [mayor]) as never }
  );
  assert.equal(r.movimientoEncontrado, false);
  assert.equal(r.movimientoRecomendado, undefined);
  assert.deepEqual(r.movimientosAmbiguos.map((m) => m.movementId), ["m-go"]);
  assert.deepEqual(r.movimientosPersistidos.map((m) => m.origenCoincidencia), ["cargo_mayor"]);
});

test("con un cargo exacto no se busca ningún cargo mayor", async () => {
  let llamado = false;
  const r = await buscarCargoParaPropuesta(c, { ...deps([cargo("m1", "Uber Pending")]), cargoMayor: (async () => { llamado = true; return []; }) as never });
  assert.equal(r.movimientoRecomendado?.movementId, "m1");
  assert.equal(llamado, false);
});
