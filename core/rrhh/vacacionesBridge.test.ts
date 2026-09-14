import assert from "node:assert/strict";
import test from "node:test";
import { ENCABEZADOS_PUENTE_VACACIONES, interpretarTablaVacaciones } from "./vacacionesBridge";

const ahora = new Date("2026-09-14T12:00:00.000Z");

test("acepta una copia vigente sin calcular ni modificar los saldos de Holded", () => {
  const resultado = interpretarTablaVacaciones([
    [...ENCABEZADOS_PUENTE_VACACIONES],
    ["WOBA", "Carlos Calzada", 2026, 24, 2, 8.5, 6, 9.5, "2026-09-14T10:00:00.000Z"],
  ], { ahora, maxAgeHours: 24 });

  assert.deepEqual(resultado, {
    estado: "ok",
    registros: [{
      empresa: "WOBA",
      nombre: "Carlos Calzada",
      ano: 2026,
      estado: "vigente",
      diasAsignados: 24,
      diasSolicitadosPendientes: 2,
      diasAprobados: 8.5,
      diasUsados: 6,
      diasRestantes: 9.5,
      actualizadoEn: "2026-09-14T10:00:00.000Z",
    }],
  });
});

test("bloquea toda la fuente si aparece una columna de PII no autorizada", () => {
  const resultado = interpretarTablaVacaciones([
    [...ENCABEZADOS_PUENTE_VACACIONES, "salario"],
    ["WOBA", "Carlos Calzada", 2026, 24, 0, 8, 6, 10, "2026-09-14T10:00:00Z", 100000],
  ], { ahora, maxAgeHours: 24 });

  assert.equal(resultado.estado, "error");
  assert.match(resultado.detalle ?? "", /columnas autorizadas/i);
  assert.doesNotMatch(JSON.stringify(resultado), /100000|salario/i);
});

test("bloquea columnas reordenadas para que la lectura física siempre termine en I", () => {
  const headers = [...ENCABEZADOS_PUENTE_VACACIONES];
  [headers[1], headers[2]] = [headers[2], headers[1]];
  const resultado = interpretarTablaVacaciones([headers], { ahora, maxAgeHours: 24 });
  assert.equal(resultado.estado, "error");
});

test("un registro vencido conserva evidencia pero queda prohibido para responder", () => {
  const resultado = interpretarTablaVacaciones([
    [...ENCABEZADOS_PUENTE_VACACIONES],
    ["WOBA", "Heydi Antunez", 2026, 24, 1, 9, 7, 8, "2026-09-10T10:00:00.000Z"],
  ], { ahora, maxAgeHours: 24 });

  assert.equal(resultado.estado, "ok");
  assert.equal(resultado.registros[0]?.estado, "vencido");
  assert.equal(resultado.registros[0]?.diasRestantes, 8);
});

test("no transforma vacíos, fechas futuras ni texto inválido en cero", () => {
  const resultado = interpretarTablaVacaciones([
    [...ENCABEZADOS_PUENTE_VACACIONES],
    ["WOBA", "Heydi Antunez", 2026, 24, "", "ocho", 0, 10, "2026-09-15T10:00:00.000Z"],
  ], { ahora, maxAgeHours: 24 });

  assert.equal(resultado.registros[0]?.estado, "incompleto");
  assert.equal(resultado.registros[0]?.diasSolicitadosPendientes, undefined);
});
