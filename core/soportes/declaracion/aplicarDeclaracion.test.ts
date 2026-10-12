import assert from "node:assert/strict";
import test from "node:test";
import { clasificarCargo, planificarAplicacion, textoPlan } from "./aplicarDeclaracion";
import type { CargoDeclarado, Declaracion } from "./declaracionStore";

const cargo = (id: string, extra: Partial<CargoDeclarado> = {}): CargoDeclarado => ({ id, fecha: "2026-09-07", lugar: "Airalo", valor: 9, moneda: "EUR", ...extra });
const decl = (cargos: CargoDeclarado[]): Declaracion => ({ id: "d1", empresa: "EWORKS", titular: "German Alejandro Robles", email: "g@x.com", cargoFirmante: "CEO", chatId: 1,
  cargos, driveFileId: "f", driveUrl: "u", nombreArchivo: "GASTOS SIN SOPORTE GERMAN.docx", estado: "firmada", creadoEn: 0, archivoFirmadoDriveId: "s" });

test("un cargo con una compra única es «existente», con varias «ambiguo», sin ninguna «nuevo», y lo ya aplicado no se repite", () => {
  assert.equal(clasificarCargo(cargo("a"), [{ id: "c1", contactName: "Airalo", total: 9, fecha: "2026-09-07" }]).situacion, "existente");
  assert.equal(clasificarCargo(cargo("b"), [{ id: "c1", contactName: "Airalo", total: 9, fecha: "2026-09-07" }, { id: "c2", contactName: "Airalo", total: 9, fecha: "2026-09-08" }]).situacion, "ambiguo");
  assert.equal(clasificarCargo(cargo("c"), []).situacion, "nuevo");
  assert.equal(clasificarCargo(cargo("d", { estadoSoporte: "adjuntado", compraId: "c9" }), []).situacion, "ya_aplicado");
});

test("el plan consulta Holded solo para los cargos sin aplicar y el texto resume cada grupo (caso German, cualquier empresa)", async () => {
  const consultados: string[] = [];
  const plan = await planificarAplicacion(decl([cargo("1", { lugar: "Avolta", valor: 31.25 }), cargo("2", { lugar: "Rosso Brera", valor: 80 }), cargo("3", { estadoSoporte: "propuesto" })]), {
    compras: async (_e, c) => { consultados.push(c.id); return { compras: c.lugar === "Avolta" ? [{ id: "c-av", contactName: "Avolta", total: 31.25, fecha: "2026-09-07" }] : [] }; },
  });
  assert.deepEqual(consultados, ["1", "2"]);
  assert.deepEqual(plan.cargos.map((x) => x.situacion), ["existente", "nuevo", "ya_aplicado"]);
  const texto = textoPlan(plan);
  assert.match(texto, /Ya registrados en Holded \(se les adjunta la declaración\): 1/);
  assert.match(texto, /Sin gasto en Holded \(se propone crearlos.*\): 1/);
  assert.match(texto, /Ya aplicados antes: 1/);
});
