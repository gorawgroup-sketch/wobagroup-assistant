import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { identidadCorreoDeBorrador, identidadCorreoDePropuesta } from "./emailCallbackHandler";

test("la propuesta conserva la identidad exacta del hilo y mensaje que la originaron", () => {
  assert.deepEqual(
    identidadCorreoDePropuesta({ threadId: "thread-1", mensajeId: "message-1" }),
    { threadId: "thread-1", mensajeId: "message-1" }
  );
  assert.deepEqual(
    identidadCorreoDePropuesta({ threadId: " thread-1 ", mensajeId: " " }),
    undefined
  );
  assert.equal(identidadCorreoDePropuesta({ threadId: "", mensajeId: "message-1" }), undefined);
  assert.equal(identidadCorreoDePropuesta({ threadId: "", mensajeId: "  " }), undefined);
});

test("un borrador conserva la identidad del correo hasta su decisión terminal", () => {
  assert.deepEqual(
    identidadCorreoDeBorrador({ correoThreadId: "thread-draft", correoMensajeId: "message-draft" }),
    { threadId: "thread-draft", mensajeId: "message-draft" }
  );
  assert.equal(identidadCorreoDeBorrador({ correoThreadId: "thread-draft", correoMensajeId: "" }), undefined);
  assert.equal(identidadCorreoDeBorrador({ correoThreadId: "", correoMensajeId: "message-draft" }), undefined);
  assert.equal(identidadCorreoDeBorrador({ correoThreadId: "", correoMensajeId: " " }), undefined);
});

test("una ruta legacy parcial nunca adopta el mensaje activo del mismo hilo", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gmail/emailCallbackHandler.ts"), "utf8");
  const inicio = fuente.indexOf("export async function ofrecerResponderCorreo");
  const fin = fuente.indexOf("function tecladoOfertaResponder", inicio);
  const publicacion = fuente.slice(inicio, fin);

  assert.doesNotMatch(publicacion, /obtenerActivoActual/);
  assert.doesNotMatch(publicacion, /activo\?\.id === threadId/);
  assert.match(publicacion, /if \(origenCola\)[\s\S]*!threadCorreo \|\| !mensajeCorreo/);
});

