import assert from "node:assert/strict";
import test from "node:test";
import { AUTOMATIZABLE, compararResumenes, ejecutarRevisionEnSeco, resumirParaComparar, type ResumenSeco } from "./revisionEnSeco";
import type { ResultadoAuto } from "./model";

const resumen = (version: string, correos: ResumenSeco["correos"]): ResumenSeco => ({ version, fecha: "2026-10-08T00:00:00Z", simulados: 0, revisados: 1, correos });

test("resume por correo: automatizables, pendientes con su motivo legible y sin los aplazados", () => {
  const resultado: ResultadoAuto = { modo: "simulate", revisados: 3, completados: 0, simulados: 1,
    gastos: [],
    pendientes: [
      { mensajeId: "a", asunto: "Ticket A", motivos: ["operacion_pendiente_sin_escritura_en_simulacion"] },
      { mensajeId: "b", asunto: "Recibo B", motivos: ["lectura_incompleta", "lectura:No pude leer el adjunto «b.pdf»"] },
      { mensajeId: "c", asunto: "Nuevo C", motivos: ["revision_pospuesta_por_limite_de_coste"] },
    ] };
  const r = resumirParaComparar(resultado, "abc1234");
  assert.equal(r.correos.a.estado, AUTOMATIZABLE);
  assert.match(r.correos.b.estado, /No pude leer el adjunto «b\.pdf»/);
  assert.equal(r.correos.c, undefined);
});

test("empeora solo si un correo pasa de automatizable a pendiente o aparece un motivo sin catalogar", () => {
  const antes = resumen("v1", { a: { asunto: "A", estado: AUTOMATIZABLE }, b: { asunto: "B", estado: "Falta el proveedor" } });
  const mejor = compararResumenes(antes, resumen("v2", { a: { asunto: "A", estado: AUTOMATIZABLE }, b: { asunto: "B", estado: AUTOMATIZABLE }, n: { asunto: "N", estado: "Motivo X" } }));
  assert.equal(mejor.empeora, false); assert.equal(mejor.cambios.length, 1);
  const peor = compararResumenes(antes, resumen("v2", { a: { asunto: "A", estado: "La fecha no es válida" } }));
  assert.equal(peor.empeora, true); assert.match(peor.cambios[0], /antes se automatizaba y ahora queda pendiente/);
  const sinCatalogar = compararResumenes(undefined, resumen("v2", { z: { asunto: "Z", estado: "Motivo sin explicación catalogada (x)" } }));
  assert.equal(sinCatalogar.empeora, true);
});

function deps(extra: Partial<Parameters<typeof ejecutarRevisionEnSeco>[0]> & { resultado?: ResultadoAuto }) {
  const avisos: string[] = []; const guardados: ResumenSeco[] = [];
  const d = {
    version: () => "v2", hayRevisionEnCurso: () => false, ultima: async () => undefined as ResumenSeco | undefined,
    revisar: async () => extra.resultado ?? { modo: "simulate" as const, revisados: 0, completados: 0, simulados: 0, gastos: [], pendientes: [] },
    guardar: async (r: ResumenSeco) => { guardados.push(r); }, avisar: async (t: string) => { avisos.push(t); },
    ...extra,
  };
  return { d, avisos, guardados };
}

test("no arranca con una revisión real en marcha ni repite la misma versión", async () => {
  const a = deps({ hayRevisionEnCurso: () => true });
  assert.equal(await ejecutarRevisionEnSeco(a.d), "omitida_revision_en_curso");
  const b = deps({ ultima: async () => resumen("v2", {}) });
  assert.equal(await ejecutarRevisionEnSeco(b.d), "omitida_misma_version");
  assert.equal(a.guardados.length + b.guardados.length, 0);
});

test("avisa solo cuando empeora; si no, guarda y calla", async () => {
  const anterior = resumen("v1", { a: { asunto: "A", estado: AUTOMATIZABLE } });
  const peor = deps({ ultima: async () => anterior, resultado: { modo: "simulate", revisados: 1, completados: 0, simulados: 0, gastos: [],
    pendientes: [{ mensajeId: "a", asunto: "A", motivos: ["fecha_invalida"], detalles: [{ proveedor: "P", empresa: "WOBA", monto: 1, moneda: "EUR", motivos: ["fecha_invalida"] }] }] } });
  assert.equal(await ejecutarRevisionEnSeco(peor.d), "aviso_enviado");
  assert.match(peor.avisos[0], /algo empeoró respecto a la versión v1/);
  assert.equal(peor.guardados[0].version, "v2");
  const igual = deps({ ultima: async () => anterior, resultado: { modo: "simulate", revisados: 1, completados: 0, simulados: 1, gastos: [],
    pendientes: [{ mensajeId: "a", asunto: "A", motivos: ["operacion_pendiente_sin_escritura_en_simulacion"] }] } });
  assert.equal(await ejecutarRevisionEnSeco(igual.d), "sin_cambios_a_peor");
  assert.equal(igual.avisos.length, 0);
});

test("si la pasada falla, avisa y no guarda", async () => {
  const f = deps({ revisar: async () => { throw new Error("Gmail 503"); } });
  assert.equal(await ejecutarRevisionEnSeco(f.d), "fallo");
  assert.match(f.avisos[0], /Gmail 503/); assert.equal(f.guardados.length, 0);
});
