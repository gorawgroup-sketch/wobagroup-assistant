import assert from "node:assert/strict";
import test from "node:test";
import type { EntradaConocimiento } from "./agente/conocimiento";
import type { DocumentoPoliza } from "./documentosPolizaStore";
import { entrada } from "./bitacora/pruebas";
import { ESTADO_SEGUROS_VACIO, HORARIOS_VIGILANTE, construirEstadoSeguros, invalidarComplementosSeguros, leerComplementosSeguros, type ComplementosSeguros } from "./estadoCerebro";
import { pago } from "./pagos/pruebas";
import type { PolizaConFila } from "./polizaRegistroSheet";
import { parsearUltimaRevision } from "./vigilante/ultimaRevision";

function poliza(parcial: Partial<PolizaConFila> & { id: string }): PolizaConFila {
  return {
    rowIndex: 2, empresa: "WOBA", empresaHolded: "WOBA", aseguradora: "Markel", correduria: "Acodrid", numeroPoliza: "023S00453RCG", tipoCobertura: "RC general",
    activoAsociado: "", capitalAsegurado: "", moneda: "EUR", franquicia: "", prima: "1475.84", periodicidad: "anual", cuentaDeCargo: "", fechaInicioVigencia: "",
    fechaVencimiento: "2027-04-16", estado: "vigente", estadoPago: "pagado", fuenteExtraccion: "", notas: "", rutaDocumento: "", ultimaVerificacion: "2026-10-05", ...parcial,
  };
}

// El registro REAL del 05/10/2026 (11 filas): 6 vigentes, 1 vencida, 2 en hold, 2 no contratadas.
const REGISTRO = [
  poliza({ id: "woba_rc_markel" }),
  poliza({ id: "woba_showroom_allianz", estado: "vencida", fechaVencimiento: "2026-09-01" }),
  poliza({ id: "woba_showroom_complemento_2026_2027", fechaVencimiento: "2027-08-31", notas: "PRÓXIMO PAGO: 2º recibo del suplemento el 01/03/2027 (por confirmar)." }),
  poliza({ id: "woba_accidentes_empleados", estado: "no_contratada", estadoPago: "no_aplica", fechaVencimiento: "" }),
  poliza({ id: "eworks_rc_markel", empresa: "EWORKS", empresaHolded: "EWORKS", fechaVencimiento: "2027-02-26" }),
  poliza({ id: "footprint_rc_markel", empresa: "Footprint", empresaHolded: "Footprint", fechaVencimiento: "2027-08-24" }),
  poliza({ id: "footprint_seguro_viajes", empresa: "Footprint", empresaHolded: "Footprint", estado: "no_contratada", estadoPago: "no_aplica", fechaVencimiento: "" }),
  poliza({ id: "woba_rc_suplemento_3_3", estadoPago: "sin_confirmar", prima: "323.24", fechaVencimiento: "2027-04-16" }),
  poliza({ id: "woba_transporte_pantallas_pendiente", estado: "pendiente_confirmacion", estadoPago: "no_aplica", fechaVencimiento: "" }),
  poliza({ id: "woba_equipos_electronicos_pendiente", estado: "pendiente_confirmacion", estadoPago: "no_aplica", fechaVencimiento: "" }),
  poliza({ id: "woba_showroom_2026_2027", fechaVencimiento: "2027-08-31" }),
];

const memoria = (id: string, tipo: EntradaConocimiento["tipo"], fecha = "2026-09-24", vigente = true): EntradaConocimiento => ({ id, tipo, texto: `texto ${id}`, fuente: "Carlos", fecha, vigente });
const documento: DocumentoPoliza = {
  id: "d1", polizaId: "woba_rc_suplemento_3_3", empresa: "WOBA", numeroPoliza: "023S00453RCG", aseguradora: "Markel", tipoDocumento: "Condiciones particulares (suplemento)",
  nombreArchivo: "Condiciones Particulares.pdf", fechaDocumento: "2026-09-11", vigenciaInicio: "2026-04-17", vigenciaFin: "2027-04-16", prima: "2.012,65 €", capitalAsegurado: "600.000,00 €",
  resumen: "RC General.", enlaceDrive: "https://drive.google.com/file/d/x/view", origen: "correo", registradoEn: "2026-10-01",
};
const complementos: ComplementosSeguros = {
  conocimiento: [memoria("pend-a", "pendiente_carlos"), memoria("dec-b", "decision"), memoria("hecho-c", "hecho"), memoria("viejo", "decision", "2026-09-01", false)],
  documentos: [documento],
  ultimaRevision: { fecha: "2026-10-05T15:35:00.000Z", confirmados: 0, enTransito: ["[WOBA] RC: -323,24 €"], devoluciones: 0, cargosARevisar: 0, correosNuevos: 0, advertencias: [] },
};
const HOY = new Date(2026, 9, 5, 12, 0, 0);

