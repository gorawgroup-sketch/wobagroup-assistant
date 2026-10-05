import assert from "node:assert/strict";
import test from "node:test";
import type { PolizaConFila } from "../polizaRegistroSheet";
import {
  confirmarPagos,
  detectarCargosAnomalos,
  detectarDevoluciones,
  formaDePago,
  pagosVigilados,
  type EvaluadorLiquidacion,
} from "./cruces";
import type { MovimientoBanco } from "./tipos";

function poliza(parcial: Partial<PolizaConFila> & { id: string }): PolizaConFila {
  return {
    rowIndex: 2, empresa: "WOBA", empresaHolded: "WOBA", aseguradora: "Markel Insurance SE",
    correduria: "Acodrid Correduría de Seguros, S.A.", numeroPoliza: "", tipoCobertura: "Responsabilidad civil general",
    activoAsociado: "", capitalAsegurado: "", moneda: "EUR", franquicia: "", prima: "", periodicidad: "",
    cuentaDeCargo: "", fechaInicioVigencia: "", fechaVencimiento: "", estado: "vigente", estadoPago: "pendiente",
    fuenteExtraccion: "", notas: "", rutaDocumento: "", ultimaVerificacion: "", ...parcial,
  };
}

function mov(parcial: Partial<MovimientoBanco> & { id: string; fecha: string; descripcion: string; importe: number }): MovimientoBanco {
  return { empresa: "WOBA", cuentaId: "bbva", cuenta: "BBVA", moneda: "EUR", importeEur: parcial.importe, estado: "pending", saldoTras: null, ...parcial };
}

const liquidado: EvaluadorLiquidacion = () => ({ estado: "liquidado", cuentaFiable: true });
const enTransito: EvaluadorLiquidacion = () => ({ estado: "en_transito", cuentaFiable: true });
const huerfano: EvaluadorLiquidacion = () => ({ estado: "huerfano", cuentaFiable: true });
const cuentaNoFiable: EvaluadorLiquidacion = () => ({ estado: "sin_saldo", cuentaFiable: false });

const HOY = "2026-10-05";

// Casos reales (WOBA, septiembre-octubre de 2026).
const suplementoMarkel = poliza({ id: "woba_rc_suplemento_3_3", prima: "323.24" });
const cargoMarkel = mov({ id: "6ac321017157b2882d0e5a07", fecha: "2026-10-05", descripcion: "N 2026275001954588 Markel Insurance SE ADEUDO A SU CARGO", importe: -323.24 });

const showroomRenovacion = poliza({ id: "woba_showroom_2026_2027", aseguradora: "Allianz, Compañía de Seguros y Reaseguros, S.A.", prima: "1016.86" });
const showroomSuplemento = poliza({ id: "woba_showroom_complemento_2026_2027", aseguradora: "Allianz, Compañía de Seguros y Reaseguros, S.A.", prima: "289.14" });
const transferenciaAcodrid = mov({
  id: "6abe302ee953c890b8019160", fecha: "2026-09-30", cuentaId: "main", cuenta: "Main",
  descripcion: "To Correduria De Seguros Acodrid S A Poliza", importe: -1306,
});

test("la forma de pago se reconoce por cómo la describe el banco", () => {
  assert.equal(formaDePago("To Correduria De Seguros Acodrid S A Poliza"), "transferencia");
  assert.equal(formaDePago("To Markel Insurance Se Recibo 111190"), "transferencia");
  assert.equal(formaDePago("N 2026275001954588 Markel Insurance SE ADEUDO A SU CARGO"), "adeudo");
  assert.equal(formaDePago("MARKEL INSURANCE, W2764898I641, 033854807074936"), "otro");
});

test("un adeudo de Markel por el importe exacto del recibo se confirma cuando el saldo del banco lo refleja", () => {
  const r = confirmarPagos([suplementoMarkel], [cargoMarkel], HOY, liquidado);
  assert.equal(r.confirmados.length, 1);
  assert.equal(r.confirmados[0].movimiento.id, "6ac321017157b2882d0e5a07");
  assert.equal(r.confirmados[0].consolidado, false);
  assert.deepEqual(r.enTransito, []);
});

