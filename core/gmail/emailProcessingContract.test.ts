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
