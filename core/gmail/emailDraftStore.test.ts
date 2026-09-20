import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  consumirBorradorUnaVez,
  seleccionarBorradorCorrelacionado,
  type BorradorCorreo,
  type DependenciasConsumoBorrador,
} from "./emailDraftStore";

test("el store de borradores persiste y puede vincular la identidad de cola", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gmail/emailDraftStore.ts"), "utf8");
  assert.match(fuente, /"deColaCorreo",\s*"correoThreadId",\s*"correoMensajeId",\s*"unidadColaId"/s);
  assert.match(fuente, /range:\s*`\$\{TAB_NAME\}!J\$\{match\.rowIndex\}:M\$\{match\.rowIndex\}`/);
  assert.match(fuente, /verificado\.id !== id/);
  assert.match(fuente, /return verificado/);
  assert.match(fuente, /datos\.deColaCorreo && \(!datos\.correoThreadId\?\.trim\(\) \|\| !datos\.correoMensajeId\?\.trim\(\)\)/);
  assert.match(fuente, /if \(!correoThreadId \|\| !correoMensajeId\) return undefined/);
  assert.doesNotMatch(fuente, /if \(!correoThreadId && !correoMensajeId\) return undefined/);
});

test("la correlación elige el borrador del hilo esperado y rechaza candidatos ajenos o ambiguos", () => {
  const base: BorradorCorreo = {
    id: "correcto",
    chatId: 1,
    messageId: 2,
    to: "persona@example.com",
    subject: "Asunto",
    threadId: "thread-correcto",
    messageIdHeader: "<mensaje-correcto@example.com>",
    cuerpo: "Texto",
    creadoEn: 10,
  };
  const ajeno: BorradorCorreo = {
    ...base,
    id: "ajeno",
    to: "otra@example.com",
    threadId: "thread-ajeno",
    messageIdHeader: "<mensaje-ajeno@example.com>",
  };

  assert.equal(
    seleccionarBorradorCorrelacionado([ajeno, base], {
      to: "PERSONA@example.com",
      threadId: "thread-correcto",
      messageIdHeader: "<mensaje-correcto@example.com>",
    })?.id,
    "correcto"
  );
  assert.throws(
    () => seleccionarBorradorCorrelacionado([ajeno], { threadId: "thread-correcto" }),
    /no corresponde al correo original/
  );
  assert.throws(
    () => seleccionarBorradorCorrelacionado([ajeno, base]),
    /varios borradores/
  );
});

test("dos callbacks concurrentes consumen el mismo borrador una sola vez y no borran la fila vecina", async () => {
  const crear = (id: string): BorradorCorreo => ({
    id,
    chatId: 1,
    messageId: 2,
    to: "destino@example.com",
    subject: "Asunto",
    cuerpo: "Texto",
    creadoEn: Date.now(),
  });
  const filas = [crear("draft-a"), crear("draft-b")];
  const dependencias: DependenciasConsumoBorrador = {
    leer: async () => filas.map((borrador, indice) => ({ rowIndex: indice + 2, borrador })),
    eliminar: async (rowIndex) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      filas.splice(rowIndex - 2, 1);
    },
  };

  const clave = `emailDraftStore:test:${Date.now()}:${Math.random()}`;
  const resultados = await Promise.all([
    consumirBorradorUnaVez("draft-a", dependencias, clave),
    consumirBorradorUnaVez("draft-a", dependencias, clave),
  ]);

  assert.equal(resultados.filter(Boolean).length, 1);
  assert.deepEqual(filas.map((fila) => fila.id), ["draft-b"]);
});
