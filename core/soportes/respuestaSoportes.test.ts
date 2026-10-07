import assert from "node:assert/strict";
import test from "node:test";
import {
  cargoQueYaSoporta, componerAnalisis, hechosDelCargo, limpiarCuerpoSinCitas, parsearAsuntoRespuesta, proponerAccionCargo,
  type InterpretacionCargo, type SoporteLeido,
} from "./respuestaSoportes";

const cargo = (o: Partial<{ fecha: string; comercio: string; total: number; monedaCuenta: string; importeOriginal: number; monedaOriginal: string }>) =>
  ({ id: "x", fecha: "2026-09-23", comercio: "Payu*uber", total: -7.37, monedaCuenta: "EUR", importeOriginal: 26971, monedaOriginal: "COP", tarjeta4: "2214", ...o });

// Los tres cargos reales de Alejandro (Footprint, 2026-10-06), en el orden de la tabla del correo.
const CARGOS = [
  cargo({ fecha: "2026-09-04", comercio: "Rappi* Verif $0.83 Usd", total: -0.83, monedaCuenta: "USD", importeOriginal: 0.83, monedaOriginal: "USD" }),
  cargo({ fecha: "2026-09-05", comercio: "Dlo*uber Rides", total: -1.25, importeOriginal: 24.2, monedaOriginal: "MXN" }),
  cargo({}),
];

test("el cuerpo de la respuesta se lee sin el correo citado debajo", () => {
  const cuerpo = [
    "Hola:", "", "1. Rappi: adjunto el comprobante.", "", "Saludos,", "", "On Tue, Oct 6, 2026 at 10:21 AM Admin Asistente <asistente@wobagroup.com>", "wrote:", "", "> Hola, Alejandro:", "> 1 04/09/2026 Rappi",
  ].join("\n");
  assert.equal(limpiarCuerpoSinCitas(cuerpo), "Hola:\n\n1. Rappi: adjunto el comprobante.\n\nSaludos,");
  assert.equal(limpiarCuerpoSinCitas("Sí\n> cita\n> otra"), "Sí");
  assert.equal(limpiarCuerpoSinCitas("El martes, 6 de oct de 2026, 10:21, Admin escribió:\n> hola\nresto"), "");
});

test("solo se reconoce la respuesta a la solicitud de soportes, no un reenvío ni otro asunto", () => {
  assert.deepEqual(parsearAsuntoRespuesta("Re: Footprint · Soportes pendientes de tus gastos con tarjeta (01/08/2026 – 06/10/2026)"), { empresa: "Footprint" });
  assert.deepEqual(parsearAsuntoRespuesta("RE: RE: WOBA · Soportes pendientes de tus gastos con tarjeta (…)"), { empresa: "WOBA" });
  assert.equal(parsearAsuntoRespuesta("Fwd: Footprint · Soportes pendientes de tus gastos con tarjeta"), undefined);
  assert.equal(parsearAsuntoRespuesta("Footprint · Factura de septiembre"), undefined);
  assert.equal(parsearAsuntoRespuesta("Re: URGENTE | Footprint: soportes de gastos sin conciliar"), undefined);
});

const movimientos = [
  { cuentaId: "usd", fecha: "2026-09-04", importe: -0.83, moneda: "USD", estado: "pending" },
  { cuentaId: "usd", fecha: "2026-09-05", importe: 0.83, moneda: "USD", estado: "reconciled" },
  { cuentaId: "eur", fecha: "2026-09-04", importe: -1.25, moneda: "EUR", estado: "pending" },
  { cuentaId: "eur", fecha: "2026-09-22", importe: -7.35, moneda: "EUR", estado: "reconciled" },
  { cuentaId: "eur", fecha: "2026-09-23", importe: -7.37, moneda: "EUR", estado: "pending" },
];

test("los hechos de cada cargo salen de Holded: su movimiento y el abono que lo compensa", () => {
  const rappi = hechosDelCargo(CARGOS[0], movimientos);
  assert.equal(rappi.movimiento?.estado, "pending");
  assert.deepEqual(rappi.reembolso, { fecha: "2026-09-05", importe: 0.83, moneda: "USD", estado: "reconciled" });
  assert.equal(hechosDelCargo(CARGOS[1], movimientos).reembolso, undefined);
  assert.equal(hechosDelCargo(CARGOS[2], movimientos).movimiento?.fecha, "2026-09-23", "7,37 no se confunde con el 7,35 del 22/09");
});

test("el comprobante ya registrado se asocia al otro cargo, ya conciliado, que lo soporta", () => {
  const otro = cargoQueYaSoporta({ gastoId: "g", proveedor: "Uber", monto: 7.35, moneda: "EUR", fecha: "2026-09-22" }, movimientos);
  assert.deepEqual(otro, { fecha: "2026-09-22", importe: 7.35, moneda: "EUR" });
  assert.equal(cargoQueYaSoporta({ gastoId: "g", monto: 7.35, moneda: "EUR", fecha: "2026-08-01" }, movimientos), undefined);
});

const pdf: SoporteLeido = { nombre: "Receipt_22sep.pdf", esGasto: true, proveedor: "Uber", monto: 26971, moneda: "COP", fecha: "2026-09-22", yaRegistrado: { gastoId: "6ab9", proveedor: "Uber", monto: 7.35, moneda: "EUR", fecha: "2026-09-22" }, cargoQueYaLoSoporta: { fecha: "2026-09-22", importe: 7.35, moneda: "EUR" } };
const captura: SoporteLeido = { nombre: "image.png", esGasto: false, descripcion: "captura de la app del banco con varios movimientos" };
const interpretaciones: InterpretacionCargo[] = [
  { numero: 1, situacion: "compensado_reembolso", loQueDice: "débito el 3/09 y reembolso el 4/09", adjunto: "image.png" },
  { numero: 2, situacion: "no_reconoce", loQueDice: "desconoce el débito" },
  { numero: 3, situacion: "soporte_adjunto", loQueDice: "reenvía el soporte de Uber", adjunto: "Receipt_22sep.pdf" },
];

