import assert from "node:assert/strict";
import test from "node:test";
import type { MovimientoBanco } from "../holded/pagosMultiples/pagos";
import { buscarCargoParcial, consultarCargoParcial, conciliarParcialDeRecibo, palabraDistintiva, seleccionarCargoParcial, textoOfertaParcial } from "./conciliacionParcialRecibo";

const mov = (movementId: string, descripcion: string, monto: number, fecha = "2026-09-28"): MovimientoBanco =>
  ({ accountId: "ftg-usd", cuenta: "FTG USD", movementId, fecha, monto, moneda: "USD", descripcion });
const gasto = { empresa: "Footprint" as const, proveedor: "Metroart Hotel", monto: 581.92, moneda: "USD", fecha: "2026-09-27" };

test("caso Metroart: el único cargo libre del hotel, menor que el gasto, es una parte del recibo", () => {
  const r = seleccionarCargoParcial([mov("a".repeat(24), "Metroart Hotel", 451.30), mov("b".repeat(24), "Uber Pending", 5.95)], gasto);
  assert.equal(r?.monto, 451.30);
});
test("no se ofrece nada con varios candidatos, importes minúsculos, el importe completo u otro proveedor", () => {
  assert.equal(seleccionarCargoParcial([mov("a".repeat(24), "Metroart Hotel", 451.30), mov("b".repeat(24), "Metroart Hotel", 130.62)], gasto), undefined, "dos candidatos del mismo proveedor: ambiguo");
  assert.equal(seleccionarCargoParcial([mov("a".repeat(24), "Metroart Hotel", 12.00)], gasto), undefined, "menos del 10 % del gasto no es «una parte»");
  assert.equal(seleccionarCargoParcial([mov("a".repeat(24), "Metroart Hotel", 581.92)], gasto), undefined, "el importe completo lo resuelve la búsqueda normal");
  assert.equal(seleccionarCargoParcial([mov("a".repeat(24), "Metroart Hotel", 600)], gasto), undefined, "mayor que el gasto: es el cargo mayor, otro flujo");
  assert.equal(seleccionarCargoParcial([mov("a".repeat(24), "Hotel Playa Sol", 451.30)], gasto), undefined, "otro proveedor");
  assert.equal(seleccionarCargoParcial([mov("a".repeat(24), "Metroart Hotel", 451.30)], { ...gasto, proveedor: "" }), undefined, "sin proveedor identificable no se adivina");
});
test("la coincidencia exige la palabra DISTINTIVA del proveedor: las genéricas (Hotel, Management, Group…) no bastan", () => {
  assert.equal(palabraDistintiva("Metroart Hotel"), "metroart");
  assert.equal(palabraDistintiva("Management Group Investors, LLC"), undefined);
  assert.equal(palabraDistintiva("Madrid Hotel 101 Spain Management"), "madrid");
  assert.equal(palabraDistintiva("Hotel"), undefined);
  assert.equal(seleccionarCargoParcial([mov("a".repeat(24), "Hotel Playa Sol", 451.30)], gasto), undefined);
  assert.equal(seleccionarCargoParcial([mov("a".repeat(24), "METROART HOTEL BARCELONA", 451.30)], gasto)?.monto, 451.30);
  assert.equal(seleccionarCargoParcial([mov("a".repeat(24), "Dlc*uber Rides", 6)], { ...gasto, proveedor: "Uber", monto: 20 })?.monto, 6);
});
test("un proveedor frecuente con muchos cargos libres (Uber) no genera oferta", () => {
  const uber = { empresa: "Footprint" as const, proveedor: "Uber", monto: 8.95, moneda: "USD", fecha: "2026-09-28" };
  assert.equal(seleccionarCargoParcial([mov("a".repeat(24), "Uber Pending", 6.91), mov("b".repeat(24), "Uber Pending", 2.04), mov("c".repeat(24), "Uber Pending", 5.95)], uber), undefined);
});
test("buscarCargoParcial lee el banco con la empresa, moneda y fecha del gasto", async () => {
  let visto = "";
  const r = await buscarCargoParcial(gasto, async (e, m, f) => { visto = `${e}|${m}|${f}`; return [mov("a".repeat(24), "Metroart Hotel", 451.30)]; });
  assert.equal(visto, "Footprint|USD|2026-09-27");
  assert.equal(r?.movementId, "a".repeat(24));
});
test("sin palabra distintiva no se lee el banco", async () => {
  let lecturas = 0;
  const r = await buscarCargoParcial({ ...gasto, proveedor: "Management Group Investors LLC" }, async () => { lecturas++; return []; });
  assert.equal(r, undefined); assert.equal(lecturas, 0);
});
test("el texto de la oferta dice cuánto queda abierto y que solo se concilie si es parte del recibo", () => {
  const t = textoOfertaParcial(mov("a".repeat(24), "Metroart Hotel", 451.30), gasto, "Metroart Hotel — 581.92 USD");
  assert.match(t, /451\.30 USD/); assert.match(t, /130\.62 USD ABIERTOS/); assert.match(t, /Si no es una parte de este recibo, no lo concilies/);
});

