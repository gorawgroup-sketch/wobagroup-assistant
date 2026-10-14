import assert from "node:assert/strict";
import test from "node:test";
import { auditarCargosExactos, esDescarteReportable, textoAviso, type CargoLibre, type CompraAuditable, type DepsAuditoriaCargos } from "./auditoriaCargosExactos";
import type { EntradaTraza } from "./trazaBusqueda";

/**
 * Auditoría de cargos exactos no ofrecidos: solo parejas únicas de importe exacto, solo descartes que pueden ocultar un cargo legítimo,
 * un único aviso por pareja y nada de escribir ni conciliar.
 */
const AHORA = Date.UTC(2026, 9, 14, 8, 45);
const compra = (o: Partial<CompraAuditable> = {}): CompraAuditable => ({ empresa: "Footprint", id: "c1", fecha: "2026-10-05", total: 20.15, moneda: "EUR", proveedor: "Burger King", concepto: "Comida", ...o });
const cargo = (o: Partial<CargoLibre> = {}): CargoLibre => ({ movementId: "m1", cuentaId: "a1", descripcion: "Bk", monto: -20.15, moneda: "EUR", equivalenteEur: null, fecha: "2026-10-07", ...o });
const traza = (o: Partial<EntradaTraza> = {}): EntradaTraza => ({ movementId: "m1", descripcion: "Bk", monto: -20.15, moneda: "EUR", fecha: "2026-10-07", resultado: "descartado", motivo: "el nombre no se reconoce y no coinciden la fecha (±1 día) (2 días de diferencia)", ...o });

function deps(o: { compras?: CompraAuditable[]; cargos?: CargoLibre[]; trazas?: EntradaTraza[]; avisadas?: string[]; avisos?: string[]; marcadas?: string[]; simular?: boolean } = {}): DepsAuditoriaCargos {
  return {
    comprasPendientes: async (e) => (o.compras ?? [compra()]).filter((c) => c.empresa === e),
    cargosLibres: async () => o.cargos ?? [cargo()],
    buscar: async () => o.trazas ?? [traza()],
    yaAvisadas: async () => new Set(o.avisadas ?? []),
    marcarAvisadas: async (c) => { o.marcadas?.push(...c); },
    avisar: async (t) => { o.avisos?.push(t); },
    ahora: () => AHORA, simular: o.simular,
  };
}

test("cargo exacto a 2 días descartado por fecha/nombre → hallazgo no_ofrecido y un aviso", async () => {
  const avisos: string[] = [], marcadas: string[] = [];
  const r = await auditarCargosExactos(deps({ avisos, marcadas }), ["Footprint"]);
  assert.equal(r.hallazgos.length, 1); assert.equal(r.hallazgos[0].tipo, "no_ofrecido");
  assert.equal(avisos.length, 1); assert.match(avisos[0], /Bk/); assert.deepEqual(marcadas, ["Footprint|c1|m1"]);
  assert.doesNotMatch(avisos[0], /✅|❌/);
});

test("la misma pareja ya avisada no se vuelve a avisar", async () => {
  const avisos: string[] = [];
  const r = await auditarCargosExactos(deps({ avisos, avisadas: ["Footprint|c1|m1"] }), ["Footprint"]);
  assert.equal(r.hallazgos.length, 1); assert.equal(r.nuevos.length, 0); assert.equal(avisos.length, 0);
});

test("descartes correctos (categorías contradictorias, ya conciliado, no es un cargo) no son hallazgo", async () => {
  for (const motivo of ["categorías contradictorias (gasto: alimentacion; cargo: transporte)", "ya estaba conciliado con otro documento", "no es un cargo (es un ingreso o una devolución)"]) {
    const r = await auditarCargosExactos(deps({ trazas: [traza({ motivo })] }), ["Footprint"]);
    assert.equal(r.hallazgos.length, 0, motivo);
  }
  assert.equal(esDescarteReportable("categorías contradictorias (x)"), false);
});

