import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ErrorTrasEjecucion, esErrorTrasEjecucion, mensajeFalloTrasEjecucion } from "./errorTrasEjecucion";
import { TurnoConEfectosError } from "../claude/turnSafety";

async function fuente(ruta: string): Promise<string> {
  return readFile(join(process.cwd(), ruta), "utf8");
}

function cuerpoFuncion(codigo: string, firma: string): string {
  const inicio = codigo.indexOf(firma);
  assert.notEqual(inicio, -1, `no se encontró ${firma}`);
  const fin = codigo.indexOf("\n}\n", inicio);
  assert.notEqual(fin, -1, `no se encontró el final de ${firma}`);
  return codigo.slice(inicio, fin);
}

test("ErrorTrasEjecucion conserva la causa y se distingue de un error común", () => {
  const causa = new Error("Se creó un borrador durante la ejecución, pero no corresponde al correo original.");
  const error = new ErrorTrasEjecucion("La instrucción se ejecutó", causa);
  assert.equal(esErrorTrasEjecucion(error), true);
  assert.equal(esErrorTrasEjecucion(causa), false);
  assert.equal(error.cause, causa);
  assert.match(error.message, /La instrucción se ejecutó: Se creó un borrador/);
});

test("un turno de askClaude cortado tras iniciar efectos también cuenta como ya ejecutado", () => {
  // Hallazgo real de auditoría: un 529/timeout tras crear borrador y recordatorio re-armaba la orientación.
  const turno = new TurnoConEfectosError(new Error("529 overloaded"));
  assert.equal(esErrorTrasEjecucion(turno), true);
  const texto = mensajeFalloTrasEjecucion(turno);
  assert.match(texto, /ya se ejecutó/);
  assert.match(texto, /NO la volverá a ejecutar/);
  assert.doesNotMatch(texto, /reintent/i);
});

test("ningún pendiente de texto libre se re-arma tras un fallo posterior a la ejecución", async () => {
  const servidor = await fuente("src/server.ts");
  const cuerpo = cuerpoFuncion(servidor, "async function intentarResolverPendienteTextoLibre(");
  const catches = cuerpo.split("} catch (error) {").slice(1);
  assert.ok(catches.length >= 10, "se esperaban los catch de todos los pendientes de texto libre");
  for (const bloque of catches) {
    const guarda = bloque.indexOf("if (esErrorTrasEjecucion(error)) {");
    assert.notEqual(guarda, -1, `un catch no distingue ErrorTrasEjecucion:\n${bloque.slice(0, 300)}`);
    const finGuarda = bloque.indexOf("}", guarda);
    const dentro = bloque.slice(guarda, finGuarda);
    assert.match(dentro, /sendTelegramMessage\(chatId, mensajeFalloTrasEjecucion\(error\)\)/);
    assert.match(dentro, /throw error;/);
    for (const reArmado of ["restaurarPendiente", "guardarPendiente"]) {
      const posicion = bloque.indexOf(reArmado);
      if (posicion !== -1) assert.ok(finGuarda < posicion, `${reArmado} ocurre antes de relanzar el error`);
    }
  }
});

test("la orientación de correo marca como posterior a la ejecución todo fallo tras askClaude", async () => {
  const handler = await fuente("core/gmail/emailCallbackHandler.ts");
  const cuerpo = cuerpoFuncion(handler, "export async function continuarConOrientacion(");
  const askClaude = cuerpo.indexOf('await askClaude(instruccion, chatId, undefined, "orientacion_correo")');
  const intento = cuerpo.indexOf("try {", askClaude);
  const envoltura = cuerpo.lastIndexOf('throw new ErrorTrasEjecucion("La instrucción se ejecutó');
  assert.ok(askClaude > 0 && intento > askClaude && envoltura > intento);
  // Todo el cierre (vincular borrador, generar borrador, avanzar la cola) queda dentro de la envoltura.
  for (const paso of ["obtenerBorradorCreadoDesde(", "vincularBorradorACola(", "generarBorradorYOfrecer(", "avanzarColaCorreoSiActivo("]) {
    const posicion = cuerpo.indexOf(paso, askClaude);
    assert.ok(posicion > intento && posicion < envoltura, `${paso} quedó fuera de la envoltura`);
  }
});

test("la selección de gasto no vuelve a pedir un texto que ya se aplicó", async () => {
  const handler = await fuente("core/gastos/gastoCallbackHandler.ts");
  const seleccion = cuerpoFuncion(handler, "export async function continuarConSeleccionGasto(");
  const reintentable = seleccion.indexOf("if (!resultado.ok && resultado.reintentable)");
  const intento = seleccion.indexOf("  try {", reintentable);
  assert.ok(reintentable > 0 && intento > reintentable);
  assert.match(seleccion.slice(intento), /throw new ErrorTrasEjecucion\("Tu respuesta ya se aplicó/);

  const otras = cuerpoFuncion(handler, "async function aplicarTextoOtrasAcciones(");
  const llamada = otras.indexOf('respuesta = await askClaude(instruccion, propuesta.chatId, undefined, "accion_gasto")');
  const marca = otras.indexOf("instruccionEjecutada = true;", llamada);
  assert.ok(llamada > 0 && marca > llamada, "la marca va DESPUÉS de askClaude: un fallo previo sí es reintentable");
  const tras = otras.slice(otras.indexOf("if (instruccionEjecutada || esErrorTrasEjecucion(error)) {"));
  assert.match(tras.slice(0, 400), /reintentable: false/);
});

test("«Proceder» nunca se vuelve a ofrecer tras una acción de correo ya ejecutada", async () => {
  const handler = await fuente("core/gmail/emailCallbackHandler.ts");
  assert.match(handler, /\.\.\.\(yaEjecutada \? \[\] : \[\{ text: "✅ Proceder"/);
  const proceder = handler.slice(handler.indexOf("// email_proceder"), handler.indexOf("export async function continuarConOrientacion"));
  const llamada = proceder.indexOf('await askClaude(instruccion, propuesta.chatId, undefined, "accion_correo")');
  assert.ok(llamada > 0 && proceder.indexOf("accionEjecutada = true;", llamada) > llamada);
  assert.match(proceder, /accionEjecutada \|\| esErrorTrasEjecucion\(error\)/);
  // Con respuesta obligatoria, un borrador a terceros del hilo no sustituye la respuesta al remitente.
  assert.match(proceder, /aceptarOtroDestinatarioDelHilo: !requiereRespuesta/);
});

test("un ajuste de monto a medio escribir nunca se re-arma para aplicarse dos veces", async () => {
  const handler = await fuente("core/gastos/gastoCallbackHandler.ts");
  const nuevoMonto = cuerpoFuncion(handler, "async function aplicarNuevoMonto(");
  assert.match(nuevoMonto, /actual\.monto !== propuesta\.monto[\s\S]*throw new ErrorTrasEjecucion/);
  const continuar = cuerpoFuncion(handler, "export async function continuarConAjusteMonto(");
  assert.match(continuar, /throw new ErrorTrasEjecucion\("El monto quedó ajustado/);
});
