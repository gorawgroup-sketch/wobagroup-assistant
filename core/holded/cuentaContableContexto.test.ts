import assert from "node:assert/strict";
import test from "node:test";
import { evaluarCuentaContable, exigirCuentaRevalidada, esServicioNoViaje, type CompraPrecedente, type CuentaContableReal } from "./cuentaContableContexto";
const cuentas: CuentaContableReal[] = [
  { id: "servicios", name: "Otros servicios", archived: false },
  { id: "viaje", name: "Gastos de Viaje", archived: false },
  { id: "fx", name: "Diferencias negativas de cambio", archived: false },
  { id: "software", name: "Software y licencias", archived: false },
];
const compra = (id: string, account = "servicios", texto = "Anthropic* Claude Sub"): CompraPrecedente => ({
  id, contact_id: "anthropic", contact_name: "Anthropic, PBC", description: texto,
  document_number: id, date: "2026-08-23", draft: false, status: "completed", lines: [{ name: texto, account }],
});
const criterios = { proveedor: "Anthropic, PBC", contactId: "anthropic", concepto: "Compra única de créditos Anthropic — tarjeta personal de Boris — comprobante visual del correo", personaAsociada: "Boris Dallafontana", contextoDeViaje: true, excluirCompraId: "2618-1534" };

