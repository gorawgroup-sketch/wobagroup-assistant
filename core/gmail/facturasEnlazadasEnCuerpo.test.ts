import assert from "node:assert/strict";
import test from "node:test";
import { verificarFacturasEnlazadasEnCuerpo, type DependenciasFacturasEnlazadas } from "./facturasEnlazadasEnCuerpo";
import type { DatosFactura } from "../documental/extractInvoiceData";

const htmlTresEnlaces = `
  <p>please find attached the documents for your stay.</p>
  <a href="https://ejemplo.house/invoice/1.pdf">invoice_2026000097-rk_1.pdf</a>
  <a href="https://ejemplo.house/invoice/2.pdf">invoice_2026001038-fk_2.pdf</a>
  <a href="https://ejemplo.house/invoice/3.pdf">invoice_2026000098-rk_3.pdf</a>
`;

function factura(parcial: Partial<DatosFactura>): DatosFactura {
  return {
    esFacturaOGasto: true, proveedor: "Proveedor", monto: 0, moneda: "EUR",
    fecha: "2026-09-20", concepto: "Concepto", reciboSimplificado: true,
    lineas: [{ concepto: "Concepto", base: 0, tipoIvaPct: 0 }],
    empresaProbable: "Footprint", confianza: "alta", razon: "prueba",
    ...parcial,
  };
}

const gastoDelCuerpo = factura({
  monto: 259.44, moneda: "EUR", fecha: "", proveedor: "Queen Home Apartments srls",
  concepto: "Hospedaje Italia — Queen Home Apartments srls (3 facturas que suman el total pagado)",
  personaAsociada: "Yessenia Dos Prazeres",
});

/** Cada llamada a `extraer` devuelve el siguiente dato de la lista, en el mismo orden en que se procesan los enlaces. */
function depsPorOrden(datos: DatosFactura[]): DependenciasFacturasEnlazadas {
  let i = 0;
  return {
    descargar: async () => Buffer.from("%PDF-1.4 simulado"),
    extraer: async () => datos[i++] ?? factura({ esFacturaOGasto: false, monto: 0 }),
  };
}

test("caso real (Queen Home Apartments): 3 facturas cuya suma exacta coincide -> se verifica y se combina", async () => {
  const deps = depsPorOrden([
    factura({ numeroDocumento: "2026000097/RK", monto: 92.52, moneda: "EUR", fecha: "2026-09-20", concepto: "Hospedaje", reciboSimplificado: true }),
    factura({ numeroDocumento: "2026001038/FK", monto: 158.92, moneda: "EUR", fecha: "2026-09-20", concepto: "Servicios", reciboSimplificado: false,
      lineas: [{ concepto: "Servicios", base: 130.27, tipoIvaPct: 22 }] }),
    factura({ numeroDocumento: "2026000098/RK", monto: 8.00, moneda: "EUR", fecha: "2026-09-20", concepto: "Tasa turística", contextoDeViaje: true }),
  ]);
  const r = await verificarFacturasEnlazadasEnCuerpo(htmlTresEnlaces, gastoDelCuerpo, "contexto", deps);
  assert.equal(r.verificado, true);
  if (!r.verificado) return;
  assert.equal(r.leidas.length, 3);
  assert.equal(r.datosCombinados.monto, 259.44);
  assert.equal(r.datosCombinados.fecha, "2026-09-20", "rellena la fecha desde las facturas cuando el cuerpo no la trae");
  assert.equal(r.datosCombinados.numeroDocumento, "2026000097/RK + 2026001038/FK + 2026000098/RK");
  assert.equal(r.datosCombinados.contextoDeViaje, true);
  assert.match(r.datosCombinados.concepto, /92\.52/);
  assert.match(r.datosCombinados.concepto, /158\.92/);
  assert.match(r.datosCombinados.concepto, /8\.00/);
  // Conservador a propósito: sigue como recibo simplificado, una sola línea, sin reclamar el 22% de IVA italiano.
  assert.equal(r.datosCombinados.reciboSimplificado, true);
  assert.equal(r.datosCombinados.lineas.length, 1);
  assert.equal(r.datosCombinados.lineas[0].tipoIvaPct, 0);
});

test("si la suma NO cuadra con el importe del cuerpo, no se verifica y no se inventa nada", async () => {
  const deps = depsPorOrden([
    factura({ monto: 92.52, moneda: "EUR" }),
    factura({ monto: 100.00, moneda: "EUR" }), // no cuadra con 259.44
    factura({ monto: 8.00, moneda: "EUR" }),
  ]);
  const r = await verificarFacturasEnlazadasEnCuerpo(htmlTresEnlaces, gastoDelCuerpo, undefined, deps);
  assert.equal(r.verificado, false);
  if (r.verificado) return;
  assert.match(r.motivo ?? "", /no cuadra/);
});

test("menos de 2 enlaces en el cuerpo: no se intenta nada (ni una descarga)", async () => {
  let descargas = 0;
  const deps: DependenciasFacturasEnlazadas = {
    descargar: async () => { descargas++; return Buffer.from("%PDF-1.4"); },
    extraer: async () => factura({}),
  };
  const html = `<a href="https://ejemplo.com/unica.pdf">unica</a>`;
  const r = await verificarFacturasEnlazadasEnCuerpo(html, gastoDelCuerpo, undefined, deps);
  assert.equal(r.verificado, false);
  assert.equal(descargas, 0);
});

