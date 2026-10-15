import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const rutaCliente = join(process.cwd(), "core/gmail/client.ts");
const rutaJob = join(process.cwd(), "core/jobs/revisarCorreoNuevo.ts");
const rutaPuntual = join(process.cwd(), "core/tools/revisarCorreoPuntual.ts");
const rutaCaptura = join(process.cwd(), "core/tools/capturarCorreo.ts");

test("la revisión general incluye los no leídos pendientes y excluye los ya procesados automáticamente", async () => {
  const fuente = await readFile(rutaCliente, "utf8");
  const inicio = fuente.indexOf("export async function listarHilosNoLeidos");
  const final = fuente.indexOf("export async function listarHilosNoLeidosDe", inicio);
  assert.notEqual(inicio, -1);
  assert.notEqual(final, -1);
  assert.match(fuente.slice(inicio, final), /is:unread -label:\$\{ETIQUETA_PROCESADO_AUTOMATICO\} -in:spam -in:trash/);
});
test("la búsqueda puntual exige una referencia concreta y puede incluir correos leídos", async () => {
  const [job, tool] = await Promise.all([
    readFile(rutaJob, "utf8"),
    readFile(rutaPuntual, "utf8"),
  ]);
  assert.match(tool, /esReferenciaCorreoConcreta\(busqueda\)/);
  assert.match(job, /`\$\{busqueda\.trim\(\)\} in:inbox`/);
  assert.match(job, /activo\.id === correo\.threadId/);
});

test("capturar sin referencia usa el no leído más antiguo y no marca leído antes de ver adjuntos", async () => {
  const fuente = await readFile(rutaCaptura, "utf8");
  assert.match(fuente, /listarHilosNoLeidos\(\)/);
  assert.match(fuente, /fechaPrimerNoLeido \|\| [ab]\.fecha/);

  const sinAdjuntos = fuente.indexOf("if (resumen.adjuntos.length === 0)");
  const marcarLeido = fuente.indexOf("marcarHiloComoLeido(resumen.threadId)");
  assert.ok(sinAdjuntos >= 0 && marcarLeido > sinAdjuntos, "el marcado como leído debe ocurrir solo después de comprobar que no hay decisiones pendientes");
});

test("la revisión nunca continúa ni cierra un correo si falló su lectura completa o su evaluación como gasto", async () => {
  const fuente = await readFile(rutaJob, "utf8");
  const inicio = fuente.indexOf("async function procesarCorreoLocalizado");
  const fin = fuente.indexOf("export async function procesarSiguienteCorreoActivo", inicio);
  const flujo = fuente.slice(inicio, fin);

  assert.doesNotMatch(flujo, /Error leyendo el cuerpo completo[\s\S]{0,300}return ""/);
  assert.match(flujo, /cuerpoCompleto = await obtenerCuerpoCompletoCorreo\(correo\.id\)[\s\S]{0,500}throw error/);
  assert.match(flujo, /gastoDetectado = await extraerGastoDeCorreo[\s\S]{0,700}No se pudo determinar si[\s\S]{0,300}throw error/);
});

