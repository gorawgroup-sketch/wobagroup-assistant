import assert from "node:assert/strict";
import test from "node:test";
import {
  cargoQueYaSoporta, componerAnalisis, extraerListaCargos, hechosDelCargo, limpiarCuerpoSinCitas, parsearAsuntoRespuesta, proponerAccionCargo,
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

test("la lista de cargos del modelo se acepta como lista, como texto JSON o como texto con el objeto envuelto (caso real 07-10)", () => {
  const items = [{ numero: 1, situacion: "no_reconoce", lo_que_dice: "no es mío" }];
  assert.deepEqual(extraerListaCargos({ cargos: items }), items);
  assert.deepEqual(extraerListaCargos({ cargos: JSON.stringify(items) }), items);
  assert.deepEqual(extraerListaCargos({ cargos: JSON.stringify({ cargos: items }) }), items, "envuelto: {\"cargos\":\"{\\\"cargos\\\":[…]}\"}");
  assert.equal(extraerListaCargos({ cargos: "esto no es json" }), undefined);
  assert.equal(extraerListaCargos({ cargos: 5 }), undefined);
  assert.equal(extraerListaCargos(undefined), undefined);
});

import { extraerCuerpoCitado } from "./respuestaSoportes";
// Caso real (Kelly, 14-10-2026): respondió anotando junto a cada fila de la tabla citada; el cuerpo propio solo traía saludo y firma.
test("extraerCuerpoCitado conserva la tabla citada con las anotaciones de la persona junto a cada cargo", () => {
  const cuerpo = [
    "Hola, les envío.", "Saludos, Kelly", "",
    "El lun, 13 oct 2026 a las 9:00, Admin Asistente <asistente@wobagroup.com> escribió:",
    "> 1 | 17/08/2026 | Airbnb * Hm9rh5qbqw | 495,13 USD | Pendiente. ENVIADO",
    "> 2 | 02/09/2026 | Dlo*serv Uber Eats Ca | 0,45 USD | Pendiente. NO LO ENCUENTRO COMO SOPORTE EN UBER",
    ">> 7 | 30/09/2026 | Cafe Pergamino 10b | 28,49 USD | Pendiente REENVIADO COMO 21.16 euros - Desayuno com Yanessy - Visa",
  ].join("\n");
  const citado = extraerCuerpoCitado(cuerpo);
  assert.match(citado, /Airbnb \* Hm9rh5qbqw .*ENVIADO/);
  assert.match(citado, /NO LO ENCUENTRO COMO SOPORTE EN UBER/);
  assert.match(citado, /^7 \| 30\/09\/2026 .*REENVIADO COMO 21\.16 euros/m);
  assert.doesNotMatch(citado, /Saludos, Kelly/);
});

// Carlos, 14-10-2026: en todos los cargos sin comprobante se envía el formato de transacciones sin soporte de la empresa para firma.
test("un cargo reconocido sin recibo se cubre con la declaración de gastos sin soporte y la acción sugerida la prepara", () => {
  const a = componerAnalisis({
    nombre: "Kelly Johanna Correales", empresa: "Footprint", email: "kelly@footprint.global",
    cargos: [CARGOS[1]],
    interpretaciones: [{ numero: 1, situacion: "sin_recibo", loQueDice: "No lo encuentro como soporte en Uber, seguramente es un cargo adicional" }],
    hechos: [{}], soportes: [],
  });
  assert.match(a.resumen, /Reconoce el cargo pero no tiene ni puede conseguir el comprobante/);
  assert.match(a.resumen, /declaración de gastos sin soporte/);
  assert.match(a.accionSugerida, /preparar_declaracion_gastos_sin_soporte/);
  assert.match(a.accionSugerida, /Footprint/);
  assert.match(a.accionSugerida, new RegExp(`id ${CARGOS[1].id}`));
  assert.doesNotMatch(a.accionSugerida, /pidiéndole solo lo que falta/);
});

import { emparejarCorreoAnterior, localizarSoportesEnviadosAntes } from "./respuestaSoportes";
// Caso real Kelly (14-10-2026): «REENVIADO» sin adjunto; el recibo llegó en un correo anterior ya registrado.
test("«ya lo envié» sin adjunto: se localiza el correo anterior por importe o por el asunto citado, y su gasto registrado", async () => {
  const cargo = { ...CARGOS[1], fecha: "2026-09-30", comercio: "Cafe Pergamino 10b", total: -28.49, monedaCuenta: "USD", importeOriginal: 95711, monedaOriginal: "COP" };
  const correos = [
    { id: "m1", asunto: "21.16 euros - Desayuno com Yanessy - Visa", fecha: "2026-09-30" },
    { id: "m2", asunto: "9.55 euros - Almuerzo MED - Visa", fecha: "2026-09-30" },
    { id: "m3", asunto: "28,49 USD - Otro - Visa", fecha: "2026-08-01" },
  ];
  const dice: InterpretacionCargo = { numero: 1, situacion: "soporte_enviado_antes", loQueDice: "Anota 'REENVIADO COMO 21.16 euros - Desayuno com Yanessy - Visa' junto al cargo" };
  assert.equal(emparejarCorreoAnterior(cargo, dice, correos)?.id, "m1", "por el asunto citado en su respuesta");
  assert.equal(emparejarCorreoAnterior({ ...cargo, total: -9.55 }, { ...dice, loQueDice: "reenviado" }, correos)?.id, "m2", "por el importe del cargo en el asunto");
  assert.equal(emparejarCorreoAnterior({ ...cargo, total: -28.49 }, { ...dice, loQueDice: "reenviado" }, correos), undefined, "fuera de la ventana de fechas no cuenta");

  const interpretaciones: InterpretacionCargo[] = [dice];
  const soportes = await localizarSoportesEnviadosAntes("kelly@footprint.global", "Footprint", [cargo], interpretaciones, {
    correosDe: async () => correos,
    registros: async () => [{ mensajeIdGmail: "m1", gastoId: "g-21", empresa: "Footprint", creadoEn: 1, identidad: { proveedor: "CAFE DE SANTA BARBARA S.A.S", monto: 21.16, moneda: "EUR", fecha: "2026-09-30" } } as never],
  });
  assert.equal(soportes.length, 1);
  assert.equal(soportes[0].yaRegistrado?.gastoId, "g-21");
  assert.equal(interpretaciones[0].adjunto, soportes[0].nombre, "la interpretación queda enlazada al soporte localizado");
  const a = componerAnalisis({ nombre: "Kelly", cargos: [cargo], interpretaciones, hechos: [{}], soportes });
  assert.match(a.resumen, /ya estaba registrado como gasto/);
  assert.match(a.resumen, /Conciliar ese gasto ya registrado con este cargo/);
  assert.doesNotMatch(a.accionSugerida, /pidiéndole solo lo que falta/);
});

test("«ya lo envié» con el correo anterior aún en la cola: no se le pide nada, se procesa ese correo", async () => {
  const cargo = { ...CARGOS[1], fecha: "2026-10-01", comercio: "Crepes Y Waffles Pobla", total: -65.67, monedaCuenta: "EUR" };
  const interpretaciones: InterpretacionCargo[] = [{ numero: 1, situacion: "soporte_enviado_antes", loQueDice: "REENVIADO" }];
  const soportes = await localizarSoportesEnviadosAntes("k@x.com", "Footprint", [cargo], interpretaciones, {
    correosDe: async () => [{ id: "m8", asunto: "Fwd: 65,67 euros - Cena Team Colombia - Visa", fecha: "2026-10-11" }],
    registros: async () => [],
  });
  assert.equal(soportes[0]?.enColaSinProcesar, true);
  const a = componerAnalisis({ nombre: "Kelly", cargos: [cargo], interpretaciones, hechos: [{}], soportes });
  assert.match(a.resumen, /sigue en la cola de revisión, aún sin registrar/);
  assert.doesNotMatch(a.accionSugerida, /pidiéndole/);
});
