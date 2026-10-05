import assert from "node:assert/strict";
import test from "node:test";
import { aplicarReglasAgregadas, cubiertoPorRegla, lineaDesdeExplicacion, palabrasClaveDesdeExplicacion, textoCubiertos, type ReglaAgregada } from "./reglasAgregadas";

const CONCEPTO = "To Calzada Jimenez, Carlos Nomina Septiembre";
const EXPLICACION = "Esto hace parte de la línea Nóminas y ya viene sumado con la de Heidi Antunes";

test("caso Carlos: de «Nomina» en el concepto y «Nóminas» en la explicación sale la palabra clave «nomina» y la línea «Nóminas»", () => {
  assert.deepEqual(palabrasClaveDesdeExplicacion(CONCEPTO, EXPLICACION), ["nomina"]);
  assert.equal(lineaDesdeExplicacion(EXPLICACION), "Nóminas");
  assert.equal(lineaDesdeExplicacion("Va en la fila que dice Seguridad Social, junto con otras"), "Seguridad Social");
  assert.equal(lineaDesdeExplicacion("ya está sumado"), "ya está sumado");
});
test("no toma como clave meses ni palabras genéricas; si nada identificable coincide devuelve vacío; los nombres solo si Carlos los menciona", () => {
  assert.deepEqual(palabrasClaveDesdeExplicacion("Pago septiembre transferencia", "Está sumado en otra línea de septiembre"), []);
  assert.deepEqual(palabrasClaveDesdeExplicacion("Pago septiembre transferencia Heidi Antunes", "Todo lo de Heidi Antunes va en la línea Nóminas"), ["heidi", "antunes"]);
});

const regla: ReglaAgregada = { id: "r1", empresa: "WOBA", palabrasClave: ["nomina"], lineaCashflow: "Nóminas", explicacion: EXPLICACION, tipo: "gasto", creadoEn: "2026-10-05" };
test("la regla cubre los cargos de esa empresa con la palabra (también en plural) y NADA más", () => {
  const m = (descripcion: string, empresa = "WOBA", esIngreso = false) => ({ empresa, descripcion, esIngreso });
  assert.ok(cubiertoPorRegla(m("To Antunes, Heidi Nomina Septiembre"), [regla]));
  assert.ok(cubiertoPorRegla(m("NOMINAS septiembre 2026"), [regla]));
  assert.equal(cubiertoPorRegla(m("Nominas SL servicios de gestión"), [regla])?.id, "r1", "palabra completa en plural: cubierta (el proveedor «Nominas» sí coincide por palabra)");
  assert.equal(cubiertoPorRegla(m("Nominasoft licencia"), [regla]), undefined, "un prefijo suelto no basta");
  assert.equal(cubiertoPorRegla(m("To Antunes Nomina", "EWORKS"), [regla]), undefined, "otra empresa");
  assert.equal(cubiertoPorRegla(m("Nomina devuelta", "WOBA", true), [regla]), undefined, "un abono no es un cargo: otra regla");
  assert.equal(cubiertoPorRegla(m("Alquiler oficina"), [regla]), undefined);
  assert.equal(cubiertoPorRegla(m("Nomina"), [{ ...regla, palabrasClave: [] }]), undefined, "una regla sin palabras no cubre nada");
});
test("aplicar separa pendientes y cubiertos y el aviso cuenta por línea", () => {
  const movs = [{ empresa: "WOBA", descripcion: "Nomina Carlos", valorEur: -2064.25 }, { empresa: "WOBA", descripcion: "Nomina Heidi", valorEur: -1800 }, { empresa: "WOBA", descripcion: "Seguro coche", valorEur: -90 }];
  const r = aplicarReglasAgregadas(movs, [regla]);
  assert.deepEqual(r.pendientes.map((x) => x.descripcion), ["Seguro coche"]);
  assert.equal(r.cubiertos.length, 2);
  assert.match(textoCubiertos(r.cubiertos), /2 movimiento\(s\).*2 en «Nóminas»/);
  assert.equal(textoCubiertos([]), "");
});