test("la cola fija las decisiones pendientes antes de comprobar la operación anterior y no calla un cierre fallido", async () => {
  const fuente = await readFile(rutaJob, "utf8");
  // Con 0 pendientes el vigilante da el correo por resuelto y lo marca leído: el error previo no debe dejar ese estado.
  const cola = fuente.slice(fuente.indexOf("async function procesarSiguienteCorreoActivoInterno"),
    fuente.indexOf("export async function handleReintentarActivoCallback"));
  assert.ok(cola.indexOf("establecerPendientesActivo(") >= 0 && cola.indexOf("establecerPendientesActivo(") < cola.indexOf("comprobarCorreoDisponible("),
    "en la cola, establecerPendientesActivo debe ir antes de comprobarCorreoDisponible");
  const reintento = fuente.slice(fuente.indexOf("export async function handleReintentarActivoCallback"),
    fuente.indexOf("export async function procesarCorreoPuntual"));
  assert.ok(reintento.indexOf("establecerPendientesActivo(") >= 0 && reintento.indexOf("establecerPendientesActivo(") < reintento.indexOf("comprobarCorreoDisponible("),
    "en el reintento, establecerPendientesActivo debe ir antes de comprobarCorreoDisponible");
  // El cierre de un correo «ya registrado» nunca descarta el texto de fallo: avisa con botones de reintento.
  assert.match(reintento, /previa\.tipo === "ya_registrado" && alcance === "correo"/,
    "un reintento de un adjunto o del cuerpo no puede dar el correo entero por cerrado");
  const cierre = fuente.slice(fuente.indexOf("async function cerrarActivoYaRegistrado"),
    fuente.indexOf("export async function handleDescartarActivoCallback"));
  assert.match(cierre, /if \(cierre\.ok\) return;/);
  assert.match(cierre, /publicarReintentoTecnico\(/);
  // La búsqueda puntual informa pero no le quita al operador la revisión que pidió.
  const puntual = fuente.slice(fuente.indexOf("async function procesarCorreoPuntualInterno"), fuente.indexOf("Señal genérica de"));
  assert.match(puntual, /yaRegistrado/);
  assert.ok(puntual.indexOf("mensajeYaRegistrado") < puntual.indexOf("procesarCorreoLocalizado(chatId, correo, false)"));
});

test("«Reprocesar este correo» está cableado: ruta, protección de superadmin y reapertura del propio botón", async () => {
  const [servidor, usuarios, entregas, job] = await Promise.all([
    readFile(join(process.cwd(), "src/server.ts"), "utf8"),
    readFile(join(process.cwd(), "core/telegram/authorizedUsersSheet.ts"), "utf8"),
    readFile(join(process.cwd(), "core/telegram/durableDelivery.ts"), "utf8"),
    readFile(rutaJob, "utf8"),
  ]);
  assert.match(servidor, /data === "colacorreo_reprocesaractivo"[\s\S]{0,80}handleReprocesarActivoCallback\(callback\)/);
  assert.match(usuarios, /"colacorreo_reprocesaractivo"/);
  // Deliberado (hallazgo real de auditoría, 28/09): "colacorreo_reprocesaractivo"/"descartaractivo" actúan sobre
  // "el activo actual" sin verificar identidad, así que NO están en el set reabrible — solo gasto_aprobar, que es
  // atómico y no depende de qué correo esté activo. La cobertura de comportamiento (solo esta acción se reabre)
  // vive en durableDelivery.test.ts; aquí solo se confirma el cableado textual del set.
  const bloqueSet = entregas.slice(entregas.indexOf("ACCIONES_REABRIBLES_TRAS_COMPLETAR"), entregas.indexOf("]);", entregas.indexOf("ACCIONES_REABRIBLES_TRAS_COMPLETAR")) + 3);
  const entradas = bloqueSet.split("\n").filter(linea => !linea.trim().startsWith("//")).join("\n");
  assert.match(entradas, /"gasto_aprobar"/);
  assert.doesNotMatch(entradas, /"colacorreo_/);
  // Antes de reprocesar se vuelve a comprobar que NO hay pregunta viva, para no duplicar una propuesta recién llegada.
  const manejador = job.slice(job.indexOf("export async function handleReprocesarActivoCallback"),
    job.indexOf("export async function handleDescartarActivoCallback"));
  assert.ok(manejador.indexOf("huboSenalDeEntrega(") >= 0 && manejador.indexOf("huboSenalDeEntrega(") < manejador.indexOf("reencolarActivoParaReintento("));
  assert.match(manejador, /conCoordinadorCorreo\(/);
  // Nunca reprocesar un correo ya resuelto (pendientesRestantes<=0) ni mientras otro callback sigue en vuelo —
  // ambas comprobaciones antes de reencolarActivoParaReintento (hallazgo real de auditoría).
  const pendientesIdx = manejador.indexOf("activo.pendientesRestantes <= 0");
  assert.ok(pendientesIdx >= 0 && pendientesIdx < manejador.indexOf("reencolarActivoParaReintento("));
  assert.match(manejador, /hayActividadCallbackReciente\(chatId\)/);
});

test("las facturas enlazadas en el cuerpo solo se verifican en la rama SIN adjuntos reales, nunca bloquean el correo, y solo reemplazan el gasto cuando se verificó", async () => {
  const fuente = await readFile(rutaJob, "utf8");
  assert.match(fuente, /import \{ verificarFacturasEnlazadasEnCuerpo \} from "\.\.\/gmail\/facturasEnlazadasEnCuerpo";/);
  const inicioSinAdjuntos = fuente.indexOf("if (gastoDetectado?.esFacturaOGasto) {");
  const inicioConAdjuntos = fuente.indexOf("if (correo.adjuntos.length > 0) {");
  assert.ok(inicioSinAdjuntos > 0 && inicioConAdjuntos > 0 && inicioSinAdjuntos > inicioConAdjuntos,
    "la verificación debe vivir en la rama posterior (sin adjuntos), nunca en la rama con adjuntos reales");
  const bloque = fuente.slice(inicioSinAdjuntos, fuente.indexOf("const bytes = await generarComprobantePDF"));
  assert.ok(bloque.indexOf("verificarFacturasEnlazadasEnCuerpo(") >= 0);
  // Un fallo de la verificación (enlace caído, IA no disponible…) nunca debe tumbar el procesamiento del correo:
  // tiene su propio .catch() que cae a "no verificado", nunca deja que el error se propague sin capturar.
  const llamada = bloque.slice(bloque.indexOf("verificarFacturasEnlazadasEnCuerpo("));
  const hastaElCatch = llamada.slice(0, llamada.indexOf(".catch("));
  assert.doesNotMatch(hastaElCatch, /;\s*$/m, "la llamada y su .catch() deben ser una sola expresión encadenada");
  assert.match(llamada.slice(0, 400), /\.catch\(\(error\)/);
  // gastoDetectado solo se reemplaza dentro de la rama verificado:true — nunca incondicionalmente.
  const asignacion = bloque.indexOf("gastoDetectado = verificacionEnlazadas.datosCombinados");
  const guardaVerificado = bloque.lastIndexOf("if (verificacionEnlazadas.verificado)", asignacion);
  assert.ok(asignacion > 0 && guardaVerificado > 0 && asignacion - guardaVerificado < 120);
});

// «Vuelve a proponerlo» (Carlos, 2026-10-14): un correo descartado solo se reabre levantando el descarte ANTES de procesarlo.
test("la búsqueda puntual con volverAProponer retira el descarte del operador antes de procesar el correo", async () => {
  const fuente = await readFile(join(process.cwd(), "core/jobs/revisarCorreoNuevo.ts"), "utf8");
  const puntual = fuente.slice(fuente.indexOf("async function procesarCorreoPuntualInterno"), fuente.indexOf("Señal genérica de"));
  const retirar = puntual.indexOf("retirarGastoDescartadoPorOperador(correo.id)");
  assert.ok(retirar >= 0, "debe levantar el descarte");
  assert.ok(puntual.slice(0, retirar).includes("opciones.volverAProponer"), "solo cuando el operador lo pide");
  assert.ok(retirar < puntual.indexOf("await procesarCorreoLocalizado(chatId, correo, false);"), "antes de procesar");
});

// Cadena completa (Carlos, 14-10): los nombres del documento viajan de la propuesta a la pregunta «¿conciliar?» y a «Sí, conciliar».
test("los nombres alternativos del documento llegan a la pregunta de conciliación y a la conciliación posterior", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");
  assert.match(fuente, /nombresAlternativos: propuesta\.nombresAlternativos,\n\s*\};\n\n(\s*\/\/[^\n]*\n)*\s*if \(conciliarInline \|\| propuesta\.conciliacionPlanificada\)/, "datosConciliacionPendiente lleva los nombres");
  assert.ok(fuente.includes("pendiente.threadIdGmail,\n      pendiente.nombresAlternativos\n"), "«Sí, conciliar» pasa los nombres de la pendiente");
  assert.match(fuente, /buscarMovimientoSimilar\(empresa, \{ monto, fecha: fechaBusqueda, moneda, proveedor, concepto: conceptoBusqueda, nombresAlternativos \}\)/);
  const store = await readFile(join(process.cwd(), "core/gastos/conciliacionPendienteStore.ts"), "utf8");
  assert.match(store, /const ULTIMA_COLUMNA = String\.fromCharCode\(64 \+ HEADERS\.length\)/);
  for (const rango of store.match(/`\$\{TAB_NAME\}!A[^`]*:[^`]*`/g) ?? []) assert.match(rango, /\$\{ULTIMA_COLUMNA\}/, `rango fijo: ${rango}`);
});

// Periodo contable cerrado (casos reales 14-10): «Sí, usar hoy» concilia contra el cargo ya identificado y la pregunta busca en la fecha del cargo.
test("con la fecha bloqueada, el botón concilia contra el movimiento recomendado y la pregunta usa la fecha del cargo", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");
  const bloque = fuente.slice(fuente.indexOf("async function manejarFechaBloqueada"), fuente.indexOf("async function manejarFechaBloqueada") + 4000);
  assert.match(bloque, /movimientoRecomendadoPropuesta\(nuevaPropuesta\)/);
  assert.match(bloque, /recomendado \? "gasto_nuevo_conciliar" : "gasto_nuevo"/);
  assert.match(fuente, /fecha: propuesta\.movimientosAmbiguos\?\.\[0\]\?\.fecha \|\| propuesta\.fecha,/);
});

// Carlos, 14-10-2026 (caso Kelly / Crepes & Waffles): si el dato ya se le pidió al creador, la cola no espera al operador.
test("la cola aparca el correo activo cuando el dato que falta ya se pidió al creador y sigue con el siguiente", async () => {
  const fuente = await readFile(join(process.cwd(), "core/jobs/revisarCorreoNuevo.ts"), "utf8");
  const fn = fuente.slice(fuente.indexOf("export async function aparcarActivoSiEsperaAlCreador"), fuente.indexOf("export async function avanzarColaCorreoSiActivo("));
  assert.match(fn, /pendientesYaSolicitados\(\)/);
  assert.match(fn, /pendientes\.every\(\(p\) => solicitados\.has\(p\.id\)\)/, "solo si TODAS las preguntas del correo ya se pidieron");
  assert.match(fn, /avanzarColaCorreoSiActivo\(chatId, \{ threadId: activo\.id, mensajeId: activo\.mensajeId \}/);
  assert.match(fuente, /if \(activo && await aparcarActivoSiEsperaAlCreador\(chatId, activo\)\)/);
});

// Caso real RODOAR (14-10-2026): el comprobante venía en un mensaje anterior del hilo; la cola solo miraba el último.
test("procesarCorreoLocalizado procesa el mensaje anterior del hilo con adjuntos pendientes, conservando la identidad de la cola", async () => {
  const fuente = await readFile(join(process.cwd(), "core/jobs/revisarCorreoNuevo.ts"), "utf8");
  const fn = fuente.slice(fuente.indexOf("async function procesarCorreoLocalizado("), fuente.indexOf("async function procesarCorreoLocalizado(") + 3000);
  const identidad = fn.indexOf("const identidadCola: IdentidadCorreoCola = {");
  const eleccion = fn.indexOf("mensajeDelHiloConAdjuntosPendientes(correo)");
  assert.ok(identidad >= 0 && eleccion > identidad, "la identidad de la cola se fija ANTES de cambiar de mensaje");
  assert.match(fn, /if \(anterior\) \{[\s\S]*correo = anterior;/);
});