test("guardar, orientar y proceder restauran la acción al fallar sin avanzar la cola", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gmail/emailCallbackHandler.ts"), "utf8");

  const inicioGuardar = fuente.indexOf('if (accion === "email_guardar")');
  const inicioOrientar = fuente.indexOf('if (accion === "email_orientar")', inicioGuardar);
  const inicioProceder = fuente.indexOf("// email_proceder", inicioOrientar);
  const finHandler = fuente.indexOf("\n}\n\n/**\n * Continúa el flujo", inicioProceder);
  assert.ok(inicioGuardar >= 0 && inicioOrientar > inicioGuardar && inicioProceder > inicioOrientar && finHandler > inicioProceder);

  const guardar = fuente.slice(inicioGuardar, inicioOrientar);
  assert.match(guardar, /restaurarPropuestaTrasError\(/);
  assert.doesNotMatch(guardar, /avanzarColaCorreoSiActivo/);
  assert.match(guardar, /identidadPropuesta/);

  const orientar = fuente.slice(inicioOrientar, inicioProceder);
  assert.match(orientar, /mensajeId:\s*propuesta\.mensajeId/);
  assert.match(orientar, /restaurarPropuestaTrasError\(/);
  assert.doesNotMatch(orientar, /avanzarColaCorreoSiActivo/);

  const proceder = fuente.slice(inicioProceder, finHandler);
  const inicioCatch = proceder.lastIndexOf("} catch (error) {");
  assert.ok(inicioCatch > 0);
  const errorProceder = proceder.slice(inicioCatch);
  assert.match(errorProceder, /restaurarPropuestaTrasError\(/);
  assert.doesNotMatch(errorProceder, /avanzarColaCorreoSiActivo/);
  assert.match(
    proceder.slice(0, inicioCatch),
    /avanzarColaCorreoSiActivo\([\s\S]*propuesta\.chatId,[\s\S]*identidad,[\s\S]*email-accion:\$\{propuesta\.id\}:resolver/
  );
  assert.match(proceder.slice(0, inicioCatch), /vincularBorradorACola\(borradorPendiente\.id, identidad\)/);
  assert.match(proceder.slice(0, inicioCatch), /if \(!hayBorradorPendiente && propuesta\.deColaCorreo && identidad\)/);
  assert.match(proceder.slice(0, inicioCatch), /propuesta\.deColaCorreo \|\| requiereRespuesta/);
});

test("una orientación fallida se devuelve al store y solo su identidad puede cerrar Gmail", async () => {
  const [handler, servidor] = await Promise.all([
    readFile(join(process.cwd(), "core/gmail/emailCallbackHandler.ts"), "utf8"),
    readFile(join(process.cwd(), "src/server.ts"), "utf8"),
  ]);

  const inicio = handler.indexOf("export async function continuarConOrientacion");
  const fin = handler.indexOf("export async function handleDraftCallback", inicio);
  const orientacion = handler.slice(inicio, fin);
  assert.match(orientacion, /mensajeId\?: string/);
  assert.match(
    orientacion,
    /avanzarColaCorreoSiActivo\([\s\S]*chatId,[\s\S]*identidad,[\s\S]*email-orientacion:\$\{identidadEstable\}:resolver/
  );
  assert.doesNotMatch(orientacion, /avanzarColaCorreoSiActivo\(chatId\)/);
  assert.match(orientacion, /vincularBorradorACola\(borradorPendiente\.id, identidad\)/);
  assert.match(orientacion, /if \(!borradorPendiente && deColaCorreo && identidad\)/);
  assert.match(orientacion, /deColaCorreo \|\| pareceRespuesta/);

  const consumo = servidor.indexOf("const reclamoOrientacion = await reclamarPendienteOrientacionCorreo");
  const siguiente = servidor.indexOf("const pendienteOrientacionAnotacion", consumo);
  const flujoServidor = servidor.slice(consumo, siguiente);
  assert.match(flujoServidor, /reclamoOrientacion\.estado === "ambigua"/);
  assert.match(flujoServidor, /pendienteOrientacion\.mensajeId/);
  assert.match(flujoServidor, /restaurarPendienteOrientacionCorreo\(pendienteOrientacion\)/);
});

test("un borrador pendiente no cierra el correo hasta enviar o cancelar", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gmail/emailCallbackHandler.ts"), "utf8");
  const inicio = fuente.indexOf("export async function handleDraftCallback");
  const fin = fuente.indexOf("let anthropicEdicion", inicio);
  const callbacks = fuente.slice(inicio, fin);

  const verificar = callbacks.slice(
    callbacks.indexOf('if (accion === "draft_verificar")'),
    callbacks.indexOf('if (accion === "draft_cancelar")')
  );
  assert.match(verificar, /consultarEnvioCorreoExistente\(`borrador:\$\{borrador\.id\}`\)/);
  assert.match(verificar, /const consumido = await consumirBorradorCorreo\(borrador\.id\)/);
  assert.match(
    verificar,
    /avanzarColaCorreoSiActivo\([\s\S]*consumido\.chatId,[\s\S]*identidad,[\s\S]*email-borrador:\$\{consumido\.id\}:resolver/
  );

  const cancelar = callbacks.slice(
    callbacks.indexOf('if (accion === "draft_cancelar")'),
    callbacks.indexOf('if (accion === "draft_editar")')
  );
  assert.match(cancelar, /identidadCorreoDeBorrador\(borrador\)/);
  assert.match(
    cancelar,
    /avanzarColaCorreoSiActivo\([\s\S]*borrador\.chatId,[\s\S]*identidad,[\s\S]*email-borrador:\$\{borrador\.id\}:resolver/
  );

  const editar = callbacks.slice(
    callbacks.indexOf('if (accion === "draft_editar")'),
    callbacks.indexOf("// draft_enviar")
  );
  assert.doesNotMatch(editar, /avanzarColaCorreoSiActivo/);

  const enviar = callbacks.slice(callbacks.indexOf("// draft_enviar"));
  assert.match(enviar, /const consumido = await consumirBorradorCorreo\(id\)/);
  assert.match(enviar, /identidadCorreoDeBorrador\(consumido\)/);
  assert.match(
    enviar,
    /avanzarColaCorreoSiActivo\([\s\S]*consumido\.chatId,[\s\S]*identidad,[\s\S]*email-borrador:\$\{consumido\.id\}:resolver/
  );
  assert.match(enviar, /draft_verificar:\$\{borrador\.id\}/);
});
