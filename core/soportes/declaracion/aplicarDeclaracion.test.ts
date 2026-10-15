import assert from "node:assert/strict";
import test from "node:test";
import { decidirAccion, elegirComprasDeLaDeclaracion, esCompraDeLaDeclaracion, pagadoPorLaCompra, planificarAplicacion, textoPlan, totalDeclarado, type CompraTotal } from "./aplicarDeclaracion";
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
  // Dos compras del titular con el mismo total: la del número DECL exacto gana; sin número, las dos (ambigüedad que bloquea).
  const dos = [compra({ id: "a" }), compra({ id: "b", documentNumber: "DECL-7aeb11cd" })];
  assert.deepEqual(elegirComprasDeLaDeclaracion(dos, d).map((c) => c.id), ["b"]);
  assert.deepEqual(elegirComprasDeLaDeclaracion([compra({ id: "a" }), compra({ id: "c" })], d).map((c) => c.id), ["a", "c"]);
});

test("decidirAccion: todos localizados → conciliar la compra existente o crear y conciliar; un cargo sin banco bloquea; todo conciliado = resuelta", () => {
  const ok = cuatro.map((c, i) => loc(c, mov(`m${i}`, c.fecha, c.lugar, -c.valor)));
  assert.equal(decidirAccion([compra()], ok).accion, "conciliar_existente");
  assert.equal(decidirAccion([], ok).accion, "crear_y_conciliar");
  const unoSin = [...ok.slice(0, 3), loc(cuatro[3], undefined, "no_encontrado")];
  const r = decidirAccion([compra()], unoSin);
  assert.equal(r.accion, "bloqueado"); assert.match(r.bloqueos[0], /Rist Pizz Tovo/);
  assert.equal(decidirAccion([compra(), compra({ id: "otra" })], ok).accion, "bloqueado");
  const todosConciliados = ok.map((x) => ({ ...x, situacion: "ya_conciliado" as const }));
  const pagos = ok.map((x, i) => ({ id: `p${i}`, centimos: Math.round(x.cargo.valor * 100), accountId: "acc", fecha: x.cargo.fecha }));
  assert.equal(decidirAccion([compra()], todosConciliados, pagos).accion, "ya_resuelta", "conciliados CON la compra del total");
  const r2 = decidirAccion([compra()], todosConciliados, pagos.slice(1));
  assert.equal(r2.accion, "bloqueado"); assert.match(r2.bloqueos[0], /con otro documento/);
  assert.equal(pagadoPorLaCompra(todosConciliados[0], pagos), true);
  // Monedas: mezcladas o no habilitadas → bloqueado (la conciliación múltiple solo está habilitada en EUR por defecto).
  const usd = loc(cargo("u", { moneda: "USD", lugar: "Uber", valor: 5 }), { ...mov("mu", "2026-09-07", "Uber", -5), moneda: "USD" });
  assert.match(decidirAccion([], [...ok, usd]).bloqueos[0], /mezclan monedas/);
  assert.match(decidirAccion([], [usd]).bloqueos[0], /no está habilitada en USD/);
});

test("el plan lee Holded y el banco una vez, suma el total y el texto dice gasto único + cargos con su movimiento", async () => {
  const d = decl(cuatro);
  const plan = await planificarAplicacion(d, {
    compras: async (_e, _d, total, moneda) => { assert.equal(total, 167.65); assert.equal(moneda, "EUR"); return [compra()]; },
    cargos: async (_e, cargos) => cargos.map((c, i) => loc(c, mov(`m${i}`, c.fecha, c.lugar, -c.valor))),
    pagos: async () => { throw new Error("no debe leer pagos si ningún cargo está conciliado"); },
  });
  assert.equal(plan.accion, "conciliar_existente");
  assert.equal(plan.compra?.id, "6ad0c5d3");
  const texto = textoPlan(plan);
  assert.match(texto, /un solo gasto de 167\.65 EUR por 4 cargo\(s\)/);
  assert.match(texto, /ya existe en Holded \(German Alejandro Robles/);
  assert.match(texto, /Rosso Brera · 80\.00 EUR → banco 2026-09-08 «Rosso Brera» \(Euros EWKS\)/);
});
