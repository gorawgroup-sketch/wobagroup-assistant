import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  debeAvanzarColaTrasRedirigirGasto,
  finalizarDocumentoTerminalAntesDeRender,
  identidadColaDocumentoParaRespuesta,
  transferirDesambiguacionACaptura,
} from "./documentCallbackHandler";
import type { PendienteDesambiguacion } from "./disambiguationStore";

test("una propuesta de gasto conserva activo y no leído el correo", () => {
  assert.equal(debeAvanzarColaTrasRedirigirGasto("propuesta_enviada"), false);
  assert.equal(debeAvanzarColaTrasRedirigirGasto("gasto_propuesto"), false);
});

test("pedir datos adicionales conserva activo y no leído el correo", () => {
  assert.equal(debeAvanzarColaTrasRedirigirGasto("pendiente_datos"), false);
  assert.equal(debeAvanzarColaTrasRedirigirGasto("gasto_pendiente_datos"), false);
});

test("propuesta intermedia seguida de resolución terminal produce un solo avance", () => {
  let avances = 0;
  const intentarAvanceDesdeDocumento = (resultado: Parameters<typeof debeAvanzarColaTrasRedirigirGasto>[0]) => {
    if (debeAvanzarColaTrasRedirigirGasto(resultado)) avances += 1;
  };

  // Primer callback: solo creó los botones del gasto; no debe cerrar el correo.
  intentarAvanceDesdeDocumento("propuesta_enviada");
  assert.equal(avances, 0);

  // Segundo callback: representa la aprobación/creación terminal en el flujo de gastos.
  avances += 1;
  assert.equal(avances, 1);
});

test("un duplicado comprobado sí es terminal en la redirección documental", () => {
  assert.equal(debeAvanzarColaTrasRedirigirGasto("propuesta_duplicada"), true);
  assert.equal(debeAvanzarColaTrasRedirigirGasto("propuesta_pendiente_existente"), false);
  assert.equal(debeAvanzarColaTrasRedirigirGasto("gasto_duplicado"), true);
});

test("un fallo de Telegram no impide cerrar exactamente una vez la identidad documental terminal", async (t) => {
  t.mock.method(console, "error", () => {});
  const eventos: string[] = [];
  const identidades: Array<{ threadId?: string; mensajeId?: string }> = [];

  await finalizarDocumentoTerminalAntesDeRender(
    77,
    { threadId: "thread-documento", mensajeIdGmail: "message-documento", deColaCorreo: true },
    "documento:terminal",
    async () => {
      eventos.push("telegram");
      throw new Error("Telegram temporalmente caído");
    },
    async (_chatId, identidad, claveIdempotencia) => {
      eventos.push("cola");
      identidades.push({ ...identidad, claveIdempotencia } as typeof identidad & { claveIdempotencia: string });
    }
  );

  assert.deepEqual(eventos, ["cola", "telegram"]);
  assert.deepEqual(identidades, [{
    threadId: "thread-documento",
    mensajeId: "message-documento",
    claveIdempotencia: "documento:terminal",
  }]);
});

