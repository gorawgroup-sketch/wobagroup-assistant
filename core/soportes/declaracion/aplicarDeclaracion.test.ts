import assert from "node:assert/strict";
import test from "node:test";
import { decidirAccion, esCompraDeLaDeclaracion, planificarAplicacion, textoPlan, totalDeclarado, type CompraTotal } from "./aplicarDeclaracion";
import type { CargoDeclarado, Declaracion } from "./declaracionStore";
import type { CargoLocalizado, MovimientoBanco } from "./localizarCargos";

const cargo = (id: string, extra: Partial<CargoDeclarado> = {}): CargoDeclarado => ({ id, fecha: "2026-09-07", lugar: "Airalo", valor: 9, moneda: "EUR", ...extra });
const decl = (cargos: CargoDeclarado[]): Declaracion => ({ id: "7aeb11cd", empresa: "EWORKS", titular: "German Alejandro Robles", email: "g@x.com", cargoFirmante: "CEO", chatId: 1,
  cargos, driveFileId: "f", driveUrl: "u", nombreArchivo: "GASTOS SIN SOPORTE GERMAN.docx", estado: "firmada", creadoEn: 0, archivoFirmadoDriveId: "s" });
const mov = (movementId: string, fecha: string, descripcion: string, importe: number): MovimientoBanco => ({ accountId: "acc", cuenta: "Euros EWKS", movementId, fecha, descripcion, importe, moneda: "EUR", estado: "pending", conciliado: 0 });
const loc = (c: CargoDeclarado, m: MovimientoBanco | undefined, situacion: CargoLocalizado["situacion"] = "localizado"): CargoLocalizado => ({ cargo: c, situacion, movimiento: m });
const compra = (extra: Partial<CompraTotal> = {}): CompraTotal => ({ id: "6ad0c5d3", contactName: "German Alejandro Robles", total: 167.65, fecha: "2026-10-15", documentNumber: "00000", ...extra });

// Caso real German (EWORKS, 15-10-2026): 4 cargos = 167,65 €; el gasto del total ya existía (creado desde el chat, número 00000).
const cuatro = [cargo("1", { fecha: "2026-09-07", lugar: "Avolta Aams K Comunal 220", valor: 31.25 }), cargo("2", { fecha: "2026-09-07", lugar: "Airalo", valor: 9 }),
  cargo("3", { fecha: "2026-09-08", lugar: "Rosso Brera", valor: 80 }), cargo("4", { fecha: "2026-09-13", lugar: "Rist Pizz Tovo", valor: 47.4 })];

test("la compra del total se reconoce por el número DECL-id o por el nombre del titular como contacto", () => {
  const d = decl(cuatro);
  assert.equal(esCompraDeLaDeclaracion(compra(), d), true);
  assert.equal(esCompraDeLaDeclaracion(compra({ contactName: "Proveedor X", documentNumber: "DECL-7aeb11cd" }), d), true);
  assert.equal(esCompraDeLaDeclaracion(compra({ contactName: "Rosso Brera" }), d), false);
  assert.equal(totalDeclarado(cuatro), 167.65);
});

test("decidirAccion: todos localizados → conciliar la compra existente o crear y conciliar; un cargo sin banco bloquea; todo conciliado = resuelta", () => {
  const ok = cuatro.map((c, i) => loc(c, mov(`m${i}`, c.fecha, c.lugar, -c.valor)));
  assert.equal(decidirAccion([compra()], ok).accion, "conciliar_existente");
  assert.equal(decidirAccion([], ok).accion, "crear_y_conciliar");
  const unoSin = [...ok.slice(0, 3), loc(cuatro[3], undefined, "no_encontrado")];
  const r = decidirAccion([compra()], unoSin);
  assert.equal(r.accion, "bloqueado"); assert.match(r.bloqueos[0], /Rist Pizz Tovo/);
  assert.equal(decidirAccion([compra(), compra({ id: "otra" })], ok).accion, "bloqueado");
  assert.equal(decidirAccion([compra()], ok.map((x) => ({ ...x, situacion: "ya_conciliado" as const }))).accion, "ya_resuelta");
});

test("el plan lee Holded y el banco una vez, suma el total y el texto dice gasto único + cargos con su movimiento", async () => {
  const d = decl(cuatro);
  const plan = await planificarAplicacion(d, {
    compras: async (_e, _d, total, moneda) => { assert.equal(total, 167.65); assert.equal(moneda, "EUR"); return [compra()]; },
    cargos: async (_e, cargos) => cargos.map((c, i) => loc(c, mov(`m${i}`, c.fecha, c.lugar, -c.valor))),
  });
  assert.equal(plan.accion, "conciliar_existente");
  assert.equal(plan.compra?.id, "6ad0c5d3");
  const texto = textoPlan(plan);
  assert.match(texto, /un solo gasto de 167\.65 EUR por 4 cargo\(s\)/);
  assert.match(texto, /ya existe en Holded \(German Alejandro Robles/);
  assert.match(texto, /Rosso Brera · 80\.00 EUR → banco 2026-09-08 «Rosso Brera» \(Euros EWKS\)/);
});
