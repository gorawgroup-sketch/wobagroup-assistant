import assert from "node:assert/strict";
import test from "node:test";
import type { EntradaConocimiento } from "./agente/conocimiento";
import { construirInformeSemanal, eventosProximos } from "./informeSemanal";
import type { PolizaConFila } from "./polizaRegistroSheet";

function poliza(parcial: Partial<PolizaConFila> & { id: string }): PolizaConFila {
  return {
    rowIndex: 2, empresa: "WOBA", empresaHolded: "WOBA", aseguradora: "Allianz", correduria: "Acodrid", numeroPoliza: "054239034", tipoCobertura: "Todo riesgo showroom",
    activoAsociado: "", capitalAsegurado: "", moneda: "EUR", franquicia: "", prima: "1016.86", periodicidad: "semestral", cuentaDeCargo: "", fechaInicioVigencia: "",
    fechaVencimiento: "2027-08-31", estado: "vigente", estadoPago: "pagado", fuenteExtraccion: "", notas: "", rutaDocumento: "", ultimaVerificacion: "2026-10-05", ...parcial,
  };
}
const pendiente = (id: string, texto: string, fecha = "2026-09-24"): EntradaConocimiento => ({ id, tipo: "pendiente_carlos", texto, fuente: "correo", fecha, vigente: true });

test("los «PRÓXIMO PAGO» con fecha dentro del horizonte entran en el calendario; los lejanos o sin fecha no", () => {
  const p = poliza({ id: "a", notas: "✅ AL CORRIENTE. || PRÓXIMO PAGO: 2ª cuota semestral el 01/03/2027 (por confirmar). || otro", fechaVencimiento: "2027-08-31" });
  assert.deepEqual(eventosProximos([p], "2026-10-05", 60), []);
  const cerca = eventosProximos([p], "2027-01-15", 60);
  assert.equal(cerca.length, 1);
  assert.deepEqual(cerca[0], { fecha: "2027-03-01", tipo: "pago", polizaId: "a", empresa: "WOBA", texto: "[WOBA] 2ª cuota semestral el 01/03/2027 (por confirmar)" });
  assert.deepEqual(eventosProximos([poliza({ id: "b", notas: "PRÓXIMO PAGO: sin fecha clara" })], "2027-01-15", 400), [{ fecha: "2027-08-31", tipo: "vencimiento", polizaId: "b", empresa: "WOBA", texto: "Vence Todo riesgo showroom (Allianz, 054239034)" }]);
});

test("lo vencido, lo no contratado y lo que está en hold no genera vencimientos", () => {
  const vivas = [poliza({ id: "v", estado: "vencida", fechaVencimiento: "2026-10-20" }), poliza({ id: "n", estado: "no_contratada", fechaVencimiento: "2026-10-20" }), poliza({ id: "h", estado: "pendiente_confirmacion", fechaVencimiento: "2026-10-20" })];
  assert.deepEqual(eventosProximos(vivas, "2026-10-05"), []);
});

test("sin nada pendiente ni próximo el resumen calla", () => {
  assert.equal(construirInformeSemanal({ hoy: "2026-10-12", polizas: [poliza({ id: "a" })], conocimiento: [] }), null);
});

test("el resumen junta pagos sin confirmar, lo que espera a Carlos (con los días que lleva) y lo que viene", () => {
  const informe = construirInformeSemanal({
    hoy: "2026-10-12",
    polizas: [
      poliza({ id: "sup", tipoCobertura: "RC — suplemento 3.3", prima: "323.24", estadoPago: "sin_confirmar", fechaVencimiento: "2026-11-02" }),
    ],
    conocimiento: [pendiente("pend-excluir", "Excluir la garantía de RC del multirriesgo de WOBA (Allianz).")],
  });
  assert.equal(informe?.titulo, "🛡️ Seguros — resumen semanal (12/10)");
  assert.match(informe?.cuerpo ?? "", /\*\*Pagos sin confirmar\*\* \(1\)\n- \[WOBA\] RC — suplemento 3\.3 — 323\.24 EUR \(sin_confirmar\)/);
  assert.match(informe?.cuerpo ?? "", /Esperando a Carlos\*\* \(1\)\n- Excluir la garantía .* \(desde el 24\/09, hace 18 días\)/);
  assert.match(informe?.cuerpo ?? "", /02\/11\/2026 · Vence RC — suplemento 3\.3 \(Allianz, 054239034\)/);
});

