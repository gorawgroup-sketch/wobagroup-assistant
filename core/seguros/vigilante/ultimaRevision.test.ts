import assert from "node:assert/strict";
import test from "node:test";
import type { ContenidoInforme } from "./informe";
import type { MovimientoBanco } from "./tipos";
import { parsearUltimaRevision, resumirRevision } from "./ultimaRevision";
import type { ResultadoVigilante } from "./vigilante";

const movimiento: MovimientoBanco = {
  empresa: "WOBA", cuentaId: "bbva", cuenta: "BBVA", id: "mov1", fecha: "2026-10-05", descripcion: "N 2026275001954588 Markel Insurance SE ADEUDO A SU CARGO",
  importe: -323.24, moneda: "EUR", importeEur: -323.24, estado: "pending", saldoTras: null,
};
const poliza = { id: "woba_rc_suplemento_3_3", empresa: "WOBA", tipoCobertura: "Responsabilidad civil general", numeroPoliza: "023S00453RCG (Suplemento 3.3)" };

function vacio(): ContenidoInforme {
  return { hoy: "2026-10-05", devoluciones: [], confirmados: [], enTransito: [], cargos: [], correos: [], ambiguos: [], sinPago: [], advertencias: [], fallosPersistentes: [] };
}

// Solo se usa la forma que lee resumirRevision.
const resultado = (contenido: ContenidoInforme, situacion: ContenidoInforme) => ({ contenido, situacion }) as unknown as ResultadoVigilante;

test("el resumen cuenta los cargos en tránsito de la SITUACIÓN aunque ya estuvieran avisados (lo nuevo está vacío)", () => {
  const enTransito = [{ polizas: [poliza], movimiento, motivo: "el saldo del banco todavía no lo refleja" }];
  const r = resumirRevision(resultado(vacio(), { ...vacio(), enTransito } as unknown as ContenidoInforme), new Date("2026-10-06T08:35:00Z"));
  assert.equal(r.fecha, "2026-10-06T08:35:00.000Z");
  assert.equal(r.enTransito.length, 1);
  assert.match(r.enTransito[0], /323,24/);
  assert.equal(r.confirmados, 0);
  assert.equal(r.correosNuevos, 0);
});

test("lo que ocurre una vez por revisión (confirmados, devoluciones, correos nuevos) es de esa revisión, no de la situación", () => {
  const contenido = { ...vacio(), confirmados: [{}, {}], devoluciones: [{}], correos: [{}, {}, {}] } as unknown as ContenidoInforme;
  const situacion = { ...vacio(), confirmados: [], devoluciones: [], correos: [{}, {}, {}, {}, {}, {}, {}, {}] } as unknown as ContenidoInforme;
  const r = resumirRevision(resultado(contenido, situacion), new Date("2026-10-06T08:35:00Z"));
  assert.equal(r.confirmados, 2);
  assert.equal(r.devoluciones, 1);
  assert.equal(r.correosNuevos, 3);
});

test("los cargos que no encajan se cuentan por la situación y las advertencias se acotan", () => {
  const situacion = { ...vacio(), cargos: [{}, {}] } as unknown as ContenidoInforme;
  const contenido = { ...vacio(), advertencias: ["x".repeat(500)], fallosPersistentes: ["Holded lleva 2 días sin responder"] };
  const r = resumirRevision(resultado(contenido, situacion), new Date("2026-10-06T08:35:00Z"));
  assert.equal(r.cargosARevisar, 2);
  assert.equal(r.advertencias.length, 2);
  assert.equal(r.advertencias[0].length, 240);
});

test("el resumen guardado se lee de vuelta y uno ilegible se ignora", () => {
  const guardado = JSON.stringify(resumirRevision(resultado(vacio(), vacio()), new Date("2026-10-06T08:35:00Z")));
  assert.equal(parsearUltimaRevision(guardado)?.fecha, "2026-10-06T08:35:00.000Z");
  assert.equal(parsearUltimaRevision(undefined), null);
  assert.equal(parsearUltimaRevision("no es json"), null);
  assert.equal(parsearUltimaRevision(JSON.stringify({ confirmados: 1 })), null);
});
