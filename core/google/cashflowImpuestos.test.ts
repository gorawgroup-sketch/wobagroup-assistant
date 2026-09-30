import assert from "node:assert/strict";
import test from "node:test";
import { filaDisponibleImpuestos, interpretarSeccionImpuestos } from "./cashflowImpuestos";

// Réplica de la hoja real leída el 2026-09-30 (filas 1-indexadas = índice + 1).
const rows: string[][] = [];
const poner = (fila: number, ...v: string[]) => { rows[fila - 1] = v; };
poner(3, "PAGOS PROYECTOS"); poner(5, "CLIENTE", "PROYECTO", "SEMANA", "VALOR", "EMPRESA"); poner(6, "Cliente A", "P", "S40", "€100.00", "WOBA");
poner(25, "IMPUESTOS POR PAGAR"); poner(27, "IMPUESTO", "SEMANA", "VALOR", "AÑ0");
poner(28, "MOD 115 WOBA Q2", "S43", "€1,867.22", "2026"); poner(32, "MOD 303 EWORKS Q4 - 25", "S40", "€351.31", "2026");
poner(45, "APLAZAMIENTO IMPUESTOS POR PAGAR"); poner(47, "IMPUESTO", "SEMANA", "VALOR", "AÑ0");
poner(48, "MOD 303 Q3 WOBA 2025", "S40", "€255.20", "2026"); poner(53, "MOD 303 Q3 WOBA 2025", "S07", "€370.83", "2027");
poner(54, "MOD 303 Q3 WOBA 2025", "", "", "2027"); poner(57, "MOD 303 Q3 WOBA 2025", "", "", "2027");
poner(58, "MOD 200 205 EWORKS", "S41", "€1,186.00", "2027"); poner(69, "MOD 200 205 EWORKS", "S33", "€1,229.45", "2027");
for (let i = 0; i < rows.length; i++) rows[i] ??= [];

test("localiza cada sección con su cabecera y su tope", () => {
  const imp = interpretarSeccionImpuestos(rows, "impuestos_por_pagar");
  assert.equal(imp.filaTitulo, 25); assert.equal(imp.filaCabecera, 27); assert.equal(imp.filaLimite, 45);
  const apl = interpretarSeccionImpuestos(rows, "aplazamiento_impuestos");
  assert.equal(apl.filaTitulo, 45); assert.equal(apl.filaCabecera, 47); assert.equal(apl.filaLimite, undefined);
});

test("una cuota nueva de WOBA va a su fila preparada; una de eWorks, después de la última con datos", () => {
  const apl = interpretarSeccionImpuestos(rows, "aplazamiento_impuestos");
  assert.equal(filaDisponibleImpuestos(apl, "MOD 303 Q3 WOBA 2025"), 54);
  assert.equal(filaDisponibleImpuestos(apl, "MOD 200 205 EWORKS"), 70);
  assert.equal(filaDisponibleImpuestos(apl, "MOD 115 NUEVO"), 70);
});

test("en Impuestos por pagar escribe tras la última fila y nunca invade el siguiente título", () => {
  const imp = interpretarSeccionImpuestos(rows, "impuestos_por_pagar");
  assert.equal(filaDisponibleImpuestos(imp, "MOD 111 WOBA Q3"), 33);
  const llena = { ...imp, filas: imp.filas.map((f) => ({ ...f, impuesto: "X", valor: "€1.00" })) };
  assert.throws(() => filaDisponibleImpuestos(llena, "MOD 111 WOBA Q3"), /No hay filas vacías/);
});