test("una decisión retirada o de otro tipo no se reclama a Carlos", () => {
  const informe = construirInformeSemanal({
    hoy: "2026-10-12", polizas: [poliza({ id: "a" })],
    conocimiento: [{ ...pendiente("x", "Ya resuelto"), vigente: false }, { id: "y", tipo: "decision", texto: "Hold", fuente: "Carlos", fecha: "2026-09-30", vigente: true }],
  });
  assert.equal(informe, null);
});

// --- el calendario de pagos estructurado alimenta los próximos pagos (06-10-2026) -----------------------------------------------------------

import { textoDePagoCalendario } from "./informeSemanal";
import { pago as pagoDePrueba } from "./pagos/pruebas";

const polizaDePrueba = (parcial: Record<string, unknown>) =>
  ({ id: "woba_showroom_2026_2027", empresa: "WOBA", tipoCobertura: "Todo riesgo showroom", aseguradora: "Allianz", numeroPoliza: "054239034", estado: "vigente", fechaVencimiento: "2027-08-31", notas: "", ...parcial }) as never;

test("los pagos de una póliza salen del calendario estructurado y NO también de sus notas; las demás pólizas siguen con las notas", () => {
  const conCalendario = polizaDePrueba({ notas: "PRÓXIMO PAGO: 2ª cuota el 01/03/2027 (por confirmar)." });
  const soloNotas = polizaDePrueba({ id: "eworks_rc_markel", empresa: "EWORKS", numeroPoliza: "025S00287RCG", fechaVencimiento: "2027-02-26", notas: "PRÓXIMO PAGO: renovación 27/02/2027 (~1.679 €/año)." });
  const eventos = eventosProximos([conCalendario, soloNotas], "2026-10-06", 400, [pagoDePrueba({ fecha: "2027-03-01", importe: 955 })]);
  const pagos = eventos.filter((e) => e.tipo === "pago");
  assert.deepEqual(pagos.map((e) => `${e.fecha} ${e.polizaId}`), ["2027-02-27 eworks_rc_markel", "2027-03-01 woba_showroom_2026_2027"]);
  assert.match(pagos[1].texto, /\[WOBA\] Allianz showroom 054239034 — 2\.ª cuota semestral 2026\/27 — 955,00 € \(estimado\) · adeudo en «BBVA»/);
  assert.equal(pagos.filter((e) => e.polizaId === "woba_showroom_2026_2027").length, 1, "sin duplicado desde las notas");
  assert.match(pagos[0].texto, /renovación 27\/02\/2027/);
  assert.equal(eventos.filter((e) => e.tipo === "vencimiento").length, 2, "los vencimientos de la póliza no cambian");
});

test("sin calendario (no se pudo leer o vacío) los pagos salen de las notas como antes; los pagos ya cerrados o de pólizas no vivas no cuentan", () => {
  const poliza = polizaDePrueba({ notas: "PRÓXIMO PAGO: 2ª cuota el 01/03/2027." });
  assert.equal(eventosProximos([poliza], "2026-10-06", 400).filter((e) => e.tipo === "pago").length, 1);
  assert.equal(eventosProximos([poliza], "2026-10-06", 400, null).filter((e) => e.tipo === "pago").length, 1);
  assert.equal(eventosProximos([poliza], "2026-10-06", 400, []).filter((e) => e.tipo === "pago").length, 1);
  const cerrado = eventosProximos([poliza], "2026-10-06", 400, [pagoDePrueba({ estado: "pagado" })]).filter((e) => e.tipo === "pago");
  assert.equal(cerrado.length, 1, "solo hay un pago cerrado: la póliza no tiene previstos y se sigue con sus notas");
  const vencida = polizaDePrueba({ estado: "vencida" });
  assert.equal(eventosProximos([vencida], "2026-10-06", 400, [pagoDePrueba()]).length, 0);
});

test("el texto de un pago dice empresa, concepto, importe (estimado) y cuenta; una transferencia lo dice", () => {
  assert.equal(textoDePagoCalendario(pagoDePrueba({ estimado: false, forma: "transferencia" })), "[WOBA] Allianz showroom 054239034 — 2.ª cuota semestral 2026/27 — 955,00 € · transferencia en «BBVA»");
});