test("caso real Alejandro: cada cargo recibe su propia acción y la respuesta solo pide lo que falta", () => {
  const hechos = CARGOS.map((c) => hechosDelCargo(c, movimientos));
  const a = componerAnalisis({ nombre: "Alejandro Florez Lopez", cargos: CARGOS, interpretaciones, hechos, soportes: [captura, pdf] });
  assert.equal(a.tipo, "necesita_respuesta");
  // 1 Rappi: cargo y reembolso se anulan, no se le pide nada
  assert.match(a.resumen, /1\. 04\/09\/2026 · Rappi.*\n.*Dice: débito el 3\/09.*\n.*abono de 0,83 USD el 05\/09 que compensa este cargo exactamente.*\n.*Cargo y reembolso se anulan: no hace falta ningún soporte/);
  // 2 Dlo*uber: no lo reconoce, se mantiene pendiente y no se le reclama de nuevo
  assert.match(a.resumen, /2\. 05\/09\/2026 · Dlo\*uber Rides[^]*Mantener el cargo pendiente como «no reconocido».*no volver a reclamárselo/);
  // 3 Payu*uber: el recibo ya soporta el 7,35 del 22/09 → pedir el del 23/09
  assert.match(a.resumen, /3\. 23\/09\/2026 · Payu\*uber[^]*ya soporta OTRO cargo, conciliado: 7,35 EUR del 22\/09[^]*Pedirle el recibo del viaje del 23\/09/);
  assert.match(a.accionSugerida, /^Responder a Alejandro confirmando lo resuelto y pidiéndole solo lo que falta: el recibo del cargo de 7,37 EUR del 23\/09/);
  assert.doesNotMatch(a.accionSugerida, /Rappi|Dlo\*uber/, "lo resuelto o no reconocido no se vuelve a pedir");
  assert.match(a.resumen, /Adjuntos leídos: image\.png \(captura de la app del banco.*\); Receipt_22sep\.pdf \(gasto: Uber 26\.971,00 COP\)/);
});

test("un comprobante nuevo se propone como gasto a crear y conciliar; uno ya registrado sin otro cargo se concilia con el gasto existente", () => {
  const nuevo = proponerAccionCargo(CARGOS[2], { numero: 3, situacion: "soporte_adjunto", loQueDice: "" }, {}, { nombre: "r.pdf", esGasto: true, proveedor: "Uber", monto: 7.37, moneda: "EUR", fecha: "2026-09-23" });
  assert.match(nuevo.accion, /Crear el gasto desde ese comprobante y conciliarlo con este cargo/);
  assert.equal(nuevo.pideAlRemitente, undefined);
  const registrado = proponerAccionCargo(CARGOS[2], { numero: 3, situacion: "soporte_adjunto", loQueDice: "" }, {}, { nombre: "r.pdf", esGasto: true, yaRegistrado: { gastoId: "g", proveedor: "Uber", monto: 7.35, moneda: "EUR", fecha: "2026-09-23" } });
  assert.match(registrado.accion, /Conciliar ese gasto ya registrado con este cargo/);
});

test("sin menciones, sin adjunto válido o con un adjunto que no es comprobante, se vuelve a pedir; un cargo ya conciliado se da por resuelto", () => {
  assert.match(proponerAccionCargo(CARGOS[2], undefined, {}, undefined).pideAlRemitente ?? "", /recibo del cargo de 7,37 EUR del 23\/09/);
  assert.match(proponerAccionCargo(CARGOS[2], { numero: 3, situacion: "soporte_enviado_antes", loQueDice: "" }, {}, undefined).resultado, /no encuentro ese comprobante/);
  assert.match(proponerAccionCargo(CARGOS[0], { numero: 1, situacion: "soporte_adjunto", loQueDice: "" }, {}, captura).resultado, /no es un comprobante de gasto/);
  assert.match(proponerAccionCargo(CARGOS[2], { numero: 3, situacion: "no_reconoce", loQueDice: "" }, { movimiento: { estado: "reconciled", fecha: "2026-09-23" } }, undefined).accion, /Nada que hacer/);
});

test("si dice que hubo reembolso y Holded no lo muestra, no se da por resuelto", () => {
  const p = proponerAccionCargo(CARGOS[0], { numero: 1, situacion: "compensado_reembolso", loQueDice: "" }, { movimiento: { estado: "pending", fecha: "2026-09-04" } }, undefined);
  assert.match(p.resultado, /no encuentro ese abono en Holded/);
  assert.match(p.accion, /Revisar el extracto/);
});

test("si nadie queda con nada pendiente, la respuesta propuesta solo agradece y confirma", () => {
  const a = componerAnalisis({ nombre: "Ana Prueba", cargos: [CARGOS[1]], interpretaciones: [{ numero: 1, situacion: "no_reconoce", loQueDice: "no es mío" }], hechos: [{}], soportes: [] });
  assert.match(a.accionSugerida, /agradeciendo la respuesta.*no queda nada por pedirle/);
  assert.match(a.resumen, /El correo no trae adjuntos\./);
});
