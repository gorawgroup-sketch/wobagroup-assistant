import assert from "node:assert/strict";
import test from "node:test";
import type { GastoEtiquetado } from "../holded/gastosPorEtiqueta";
import {
  aEquivalenteEurSiPagado, ajustarFiltrosAlBoton, aplicarFiltrosReintegro, codificarFiltros, decodificarFiltros,
  normalizarExclusiones, prepararGastosReintegro,
} from "./filtrosReintegro";
import { generarInformeReintegroPDF, resumirReintegro } from "./informeReintegro";
import { gastosNumerados } from "./reintegroTelegram";

const g = (extra: Partial<GastoEtiquetado>): GastoEtiquetado => ({
  id: "x".repeat(24), fecha: "2026-09-10", proveedor: "Bolt", descripcion: "Taxi", numeroDocumento: "", total: 10, moneda: "EUR",
  tags: ["nuriaortiz", "taxi"], pendiente: 0, pagos: [{ fecha: "2026-09-10", importe: 10, cuenta: "Main" }], estado: "pagado", esTicket: false, ...extra,
});

// Caso real Nuria Ortiz / MIMO (Footprint, septiembre 2026).
const northgate = g({ id: "1".repeat(24), proveedor: "NORTHGATE ESPAÑA RENTING FLEXIBLE SA", descripcion: "Renting vehículo SEAT Ibiza", total: 463.01, tags: ["renting"], pagos: [{ fecha: "2026-09-07", importe: 463.01, cuenta: "Main" }] });
const bolt = g({ id: "2".repeat(24), proveedor: "Bolt", total: 18.64 });
const kyriad = g({ id: "3".repeat(24), proveedor: "Kyriad Créteil Bonneuil sur Marne", total: 107.97, estado: "sin_pagar", pendiente: 107.97, pagos: [] });
const parcial = g({ id: "4".repeat(24), proveedor: "Parcial SA", total: 50, estado: "parcial", pendiente: 20, pagos: [{ fecha: "2026-09-10", importe: 30, cuenta: "Main" }] });
// Air France tras conciliarlo: documento en USD pagado con 151,95 € desde la cuenta USD.
const airFrance = g({ id: "5".repeat(24), proveedor: "Air France", descripcion: "Tiquete aéreo ida y vuelta Madrid ↔ París (Orly)", total: 176.12, moneda: "USD", tags: ["avion", "nuriaortiz"], pagos: [{ fecha: "2026-08-31", importe: 151.95, cuenta: "FTG USD" }] });
const todos = [northgate, bolt, kyriad, parcial, airFrance];

test("excluye Northgate (por proveedor, sin importar mayúsculas ni acentos) y deja solo los pagados en banco", () => {
  const f = { soloPagados: true, excluir: normalizarExclusiones(["Northgate España"]) };
  assert.deepEqual(f.excluir, ["northgateespan"], "se recorta a 14 caracteres: basta para identificar al proveedor");
  const r = prepararGastosReintegro(todos, f);
  assert.deepEqual(r.gastos.map((x) => x.proveedor), ["Bolt", "Air France"]);
  assert.deepEqual(r.excluidos.map((x) => x.proveedor), ["NORTHGATE ESPAÑA RENTING FLEXIBLE SA"]);
  assert.deepEqual(r.omitidosSinPagar.map((x) => x.proveedor), ["Kyriad Créteil Bonneuil sur Marne", "Parcial SA"]);
});

test("Air France pagado en USD se reintegra por lo que salió del banco en EUR (151,95), con el importe original en el concepto", () => {
  const eur = aEquivalenteEurSiPagado(airFrance);
  assert.equal(eur.moneda, "EUR");
  assert.equal(eur.total, 151.95);
  assert.match(eur.descripcion, /documento por 176\.12 USD/);
  const r = resumirReintegro(prepararGastosReintegro([bolt, airFrance], { soloPagados: true, excluir: [] }).gastos);
  assert.equal(r.total, 170.59);
  assert.equal(r.otrasMonedas.length, 0, "ya no queda fuera de los totales como «otra moneda»");
  // Un no pagado en otra moneda no se toca.
  assert.equal(aEquivalenteEurSiPagado({ ...airFrance, estado: "sin_pagar", pagos: [] }).moneda, "USD");
});