test("el mismo adeudo, visto hoy y todavía sin reflejar en el saldo, queda EN TRÁNSITO: no se da por pagado", () => {
  const r = confirmarPagos([suplementoMarkel], [cargoMarkel], HOY, enTransito);
  assert.equal(r.confirmados.length, 0);
  assert.equal(r.enTransito.length, 1);
  assert.match(r.enTransito[0].motivo, /todavía no lo refleja/);
});

test("un adeudo que el saldo no refleja y que ya tiene movimientos posteriores se considera devuelto", () => {
  const r = confirmarPagos([suplementoMarkel], [cargoMarkel], HOY, huerfano);
  assert.equal(r.confirmados.length, 0);
  assert.match(r.enTransito[0].motivo, /probablemente se devolvió/);
});

test("en una cuenta cuyo saldo no permite comprobar nada, un adeudo no se confirma solo", () => {
  const r = confirmarPagos([suplementoMarkel], [cargoMarkel], HOY, cuentaNoFiable);
  assert.equal(r.confirmados.length, 0);
  assert.match(r.enTransito[0].motivo, /no permite comprobar/);
});

test("una transferencia ordenada por nosotros se confirma aunque la cuenta no permita comprobar su saldo", () => {
  const r = confirmarPagos([showroomRenovacion, showroomSuplemento], [transferenciaAcodrid], HOY, cuentaNoFiable);
  assert.equal(r.confirmados.length, 1);
});

test("caso real: UNA transferencia de 1.306,00 € a Acodrid paga a la vez la renovación (1.016,86 €) y el suplemento (289,14 €)", () => {
  const r = confirmarPagos([showroomRenovacion, showroomSuplemento], [transferenciaAcodrid], HOY, liquidado);
  assert.equal(r.confirmados.length, 1);
  assert.equal(r.confirmados[0].consolidado, true);
  assert.deepEqual(r.confirmados[0].polizas.map((p) => p.id).sort(), ["woba_showroom_2026_2027", "woba_showroom_complemento_2026_2027"]);
  assert.deepEqual(r.sinPago, []);
});

test("el adeudo del 01/09 de Allianz (1.016,86 €) que el banco devolvió NO se toma por el pago de la renovación", () => {
  const adeudoDevuelto = mov({ id: "6a968cd8e0928bc515005b35", fecha: "2026-09-01", descripcion: "N 2026239000922517 ALLIANZ SEGUROS Y REASEGUROS, S.A. ADEUDO DE ALLIANZ SEGUROS", importe: -1016.86 });
  const r = confirmarPagos([showroomRenovacion], [adeudoDevuelto], "2026-09-20", huerfano);
  assert.equal(r.confirmados.length, 0);
  assert.equal(r.enTransito.length, 1);
});

test("dos recibos pendientes con el mismo importe y un solo cargo: ambiguo, no se adivina cuál es", () => {
  const otraRc = poliza({ id: "otra_rc", prima: "323.24" });
  const r = confirmarPagos([suplementoMarkel, otraRc], [cargoMarkel], HOY, liquidado);
  assert.equal(r.confirmados.length, 0);
  assert.equal(r.ambiguos.length, 2);
});

test("dos cargos posibles para un mismo recibo: ambiguo", () => {
  const repetido = mov({ id: "6ac321017157b2882d0e5a08", fecha: "2026-10-04", descripcion: "N 2026274000000001 Markel Insurance SE ADEUDO A SU CARGO", importe: -323.24 });
  const r = confirmarPagos([suplementoMarkel], [cargoMarkel, repetido], HOY, liquidado);
  assert.equal(r.confirmados.length, 0);
  assert.equal(r.ambiguos.length, 1);
});