test("pareja ambigua: un cargo con dos compras posibles, o una compra con dos cargos, no se avisa", async () => {
  const dos = await auditarCargosExactos(deps({ compras: [compra(), compra({ id: "c2" })] }), ["Footprint"]);
  assert.equal(dos.hallazgos.length, 0); assert.equal(dos.ambiguos, 2);
  const cargos = await auditarCargosExactos(deps({ cargos: [cargo(), cargo({ movementId: "m2" })] }), ["Footprint"]);
  assert.equal(cargos.hallazgos.length, 0); assert.equal(cargos.ambiguos, 1);
});

test("compras de menos de 2 días o de más de 45 no se auditan; compras de otro importe no emparejan", async () => {
  assert.equal((await auditarCargosExactos(deps({ compras: [compra({ fecha: "2026-10-13" })] }), ["Footprint"])).comprasRevisadas, 0);
  assert.equal((await auditarCargosExactos(deps({ compras: [compra({ fecha: "2026-08-01" })] }), ["Footprint"])).comprasRevisadas, 0);
  assert.equal((await auditarCargosExactos(deps({ cargos: [cargo({ monto: -20.2 })] }), ["Footprint"])).comprasRevisadas, 0);
});

test("pago diferido: importe ≥ 50 se empareja hasta 30 días después y, si el buscador no lo ve, es fuera_de_ventana", async () => {
  const c = compra({ id: "kmino", total: 2372.42, moneda: "USD", fecha: "2026-09-28" });
  const g = cargo({ movementId: "m9", descripcion: "Sent Money To Business Atelier", monto: -2372.42, moneda: "USD", fecha: "2026-10-08" });
  const r = await auditarCargosExactos(deps({ compras: [c], cargos: [g], trazas: [] }), ["Footprint"]);
  assert.equal(r.hallazgos.length, 1); assert.equal(r.hallazgos[0].tipo, "fuera_de_ventana"); assert.match(r.hallazgos[0].motivo, /10 días/);
});

test("pago diferido: un importe pequeño no se empareja a más de 3 días, ni un cargo ANTERIOR a más de 3 días", async () => {
  assert.equal((await auditarCargosExactos(deps({ cargos: [cargo({ fecha: "2026-10-13" })], trazas: [] }), ["Footprint"])).comprasRevisadas, 0);
  const c = compra({ total: 500, fecha: "2026-10-10" });
  assert.equal((await auditarCargosExactos(deps({ compras: [c], cargos: [cargo({ monto: -500, fecha: "2026-10-01" })], trazas: [] }), ["Footprint"])).comprasRevisadas, 0);
});

test("si el buscador no vio el cargo y está dentro de su ventana, no se inventa un hallazgo", async () => {
  const r = await auditarCargosExactos(deps({ trazas: [] }), ["Footprint"]);
  assert.equal(r.hallazgos.length, 0);
});

test("cargo que SÍ se ofrecería pero sigue sin conciliar → ofrecido_sin_conciliar", async () => {
  const r = await auditarCargosExactos(deps({ trazas: [traza({ resultado: "ofrecido", motivo: "ofrecido (compatible)" })] }), ["Footprint"]);
  assert.equal(r.hallazgos[0].tipo, "ofrecido_sin_conciliar");
  assert.match(textoAviso(r.hallazgos), /SÍ se ofrecería/);
});

test("cargo en otra moneda: empareja por el equivalente en euros solo si la compra es en euros", async () => {
  const g = cargo({ monto: -22.5, moneda: "USD", equivalenteEur: -20.15 });
  assert.equal((await auditarCargosExactos(deps({ cargos: [g], trazas: [traza()] }), ["Footprint"])).hallazgos.length, 1);
  assert.equal((await auditarCargosExactos(deps({ compras: [compra({ moneda: "MXN" })], cargos: [g] }), ["Footprint"])).comprasRevisadas, 0);
});

test("simulación: calcula pero no avisa ni marca", async () => {
  const avisos: string[] = [], marcadas: string[] = [];
  const r = await auditarCargosExactos(deps({ avisos, marcadas, simular: true }), ["Footprint"]);
  assert.equal(r.hallazgos.length, 1); assert.equal(avisos.length, 0); assert.equal(marcadas.length, 0); assert.equal(r.simulado, true);
});
