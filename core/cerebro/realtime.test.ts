import assert from "node:assert/strict";
import test from "node:test";
import {
  contarSuscriptoresCerebro,
  obtenerRevisionCerebro,
  publicarCambioCerebro,
  suscribirCambiosCerebro,
} from "./realtime";

test("publica revisiones crecientes y permite cancelar la suscripcion", () => {
  const inicial = obtenerRevisionCerebro();
  const recibidos: number[] = [];
  const cancelar = suscribirCambiosCerebro((evento) => recibidos.push(evento.revision));

  assert.equal(contarSuscriptoresCerebro(), 1);
  const primero = publicarCambioCerebro("prueba");
  assert.equal(primero.revision, inicial + 1);
  assert.deepEqual(recibidos, [inicial + 1]);

  cancelar();
  assert.equal(contarSuscriptoresCerebro(), 0);
  publicarCambioCerebro("prueba_sin_suscriptor");
  assert.deepEqual(recibidos, [inicial + 1]);
});