test("un cargo con otro importe, de otra empresa o de otra contraparte no confirma nada", () => {
  const casiIgual = mov({ id: "a", fecha: "2026-10-05", descripcion: "Markel Insurance SE ADEUDO", importe: -323.25 });
  const otraEmpresa = mov({ id: "b", fecha: "2026-10-05", descripcion: "Markel Insurance SE ADEUDO", importe: -323.24, empresa: "EWORKS" });
  const otraContraparte = mov({ id: "c", fecha: "2026-10-05", descripcion: "Endesa Energia ADEUDO", importe: -323.24 });
  const r = confirmarPagos([suplementoMarkel], [casiIgual, otraEmpresa, otraContraparte], HOY, liquidado);
  assert.equal(r.confirmados.length, 0);
  assert.deepEqual(r.sinPago.map((p) => p.id), ["woba_rc_suplemento_3_3"]);
});

test("una entrada de dinero con el mismo importe no es un pago", () => {
  const abono = mov({ id: "d", fecha: "2026-10-05", descripcion: "From Markel Insurance Se", importe: 323.24 });
  const r = confirmarPagos([suplementoMarkel], [abono], HOY, liquidado);
  assert.equal(r.confirmados.length, 0);
});

test("la prima en texto libre no se cruza: queda como no verificable, nunca se adivina el importe", () => {
  const libre = poliza({ id: "base", prima: "1971.86 (2 cuotas semestrales: 1.016,86 + ~955 aprox)" });
  const r = confirmarPagos([libre], [transferenciaAcodrid], HOY, liquidado);
  assert.equal(r.noVerificables.length, 1);
  assert.equal(r.confirmados.length, 0);
});

test("lo ya pagado, vencido o sin contratar no se vuelve a cruzar", () => {
  const pagada = poliza({ id: "p1", prima: "323.24", estadoPago: "pagado" });
  const noContratada = poliza({ id: "p2", prima: "323.24", estado: "no_contratada" });
  const r = confirmarPagos([pagada, noContratada], [cargoMarkel], HOY, liquidado);
  assert.deepEqual(r, { confirmados: [], enTransito: [], ambiguos: [], noVerificables: [], sinPago: [] });
});

test("en una cuenta en otra divisa se compara el equivalente en EUR que calcula Holded", () => {
  const viaje = poliza({ id: "viaje", empresa: "Footprint", empresaHolded: "Footprint", aseguradora: "IATI", correduria: "", prima: "65.97" });
  const cargoUsd = mov({ id: "e", fecha: "2026-10-01", descripcion: "Iati Colombia", importe: -76.89, moneda: "USD", importeEur: -65.97, empresa: "Footprint", cuentaId: "usd" });
  const r = confirmarPagos([viaje], [cargoUsd], HOY, liquidado);
  assert.equal(r.confirmados.length, 1);
});

