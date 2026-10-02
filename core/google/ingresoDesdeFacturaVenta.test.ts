import assert from "node:assert/strict";
import test from "node:test";
import { ingresoYaRegistrado, planificarIngresoDeFactura, semanaIsoDe, textoRespuestaFacturaProcesada } from "./ingresoDesdeFacturaVenta";
import type { DatosFacturaVenta } from "../documental/extractInvoiceData";

const factura = (extra: Partial<DatosFacturaVenta> = {}): DatosFacturaVenta => ({
  cliente: "Cliente Ejemplo SL", total: 12100, moneda: "EUR", fechaFactura: "2026-10-02", fechaVencimiento: "2026-11-15",
  numero: "F-2026-118", empresa: "WOBA", concepto: "Instalación audiovisual", ...extra,
});
const hoy = new Date("2026-10-02T10:00:00Z");

test("la semana del cashflow es la semana ISO de la fecha", () => {
  assert.equal(semanaIsoDe("2026-10-02")?.etiqueta, "S40");
  assert.equal(semanaIsoDe("2026-11-15")?.etiqueta, "S46");
  assert.equal(semanaIsoDe("2026-01-01")?.etiqueta, "S01");
  // El 1 de enero de 2027 es viernes: todavía pertenece a la semana 53 de 2026.
  assert.deepEqual(semanaIsoDe("2027-01-01"), { etiqueta: "S53", semana: 53, anio: 2026 });
  assert.equal(semanaIsoDe("2027-01-04")?.etiqueta, "S01");
  assert.equal(semanaIsoDe("2026-02-30"), undefined);
  assert.equal(semanaIsoDe(""), undefined);
});

test("la factura se propone en ingresos en la semana de su vencimiento, con el vencimiento visible en la fila", () => {
  const plan = planificarIngresoDeFactura(factura(), hoy)!;
  assert.equal(plan.semana, "S46");
  assert.equal(plan.valor, 12100);
  assert.equal(plan.empresa, "WOBA");
  assert.equal(plan.proyecto, "Factura F-2026-118 · vence 15/11/2026");
  assert.deepEqual(plan.avisos, []);
});

test("sin vencimiento se usa la fecha de emisión y se avisa; nunca se inventa una fecha", () => {
  const plan = planificarIngresoDeFactura(factura({ fechaVencimiento: "" }), hoy)!;
  assert.equal(plan.origenFecha, "factura");
  assert.equal(plan.semana, "S40");
  assert.match(plan.avisos[0], /no indica vencimiento/);
});

test("otra moneda u otro año se avisan y quedan escritos en la fila", () => {
  const plan = planificarIngresoDeFactura(factura({ moneda: "USD", fechaVencimiento: "2027-01-20", empresa: "EWORKS" }), hoy)!;
  assert.equal(plan.empresa, "EWORKS");
  assert.equal(plan.semana, "S03");
  assert.match(plan.proyecto, /vence 20\/01\/2027 · USD/);
  assert.equal(plan.avisos.length, 2);
});

test("una factura de Footprint no entra: el cashflow solo cubre WOBA y eWorks", () => {
  assert.equal(planificarIngresoDeFactura(factura({ empresa: "Footprint" }), hoy), undefined);
  assert.equal(planificarIngresoDeFactura(factura({ empresa: "desconocida" }), hoy), undefined);
});

test("se avisa si la factura ya parece estar en ingresos (por su número, o por cliente y semana con el mismo importe)", () => {
  const plan = planificarIngresoDeFactura(factura(), hoy)!;
  const fila = (extra: Record<string, string>) => ({ categoria: "INGRESOS" as const, semana: "S46", valor: "12.100,00 €", cliente: "Otro", ...extra });
  assert.ok(ingresoYaRegistrado([fila({ proyecto: "Factura F-2026-118 · vence 15/11/2026" })], plan, "F-2026-118"));
  assert.ok(ingresoYaRegistrado([fila({ cliente: "CLIENTE EJEMPLO SL" })], plan, "F-2026-118"));
  assert.equal(ingresoYaRegistrado([fila({ cliente: "CLIENTE EJEMPLO SL", semana: "S47" })], plan, "F-2026-118"), undefined);
  assert.equal(ingresoYaRegistrado([fila({ valor: "500,00 €", proyecto: "Factura F-2026-118" })], plan, "F-2026-118"), undefined);
});

test("la respuesta al remitente dice qué factura, cuánto, cuándo vence y en qué semana quedó", () => {
  const f = factura();
  const texto = textoRespuestaFacturaProcesada(f, planificarIngresoDeFactura(f, hoy)!);
  assert.match(texto, /factura F-2026-118 de WOBA a Cliente Ejemplo SL por 12100\.00 EUR, con vencimiento el 15\/11\/2026/);
  assert.match(texto, /registrado en el cashflow, en ingresos de la semana 46/);
});