test("«Pólizas activas» cuenta las vigentes (6), no las vencidas ni las que están en hold (antes marcaba 9)", () => {
  const e = construirEstadoSeguros(REGISTRO, complementos, HOY, "https://sheet");
  assert.equal(e.totalPolizasActivas, 6);
  assert.deepEqual(e.resumen, { vigentes: 6, sinConfirmarPago: 1, porConfirmarOEnHold: 2, vencidas: 1, noContratadas: 2 });
  assert.deepEqual(e.porEmpresa.WOBA, { total: 8, vigentes: 4, pendientesConfirmar: 1 });
});

test("se conserva la forma anterior de la sección: el front actual sigue funcionando", () => {
  const e = construirEstadoSeguros(REGISTRO, complementos, HOY, "https://sheet");
  assert.equal(e.polizas.length, 11);
  assert.deepEqual(e.pagosSinConfirmar.map((p) => p.id), ["woba_rc_suplemento_3_3"]);
  assert.equal(e.linkRegistro, "https://sheet");
  assert.ok(["id", "empresa", "estado", "estadoPago", "notas", "ultimaVerificacion"].every((k) => k in e.polizas[0]));
});

test("los próximos vencimientos y pagos van ordenados, con los días que faltan y a qué póliza pertenecen", () => {
  const e = construirEstadoSeguros(REGISTRO, complementos, HOY, "x");
  assert.deepEqual(e.proximos.slice(0, 3).map((p) => [p.fecha, p.tipo, p.polizaId, p.diasRestantes]), [
    ["2027-02-26", "vencimiento", "eworks_rc_markel", 144],
    ["2027-03-01", "pago", "woba_showroom_complemento_2026_2027", 147],
    ["2027-04-16", "vencimiento", "woba_rc_markel", 193],
  ]);
  assert.ok(e.proximos.every((p) => p.polizaId !== "woba_showroom_allianz" && p.polizaId !== "woba_transporte_pantallas_pendiente"));
});

test("con el calendario de pagos, los pagos de «próximos» salen de él (importe, estimado y cuenta) y no se duplican con las notas; sin él, de las notas", async () => {
  const { pago } = await import("./pagos/pruebas");
  const conCalendario = construirEstadoSeguros(
    REGISTRO,
    { ...complementos, pagos: [pago({ id: "woba_showroom_complemento_2026_2027:2027-03-01", polizaId: "woba_showroom_complemento_2026_2027", fecha: "2027-03-01", importe: 289.14, concepto: "Allianz showroom — complemento", estimado: true })] },
    HOY,
    "x"
  );
  const pagos = conCalendario.proximos.filter((p) => p.tipo === "pago" && p.polizaId === "woba_showroom_complemento_2026_2027");
  assert.equal(pagos.length, 1);
  assert.match(pagos[0].texto, /\[WOBA\] Allianz showroom — complemento — 289,14 € \(estimado\) · adeudo en «BBVA»/);
  assert.equal(pagos[0].diasRestantes, 147);
  const sinCalendario = construirEstadoSeguros(REGISTRO, complementos, HOY, "x");
  assert.match(sinCalendario.proximos.find((p) => p.tipo === "pago")?.texto ?? "", /2º recibo del suplemento el 01\/03\/2027/);
  assert.equal(conCalendario.proximos.length, sinCalendario.proximos.length, "la misma cantidad de hitos: el calendario sustituye, no añade");
});

test("lo que espera a Carlos lleva los días que lleva esperando y la memoria vigente no repite los pendientes ni lo retirado", () => {
  const e = construirEstadoSeguros(REGISTRO, complementos, HOY, "x");
  assert.deepEqual(e.esperandoACarlos, [{ id: "pend-a", texto: "texto pend-a", desde: "2026-09-24", diasEsperando: 11 }]);
  assert.deepEqual(e.memoria?.map((m) => m.id), ["dec-b", "hecho-c"]);
  assert.equal(e.documentos?.[0].vigencia, "2026-04-17 → 2027-04-16");
  assert.equal(e.vigilante.ultimaRevision?.enTransito.length, 1);
  assert.deepEqual(e.vigilante.horarios, ["08:35", "17:35"]);
});

test("si no se pudieron leer los complementos, lo dice: sus campos son null, no «cero» ni lista vacía", () => {
  const e = construirEstadoSeguros(REGISTRO, null, HOY, "x");
  assert.equal(e.complementosDisponibles, false);
  assert.equal(e.esperandoACarlos, null);
  assert.equal(e.memoria, null);
  assert.equal(e.documentos, null);
  assert.equal(e.vigilante.ultimaRevision, null);
  assert.equal(e.totalPolizasActivas, 6); // lo del registro sigue valiendo
});

test("los complementos se leen una vez cada 5 minutos, una sola lectura aunque lleguen varias a la vez, y se invalidan", async () => {
  invalidarComplementosSeguros();
  let lecturas = 0;
  let reloj = 1_000_000;
  const leer = async () => { lecturas++; await new Promise((r) => setTimeout(r, 5)); return complementos; };
  const [a, b] = await Promise.all([leerComplementosSeguros(leer, () => reloj), leerComplementosSeguros(leer, () => reloj)]);
  assert.equal(a, b);
  assert.equal(lecturas, 1);
  reloj += 4 * 60_000;
  await leerComplementosSeguros(leer, () => reloj);
  assert.equal(lecturas, 1, "dentro de los 5 minutos no se vuelve a leer");
  reloj += 2 * 60_000;
  await leerComplementosSeguros(leer, () => reloj);
  assert.equal(lecturas, 2, "pasados los 5 minutos sí");
  invalidarComplementosSeguros();
  await leerComplementosSeguros(leer, () => reloj);
  assert.equal(lecturas, 3, "tras invalidar, también");
  invalidarComplementosSeguros();
});

