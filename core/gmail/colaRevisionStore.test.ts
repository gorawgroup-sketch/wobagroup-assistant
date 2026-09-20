import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  calcularPendientesIncrementados,
  calcularResolucionIdempotente,
  coincideIdentidadCorreoCola,
} from "./colaRevisionStore";

const activo = { id: "thread-a", mensajeId: "message-a" };

test("la identidad de cola exige thread y mensaje exactos; una identidad legacy parcial nunca muta", () => {
  assert.equal(coincideIdentidadCorreoCola(activo, { threadId: "thread-a" }), false);
  assert.equal(coincideIdentidadCorreoCola(activo, { mensajeId: "message-a" }), false);
  assert.equal(
    coincideIdentidadCorreoCola(activo, { threadId: "thread-a", mensajeId: "message-a" }),
    true
  );

  assert.equal(
    coincideIdentidadCorreoCola(activo, { threadId: "thread-viejo", mensajeId: "message-a" }),
    false
  );
  assert.equal(
    coincideIdentidadCorreoCola(activo, { threadId: "thread-a", mensajeId: "message-viejo" }),
    false
  );
  assert.equal(
    coincideIdentidadCorreoCola(activo, { threadId: "thread-a", mensajeId: "message-viejo" }),
    false,
    "un thread coincidente no debe ocultar un message id tardío"
  );
  assert.equal(coincideIdentidadCorreoCola(activo, {}), false);
  assert.equal(coincideIdentidadCorreoCola(activo, { threadId: "  ", mensajeId: "" }), false);
  assert.equal(
    coincideIdentidadCorreoCola({ id: "thread-a", mensajeId: "" }, { threadId: "thread-a", mensajeId: "thread-a" }),
    false,
    "una fila legacy sin message id real no puede fingir identidad completa"
  );
});

test("el incremento de pendientes solo admite enteros positivos sin desbordamiento", () => {
  assert.equal(calcularPendientesIncrementados(2, 1), 3);
  assert.equal(calcularPendientesIncrementados(0, 2), 2);
  assert.equal(calcularPendientesIncrementados(2, 0), undefined);
  assert.equal(calcularPendientesIncrementados(2, -1), undefined);
  assert.equal(calcularPendientesIncrementados(2, 1.5), undefined);
  assert.equal(calcularPendientesIncrementados(-1, 1), undefined);
  assert.equal(calcularPendientesIncrementados(Number.MAX_SAFE_INTEGER, 1), undefined);
});

test("la misma clave terminal no descuenta dos veces y claves distintas sí resuelven dos adjuntos", () => {
  const primera = calcularResolucionIdempotente(2, [], "captura:uno");
  assert.deepEqual(primera, {
    pendientesRestantes: 1,
    accionesResueltas: ["captura:uno"],
    aplicado: true,
    yaAplicado: false,
  });

  const repetida = calcularResolucionIdempotente(
    primera.pendientesRestantes,
    primera.accionesResueltas,
    "captura:uno"
  );
  assert.equal(repetida.pendientesRestantes, 1);
  assert.equal(repetida.aplicado, false);
  assert.equal(repetida.yaAplicado, true);

  const segundoAdjunto = calcularResolucionIdempotente(
    repetida.pendientesRestantes,
    repetida.accionesResueltas,
    "captura:dos"
  );
  assert.equal(segundoAdjunto.pendientesRestantes, 0);
  assert.deepEqual(segundoAdjunto.accionesResueltas, ["captura:uno", "captura:dos"]);
  assert.equal(segundoAdjunto.aplicado, true);
});

test("reactivar o reencolar reinicia el ledger junto con el contador", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gmail/colaRevisionStore.ts"), "utf8");
  const inicioActivar = fuente.indexOf("async function iniciarSiguienteActivoInterno");
  const finActivar = fuente.indexOf("export async function iniciarSiguienteActivo", inicioActivar);
  assert.match(fuente.slice(inicioActivar, finActivar), /accionesResueltas:\s*\[\]/);

  const inicioReencolar = fuente.indexOf("async function reencolarActivoParaReintentoInterno");
  const finReencolar = fuente.indexOf("export async function reencolarActivoParaReintento", inicioReencolar);
  assert.match(fuente.slice(inicioReencolar, finReencolar), /accionesResueltas:\s*\[\]/);

  const inicioEstablecer = fuente.indexOf("async function establecerPendientesActivoInterno");
  const finEstablecer = fuente.indexOf("export async function establecerPendientesActivo", inicioEstablecer);
  assert.match(fuente.slice(inicioEstablecer, finEstablecer), /accionesResueltas:\s*\[\]/);
});