const pend = { empresa: "Footprint" as const, chatId: 7, gastoId: "compra1", proveedor: "Metroart Hotel", monto: 581.92, moneda: "USD", fecha: "2026-09-27" };
const idOk = "a".repeat(24);
test("ejecución: concilia en modo parcial con el único cargo y explica lo que queda abierto", async () => {
  const llamadas: unknown[] = [];
  const servicio = {
    preparar: async (d: unknown) => { llamadas.push(d); return { id: "plan1" }; },
    decidir: async (id: string, chat: number, usuario: number, aprobar: boolean) => { llamadas.push([id, chat, usuario, aprobar]); return { estado: "completado", compra: { pendienteCentimos: 13062, moneda: "USD" } }; },
  };
  const r = await conciliarParcialDeRecibo(pend, idOk, 99, { leer: async () => [mov(idOk, "Metroart Hotel", 451.30)], servicio });
  assert.equal(r.estado, "conciliada");
  assert.match(r.nota, /130\.62 USD ABIERTOS/);
  assert.equal((llamadas[0] as { parcial: boolean }).parcial, true);
  assert.deepEqual((llamadas[0] as { movimientos: unknown[] }).movimientos, [{ accountId: "ftg-usd", movementId: idOk, fecha: "2026-09-28" }]);
  assert.deepEqual(llamadas[1], ["plan1", 7, 99, true]);
});
test("ejecución: si el cargo ofrecido ya no es el único candidato no se concilia nada", async () => {
  let preparado = false;
  const servicio = { preparar: async () => { preparado = true; return { id: "x" }; }, decidir: async () => ({ estado: "completado", compra: { pendienteCentimos: 0, moneda: "USD" } }) };
  const r = await conciliarParcialDeRecibo(pend, idOk, 99, { leer: async () => [mov("b".repeat(24), "Metroart Hotel", 451.30)], servicio });
  assert.equal(r.estado, "fallida"); assert.equal(preparado, false);
});
test("ejecución: un plan incierto se informa como incierto; un rechazo o un error, como fallida; nunca lanza", async () => {
  const leer = async () => [mov(idOk, "Metroart Hotel", 451.30)];
  const con = (estado: string, detalle?: string) => ({ preparar: async () => ({ id: "p" }), decidir: async () => ({ estado, detalle, compra: { pendienteCentimos: 0, moneda: "USD" } }) });
  assert.equal((await conciliarParcialDeRecibo(pend, idOk, 1, { leer, servicio: con("incierto", "x") })).estado, "incierta");
  assert.equal((await conciliarParcialDeRecibo(pend, idOk, 1, { leer, servicio: con("rechazado", "cambió") })).estado, "fallida");
  const roto = { preparar: async () => { throw new Error("Holded caído"); }, decidir: async () => ({ estado: "completado", compra: { pendienteCentimos: 0, moneda: "USD" } }) };
  const r = await conciliarParcialDeRecibo(pend, idOk, 1, { leer, servicio: roto });
  assert.equal(r.estado, "fallida"); assert.match(r.nota, /Holded caído/);
});

test("consulta: un fallo del banco se distingue de «no hay cargo» (no se traga el error)", async () => {
  assert.deepEqual(await consultarCargoParcial(gasto, async () => []), { tipo: "ninguno" });
  const r = await consultarCargoParcial(gasto, async () => { throw new Error("Holded 503"); });
  assert.equal(r.tipo, "consulta_fallida"); assert.match((r as { motivo: string }).motivo, /503/);
  assert.equal((await consultarCargoParcial(gasto, async () => [mov("a".repeat(24), "Metroart Hotel", 451.30)])).tipo, "oferta");
});