test("un cargo antiguo (fuera de la ventana de 60 días) no confirma un recibo nuevo con el mismo importe", () => {
  const delAnoPasado = mov({ id: "f", fecha: "2026-06-16", descripcion: "To Markel Insurance Se", importe: -323.24 });
  const r = confirmarPagos([suplementoMarkel], [delAnoPasado], HOY, liquidado);
  assert.equal(r.confirmados.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------

test("los pagos vigilados son los apuntes que el registro cita como prueba, recientes y de pólizas pagadas", () => {
  const pagada = poliza({ id: "woba_showroom_2026_2027", estadoPago: "pagado", aseguradora: "Allianz", notas: "Pagado: movimiento Holded 6abe302ee953c890b8019160 (30/09)" });
  const antigua = poliza({ id: "footprint_rc", estadoPago: "pagado", notas: "pagado el 27/08 (movimiento 6a914774ee0e2a8f6d0aafa5)" });
  const pendiente = poliza({ id: "pend", estadoPago: "pendiente", notas: "movimiento 6abe302ee953c890b8019160" });
  const viejoMov = mov({ id: "6a914774ee0e2a8f6d0aafa5", fecha: "2026-08-27", descripcion: "Markel Insurance Se Poliza Recibo", importe: -1671.03 });
  const v = pagosVigilados([pagada, antigua, pendiente], [transferenciaAcodrid, viejoMov], HOY);
  assert.deepEqual(v.map((x) => x.poliza.id), ["woba_showroom_2026_2027"]);
});

test("un abono posterior de la misma contraparte y del mismo importe es una devolución probable", () => {
  const pagada = poliza({ id: "woba_showroom_2026_2027", estadoPago: "pagado", aseguradora: "Allianz", notas: "movimiento 6abe302ee953c890b8019160" });
  const vigilados = pagosVigilados([pagada], [transferenciaAcodrid], HOY);
  const reembolso = mov({ id: "g", fecha: "2026-10-03", cuentaId: "main", cuenta: "Main", descripcion: "From Correduria De Seguros Acodrid S A Reembolso", importe: 1306 });
  const d = detectarDevoluciones(vigilados, [transferenciaAcodrid, reembolso], liquidado);
  assert.equal(d.length, 1);
  assert.equal(d[0].certeza, "probable");
  assert.equal(d[0].entrada?.id, "g");
});

test("un abono del mismo importe que solo dice «devolución» (sin nombrar a la aseguradora) es una devolución posible: solo se avisa", () => {
  const pagada = poliza({ id: "woba_rc_suplemento_3_3", estadoPago: "pagado", notas: "movimiento 6ac321017157b2882d0e5a07" });
  const vigilados = pagosVigilados([pagada], [cargoMarkel], HOY);
  const devolucion = mov({ id: "h", fecha: "2026-10-07", descripcion: "DEVOLUCION RECIBO N 2026275001954588", importe: 323.24 });
  const d = detectarDevoluciones(vigilados, [cargoMarkel, devolucion], liquidado);
  assert.equal(d.length, 1);
  assert.equal(d[0].certeza, "posible");
});

test("un cargo pagado que el saldo deja de reflejar, sin apunte contrario, es una devolución probable (así se devolvieron Allianz y Aegon)", () => {
  const pagada = poliza({ id: "woba_rc_suplemento_3_3", estadoPago: "pagado", notas: "movimiento 6ac321017157b2882d0e5a07" });
  const vigilados = pagosVigilados([pagada], [cargoMarkel], HOY);
  const d = detectarDevoluciones(vigilados, [cargoMarkel], huerfano);
  assert.equal(d.length, 1);
  assert.equal(d[0].entrada, null);
  assert.equal(d[0].certeza, "probable");
});

test("un abono de otro importe o de antes del pago no es una devolución", () => {
  const pagada = poliza({ id: "woba_rc_suplemento_3_3", estadoPago: "pagado", notas: "movimiento 6ac321017157b2882d0e5a07" });
  const vigilados = pagosVigilados([pagada], [cargoMarkel], HOY);
  const otroImporte = mov({ id: "i", fecha: "2026-10-06", descripcion: "From Markel Insurance Se", importe: 100 });
  const anterior = mov({ id: "j", fecha: "2026-10-01", descripcion: "From Markel Insurance Se", importe: 323.24 });
  assert.deepEqual(detectarDevoluciones(vigilados, [cargoMarkel, otroImporte, anterior], liquidado), []);
});

// ---------------------------------------------------------------------------------------------------------------

const registro = [
  poliza({ id: "woba_rc_markel", estadoPago: "pagado" }),
  poliza({ id: "woba_showroom_2026_2027", aseguradora: "Allianz, Compañía de Seguros y Reaseguros, S.A.", estadoPago: "pagado" }),
  poliza({ id: "eworks_rc_markel", empresa: "EWORKS", empresaHolded: "EWORKS", estadoPago: "pagado" }),
  poliza({ id: "woba_showroom_allianz", aseguradora: "Allianz", estado: "vencida", estadoPago: "pagado" }),
];

test("Aegon, Pelayo e IATI se pagan todos los meses y no son un aviso: decisiones de Carlos ya documentadas", () => {
  const silenciosos = [
    mov({ id: "1", fecha: "2026-10-01", descripcion: "N 2026273001083953 AEGON ESPANA S.A. ADEUDO DE SEGUROS", importe: -234.41 }),
    mov({ id: "2", fecha: "2026-08-24", cuentaId: "main", descripcion: "Pelayo Mutua", importe: -1039.53 }),
    mov({ id: "3", fecha: "2026-09-27", empresa: "Footprint", descripcion: "Iati Colombia", importe: -22.06 }),
  ];
  assert.deepEqual(detectarCargosAnomalos(registro, silenciosos, HOY, liquidado), []);
});

test("los cargos de las pólizas registradas (Markel de WOBA y de EWORKS, la transferencia a Acodrid) tampoco avisan", () => {
  const normales = [
    cargoMarkel,
    transferenciaAcodrid,
    mov({ id: "4", fecha: "2026-09-15", empresa: "EWORKS", cuentaId: "caixa", descripcion: "MARKEL INSURANCE, W2764898I641, 033854807074936", importe: -838.41 }),
  ];
  assert.deepEqual(detectarCargosAnomalos(registro, normales, HOY, liquidado), []);
});

test("una aseguradora que no está en el registro avisa UNA vez por contraparte, sea cual sea la remesa", () => {
  const nuevo = mov({ id: "5", fecha: "2026-10-12", descripcion: "N 2026285000999999 MAPFRE ESPANA ADEUDO DE SEGUROS", importe: -450 });
  const a = detectarCargosAnomalos(registro, [nuevo], "2026-10-12", liquidado);
  assert.equal(a.length, 1);
  assert.equal(a[0].tipo, "no_registrada");
  assert.equal(a[0].claveAviso, "cargo:WOBA:mapfre");
});

test("un cargo de Markel en una empresa que no tiene ninguna póliza de Markel también avisa", () => {
  const raro = mov({ id: "6", fecha: "2026-10-12", empresa: "Footprint", descripcion: "Markel Insurance Se Poliza", importe: -100 });
  const a = detectarCargosAnomalos(registro, [raro], "2026-10-12", liquidado);
  assert.equal(a[0]?.tipo, "no_registrada");
});

test("si la única póliza registrada de esa aseguradora está vencida, el cargo avisa cada mes", () => {
  const soloVencida = [poliza({ id: "vieja", aseguradora: "Allianz", estado: "vencida" })];
  const cargo = mov({ id: "7", fecha: "2026-10-12", descripcion: "ALLIANZ SEGUROS ADEUDO", importe: -900 });
  const a = detectarCargosAnomalos(soloVencida, [cargo], "2026-10-12", liquidado);
  assert.equal(a[0]?.tipo, "sin_poliza_vigente");
  assert.equal(a[0]?.claveAviso, "cargo:WOBA:allianz:2026-10");
});

test("un servicio dado de baja (Solunion) que vuelve a cobrar es una anomalía", () => {
  const cargo = mov({ id: "8", fecha: "2026-10-12", descripcion: "SOLUNION SEGUROS DE CREDITO ADEUDO", importe: -1305 });
  assert.equal(detectarCargosAnomalos(registro, [cargo], "2026-10-12", liquidado)[0]?.tipo, "dada_de_baja");
});

test("un cargo reciente de una aseguradora registrada que el saldo no refleja se avisa; uno de hace un mes ya es historia", () => {
  const reciente = mov({ id: "9", fecha: "2026-10-02", descripcion: "N 2026275000000009 ALLIANZ SEGUROS ADEUDO", importe: -289.14 });
  const antiguo = mov({ id: "10", fecha: "2026-09-01", descripcion: "N 2026239000922517 ALLIANZ SEGUROS Y REASEGUROS ADEUDO", importe: -1016.86 });
  const a = detectarCargosAnomalos(registro, [reciente, antiguo], HOY, huerfano);
  assert.deepEqual(a.map((x) => x.movimiento.id), ["9"]);
  assert.equal(a[0].tipo, "no_aplicado");
});

test("las entradas de dinero nunca se avisan como cargos", () => {
  const abono = mov({ id: "11", fecha: "2026-10-12", descripcion: "From Mapfre Espana Reembolso", importe: 450 });
  assert.deepEqual(detectarCargosAnomalos(registro, [abono], "2026-10-12", liquidado), []);
});
