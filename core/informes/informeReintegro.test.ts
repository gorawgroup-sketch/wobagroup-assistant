import assert from "node:assert/strict";
import test from "node:test";
import { estadoDePago, etiquetaCoincide, tieneEtiqueta, type GastoEtiquetado } from "../holded/gastosPorEtiqueta";
import { categoriaDeGasto, describirPeriodo, generarInformeReintegroPDF, importe, resumirReintegro } from "./informeReintegro";
import { gastosNumerados, nombreComprobante, rangoDeMes } from "./reintegroTelegram";

const gasto = (extra: Partial<GastoEtiquetado>): GastoEtiquetado => ({
  id: "a".repeat(24), fecha: "2026-09-10", proveedor: "Bolt", descripcion: "Traslado", numeroDocumento: "", total: 15, moneda: "EUR",
  tags: ["nuriaortiz", "taxi", "transporte"], pendiente: 0, pagos: [{ fecha: "2026-09-10", importe: 15, cuenta: "Main" }], estado: "pagado", esTicket: true, ...extra,
});

// Caso real (Footprint, 2026-10-02): «nuria» no encontraba los 26 tickets etiquetados «nuriaortiz».
test("la etiqueta de una persona encuentra sus variantes, sin arrastrar nombres cortos parecidos", () => {
  assert.equal(etiquetaCoincide("nuria", "nuriaortiz"), true);
  assert.equal(etiquetaCoincide("Nuria Ortiz", "nuria"), true);
  assert.equal(etiquetaCoincide("#Nuria", "NURIA"), true);
  assert.equal(etiquetaCoincide("nuria", "kelly"), false);
  assert.equal(etiquetaCoincide("ana", "anabel"), false);
  assert.equal(tieneEtiqueta("nuria", ["alimentacion", "kelly", "nuria"]), true);
  assert.equal(tieneEtiqueta("hospedaje", ["alojamiento"]), true);
});

test("pagado en bancos = sin saldo pendiente y con pago registrado; un pago de más también está pagado", () => {
  assert.equal(estadoDePago(463.01, 0, 1), "pagado");
  assert.equal(estadoDePago(2.73, -0.27, 1), "pagado");
  assert.equal(estadoDePago(152, 152, 0), "sin_pagar");
  assert.equal(estadoDePago(463.01, 0, 0), "sin_pagar");
  assert.equal(estadoDePago(100, 40, 1), "parcial");
});

test("los totales separan pagado, sin pagar y total, y cuadran entre sí", () => {
  const r = resumirReintegro([
    gasto({ total: 463.01, tags: ["nuria", "renting"], proveedor: "Northgate" }),
    gasto({ total: 15 }),
    gasto({ total: 152, pendiente: 152, pagos: [], estado: "sin_pagar", tags: ["avion", "nuriaortiz", "transporte"], proveedor: "Air France" }),
    gasto({ total: 100, pendiente: 40, estado: "parcial", tags: ["hospedaje", "nuriaortiz"], proveedor: "Hotel" }),
    gasto({ total: 50, moneda: "USD", proveedor: "Otro" }),
  ]);
  assert.equal(r.moneda, "EUR");
  assert.equal(r.total, 730.01);
  assert.equal(r.totalSinPagar, 192);
  assert.equal(r.totalPagado, 538.01);
  assert.equal(r.totalPagado + r.totalSinPagar, r.total);
  assert.equal(r.pagados.length, 2);
  assert.equal(r.sinPagar.length, 2);
  assert.equal(r.otrasMonedas.length, 1);
  assert.deepEqual(r.porCategoria.map((c) => c.categoria), ["Vehículo (renting / alquiler)", "Avión", "Hospedaje", "Taxi"]);
  assert.equal(r.porCategoria.reduce((s, c) => s + c.total, 0), r.total);
});

test("categoría, periodo, importes y mes se escriben como en un documento formal", () => {
  assert.equal(categoriaDeGasto(["nuriaortiz", "taxi", "transporte"]), "Taxi");
  assert.equal(categoriaDeGasto(["nuriaortiz", "transporte", "tren"]), "Tren y transporte público");
  assert.equal(categoriaDeGasto(["nuria"]), "Otros");
  assert.equal(describirPeriodo("2026-09-01", "2026-09-30"), "septiembre de 2026");
  assert.equal(describirPeriodo("2026-09-01", "2026-09-15"), "01/09/2026 – 15/09/2026");
  assert.equal(importe(1862.99), "1.862,99 €");
  assert.equal(importe(4.2), "4,20 €");
  assert.equal(importe(1234567.5, "USD"), "1.234.567,50 USD");
  assert.deepEqual(rangoDeMes("2026-02"), { desde: "2026-02-01", hasta: "2026-02-28" });
  assert.equal(rangoDeMes("2026-13"), undefined);
});

test("los comprobantes se numeran igual que el informe: primero pagados, después sin pagar", () => {
  const sinPagar = gasto({ fecha: "2026-09-03", proveedor: "Air France", total: 152, pendiente: 152, pagos: [], estado: "sin_pagar" });
  const pagado = gasto({ fecha: "2026-09-23", proveedor: "IBERIA LÍNEAS AÉREAS", total: 138.08 });
  const numerados = gastosNumerados([sinPagar, pagado]);
  assert.deepEqual(numerados.map((n) => [n.numero, n.gasto.proveedor]), [[1, "IBERIA LÍNEAS AÉREAS"], [2, "Air France"]]);
  assert.equal(nombreComprobante(1, pagado, "billete iberia.PDF", 0), "01_2026-09-23_IBERIA_LINEAS_AEREAS_138,08.pdf");
  assert.equal(nombreComprobante(2, sinPagar, "captura", 1), "02_2026-09-03_Air_France_152,00_2.pdf");
});

test("el informe se genera como PDF válido, sin páginas en blanco por el pie", async () => {
  const gastos = Array.from({ length: 28 }, (_, i) => gasto({ id: String(i).padStart(24, "0"), descripcion: `Traslado ${i} → reunión “cliente” en Barcelona`, total: 10 + i }));
  const pdf = await generarInformeReintegroPDF({
    empresa: "Footprint", persona: "Nuria Ortiz", etiqueta: "nuria", desde: "2026-09-01", hasta: "2026-09-30", destinatario: "MIMO",
    gastos, cobertura: { facturasListadas: 34, comprasPropiasLeidas: 266, lecturasFallidas: 1 }, emitido: new Date("2026-10-02T10:00:00Z"),
  });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const paginas = (pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length;
  assert.ok(paginas >= 2 && paginas <= 3, `páginas: ${paginas}`);
});
