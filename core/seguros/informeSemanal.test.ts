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
  assert.deepEqual(cerca[0], { fecha: "2027-03-01", tipo: "pago", texto: "[WOBA] 2ª cuota semestral el 01/03/2027 (por confirmar)" });
  assert.deepEqual(eventosProximos([poliza({ id: "b", notas: "PRÓXIMO PAGO: sin fecha clara" })], "2027-01-15", 400), [{ fecha: "2027-08-31", tipo: "vencimiento", texto: "Vence Todo riesgo showroom (Allianz, 054239034)" }]);
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