test("una lectura fallida no se queda en la caché: la siguiente consulta vuelve a intentarlo", async () => {
  invalidarComplementosSeguros();
  let intentos = 0;
  const leer = async () => { intentos++; if (intentos === 1) throw new Error("Sheets 429"); return complementos; };
  await assert.rejects(leerComplementosSeguros(leer, () => 5), /429/);
  assert.equal((await leerComplementosSeguros(leer, () => 6)).documentos.length, 1);
  invalidarComplementosSeguros();
});

test("la última revisión guardada se lee de vuelta; un valor ilegible es «sin datos», no un error", () => {
  assert.equal(parsearUltimaRevision(undefined), null);
  assert.equal(parsearUltimaRevision("no es json"), null);
  assert.equal(parsearUltimaRevision('{"sin":"fecha"}'), null);
  const r = parsearUltimaRevision(JSON.stringify(complementos.ultimaRevision));
  assert.equal(r?.fecha, "2026-10-05T15:35:00.000Z");
  assert.deepEqual(r?.enTransito, ["[WOBA] RC: -323,24 €"]);
});

test("el contrato lleva lo que hizo Wobi Seguros y cuándo: bitácora, programación, calendario de pagos y dónde quedan los eventos", () => {
  const conTodo: ComplementosSeguros = {
    ...complementos,
    bitacora: [
      entrada({ id: "vieja", cuando: "2026-10-05T06:35:40.000Z" }),
      entrada({ id: "nueva", tarea: "pagos", cuando: "2026-10-05T06:55:30.000Z", resultado: "con_novedades", resumen: "Calendario revisado: 6 pagos previstos" }),
    ],
    pagos: [pago({ fecha: "2027-02-27", eventoCalendarId: "evt-1", avisos: "d3" }), pago({ id: "otro", fecha: "2027-08-27" })],
  };
  const e = construirEstadoSeguros(REGISTRO, conTodo, HOY, "https://sheet", { cuentaCalendario: "asistente@wobagroup.com", invitaCalendario: true });
  assert.deepEqual(e.bitacora?.map((b) => b.id), ["nueva", "vieja"], "lo último primero");
  assert.equal(e.bitacora?.[0].etiqueta, "Calendario de pagos");
  assert.deepEqual(e.programacion.map((t) => t.id), ["vigilante", "avisos", "pagos", "semanal", "agente"]);
  assert.equal(e.programacion[2].ultima?.resumen, "Calendario revisado: 6 pagos previstos");
  assert.equal(e.programacion[0].cuando, "Todos los días a las 08:35 y 17:35 (hora de Madrid)");
  assert.deepEqual(e.calendarioPagos?.map((p) => [p.fecha, p.evento.estado, p.avisosEnviados]), [["2027-02-27", "creado", ["aviso a 3 días"]], ["2027-08-27", "pendiente", []]]);
  assert.equal(e.calendario.cuenta, "asistente@wobagroup.com");
  assert.equal(e.calendario.invitaACarlos, true);
  assert.deepEqual(e.vigilante.horarios, ["08:35", "17:35"], "el campo anterior no cambia");
  assert.equal(JSON.stringify(e).includes("undefined"), false);
});

test("sin lectura de la bitácora o del calendario de pagos el contrato dice null (no «sin actividad»), y la programación sigue", () => {
  const e = construirEstadoSeguros(REGISTRO, complementos, HOY, "https://sheet");
  assert.equal(e.bitacora, null);
  assert.equal(e.calendarioPagos, null);
  assert.equal(e.programacion.length, 5, "lo que corre no depende de poder leer su constancia");
  assert.ok(e.programacion.filter((t) => t.dias !== "bajo_demanda").every((t) => t.estado === "sin_lectura"));
  assert.equal(e.calendario.cuenta, null);
  assert.equal(e.calendario.invitaACarlos, false);

  const sinComplementos = construirEstadoSeguros(REGISTRO, null, HOY, "https://sheet");
  assert.equal(sinComplementos.bitacora, null);
  assert.equal(sinComplementos.complementosDisponibles, false);
});

test("los horarios del vigilante salen de la programación compartida y la forma de reserva no inventa actividad", () => {
  assert.deepEqual(HORARIOS_VIGILANTE, ["08:35", "17:35"]);
  assert.equal(ESTADO_SEGUROS_VACIO.bitacora, null);
  assert.equal(ESTADO_SEGUROS_VACIO.calendarioPagos, null);
  assert.equal(ESTADO_SEGUROS_VACIO.programacion.length, 5);
  assert.ok(ESTADO_SEGUROS_VACIO.programacion.every((t) => t.proxima === null && t.ultima === null), "sin hora de referencia no hay próxima cita");
});
