import assert from "node:assert/strict";
import test from "node:test";
import { incorporarContextoClasificacion, validarAnalisis } from "./analyze";

test("normaliza fecha española, moneda y equivalente redundante de un recibo pagado", () => {
  const resultado = validarAnalisis({
    completo: true,
    resumen: "Recibo pagado",
    otrasAcciones: false,
    recibos: [{
      fuente: "cuerpo",
      tipo: "recibo",
      confianza: "alta",
      empresa: "Footprint",
      proveedor: "OUIGO ESPAÑA S.A.U.",
      fecha: "09/09/2026",
      moneda: "eur",
      monto: 100,
      equivalente: { moneda: "EUR", monto: 100 },
      concepto: "Billete ya pagado",
      evidencia: "Total pagado 100 EUR",
      evidenciaEmpresa: "Footprint",
    }],
  }, new Set(["cuerpo"]));
  assert.equal(resultado.recibos[0].fecha, "2026-09-09");
  assert.equal(resultado.recibos[0].moneda, "EUR");
  assert.equal(resultado.recibos[0].equivalente, undefined);
});

test("usa la categoría explícita del asunto cuando el ticket solo describe un consumo genérico", () => {
  const recibo = {
    fuente: "cuerpo", tipo: "ticket" as const, confianza: "alta" as const, empresa: "Footprint" as const,
    proveedor: "Nieuwe Veste", fecha: "2026-09-16", moneda: "EUR", monto: 5.4,
    concepto: "Consumo Nieuwe Veste – Breda", evidencia: "Nieuwe Veste 5,40 EUR",
    evidenciaEmpresa: "Footprint", persona: "Simon Talloen", viaje: true,
  };
  const resultado = incorporarContextoClasificacion({ completo: true, otrasAcciones: false,
    resumen: "Ticket", recibos: [recibo] }, "Fwd: Café - 5.4 eur - revolut");
  assert.equal(resultado.recibos[0].contextoClasificacion, "Fwd: Café - 5.4 eur - revolut");
});

test("conserva cargo explícito distinto en la misma moneda sin cambiar el recibo", () => {
  const r = validarAnalisis({ completo: true, otrasAcciones: false, resumen: "Hotel",
    recibos: [{ fuente: "cuerpo", tipo: "recibo", confianza: "alta", empresa: "Footprint",
      proveedor: "Trip.com", fecha: "2026-09-18", moneda: "EUR", monto: 147.44,
      equivalente: { moneda: "EUR", monto: 142.48 }, concepto: "Hotel",
      evidencia: "Recibo 147.44 EUR; cargo confirmado 142.48 EUR", evidenciaEmpresa: "Footprint" }]
  }, new Set(["cuerpo"]));
  assert.equal(r.recibos[0].monto, 147.44);
  assert.deepEqual(r.recibos[0].equivalente, { moneda: "EUR", monto: 142.48 });
});

test("si la segunda lectura de verificación falla, el análisis no se da por «incompleto»: se propaga como fallo técnico", async () => {
  const { analizarAutomatico } = await import("./analyze");
  const correo = {
    id: "m1", threadId: "t1", de: "Stripe <receipts@stripe.com>", asunto: "Your receipt from Anthropic, PBC", fecha: "2026-10-07",
    recibidoEn: 0, cuerpo: "Receipt 24.20 USD", contextoHilo: "", adjuntos: [], huella: "h1",
  };
  let llamadas = 0;
  const llamar = async () => {
    llamadas++;
    if (llamadas === 1) {
      return { stop_reason: "tool_use", content: [{ type: "tool_use" as const, id: "tu1", name: "analisis_correo_automatico",
        input: { completo: false, otrasAcciones: false, resumen: "No estoy seguro de haber leído todo.", recibos: [] } }] as never };
    }
    throw new Error('Uso de API de IA bloqueado para "correo_gastos_automatico_manual": limite_diario_proceso_alcanzado.');
  };
  await assert.rejects(
    analizarAutomatico(correo as never, { memoria: "" }, llamar as never),
    (error: unknown) => error instanceof Error && /segunda lectura de verificación/.test(error.message) && /limite_diario_proceso_alcanzado/.test(error.message)
  );
  assert.equal(llamadas, 2);
});
