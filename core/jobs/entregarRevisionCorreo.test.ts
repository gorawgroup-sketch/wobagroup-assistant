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

// Caso real 2026-09-28: Telegram rechazó por longitud el informe de una revisión ya terminada (14 gastos creados y
// conciliados); la excepción cortó todo y la cola manual con los 33 casos pendientes nunca se armó.
test("si el envío del informe falla, la cola se arma igual y recibe el informe como pendiente", async (t) => {
  t.mock.method(console, "error", () => {});
  const eventos: string[] = [];
  const resultado = await entregarRevisionCorreo({
    resumen: "informe largo", publicar: () => true,
    enviar: async () => { eventos.push("enviar"); throw new Error("Bad Request: message is too long"); },
    sincronizar: async texto => { eventos.push(`cola:${texto}`); return { informePublicado: true }; },
    recuperar: async () => { throw new Error("no debe recuperarse: la cola sí se pudo armar"); },
  });
  assert.deepEqual(eventos, ["enviar", "cola:informe largo"]);
  assert.equal(resultado.informePublicado, true, "la cola logró publicar el informe pendiente");
});

test("si fallan el envío y la cola, la recuperación sabe que el informe no salió", async (t) => {
  t.mock.method(console, "error", () => {});
  let entregadoVisto: boolean | undefined;
  const resultado = await entregarRevisionCorreo({
    resumen: "informe", publicar: () => true,
    enviar: async () => { throw new Error("red caída"); },
    sincronizar: async () => { throw new Error("429"); },
    recuperar: async (_error, informeEntregado) => { entregadoVisto = informeEntregado; return { informePublicado: false }; },
  });
  assert.equal(entregadoVisto, false);
  assert.equal(resultado.informePublicado, false);
});

test("con el informe entregado, la recuperación lo sabe", async () => {
  let entregadoVisto: boolean | undefined;
  await entregarRevisionCorreo({
    resumen: "informe", publicar: () => true,
    enviar: async () => {},
    sincronizar: async () => { throw new Error("429"); },
    recuperar: async (_error, informeEntregado) => { entregadoVisto = informeEntregado; return { informePublicado: false }; },
  });
  assert.equal(entregadoVisto, true);
});