test("sin filtros no cambia nada salvo la conversión de lo pagado en otra moneda", () => {
  const r = aplicarFiltrosReintegro(todos, { soloPagados: false, excluir: [] });
  assert.equal(r.gastos.length, 5);
  assert.deepEqual([r.excluidos.length, r.omitidosSinPagar.length], [0, 0]);
});

test("los filtros viajan en el botón y el ZIP reconstruye la MISMA lista y numeración que el PDF", () => {
  const base = "reintegrozip:Footprint:nuriaortiz:2026-09-01:2026-09-30";
  const efectivo = ajustarFiltrosAlBoton(base, { soloPagados: true, excluir: normalizarExclusiones(["Northgate España"]) });
  const segmento = codificarFiltros(efectivo);
  assert.ok(Buffer.byteLength(`${base}:${segmento}`) <= 64, "cabe en el callback_data de Telegram");
  assert.deepEqual(decodificarFiltros(segmento), efectivo);
  const delPdf = gastosNumerados(prepararGastosReintegro(todos, efectivo).gastos);
  const delZip = gastosNumerados(prepararGastosReintegro(todos, decodificarFiltros(segmento)).gastos);
  assert.deepEqual(delZip.map((x) => [x.numero, x.gasto.id]), delPdf.map((x) => [x.numero, x.gasto.id]));
});

test("un fragmento largo se acorta lo justo para caber en 64 bytes y el informe usa el acortado; si no cabe ni al mínimo, avisa", () => {
  const base = "reintegrozip:Footprint:nuriaortiz:2026-09-01:2026-09-30";
  const efectivo = ajustarFiltrosAlBoton(base, { soloPagados: true, excluir: ["northgateespan"] });
  assert.ok(Buffer.byteLength(`${base}:${codificarFiltros(efectivo)}`) <= 64);
  assert.ok(efectivo.excluir[0].length >= 4 && "northgateespan".startsWith(efectivo.excluir[0]));
  // Con dos exclusiones largas no cabe ni recortando al mínimo: error claro, nunca un recorte silencioso que cambie la lista.
  assert.throws(() => ajustarFiltrosAlBoton(base, { soloPagados: true, excluir: ["northgateespan", "otroproveedor"] }), /Demasiadas exclusiones/);
  assert.throws(() => ajustarFiltrosAlBoton("x".repeat(60), { soloPagados: true, excluir: ["northgate"] }), /Demasiadas exclusiones/);
});

test("fragmentos demasiado cortos se descartan (excluirían gastos de más) y sin filtros el segmento es vacío", () => {
  assert.deepEqual(normalizarExclusiones(["ab", "Bolt"]), ["bolt"]);
  assert.equal(codificarFiltros({ soloPagados: false, excluir: [] }), "");
  assert.deepEqual(decodificarFiltros(undefined), { soloPagados: false, excluir: [] });
});

test("el PDF solo-pagados se genera (sin sección de sin pagar) y el normal sigue generándose", async () => {
  const cobertura = { facturasListadas: 34, comprasPropiasLeidas: 266, lecturasFallidas: 0 };
  const lista = prepararGastosReintegro(todos, { soloPagados: true, excluir: ["northgateespan"] }).gastos;
  const pdf = await generarInformeReintegroPDF({ empresa: "Footprint", persona: "Nuria Ortiz", etiqueta: "nuria", desde: "2026-09-01", hasta: "2026-09-30", destinatario: "MIMO", gastos: lista, cobertura, soloPagados: true, exclusiones: ["Northgate España"] });
  assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF");
  const normal = await generarInformeReintegroPDF({ empresa: "Footprint", persona: "Nuria Ortiz", etiqueta: "nuria", desde: "2026-09-01", hasta: "2026-09-30", gastos: todos, cobertura });
  assert.equal(normal.subarray(0, 4).toString("ascii"), "%PDF");
});
