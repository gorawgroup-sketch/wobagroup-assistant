import assert from "node:assert/strict";
import test from "node:test";
import { consultarVacacionesHoldedSeguras } from "./hr";

const originalFetch = global.fetch;
const originalKey = process.env.HOLDED_API_KEY_WOBA;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.HOLDED_API_KEY_WOBA;
  else process.env.HOLDED_API_KEY_WOBA = originalKey;
});

test("devuelve solo campos RRHH permitidos y nunca filtra PII del proveedor", async () => {
  process.env.HOLDED_API_KEY_WOBA = "test-key";
  global.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/employees")) {
      assert.equal(url.searchParams.get("search"), "Heydi Antunez");
      return Response.json([{ id: "emp-1", full_name: "Heydi Antunez" }]);
    }
    if (url.pathname.endsWith("/employees/emp-1/contract")) {
      return Response.json({ vacationDays: 24, salary: 999999, iban: "NO-DEBE-SALIR" });
    }
    return Response.json({
      id: "emp-1",
      full_name: "Heydi Antunez",
      time_off_policy_id: "policy-1",
      salary: 999999,
      iban: "NO-DEBE-SALIR",
      social_security_number: "NO-DEBE-SALIR",
    });
  }) as typeof fetch;

  const result = await consultarVacacionesHoldedSeguras("WOBA", ["Heydi Antunez"]);
  assert.deepEqual(result, {
    empresa: "WOBA",
    saldoExactoDisponible: false,
    resultados: [{
      consulta: "Heydi Antunez",
      estado: "encontrado",
      nombre: "Heydi Antunez",
      politicaAusenciasConfigurada: true,
      diasAnualesContrato: 24,
      detalle:
        "La API pública de Holded identifica el perfil y, cuando existe, la asignación anual del contrato; " +
        "no expone solicitudes, aprobaciones, días usados ni saldo restante.",
    }],
  });
  const serializado = JSON.stringify(result);
  assert.doesNotMatch(serializado, /salary|iban|social_security|999999|NO-DEBE-SALIR/i);
});

test("no elige por intuición cuando un nombre coincide con varias personas", async () => {
  process.env.HOLDED_API_KEY_WOBA = "test-key";
  let llamadasDetalle = 0;
  global.fetch = (async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/employees")) llamadasDetalle++;
    return Response.json([
      { id: "emp-1", full_name: "Carlos Calzada" },
      { id: "emp-2", full_name: "Carlos Gonzalez" },
    ]);
  }) as typeof fetch;

  const result = await consultarVacacionesHoldedSeguras("WOBA", ["Carlos"]);
  assert.equal(result.resultados[0]?.estado, "ambiguo");
  assert.deepEqual(result.resultados[0]?.candidatos, ["Carlos Calzada", "Carlos Gonzalez"]);
  assert.equal(llamadasDetalle, 0, "no debe abrir el perfil/contrato de un homónimo al azar");
});

test("declara no disponible el saldo cuando vacationDays viene null", async () => {
  process.env.HOLDED_API_KEY_WOBA = "test-key";
  global.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/employees")) {
      return Response.json([{ id: "emp-1", full_name: "Heydi Antunez" }]);
    }
    if (url.pathname.endsWith("/contract")) return Response.json({ vacationDays: null });
    return Response.json({ id: "emp-1", full_name: "Heydi Antunez", time_off_policy_id: "policy-1" });
  }) as typeof fetch;

  const result = await consultarVacacionesHoldedSeguras("WOBA", ["Heydi Antunez"]);
  assert.equal(result.resultados[0]?.estado, "encontrado");
  assert.equal(result.resultados[0]?.diasAnualesContrato, null);
  assert.equal(result.saldoExactoDisponible, false);
});