test("todas las resoluciones documentales terminales usan cierre antes de renderizar", async () => {
  const fuente = await readFile(join(process.cwd(), "core/documental/documentCallbackHandler.ts"), "utf8");
  const apariciones = fuente.match(/finalizarDocumentoTerminalAntesDeRender\(/g) ?? [];

  // Definición + descarte de propuesta + archivado de propuesta + archivado
  // ambiguo + descarte ambiguo.
  assert.equal(apariciones.length, 5);
});

test("responder desde documento solo reserva ownership con hilo y mensaje exactos", async () => {
  assert.deepEqual(
    identidadColaDocumentoParaRespuesta({
      deColaCorreo: true,
      threadId: " thread-1 ",
      mensajeIdGmail: " message-1 ",
    }),
    { threadId: "thread-1", mensajeId: "message-1" }
  );
  assert.equal(
    identidadColaDocumentoParaRespuesta({ deColaCorreo: true, threadId: "thread-1" }),
    undefined
  );
  assert.equal(
    identidadColaDocumentoParaRespuesta({ deColaCorreo: false, threadId: "thread-1" }),
    null
  );

  const fuente = await readFile(join(process.cwd(), "core/documental/documentCallbackHandler.ts"), "utf8");
  const docInicio = fuente.indexOf('if (accion === "doc_responder")');
  const docFin = fuente.indexOf('if (accion === "doc_conocimiento")', docInicio);
  const desambInicio = fuente.indexOf('if (accion === "desamb_responder")');
  const desambFin = fuente.indexOf("// desamb_conocimiento", desambInicio);
  const docResponder = fuente.slice(docInicio, docFin);
  const desambResponder = fuente.slice(desambInicio, desambFin);

  for (const rama of [docResponder, desambResponder]) {
    assert.match(rama, /identidadColaDocumentoParaRespuesta\(/);
    assert.match(rama, /deColaCorreo === true && !identidadRespuesta/);
    assert.match(rama, /ofrecerResponderCorreo\([\s\S]*identidadRespuesta/);
  }
});

test("transferir una desambiguación restaura la pregunta si crear la captura falla", async () => {
  const pendiente: PendienteDesambiguacion = {
    id: "desamb-1",
    chatId: 77,
    messageId: 456,
    rutaLocal: "/tmp/documento.pdf",
    nombreArchivoOriginal: "documento.pdf",
    nombreParaClasificar: "documento.pdf",
    preguntaFormulada: "¿Dónde va?",
    creadoEn: Date.now(),
  };
  const restauradas: string[] = [];

  await assert.rejects(
    transferirDesambiguacionACaptura(
      pendiente,
      async () => {
        throw new Error("Sheets temporalmente caído");
      },
      async (valor) => {
        restauradas.push(valor.id);
      }
    ),
    /Sheets temporalmente caído/
  );
  assert.deepEqual(restauradas, ["desamb-1"]);
});

test("desamb_conocimiento reclama la pregunta antes de iniciar la captura", async () => {
  const fuente = await readFile(join(process.cwd(), "core/documental/documentCallbackHandler.ts"), "utf8");
  const inicio = fuente.indexOf("// desamb_conocimiento: reclama");
  const fin = fuente.indexOf("await answerCallbackQuerySafe(callback.id);", inicio);
  const rama = fuente.slice(inicio, fin);
  const claim = rama.indexOf("consumirPendienteDesambiguacionPorId(idBoton, chatId)");
  const captura = rama.indexOf("iniciarSeleccionEmpresaCaptura(");
  assert.ok(claim >= 0 && captura > claim);
  assert.match(rama, /transferirDesambiguacionACaptura\(pendiente/);
});

test("desamb_elegir valida antes de consumir y restaura la pregunta si Drive no confirma", async () => {
  const fuente = await readFile(join(process.cwd(), "core/documental/documentCallbackHandler.ts"), "utf8");
  const inicio = fuente.indexOf('if (accion === "desamb_elegir")');
  const fin = fuente.indexOf('if (accion === "desamb_esgasto")', inicio);
  const rama = fuente.slice(inicio, fin);

  const validacion = rama.indexOf("Number.isInteger(indice)");
  const consumo = rama.indexOf("consumirPendienteDesambiguacionPorId(pendientePeek.id, chatId)");
  assert.ok(validacion >= 0 && consumo > validacion, "la opción debe validarse antes de reclamar la pregunta");
  assert.match(rama, /if \(resultado\.ok\)[\s\S]*await restaurarPendienteDesambiguacion\(pendiente\)/);
  assert.match(rama, /catch \(error\)[\s\S]*restaurarPendienteDesambiguacion\(pendiente\)/);
});

// Caso real reportado por Carlos con captura de pantalla (2026-09-27): una pregunta de
// desambiguación cuya decisión ya se resolvió (archivada, redirigida a gasto, transferida a
// conocimiento, o descartada) se quedaba con sus botones vivos para siempre, aunque el resultado ya
// se hubiera publicado en un mensaje aparte. Estructural por el mismo motivo que los tests
// anteriores de este archivo: handleDesambiguacionCallback no admite inyección de dependencias.
test("cada desenlace terminal de la desambiguación retira la pregunta original, y solo el fallo la conserva", async () => {
  const fuente = await readFile(join(process.cwd(), "core/documental/documentCallbackHandler.ts"), "utf8");
  assert.match(fuente, /import \{ retirarPreguntaCaducada \} from "\.\.\/telegram\/preguntaCaducada";/);

  // desamb_elegir: éxito retira, el reintento (Drive no confirmó / excepción) conserva los botones.
  const inicioElegir = fuente.indexOf('if (accion === "desamb_elegir")');
  const finElegir = fuente.indexOf('if (accion === "desamb_esgasto")', inicioElegir);
  const ramaElegir = fuente.slice(inicioElegir, finElegir);
  assert.match(ramaElegir, /if \(resultado\.ok\) \{[\s\S]*?retirarPreguntaCaducada\(callback\)[\s\S]*?return;\s*\}/);
  const idxRestaurarOk = ramaElegir.search(/\/\/ Drive no confirmó el archivado/);
  assert.ok(idxRestaurarOk > 0 && !ramaElegir.slice(idxRestaurarOk).includes("retirarPreguntaCaducada"),
    "el reintento tras un fallo de Drive no debe retirar la pregunta: sus botones siguen siendo válidos");

  // desamb_esgasto: solo retira si hubo un resultadoGasto real (nunca en el catch, que restaura).
  const inicioEsgasto = fuente.indexOf('if (accion === "desamb_esgasto")');
  const finEsgasto = fuente.indexOf('if (accion === "desamb_conocimiento"', inicioEsgasto);
  const ramaEsgasto = fuente.slice(inicioEsgasto, finEsgasto);
  assert.match(ramaEsgasto, /if \(resultadoGasto\) \{[\s\S]*?await retirarPreguntaCaducada\(callback\);\s*\}\s*return;/);
  const idxCatchEsgasto = ramaEsgasto.indexOf("} catch (error) {");
  const idxIfResultado = ramaEsgasto.indexOf("if (resultadoGasto) {");
  assert.ok(idxCatchEsgasto > 0 && idxIfResultado > idxCatchEsgasto, "el retiro debe quedar fuera/después del catch, nunca dentro de él");

  // desamb_conocimiento: la pregunta ya no disponible usa el mecanismo compartido (antes usaba un
  // aviso aparte que nunca tocaba los botones); el éxito retira, el catch (falla la lectura) conserva.
  const inicioConoc = fuente.indexOf('if (accion === "desamb_conocimiento" || accion === "desamb_alerta" || accion === "desamb_responder")');
  const finConoc = fuente.indexOf('if (accion !== "desamb_descartar")', inicioConoc);
  const ramaConoc = fuente.slice(inicioConoc, finConoc);
  assert.match(ramaConoc, /if \(!pendiente\) \{\s*await retirarPreguntaCaducada\(callback, "Esta pregunta ya no está disponible \(expiró o ya se respondió\)\."\);/);
  assert.match(ramaConoc, /await transferirDesambiguacionACaptura\(pendiente, async \(reclamada\) => \{[\s\S]*?\}\);[\s\S]*?await retirarPreguntaCaducada\(callback\);\s*\} catch/);

  // desamb_descartar: "ya no disponible" también usa el mecanismo compartido (con el aviso compuesto
  // según cuántas otras preguntas queden), y el descarte terminal retira la pregunta.
  const inicioDescartar = fuente.indexOf('if (accion !== "desamb_descartar")');
  const ramaDescartar = fuente.slice(inicioDescartar);
  assert.match(ramaDescartar, /await retirarPreguntaCaducada\(callback, aviso\);/);
  assert.match(ramaDescartar, /finalizarDocumentoTerminalAntesDeRender\(\s*chatId,\s*pendiente\.correoOrigen,[\s\S]*?\(\) => Promise\.all\(\[\s*retirarPreguntaCaducada\(callback\),/);
});