test("regresión Anthropic: dos servicios, dos ajustes FX y compra errónea no convierten créditos en viaje", () => {
  const resultado = evaluarCuentaContable(criterios, [compra("2618-1534", "viaje"), compra("fx1", "fx", "Anthropic"), compra("fx2", "fx", "Anthropic"), compra("julio"), compra("agosto")], cuentas);
  assert.equal(resultado.sugerencia?.accountId, "servicios");
  assert.deepEqual(resultado.sugerencia?.evidencia.map((e) => e.compraId), ["julio", "agosto"]);
  assert.equal(resultado.descartados.length, 2);
  assert.deepEqual(resultado.sugerencia?.tags, []);
});
test("historial contaminado de viajes se descarta aunque sea mayoritario", () => {
  const historial = [compra("julio"), compra("agosto"), ...Array.from({ length: 40 }, (_, i) => compra(`mal-${i}`, "viaje"))];
  assert.equal(evaluarCuentaContable(criterios, historial, cuentas).sugerencia?.accountId, "servicios");
});
test("no copia una única compra previa ni usa múltiples líneas como múltiples votos", () => {
  const p = compra("unica"); p.lines = Array.from({ length: 10 }, () => ({ name: "Claude", account: "servicios" }));
  assert.equal(evaluarCuentaContable(criterios, [p, p], cuentas).sugerencia, undefined);
});
test("cuentas incompatibles o archivadas jamás se eligen como fallback", () => {
  assert.equal(evaluarCuentaContable(criterios, [compra("a", "viaje"), compra("b", "viaje")], cuentas).sugerencia, undefined);
  const archivadas = cuentas.map((c) => ({ ...c, archived: true }));
  assert.equal(evaluarCuentaContable(criterios, [compra("a"), compra("b")], archivadas).sugerencia, undefined);
});
test("cuentas distintas entre precedentes comparables requieren revisión, incluso con mayoría", () => {
  const r = evaluarCuentaContable(criterios, [compra("a"), compra("b"), compra("c", "software")], cuentas);
  assert.equal(r.sugerencia, undefined); assert.match(r.motivo, /cuentas distintas/);
});
test("borrradores, anulados y el propio gasto no se usan para confirmarse a sí mismos", () => {
  const r = evaluarCuentaContable(criterios, [{ ...compra("a"), draft: true }, { ...compra("b"), status: "cancelled" }, compra("2618-1534")], cuentas);
  assert.equal(r.sugerencia, undefined);
});
test("sin precedente del proveedor puede usar servicios digitales comparables con evidencia", () => {
  const p = [compra("a"), compra("b")].map((c) => ({ ...c, contact_id: "openai", contact_name: "OpenAI", description: "Servicio API", lines: [{ name: "Servicio API", account: "software" }] }));
  const r = evaluarCuentaContable(criterios, p, cuentas);
  assert.equal(r.sugerencia?.accountId, "software"); assert.equal(r.sugerencia?.aprendidoDe, "categoria");
});
test("persona, tarjeta, correo y empresa no constituyen similitud contable", () => {
  const c = { proveedor: "Nuevo proveedor", concepto: "Compra de insumos Boris Mastercard Revolut cuenta personal comprobante visual correo original", personaAsociada: "Boris" };
  const p = [compra("a", "viaje", "Boris Mastercard Revolut comprobante visual correo original"), compra("b", "viaje", "Boris Mastercard Revolut comprobante visual correo original")];
  assert.equal(evaluarCuentaContable(c, p, cuentas).sugerencia, undefined);
});
test("contexto de viaje solo se considera con naturaleza compatible del gasto", () => {
  const historial = [compra("hotel", "viaje", "Hotel Madrid"), compra("taxi", "viaje", "Taxi Madrid")].map((p) => ({ ...p, contact_id: "otro", contact_name: "Hotel", tags: ["transporte"] }));
  assert.equal(evaluarCuentaContable({ proveedor: "Restaurante", concepto: "Almuerzo individual", contextoDeViaje: true, tagsCategoria: ["alimentacion"] }, historial, cuentas).sugerencia?.accountId, "viaje");
  assert.equal(evaluarCuentaContable({ proveedor: "Proveedor", concepto: "Suscripción", contextoDeViaje: true, tagsCategoria: ["alimentacion"] }, historial, cuentas).sugerencia, undefined);
});
test("aprendizaje anterior no puede imponer viajes a software ni cuentas inexistentes", () => {
  for (const cuentaId of ["viaje", "inexistente"]) {
    const r = evaluarCuentaContable(criterios, [compra("a"), compra("b")], cuentas, { cuentaId, confirmadoEn: new Date().toISOString() });
    assert.equal(r.sugerencia?.accountId, "servicios");
  }
});
test("corrección confirmada vigente sí se respeta en una cuenta compatible", () => {
  const r = evaluarCuentaContable(criterios, [], cuentas, { cuentaId: "software", confirmadoEn: new Date().toISOString() });
  assert.equal(r.sugerencia?.accountId, "software");
  assert.equal(r.sugerencia?.aprendidoDe, "correccion_confirmada");
});
test("bloquea escrituras con cuenta ausente, obsoleta o sin evidencia", () => {
  const r = evaluarCuentaContable(criterios, [compra("a"), compra("b")], cuentas);
  assert.throws(() => exigirCuentaRevalidada("viaje", r), /nueva propuesta/);
  assert.throws(() => exigirCuentaRevalidada(undefined, r));
  assert.throws(() => exigirCuentaRevalidada("servicios", { motivo: "historial inaccesible", descartados: [] }));
  assert.equal(exigirCuentaRevalidada("servicios", r).accountId, "servicios");
});
test("no degrada servicios profesionales o suscripciones a viajes por su pagador", () => {
  assert.equal(esServicioNoViaje("Asesoría", "Honorarios"), true);
  assert.equal(esServicioNoViaje("Anthropic", "Créditos"), true);
  assert.equal(esServicioNoViaje("Hotel", "Alojamiento"), false);
});

test("un proveedor desconocido no hereda viajes por historial o persona sin naturaleza compatible", () => {
  const p = [compra("a", "viaje", "Pro mensual"), compra("b", "viaje", "Pro mensual")].map((p) => ({ ...p, contact_name: "Figma", contact_id: "figma" }));
  assert.equal(evaluarCuentaContable({ proveedor: "Figma", contactId: "figma", concepto: "Pro mensual", contextoDeViaje: true }, p, cuentas).sugerencia, undefined);
});
