import assert from "node:assert/strict";
import test from "node:test";
import {
  crearBloqueoOperaciones,
  etiquetaEstadoSolicitud,
  solicitudBloqueaBoton,
  solicitudChatActiva,
  tonoEstadoSolicitud,
} from "./chatOperationState.mjs";

test("el cerrojo rechaza un segundo clic antes de cualquier repintado", () => {
  const bloqueo = crearBloqueoOperaciones();
  assert.equal(bloqueo.intentar(81), true);
  assert.equal(bloqueo.intentar(81), false);
  assert.equal(bloqueo.contiene(81), true);
  bloqueo.liberar(81);
  assert.equal(bloqueo.intentar(81), true);
});

test("solo recupera solicitudes que todavía pueden cambiar de estado", () => {
  for (const estado of ["registrando", "en_cola", "procesando", "aplicado", "verificando"]) {
    assert.equal(solicitudChatActiva({ estado }), true, estado);
  }
  for (const estado of ["completado", "incierto", "fallido"]) {
    assert.equal(solicitudChatActiva({ estado }), false, estado);
  }
});

test("una decisión incierta continúa bloqueada después de reconectar", () => {
  const incierta = { tipo: "boton", origenMessageId: 81, estado: "incierto" };
  assert.equal(solicitudBloqueaBoton(incierta), true);
  assert.equal(etiquetaEstadoSolicitud(incierta), "Resultado incierto · repetición bloqueada");
  assert.equal(tonoEstadoSolicitud(incierta), "alerta");
});

test("solo una decisión confirmada deja de bloquear su botón original", () => {
  assert.equal(solicitudBloqueaBoton({ tipo: "boton", origenMessageId: 81, estado: "procesando" }), true);
  assert.equal(solicitudBloqueaBoton({ tipo: "boton", origenMessageId: 81, estado: "completado" }), false);
  assert.equal(solicitudBloqueaBoton({ tipo: "mensaje", origenMessageId: 81, estado: "procesando" }), false);
});
