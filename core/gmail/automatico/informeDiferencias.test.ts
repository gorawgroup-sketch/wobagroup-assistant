import assert from "node:assert/strict";
import test from "node:test";
import { calcularDiferencias, diferenciasDeEstaRevision, lineasDiferencias } from "./informeDiferencias";
import { AUTOMATIZABLE, type ResumenSeco } from "./revisionEnSeco";
import { resumenAutomatico } from "./service";

const resumen = (fecha: string, correos: ResumenSeco["correos"]): ResumenSeco => ({ version: "v", fecha, simulados: 0, revisados: 1, correos });

test("clasifica nuevos, resueltos, cambiados e iguales; lo automatizado no cuenta como pendiente", () => {
  const antes = resumen("2026-10-08T10:00:00Z", {
    a: { asunto: "A", estado: "Falta el proveedor" }, b: { asunto: "B", estado: "Fecha inválida" }, c: { asunto: "C", estado: "Sin cargo" }, d: { asunto: "D", estado: AUTOMATIZABLE },
  });
  const ahora = resumen("2026-10-08T12:00:00Z", {
    a: { asunto: "A", estado: "Falta el proveedor" }, b: { asunto: "B", estado: "Proveedor por confirmar" }, e: { asunto: "E", estado: "Nuevo motivo" }, d: { asunto: "D", estado: AUTOMATIZABLE },
  });
  const dif = calcularDiferencias(antes, ahora);
  assert.equal(dif.iguales, 1);
  assert.deepEqual(dif.resueltos, [{ asunto: "C" }]);
  assert.deepEqual(dif.nuevos, [{ asunto: "E", estado: "Nuevo motivo" }]);
  assert.deepEqual(dif.cambiados, [{ asunto: "B", antes: "Fecha inválida", ahora: "Proveedor por confirmar" }]);
});

test("la sección del informe dice lo que cambió, o que no hay registro anterior, o que no hay cambios", () => {
  const conCambios = lineasDiferencias({ desde: "2026-10-08T10:00:00Z", nuevos: [{ asunto: "E", estado: "Nuevo motivo" }], resueltos: [{ asunto: "C" }], cambiados: [], iguales: 2 }).join("\n");
  assert.match(conCambios, /🔁 Desde la última revisión \(08\/10.{0,3}12:00\)/);
  assert.match(conCambios, /✅ Resueltos desde entonces: 1\.\n  • «C»/);
  assert.match(conCambios, /🆕 Pendientes nuevos: 1\.\n  • «E»: Nuevo motivo/);
  assert.match(conCambios, /➡️ Siguen igual: 2\./);
  assert.match(lineasDiferencias({ nuevos: [], resueltos: [], cambiados: [], iguales: 0 }).join("\n"), /Primera revisión con registro de cambios/);
  assert.match(lineasDiferencias({ desde: "2026-10-08T10:00:00Z", nuevos: [], resueltos: [], cambiados: [], iguales: 4 }).join("\n"), /Sin cambios: 4 pendiente\(s\)/);
  assert.deepEqual(lineasDiferencias(undefined), []);
});

test("el informe completo incluye la sección de diferencias antes de la lista de motivos", () => {
  const texto = resumenAutomatico({ modo: "execute", revisados: 2, completados: 0, simulados: 0, gastos: [],
    pendientes: [{ mensajeId: "a", asunto: "A", motivos: ["fecha_invalida"], detalles: [{ proveedor: "P", empresa: "WOBA", monto: 1, moneda: "EUR", motivos: ["fecha_invalida"] }] }],
    diferencias: { desde: "2026-10-08T10:00:00Z", nuevos: [{ asunto: "A", estado: "La fecha del comprobante no es válida" }], resueltos: [], cambiados: [], iguales: 0 } });
  assert.ok(texto.indexOf("🔁 Desde la última revisión") < texto.indexOf("🟡 Por qué quedaron gastos para revisión manual"));
  assert.match(texto, /🆕 Pendientes nuevos: 1\./);
});

test("un fallo del almacén no interrumpe la revisión: el informe sale sin la sección", async () => {
  const resultado = { modo: "execute" as const, revisados: 0, completados: 0, simulados: 0, gastos: [], pendientes: [] };
  const dif = await diferenciasDeEstaRevision(resultado, "v", { ultimo: async () => { throw new Error("Postgres caído"); }, guardar: async () => {} });
  assert.equal(dif, undefined);
  const guardados: ResumenSeco[] = [];
  const ok = await diferenciasDeEstaRevision(resultado, "v", { ultimo: async () => undefined, guardar: async (r) => { guardados.push(r); } });
  assert.equal(ok?.desde, undefined); assert.equal(guardados.length, 1);
});
