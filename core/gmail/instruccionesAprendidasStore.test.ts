import assert from "node:assert/strict";
import test from "node:test";
import {
  esInstruccionReutilizable,
  extraerEmailRemitente,
  instruccionSustituyeAnteriores,
  patronDeAsunto,
  seleccionarInstruccionesAplicables,
  type InstruccionCorreoAprendida,
} from "./instruccionesAprendidasStore";

function regla(cambios: Partial<InstruccionCorreoAprendida> = {}): InstruccionCorreoAprendida {
  return {
    rowIndex: 2,
    clave: "k",
    remitente: "avisos@proveedor.com",
    alcance: "remitente_asunto",
    patronAsunto: "aviso cobro business atelier",
    instruccion: "De ahora en adelante, preparar el gasto y dejarlo pendiente de aprobación.",
    activa: true,
    vecesConfirmada: 2,
    creadaEn: "2026-09-20T00:00:00.000Z",
    actualizadaEn: "2026-09-21T00:00:00.000Z",
    mensajeIdOrigen: "gmail-1",
    ...cambios,
  };
}

test("solo aprende instrucciones explícitamente reutilizables", () => {
  assert.equal(esInstruccionReutilizable("Responde este correo hoy"), false);
  assert.equal(esInstruccionReutilizable("De ahora en adelante, guarda estos correos como conocimiento"), true);
  assert.equal(esInstruccionReutilizable("Cada vez que llegue uno, prepara el reporte"), true);
  assert.equal(esInstruccionReutilizable(`Siempre recuerda ${"x".repeat(1_300)}`), false);
});

test("extrae el remitente real y agrupa asuntos de la misma familia aunque cambie el número", () => {
  assert.equal(extraerEmailRemitente("Proveedor <Avisos@Proveedor.com>"), "avisos@proveedor.com");
  assert.equal(patronDeAsunto("Fwd: Aviso de cobro ES40_1004356525 BUSINESS ATELIER"), "aviso cobro business atelier");
});

test("aplica una regla solo al remitente y familia de asunto correctos", () => {
  const reglas = [regla()];
  assert.equal(
    seleccionarInstruccionesAplicables(
      "Proveedor <avisos@proveedor.com>",
      "RE: Aviso de cobro ES41_999999 BUSINESS ATELIER",
      reglas
    ).length,
    1
  );
  assert.equal(seleccionarInstruccionesAplicables("otro@proveedor.com", "Aviso de cobro BUSINESS ATELIER", reglas).length, 0);
  assert.equal(seleccionarInstruccionesAplicables("avisos@proveedor.com", "Invitación a reunión", reglas).length, 0);
});

test("una regla de remitente no depende del asunto y una regla inactiva nunca aplica", () => {
  const reglas = [regla({ alcance: "remitente", patronAsunto: "" }), regla({ clave: "inactiva", activa: false })];
  assert.equal(seleccionarInstruccionesAplicables("avisos@proveedor.com", "Cualquier asunto", reglas).length, 1);
});

test("reconoce correcciones explícitas que deben sustituir la regla anterior", () => {
  assert.equal(instruccionSustituyeAnteriores("Ya no archives estos correos; en vez de eso prepara un borrador"), true);
  assert.equal(instruccionSustituyeAnteriores("Siempre archiva estos correos"), false);
});
