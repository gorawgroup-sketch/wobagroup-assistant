import test from "node:test";
import assert from "node:assert/strict";
import { entregarRevisionCorreo } from "./entregarRevisionCorreo";

test("una cuota agotada en la cola no oculta el gasto ya completado ni repite su ejecución", async () => {
  const eventos: string[] = [];
  const resultado = await entregarRevisionCorreo({
    resumen: "1 gasto completado", publicar: () => true,
    enviar: async texto => { eventos.push(texto); },
    sincronizar: async texto => {
      assert.equal(texto, ""); eventos.push("cola"); throw new Error("429");
    },
    recuperar: async error => {
      assert.match(String(error), /429/); eventos.push("recuperar");
      return { informePublicado: false };
    },
  });
  assert.deepEqual(eventos, ["1 gasto completado", "cola", "recuperar"]);
  assert.equal(resultado.informePublicado, true);
});

test("una revisión silenciosa no publica el resumen", async () => {
  let enviado = false;
  const r = await entregarRevisionCorreo({
    resumen: "resultado", publicar: () => false,
    enviar: async () => { enviado = true; },
    sincronizar: async texto => { assert.equal(texto, "resultado"); return { informePublicado: false }; },
    recuperar: async () => { throw new Error("no debe fallar"); },
  });
  assert.equal(enviado, false);
  assert.equal(r.informePublicado, false);
});