test("un enlace que falla al descargar no bloquea a los demás; si igual cuadra, se verifica con los que sí se leyeron", async () => {
  let descargaIntentada = 0;
  let extraidos = 0;
  const datosDeLosQueSiSeDescargan = [
    factura({ numeroDocumento: "A", monto: 251.44, moneda: "EUR", fecha: "2026-09-20" }),
    factura({ numeroDocumento: "B", monto: 8.00, moneda: "EUR", fecha: "2026-09-20" }),
  ];
  const deps: DependenciasFacturasEnlazadas = {
    descargar: async () => { descargaIntentada++; if (descargaIntentada === 2) throw new Error("timeout simulado"); return Buffer.from("%PDF-1.4"); },
    extraer: async () => datosDeLosQueSiSeDescargan[extraidos++],
  };
  const r = await verificarFacturasEnlazadasEnCuerpo(htmlTresEnlaces, gastoDelCuerpo, undefined, deps);
  // El 2º enlace falla al descargar; quedan el 1º y el 3º leídos: 251.44 + 8.00 = 259.44 -> sí cuadra.
  assert.equal(r.verificado, true);
  if (!r.verificado) return;
  assert.equal(r.leidas.length, 2);
  assert.equal(descargaIntentada, 3);
});

test("un documento leído que NO es factura/gasto (esFacturaOGasto:false) no cuenta como leído — con solo 1 válido, ni se intenta sumar", async () => {
  const deps = depsPorOrden([
    factura({ esFacturaOGasto: false, monto: 92.52, moneda: "EUR" }),
    factura({ esFacturaOGasto: false, monto: 158.92, moneda: "EUR" }),
    factura({ monto: 8.00, moneda: "EUR" }),
  ]);
  const r = await verificarFacturasEnlazadasEnCuerpo(htmlTresEnlaces, gastoDelCuerpo, undefined, deps);
  assert.equal(r.verificado, false);
  if (r.verificado) return;
  assert.equal(r.leidas.length, 1);
  assert.match(r.motivo ?? "", /1 de 3/);
});

test("un documento leído que NO es factura/gasto se descarta, y con los 2 restantes ya no cuadra la suma", async () => {
  const deps = depsPorOrden([
    factura({ monto: 92.52, moneda: "EUR" }),
    factura({ esFacturaOGasto: false, monto: 158.92, moneda: "EUR" }),
    factura({ monto: 8.00, moneda: "EUR" }),
  ]);
  const r = await verificarFacturasEnlazadasEnCuerpo(htmlTresEnlaces, gastoDelCuerpo, undefined, deps);
  assert.equal(r.verificado, false);
  if (r.verificado) return;
  assert.equal(r.leidas.length, 2);
  assert.match(r.motivo ?? "", /no cuadra/);
});

test("facturas en monedas distintas nunca se suman a ciegas", async () => {
  const deps = depsPorOrden([
    factura({ monto: 92.52, moneda: "EUR" }),
    factura({ monto: 158.92, moneda: "USD" }),
    factura({ monto: 8.00, moneda: "EUR" }),
  ]);
  const r = await verificarFacturasEnlazadasEnCuerpo(htmlTresEnlaces, gastoDelCuerpo, undefined, deps);
  assert.equal(r.verificado, false);
  if (r.verificado) return;
  assert.match(r.motivo ?? "", /monedas distintas/);
});

test("si las facturas leídas traen fechas distintas entre sí, no se adivina cuál usar", async () => {
  const deps = depsPorOrden([
    factura({ monto: 92.52, moneda: "EUR", fecha: "2026-09-18" }),
    factura({ monto: 158.92, moneda: "EUR", fecha: "2026-09-20" }),
    factura({ monto: 8.00, moneda: "EUR", fecha: "2026-09-20" }),
  ]);
  const r = await verificarFacturasEnlazadasEnCuerpo(htmlTresEnlaces, gastoDelCuerpo, undefined, deps);
  assert.equal(r.verificado, true);
  if (!r.verificado) return;
  assert.equal(r.datosCombinados.fecha, "", "el cuerpo ya no traía fecha y las facturas no coinciden: se deja en blanco");
});

test("si el cuerpo YA traía una fecha real, nunca se sobrescribe con la de las facturas", async () => {
  const conFecha = { ...gastoDelCuerpo, fecha: "2026-09-01" };
  const deps = depsPorOrden([
    factura({ monto: 92.52, moneda: "EUR", fecha: "2026-09-20" }),
    factura({ monto: 158.92, moneda: "EUR", fecha: "2026-09-20" }),
    factura({ monto: 8.00, moneda: "EUR", fecha: "2026-09-20" }),
  ]);
  const r = await verificarFacturasEnlazadasEnCuerpo(htmlTresEnlaces, conFecha, undefined, deps);
  assert.equal(r.verificado, true);
  if (!r.verificado) return;
  assert.equal(r.datosCombinados.fecha, "2026-09-01");
});

test("la confianza combinada nunca es mayor que la del documento menos confiable", async () => {
  const deps = depsPorOrden([
    factura({ monto: 92.52, moneda: "EUR", confianza: "alta" }),
    factura({ monto: 158.92, moneda: "EUR", confianza: "baja" }),
    factura({ monto: 8.00, moneda: "EUR", confianza: "media" }),
  ]);
  const r = await verificarFacturasEnlazadasEnCuerpo(htmlTresEnlaces, gastoDelCuerpo, undefined, deps);
  assert.equal(r.verificado, true);
  if (!r.verificado) return;
  assert.equal(r.datosCombinados.confianza, "baja");
});