test("todas las mutaciones read-modify-write de la cola comparten un mutex", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gmail/colaRevisionStore.ts"), "utf8");
  const mutaciones = [
    "encolarCorreos",
    "iniciarSiguienteActivo",
    "descartarActivoEstancado",
    "reencolarActivoParaReintento",
    "vaciarColaCorreoDelChat",
    "establecerPendientesActivo",
    "incrementarPendientesActivo",
    "revertirIncrementoPendientesActivo",
    "resolverUnoActivo",
    "prepararCierreExplicitoActivo",
    "confirmarActivoResueltoTrasMarcarLeido",
  ];
  for (const nombre of mutaciones) {
    const inicio = fuente.indexOf(`export async function ${nombre}`);
    assert.notEqual(inicio, -1, nombre);
    const fin = fuente.indexOf("\n}", inicio);
    const wrapper = fuente.slice(inicio, fin + 2);
    assert.match(wrapper, /conMutex\(MUTEX_COLA/, nombre);
  }
});

test("adjuntos más solicitud cuentan una decisión adicional y conservan identidad de cola", async () => {
  const fuente = await readFile(join(process.cwd(), "core/jobs/revisarCorreoNuevo.ts"), "utf8");
  const inicio = fuente.indexOf("if (correo.adjuntos.length > 0)");
  const fin = fuente.indexOf("let indiceAdjunto = 0", inicio);
  assert.notEqual(inicio, -1);
  assert.notEqual(fin, -1);
  const solicitudConAdjuntos = fuente.slice(inicio, fin);

  const incremento = solicitudConAdjuntos.indexOf("incrementarPendientesActivo(chatId, identidadCola)");
  const propuesta = solicitudConAdjuntos.indexOf("crearPropuestaAccionCorreo({");
  assert.ok(incremento >= 0 && propuesta > incremento, "debe reservar el pendiente antes de publicar botones");
  assert.match(solicitudConAdjuntos, /mensajeId:\s*correo\.id/);
  assert.match(solicitudConAdjuntos, /deColaCorreo,/);
  assert.doesNotMatch(solicitudConAdjuntos, /deColaCorreo:\s*false/);
  assert.match(solicitudConAdjuntos, /throw error;/, "si no puede publicar la solicitud, el correo debe permanecer pendiente");
});

test("la resolución y sus reintentos usan la identidad original hasta confirmar Gmail", async () => {
  const fuente = await readFile(join(process.cwd(), "core/jobs/revisarCorreoNuevo.ts"), "utf8");
  const inicio = fuente.indexOf("export async function avanzarColaCorreoSiActivo");
  const fin = fuente.indexOf("export async function handleColaCorreoSiguienteCallback", inicio);
  assert.notEqual(inicio, -1);
  assert.notEqual(fin, -1);
  const avance = fuente.slice(inicio, fin);

  assert.match(avance, /resolverUnoActivo\(chatId, identidadEsperada, claveIdempotencia\)/);
  assert.match(avance, /avanzarColaCorreoSiActivo\(chatId, identidadInmutable, claveIdempotencia\)/);
  assert.match(avance, /activoResuelto\.mensajeId !== resultado\.identidadResuelta\.mensajeId/);
  assert.match(avance, /marcarMensajeComoLeido\(resultado\.identidadResuelta\.mensajeId\)/);
  assert.match(avance, /confirmarActivoResueltoTrasMarcarLeido\(chatId, resultado\.identidadResuelta\)/);
});

test("el salto explícito persiste el cierre exacto antes de marcar Gmail como leído", async () => {
  const fuente = await readFile(join(process.cwd(), "core/jobs/revisarCorreoNuevo.ts"), "utf8");
  const inicio = fuente.indexOf("async function saltarCorreoActivoInterno");
  const fin = fuente.indexOf("export async function handleDescartarActivoCallback", inicio);
  const salto = fuente.slice(inicio, fin);
  const preparar = salto.indexOf("prepararCierreExplicitoActivo(");
  const marcar = salto.indexOf("marcarMensajeComoLeido(activo.mensajeId)");
  const confirmar = salto.indexOf("confirmarActivoResueltoTrasMarcarLeido(chatId, cierre.identidadResuelta)");

  assert.ok(preparar >= 0 && marcar > preparar && confirmar > marcar);
  assert.match(salto, /threadId: activo\.id, mensajeId: activo\.mensajeId/);
  assert.doesNotMatch(salto, /descartarActivoEstancado\(/);
});
