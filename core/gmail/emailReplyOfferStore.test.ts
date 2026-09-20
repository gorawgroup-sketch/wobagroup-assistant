import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  consumirOfertaResponderUnaVez,
  identidadCorreoDeOferta,
  type DependenciasConsumoOfertaResponder,
  type OfertaResponderCorreo,
} from "./emailReplyOfferStore";

function crearOferta(id: string): OfertaResponderCorreo {
  return {
    id,
    chatId: 10,
    messageId: 20,
    de: "proveedor@example.com",
    asunto: "Documento",
    threadId: "thread-gmail",
    messageIdHeader: "<mensaje@example.com>",
    contexto: "Acuse de recibo",
    deColaCorreo: true,
    correoThreadId: "thread-gmail",
    correoMensajeId: "message-gmail",
    creadoEn: Date.now(),
  };
}

test("una oferta de cola solo expone identidad cuando conserva hilo y mensaje exactos", () => {
  assert.deepEqual(
    identidadCorreoDeOferta({ correoThreadId: " thread-1 ", correoMensajeId: " message-1 " }),
    { threadId: "thread-1", mensajeId: "message-1" }
  );
  assert.equal(identidadCorreoDeOferta({ correoThreadId: "thread-1", correoMensajeId: "" }), undefined);
  assert.equal(identidadCorreoDeOferta({ correoThreadId: "", correoMensajeId: "message-1" }), undefined);
});

test("dos toques concurrentes reclaman una oferta una sola vez sin borrar la vecina", async () => {
  const filas = [crearOferta("oferta-a"), crearOferta("oferta-b")];
  const dependencias: DependenciasConsumoOfertaResponder = {
    leer: async () => filas.map((oferta, indice) => ({ rowIndex: indice + 2, oferta })),
    eliminar: async (rowIndex) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      filas.splice(rowIndex - 2, 1);
    },
  };
  const clave = `emailReplyOfferStore:test:${Date.now()}:${Math.random()}`;

  const resultados = await Promise.all([
    consumirOfertaResponderUnaVez("oferta-a", dependencias, clave),
    consumirOfertaResponderUnaVez("oferta-a", dependencias, clave),
  ]);

  assert.equal(resultados.filter(Boolean).length, 1);
  assert.deepEqual(filas.map((oferta) => oferta.id), ["oferta-b"]);
});

test("la oferta visible reserva una unidad y compensa si no logra publicarse", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gmail/emailCallbackHandler.ts"), "utf8");
  const inicio = fuente.indexOf("export async function ofrecerResponderCorreo");
  const fin = fuente.indexOf("function tecladoOfertaResponder", inicio);
  const flujo = fuente.slice(inicio, fin);

  assert.match(flujo, /obtenerOfertaResponderPorCorreo\(chatId, identidadExacta\)/);
  assert.match(flujo, /incrementarPendientesActivo\(chatId, identidadExacta\)/);
  assert.match(flujo, /correoThreadId:\s*identidadExacta\?\.threadId/);
  assert.match(flujo, /correoMensajeId:\s*identidadExacta\?\.mensajeId/);
  assert.match(flujo, /revertirIncrementoPendientesActivo\(chatId, identidadExacta\)/);
});

test("No cierra solo su unidad exacta y Sí la transfiere al borrador", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gmail/emailCallbackHandler.ts"), "utf8");
  const inicio = fuente.indexOf('if (accion === "email_responder_si" || accion === "email_responder_no")', fuente.indexOf("handleEmailActionCallbackInterno"));
  const fin = fuente.indexOf("if (!ACCIONES_PROPUESTA_CORREO.has", inicio);
  const flujo = fuente.slice(inicio, fin);

  assert.match(flujo, /identidadCorreoDeOferta\(oferta\)/);
  assert.match(
    flujo,
    /avanzarColaCorreoSiActivo\([\s\S]*oferta\.chatId,[\s\S]*identidadOferta,[\s\S]*email-oferta:\$\{oferta\.id\}:resolver/
  );
  assert.match(flujo, /generarBorradorYOfrecer\([\s\S]*oferta\.deColaCorreo \? identidadOferta : undefined/);
  assert.match(flujo, /restaurarOfertaTrasError/);
});

test("captura y respuesta laterales de processClassification conservan y compensan ownership", async () => {
  const fuente = await readFile(join(process.cwd(), "core/documental/processClassification.ts"), "utf8");
  const inicio = fuente.indexOf("async function ofrecerCapturaYRespuesta");
  const fin = fuente.indexOf("export async function manejarClasificacion", inicio);
  const flujo = fuente.slice(inicio, fin);

  assert.match(flujo, /mensajeId:\s*archivo\.correoOrigen\.mensajeIdGmail\.trim\(\)/);
  assert.match(flujo, /incrementarPendientesActivo\(archivo\.chatId, identidadCola\)/);
  assert.match(flujo, /revertirIncrementoPendientesActivo\(archivo\.chatId, identidadCola\)/);
  assert.match(flujo, /iniciarSeleccionEmpresaCaptura\([\s\S]*true,[\s\S]*identidadCola/);
  assert.match(flujo, /ofrecerResponderCorreo\([\s\S]*identidadCola \?\? null/);
});
