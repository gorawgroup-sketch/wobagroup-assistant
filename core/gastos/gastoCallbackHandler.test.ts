import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ejecutarAccionLateralGastoConReserva,
  extraerContextoLibreDeCorreccion,
  finalizarGastoCorreoAntesDeRender,
  gastoPermiteCerrarCorreo,
  prepararPropuestaFinalGasto,
  reponerResolucionContactoTrasFallo,
  validarTotalFiscalGasto,
  CuentaContableNoInferidaError,
  DescuadreFiscalGastoError,
  botonesResolucionContacto,
  textoResolucionContacto,
  nombreProveedorParaBusqueda,
  ajustarPropuestaAlMovimientoRecomendado,
  type EstadoIntentoConciliacion,
} from "./gastoCallbackHandler";
import { combinarTagsGastoAprendidos } from "../holded/write";
import type { ResolucionContactoPendiente } from "./contactoResolucionStore";
import type { PropuestaGasto } from "./gastoProposalSheet";

test("un correo de gasto solo puede cerrarse con soporte y conciliación verificados", () => {
  const noTerminales: EstadoIntentoConciliacion[] = [
    "esperando_eleccion",
    "sin_candidato",
    "fallida",
    "incierta",
  ];

  assert.equal(gastoPermiteCerrarCorreo(true, { estado: "conciliada" }), true);
  assert.equal(gastoPermiteCerrarCorreo(false, { estado: "conciliada" }), false);
  for (const estado of noTerminales) {
    assert.equal(gastoPermiteCerrarCorreo(true, { estado }), false, estado);
    assert.equal(gastoPermiteCerrarCorreo(false, { estado }), false, estado);
  }
});

test("un fallo no terminal restaura la misma resolución aunque Telegram también falle", async (t) => {
  t.mock.method(console, "error", () => {});
  const resolucion: ResolucionContactoPendiente = {
    id: "resolucion-estable",
    propuesta: { id: "propuesta", proveedor: "Proveedor" } as PropuestaGasto,
    empresaFinal: "Footprint",
    conceptoFinal: "alimentación",
    alternativas: [],
    chatId: 77,
    messageId: 800,
    creadoEn: Date.now(),
  };
  const restauradas: string[] = [];

  await reponerResolucionContactoTrasFallo(
    resolucion,
    "fallo temporal",
    async (valor) => {
      restauradas.push(valor.id);
      return valor;
    },
    async () => {
      throw new Error("Telegram caído");
    }
  );

  assert.deepEqual(restauradas, ["resolucion-estable"]);
});

test("la resolución permite el genérico autorizado sin inventar un contacto nuevo", () => {
  const base = {
    id: "resolucion-segura",
    propuesta: { id: "propuesta", proveedor: "Parking Moraleja" } as PropuestaGasto,
    empresaFinal: "Footprint" as const,
    conceptoFinal: "Parking",
    alternativas: [{ contactId: "contacto-1", contactName: "Parking Moraleja", motivo: "nombre_parecido" as const }],
    chatId: 77,
    messageId: 800,
    creadoEn: Date.now(),
  };

  const botones = botonesResolucionContacto(base).flat();
  assert.deepEqual(
    botones.map((boton) => boton.text),
    [
      '✅ Parking Moraleja',
      '🆕 Crear contacto nuevo: "Parking Moraleja"',
      "🆗 Crear sin contacto",
      "✏️ Dar instrucciones específicas",
    ]
  );
  assert.equal(botones.some((boton) => boton.callback_data.startsWith("gasto_crearsinproveedor:")), true);

  const proveedorVacio = botonesResolucionContacto({
    ...base,
    propuesta: { ...base.propuesta, proveedor: "   " },
  }).flat();
  assert.deepEqual(
    proveedorVacio.map((boton) => boton.text),
    ["✅ Parking Moraleja", "🆗 Crear sin contacto", "✏️ Dar instrucciones específicas"]
  );

  const proveedorGenerico = botonesResolucionContacto({
    ...base,
    propuesta: { ...base.propuesta, proveedor: "Aerolínea no identificada" },
  }).flat();
  assert.equal(proveedorGenerico.some((boton) => boton.callback_data.startsWith("gasto_crearsinproveedor:")), true);
  assert.equal(proveedorGenerico.some((boton) => boton.callback_data.startsWith("gasto_crearcontactonuevo:")), false);
});

test("la búsqueda elimina descriptores de pago sin mutilar nombres legales", () => {
  assert.equal(nombreProveedorParaBusqueda("ePayco (pasarela de pago)"), "ePayco");
  assert.equal(nombreProveedorParaBusqueda("Stripe [payment processor]"), "Stripe");
  assert.equal(nombreProveedorParaBusqueda("ACME (Colombia) S.A.S."), "ACME (Colombia) S.A.S.");
});

test("crear sin contacto conserva el proveedor real para inferir cuenta y tags", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");
  assert.match(fuente, /const proveedorParaInferencia = aprenderAlias \? contacto\.name : resolucion\.propuesta\.proveedor/);
  assert.match(fuente, /proveedor: proveedorParaInferencia/);
});

test("una resolución republicada usa el mensaje vigente para reponer cualquier resultado", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");
  assert.match(
    fuente,
    /const propuestaCorregidaBase: PropuestaGasto = \{[\s\S]*?\.\.\.resolucion\.propuesta,[\s\S]*?messageId: resolucion\.messageId,/
  );
});

test("un movimiento aproximado confirmado ajusta monto y líneas antes de crear", () => {
  const propuesta = {
    id: "p-ajuste-banco",
    empresa: "Footprint",
    proveedor: "ESSO Minderhout",
    monto: 87.9,
    moneda: "EUR",
    fecha: "2026-08-30",
    concepto: "Gasolina",
    rutaLocal: "/tmp/esso.pdf",
    nombreArchivoOriginal: "esso.pdf",
    candidatos: [],
    lineas: [{ concepto: "Combustible", base: 72.64, tipoIvaPct: 21, tratamientoFiscal: "iva" as const }],
    chatId: 1,
    messageId: 2,
    creadoEn: 3,
  } satisfies PropuestaGasto;

  const ajustada = ajustarPropuestaAlMovimientoRecomendado(propuesta, {
    accountId: "cuenta",
    movementId: "movimiento",
    descripcion: "Esso Minderhout",
    monto: -88.69,
    moneda: "EUR",
    fecha: "2026-08-30",
    origenCoincidencia: "aproximada",
  });

  assert.equal(ajustada.monto, 88.69);
  assert.equal(ajustada.lineas[0].base, 72.64 * 88.69 / 87.9);
  assert.equal(ajustada.lineas[0].tipoIvaPct, 21);

  const otraMoneda = ajustarPropuestaAlMovimientoRecomendado(propuesta, {
    accountId: "cuenta",
    movementId: "movimiento-usd",
    descripcion: "Esso Minderhout",
    monto: -88.69,
    moneda: "USD",
    fecha: "2026-08-30",
    origenCoincidencia: "aproximada",
  });
  assert.equal(otraMoneda, propuesta);
});

test("un fallo de Telegram ocurre después del cierre durable y no reabre la operación financiera", async (t) => {
  t.mock.method(console, "error", () => {});
  const eventos: string[] = [];

  const cerrado = await finalizarGastoCorreoAntesDeRender(
    async () => { eventos.push("memoria"); },
    async () => { eventos.push("gmail"); return true; },
    async () => { eventos.push("recuperar"); },
    async () => {
      eventos.push("telegram");
      throw new Error("Telegram temporalmente caído");
    }
  );

  assert.equal(cerrado, true);
  assert.deepEqual(eventos, ["memoria", "gmail", "telegram"]);
});

test("si Telegram falla al publicar una acción lateral se compensa exactamente su unidad", async (t) => {
  t.mock.method(console, "error", () => {});
  const eventos: string[] = [];

  await assert.rejects(
    ejecutarAccionLateralGastoConReserva(
      "propuesta-telegram:responder",
      true,
      { threadId: "thread-1", mensajeId: "mensaje-1" },
      {
        yaPublicada: async () => false,
        reservar: async () => { eventos.push("reservar"); return true; },
        publicar: async () => {
          eventos.push("telegram");
          throw new Error("Telegram temporalmente caído");
        },
        compensar: async () => { eventos.push("compensar"); return true; },
      }
    ),
    /Telegram temporalmente caído/
  );

  assert.deepEqual(eventos, ["reservar", "telegram", "compensar"]);
});

test("dos toques de la misma acción lateral publican y reservan una sola vez", async () => {
  let publicada = false;
  let reservas = 0;
  let publicaciones = 0;
  let compensaciones = 0;
  const dependencias = {
    yaPublicada: async () => publicada,
    reservar: async () => { reservas += 1; return true; },
    publicar: async () => {
      publicaciones += 1;
      await Promise.resolve();
      publicada = true;
      return true;
    },
    compensar: async () => { compensaciones += 1; return true; },
  };

  const resultados = await Promise.all([
    ejecutarAccionLateralGastoConReserva(
      "propuesta-doble:guardar",
      true,
      { threadId: "thread-2", mensajeId: "mensaje-2" },
      dependencias
    ),
    ejecutarAccionLateralGastoConReserva(
      "propuesta-doble:guardar",
      true,
      { threadId: "thread-2", mensajeId: "mensaje-2" },
      dependencias
    ),
  ]);

  assert.deepEqual(resultados, [true, true]);
  assert.equal(reservas, 1);
  assert.equal(publicaciones, 1);
  assert.equal(compensaciones, 0);
});

test("una acción lateral ajena a la cola no incrementa ni hereda identidad Gmail", async () => {
  let reservas = 0;
  let identidadPublicada: unknown = "sin-ejecutar";

  const resultado = await ejecutarAccionLateralGastoConReserva(
    "propuesta-manual:responder",
    false,
    { threadId: "thread-manual", mensajeId: "mensaje-manual" },
    {
      yaPublicada: async () => false,
      reservar: async () => { reservas += 1; return true; },
      publicar: async (identidad) => { identidadPublicada = identidad; return true; },
      compensar: async () => true,
    }
  );

  assert.equal(resultado, true);
  assert.equal(reservas, 0);
  assert.equal(identidadPublicada, undefined);
});

test("si falla la memoria terminal repone una acción de cierre y no avanza Gmail", async (t) => {
  t.mock.method(console, "error", () => {});
  const eventos: string[] = [];

  const cerrado = await finalizarGastoCorreoAntesDeRender(
    async () => {
      eventos.push("memoria");
      throw new Error("Sheets no disponible");
    },
    async () => { eventos.push("gmail"); return true; },
    async () => { eventos.push("recuperar"); },
    async () => { eventos.push("telegram-final"); }
  );

  assert.equal(cerrado, false);
  assert.deepEqual(eventos, ["memoria", "recuperar"]);
});

test("si falla el avance exacto repone solo el cierre sin volver a ejecutar el gasto", async (t) => {
  t.mock.method(console, "error", () => {});
  const eventos: string[] = [];

  const cerrado = await finalizarGastoCorreoAntesDeRender(
    async () => { eventos.push("memoria"); },
    async () => {
      eventos.push("gmail");
      throw new Error("cola temporalmente caída");
    },
    async () => { eventos.push("recuperar-cierre"); },
    async () => { eventos.push("telegram-final"); }
  );

  assert.equal(cerrado, false);
  assert.deepEqual(eventos, ["memoria", "gmail", "recuperar-cierre"]);
});

test("un avance no confirmado también conserva un botón durable aunque tenga reintento técnico", async (t) => {
  t.mock.method(console, "error", () => {});
  const eventos: string[] = [];

  const cerrado = await finalizarGastoCorreoAntesDeRender(
    async () => { eventos.push("memoria"); },
    async () => { eventos.push("gmail-no-confirmado"); return false; },
    async () => { eventos.push("recuperar-cierre"); },
    async () => { eventos.push("telegram-final"); }
  );

  assert.equal(cerrado, false);
  assert.deepEqual(eventos, ["memoria", "gmail-no-confirmado", "recuperar-cierre"]);
});

test("los callbacks consumen de forma atómica y usan claves estables antes del render terminal", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");

  const inicioCrear = fuente.indexOf('if (accion === "gasto_adjuntar" || accion === "gasto_nuevo"');
  const finCrear = fuente.indexOf('if (accion === "gasto_conciliar_si"', inicioCrear);
  const bloqueCrear = fuente.slice(inicioCrear, finCrear);
  assert.ok(bloqueCrear.indexOf("consumirPropuestaGasto(propuestaId)") < bloqueCrear.indexOf("crearGastoYReportar("));
  assert.match(bloqueCrear, /`gasto:\$\{propuestaEnProceso\.id\}:cierre`/);
  assert.ok(bloqueCrear.indexOf("registrarCierreGastoDePropuesta") < bloqueCrear.lastIndexOf("editTelegramMessage("));

  const inicioNormal = fuente.indexOf('if (accion === "gasto_conciliar_si" || accion === "gasto_conciliar_no")');
  const finNormal = fuente.indexOf('if (accion === "gasto_conciliar_elegir"', inicioNormal);
  const bloqueNormal = fuente.slice(inicioNormal, finNormal);
  assert.ok(bloqueNormal.indexOf("consumirConciliacionPendiente(propuestaId)") < bloqueNormal.indexOf("intentarConciliar("));
  assert.match(bloqueNormal, /`gasto:conciliacion:\$\{pendiente\.id\}:cierre`/);

  const inicioAmbigua = fuente.indexOf('if (accion === "gasto_conciliar_elegir" || accion === "gasto_conciliar_elegir_no")');
  const finAmbigua = fuente.indexOf('if (accion === "gasto_usarcontacto")', inicioAmbigua);
  const bloqueAmbigua = fuente.slice(inicioAmbigua, finAmbigua);
  assert.ok(bloqueAmbigua.indexOf("consumirConciliacionAmbiguaPendiente(propuestaId)") < bloqueAmbigua.indexOf("conciliarContraMovimientoEspecifico("));
  assert.match(bloqueAmbigua, /`gasto:conciliacion-ambigua:\$\{pendiente\.id\}:cierre`/);
});

// Caso real reportado por Carlos con captura de pantalla (2026-09-27): tras pulsar "Sí, conciliar" o
// "🔗 Conciliar con #N", la pregunta original quedaba con sus botones vivos para siempre, aunque la
// decisión ya se había resuelto en un mensaje aparte (éxito, cierre, o la lista de candidatos
// ambiguos) — un segundo toque solo lograba el aviso genérico "Esta acción ya fue procesada." sin que
// la pregunta desapareciera nunca. Estructural (no behavioral) por el mismo motivo que el test
// anterior: handleGastoCallback no admite inyección de dependencias.
test("cada desenlace terminal de conciliar retira la pregunta original en vez de dejarla viva", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");

  const inicioNormal = fuente.indexOf('if (accion === "gasto_conciliar_si" || accion === "gasto_conciliar_no")');
  const finNormal = fuente.indexOf('if (accion === "gasto_conciliar_elegir"', inicioNormal);
  const bloqueNormal = fuente.slice(inicioNormal, finNormal);

  // "No, dejar así": tanto el cierre de correo como el camino sin cola retiran la pregunta — y
  // usan retirarPreguntaTrasEnviar (manda primero, retira después) para no perder el rastro de la
  // decisión si el envío falla.
  assert.match(bloqueNormal, /reponerSoloCierreConciliacion\([\s\S]*?\),\s*\/\/[^\n]*\n\s*\(\) => retirarPreguntaTrasEnviar\(callback, \(\) => sendTelegramMessage\(pendiente\.chatId, `Ok/);
  assert.match(bloqueNormal, /await retirarPreguntaTrasEnviar\(callback, \(\) => sendTelegramMessage\(pendiente\.chatId, `Ok — "\$\{pendiente\.descripcionGasto\}" queda sin conciliar\.`\)\)\.catch/);

  // La ambigüedad (esperando_eleccion) retira la pregunta original: la decisión pasó al mensaje nuevo.
  const idxEsperando = bloqueNormal.indexOf('resultadoConciliacion.estado === "esperando_eleccion"');
  const idxRetiroEsperando = bloqueNormal.indexOf("await retirarPreguntaCaducada(callback);", idxEsperando);
  assert.ok(idxEsperando > 0 && idxRetiroEsperando > idxEsperando && idxRetiroEsperando < idxEsperando + 400);

  // El cierre de correo con éxito y el éxito fuera de la cola retiran la pregunta.
  assert.match(bloqueNormal, /reponerSoloCierreConciliacion\([\s\S]*?no vuelve a conciliar\."\s*\),\s*\(\) => retirarPreguntaTrasEnviar\(callback, \(\) => sendTelegramMessage\(pendiente\.chatId, `"\$\{pendiente\.descripcionGasto\}"/);
  const idxFinal = bloqueNormal.lastIndexOf("await retirarPreguntaTrasEnviar(callback,");
  const bloqueFinal = bloqueNormal.slice(idxFinal, idxFinal + 400);
  assert.match(bloqueFinal, /sendTelegramMessage\(/);

  // La reposición (sigue sin confirmarse, botones reales de nuevo) devuelve sin mandar un segundo
  // mensaje aparte — nunca debe competir con el mensaje ya editado.
  const idxReponer = bloqueNormal.indexOf("`⚠️ La conciliación todavía no quedó confirmada. El correo seguirá sin leer. ` +");
  const trasReponer = bloqueNormal.slice(idxReponer, idxReponer + 300);
  assert.match(trasReponer, /\);\s*return;/);

  const inicioAmbigua = fuente.indexOf('if (accion === "gasto_conciliar_elegir" || accion === "gasto_conciliar_elegir_no")');
  const finAmbigua = fuente.indexOf('if (accion === "gasto_usarcontacto")', inicioAmbigua);
  const bloqueAmbigua = fuente.slice(inicioAmbigua, finAmbigua);

  assert.match(bloqueAmbigua, /await retirarPreguntaTrasEnviar\(callback, \(\) => sendTelegramMessage\(pendiente\.chatId, `Ok — "\$\{pendiente\.descripcionGasto\}" queda sin conciliar\.`\)\)\.catch/);
  const idxFinalAmbigua = bloqueAmbigua.lastIndexOf("await retirarPreguntaTrasEnviar(callback,");
  const bloqueFinalAmbigua = bloqueAmbigua.slice(idxFinalAmbigua, idxFinalAmbigua + 400);
  assert.match(bloqueFinalAmbigua, /sendTelegramMessage\(/);
  const idxReponerAmbigua = bloqueAmbigua.indexOf("`⚠️ La conciliación todavía no quedó confirmada. El correo seguirá sin leer; ` +");
  const trasReponerAmbigua = bloqueAmbigua.slice(idxReponerAmbigua, idxReponerAmbigua + 300);
  assert.match(trasReponerAmbigua, /\);\s*return;/);
});

// Hallazgo real de auditoría (revisión de este PR, 2026-09-27): mandar el mensaje de resultado y
// retirar la pregunta en paralelo (Promise.all) podía dejar la pregunta ya borrada mientras el envío
// del resultado fallaba — el chat se quedaba sin ningún rastro de la decisión. Ya no debe quedar
// ningún Promise.all([retirarPreguntaCaducada...]) en el archivo: todos usan retirarPreguntaTrasEnviar
// (manda primero, retira después) o retirarPreguntaCaducada solo (sin mensaje que enviar).
test("ningún desenlace manda el resultado y retira la pregunta en paralelo", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");
  assert.match(fuente, /import \{ retirarPreguntaCaducada, retirarPreguntaTrasEnviar \} from "\.\.\/telegram\/preguntaCaducada";/);
  assert.doesNotMatch(fuente, /Promise\.all\(\[\s*retirarPreguntaCaducada/);
  assert.equal((fuente.match(/retirarPreguntaTrasEnviar\(callback, \(\) => sendTelegramMessage/g) ?? []).length, 8);
});

test("el soporte y los reintentos conservan la empresa y el concepto corregidos", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");

  assert.match(fuente, /adjuntarYLimpiar\(propuesta, gasto\.id, empresaFinal\)/);
  assert.match(fuente, /const cuentaIdFinal = propuestaFinal\.cuentaId!/);
  assert.match(fuente, /cuentaId: cuentaIdFinal/);
  assert.match(fuente, /tags: tagsFinales/);
  assert.match(fuente, /propuestaFinal = await prepararPropuestaFinalGasto\(propuestaCorregidaBase/);
  assert.match(fuente, /crearGastoYReportar\(\s*propuestaFinal,\s*propuestaFinal\.empresa,\s*propuestaFinal\.concepto/);
  assert.match(fuente, /propuestaCorregida = await prepararPropuestaFinalGasto\(propuestaCorregidaBase/);
  assert.match(fuente, /crearGastoYReportar\(\s*propuestaCorregida,\s*propuestaCorregida\.empresa,\s*propuestaCorregida\.concepto/);
  assert.match(fuente, /manejarFechaBloqueada\(\s*propuestaFinal,\s*propuestaFinal\.empresa,\s*propuestaFinal\.concepto/);
  assert.match(fuente, /reponerPropuestaParaReintento\(\s*propuestaCorregida,/);
});

// Ver PropuestaGasto.motivoReintento y PendientesSensibles.gastoPropuesta (core/claude/client.ts) —
// toda función que repone/crea una propuesta porque algo no terminó limpio debe fijar motivoReintento,
// para que el prompt dinámico distinga una propuesta ATASCADA de una pendiente normal recién mandada.
// reponerPropuestaParaReintento/reponerVerificacionCreacionIncierta/reponerSoloCierrePropuesta/
// reponerSoloCierreCancelacion son funciones privadas (no exportadas) que llaman a
// restaurarPropuestaGasto directo — se verifica por texto fuente, mismo patrón que el test de arriba.
// Solo reponerPropuestaParaReintento y manejarFechaBloqueada fijan motivoReintento — hallazgo real de
// la revisión adversarial de este mismo cambio: reponerVerificacionCreacionIncierta/
// reponerSoloCierrePropuesta/reponerSoloCierreCancelacion construyen un teclado de UN SOLO botón a
// mano (fuera de construirTecladoGasto), precisamente para impedir repetir una escritura incierta en
// Holded. Si se avisaran como "atascadas" (PendientesSensibles.gastoPropuesta), el modelo podría usar
// reenviar_botones_propuesta_gasto para reponerlas — esa tool reconstruye el teclado GENÉRICO completo
// (✅ Crear/❌ Cancelar incluidos), reabriendo el riesgo de doble escritura que esas pantallas existen
// para evitar. Ver el comentario de PropuestaGasto.motivoReintento (gastoProposalSheet.ts).
test("solo reponerPropuestaParaReintento y manejarFechaBloqueada fijan motivoReintento — nunca las reposiciones de teclado restringido", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");

  assert.match(
    fuente,
    /async function reponerPropuestaParaReintento[\s\S]{0,700}?motivoReintento: mensaje,/,
    "reponerPropuestaParaReintento — se llama en TODOS los catch de creación/corrección de gasto, siempre con el teclado genérico (o la variante soportePendiente/conciliacionPendiente que construirTecladoGasto ya sabe reconstruir)"
  );
  assert.match(
    fuente,
    /motivoReintento: texto,\s*\}\);/,
    "manejarFechaBloqueada crea una propuesta NUEVA (no una reposición) pero igual de atascada — debe fijarlo explícito, no heredarlo del spread — y su teclado genérico (gasto_nuevo/gasto_cancelar) es equivalente al restringido que reemplaza"
  );

  const cuerpoVerificacionIncierta = fuente.match(/async function reponerVerificacionCreacionIncierta[\s\S]{0,700}?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(cuerpoVerificacionIncierta, /motivoReintento/, "teclado de un solo botón (verificar sin repetir) — no debe avisarse como atascada");

  const cuerpoCierrePropuesta = fuente.match(/async function reponerSoloCierrePropuesta[\s\S]{0,700}?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(cuerpoCierrePropuesta, /motivoReintento/, "teclado de un solo botón (finalizar correo) — no debe avisarse como atascada");

  const cuerpoCierreCancelacion = fuente.match(/async function reponerSoloCierreCancelacion[\s\S]{0,700}?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(cuerpoCierreCancelacion, /motivoReintento/, "teclado de un solo botón (finalizar descarte) — no debe avisarse como atascada");
});

// Ver extraerContextoLibreDeCorreccion — ambos caminos de "Corregir clasificación" (el botón
// standalone que crea el gasto de inmediato, y el del teclado de selección que solo actualiza
// campos) deben pasar personaAsociada/contextoDeViaje a prepararPropuestaFinalGasto, y
// aplicarTextoCorreccion (el que deja la propuesta viva) debe persistirlos en Sheets — si no, una
// corrección de viaje en texto libre se perdería en la próxima reinferencia (mismo bug de fondo que
// PR #282, para un campo distinto). aplicarTextoCorreccion no está exportada; se verifica por texto
// fuente, mismo patrón que los demás tests de plumbing de este archivo.
test("las dos correcciones por texto libre pasan y persisten contextoDeViaje/personaAsociada", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");

  const ocurrencias = fuente.match(/const \{ contextoDeViaje, personaAsociada \} = extraerContextoLibreDeCorreccion\(textoUsuario\);/g);
  assert.equal(ocurrencias?.length, 2, "los dos caminos (continuarConCorreccionGasto y aplicarTextoCorreccion) deben extraer el contexto libre");
  assert.match(
    fuente,
    /const propuestaCorregidaBase: PropuestaGasto = \{\s*\.\.\.propuesta,\s*empresa: empresaFinal,\s*concepto: conceptoFinal \|\| propuesta\.concepto,\s*personaAsociada: personaAsociada \?\? propuesta\.personaAsociada,\s*contextoDeViaje: contextoDeViaje \?\? propuesta\.contextoDeViaje,\s*\};/,
    "continuarConCorreccionGasto mezcla la corrección en propuestaCorregidaBase ANTES del try — si prepararPropuestaFinalGasto falla, reponerPropuestaParaReintento repone esa misma base y la corrección de viaje/persona sobrevive al siguiente intento"
  );
  assert.match(
    fuente,
    /actualizarClasificacionPropuestaGasto\(\s*propuesta\.id,\s*propuestaFinal\.empresa,\s*propuestaFinal\.concepto,\s*propuestaFinal\.cuentaId,\s*propuestaFinal\.cuentaTags,\s*propuestaFinal\.personaAsociada,\s*propuestaFinal\.contextoDeViaje\s*\)/,
    "aplicarTextoCorreccion persiste en Sheets el valor YA MEZCLADO (cambios.X ?? propuesta.X vía prepararPropuestaFinalGasto), no el crudo de la extracción — así una corrección sin mención de viaje no borra lo que ya tenía la propuesta"
  );
});

test("bloquea creación y conciliación cuando el total fiscal difiere más de 0,05", () => {
  const base = {
    monto: 121,
    moneda: "EUR",
    lineas: [{ concepto: "Servicio", base: 100, tipoIvaPct: 21, tratamientoFiscal: "iva" as const }],
  };
  assert.equal(validarTotalFiscalGasto(base), 121);
  assert.doesNotThrow(() => validarTotalFiscalGasto({ ...base, monto: 121.05 }));
  assert.throws(
    () => validarTotalFiscalGasto({ ...base, monto: 121.06 }),
    (error) => error instanceof DescuadreFiscalGastoError
  );
});

test("una corrección reinfiere cuenta y categoría sin arrastrar las anteriores", async () => {
  const propuesta = {
    id: "p-reinferir",
    empresa: "WOBA",
    proveedor: "Proveedor viejo",
    monto: 10,
    moneda: "EUR",
    fecha: "2026-09-20",
    concepto: "Comida",
    rutaLocal: "/tmp/recibo.pdf",
    nombreArchivoOriginal: "recibo.pdf",
    candidatos: [],
    lineas: [],
    chatId: 1,
    messageId: 2,
    creadoEn: 3,
    cuentaId: "cuenta-vieja",
    cuentaTags: ["alimentacion", "simontalloen"],
  } satisfies PropuestaGasto;

  let criteriosRecibidos: { proveedor: string; concepto: string; personaAsociada?: string } | undefined;
  const final = await prepararPropuestaFinalGasto(
    propuesta,
    {
      empresa: "Footprint",
      concepto: "Parking aeropuerto",
      proveedor: "Parking Moreleja",
      personaAsociada: "Nuria Ortiz",
      forzarReinferencia: true,
    },
    {
      inferirCuenta: async (_empresa, criterios) => {
        criteriosRecibidos = criterios;
        return { accountId: "cuenta-nueva", tags: ["parking"], ejemplo: "precedente", aprendidoDe: "categoria" };
      },
      combinarTags: combinarTagsGastoAprendidos,
    }
  );

  assert.equal(final.cuentaId, "cuenta-nueva");
  assert.equal(final.cuentaTags?.includes("alimentacion"), false);
  assert.equal(final.cuentaTags?.includes("parking"), true);
  assert.equal(final.cuentaTags?.some((tag) => tag.toLowerCase().includes("nuria")), true);
  assert.deepEqual(criteriosRecibidos, {
    proveedor: "Parking Moreleja",
    concepto: "Parking aeropuerto",
    personaAsociada: "Nuria Ortiz",
    contextoDeViaje: undefined,
    reciboSimplificado: undefined,
    ticketDeEquipo: undefined,
  });
});

// Caso real de auditoría (Carlos, Droguería Pura / Simon Talloen, Footprint, 2026-10-01): la
// propuesta ORIGINAL calculaba contextoDeViaje=true (ticket individual de alguien de viaje) y por eso
// acertó la cuenta contable la primera vez — pero una reinferencia posterior (ej. al "Aprobar
// selección" tras una conciliación) perdía esa señal porque `cambios` nunca la trae (un botón no
// "corrige" el contexto de viaje) y antes no había ningún respaldo en la propuesta. Para un proveedor
// nuevo sin precedente propio, eso hacía fallar la reinferencia con CuentaContableNoInferidaError,
// contradiciendo la propuesta que el operador ya había visto funcionar.
test("una reinferencia recupera contextoDeViaje/reciboSimplificado/ticketDeEquipo de la propuesta original, no los pierde", async () => {
  const propuesta = {
    id: "p-viaje",
    empresa: "Footprint",
    proveedor: "Droguería Pura",
    monto: 14800,
    moneda: "COP",
    fecha: "2026-09-24",
    concepto: "Compra farmacia",
    rutaLocal: "/tmp/recibo.pdf",
    nombreArchivoOriginal: "recibo.pdf",
    candidatos: [],
    lineas: [],
    chatId: 1,
    messageId: 2,
    creadoEn: 3,
    personaAsociada: "Simon Talloen",
    contextoDeViaje: true,
    reciboSimplificado: true,
    ticketDeEquipo: true,
  } satisfies PropuestaGasto;

  let criteriosRecibidos: Record<string, unknown> | undefined;
  const final = await prepararPropuestaFinalGasto(
    propuesta,
    { empresa: "Footprint", concepto: propuesta.concepto, forzarReinferencia: true },
    {
      inferirCuenta: async (_empresa, criterios) => {
        criteriosRecibidos = criterios;
        return { accountId: "cuenta-viaje", tags: [], ejemplo: "precedente", aprendidoDe: "viaje" };
      },
      combinarTags: combinarTagsGastoAprendidos,
    }
  );

  assert.equal(final.cuentaId, "cuenta-viaje");
  assert.equal(criteriosRecibidos?.contextoDeViaje, true);
  assert.equal(criteriosRecibidos?.reciboSimplificado, true);
  assert.equal(criteriosRecibidos?.ticketDeEquipo, true);
  assert.equal(final.cuentaTags?.includes("viaje"), true, "combinarTags también debe recuperar contextoDeViaje de la propuesta original, no solo inferirCuenta");
});

test("un contextoDeViaje explícito en cambios (ej. corrección manual) gana sobre el de la propuesta original", async () => {
  const propuesta = {
    id: "p-viaje-2",
    empresa: "Footprint",
    proveedor: "Proveedor",
    monto: 10,
    moneda: "EUR",
    fecha: "2026-09-20",
    concepto: "Gasto",
    rutaLocal: "/tmp/recibo.pdf",
    nombreArchivoOriginal: "recibo.pdf",
    candidatos: [],
    lineas: [],
    chatId: 1,
    messageId: 2,
    creadoEn: 3,
    contextoDeViaje: true,
  } satisfies PropuestaGasto;

  let criteriosRecibidos: Record<string, unknown> | undefined;
  await prepararPropuestaFinalGasto(
    propuesta,
    { empresa: "Footprint", concepto: propuesta.concepto, contextoDeViaje: false, forzarReinferencia: true },
    {
      inferirCuenta: async (_empresa, criterios) => {
        criteriosRecibidos = criterios;
        return { accountId: "cuenta-x", tags: [], ejemplo: "precedente", aprendidoDe: "categoria" };
      },
      combinarTags: combinarTagsGastoAprendidos,
    }
  );

  assert.equal(criteriosRecibidos?.contextoDeViaje, false);
});

// Hallazgo real al implementar la corrección de texto libre de viaje (ver
// extraerContextoLibreDeCorreccion): un cambios.contextoDeViaje/reciboSimplificado explícito SÍ se
// usaba para inferir la cuenta (ver el test de arriba) pero nunca quedaba reflejado en el objeto que
// prepararPropuestaFinalGasto devuelve — una reinferencia POSTERIOR volvía a leer el valor viejo de
// la propuesta, perdiendo la corrección otra vez. personaAsociada sí lo hacía bien; esto lo iguala.
test("prepararPropuestaFinalGasto persiste el contextoDeViaje/reciboSimplificado corregido en la propuesta devuelta, no solo en la inferencia", async () => {
  const propuesta = {
    id: "p-viaje-3",
    empresa: "Footprint",
    proveedor: "Proveedor",
    monto: 10,
    moneda: "EUR",
    fecha: "2026-09-20",
    concepto: "Gasto",
    rutaLocal: "/tmp/recibo.pdf",
    nombreArchivoOriginal: "recibo.pdf",
    candidatos: [],
    lineas: [],
    chatId: 1,
    messageId: 2,
    creadoEn: 3,
    contextoDeViaje: false,
    reciboSimplificado: false,
  } satisfies PropuestaGasto;

  const final = await prepararPropuestaFinalGasto(
    propuesta,
    { empresa: "Footprint", concepto: propuesta.concepto, contextoDeViaje: true, reciboSimplificado: true, forzarReinferencia: true },
    {
      inferirCuenta: async () => ({ accountId: "cuenta-viaje", tags: [], ejemplo: "precedente", aprendidoDe: "viaje" }),
      combinarTags: combinarTagsGastoAprendidos,
    }
  );

  assert.equal(final.contextoDeViaje, true);
  assert.equal(final.reciboSimplificado, true);
});

// Hallazgo real de la revisión adversarial de este mismo cambio: personaAsociada ya contaba como
// cambio semántico (dispara reinferencia aunque ya exista cuentaId), pero contextoDeViaje/
// reciboSimplificado no — una corrección que SOLO trajera esos campos (sin forzarReinferencia ni
// cambiar empresa/concepto/proveedor) se habría saltado inferirCuenta, dejando la cuenta/tags viejos
// desacoplados del contexto de viaje recién corregido.
test("un contextoDeViaje/reciboSimplificado corregido dispara reinferencia aunque ya exista cuentaId, sin forzarReinferencia", async () => {
  const propuesta = {
    id: "p-viaje-4",
    empresa: "Footprint",
    proveedor: "Proveedor",
    monto: 10,
    moneda: "EUR",
    fecha: "2026-09-20",
    concepto: "Gasto",
    rutaLocal: "/tmp/recibo.pdf",
    nombreArchivoOriginal: "recibo.pdf",
    candidatos: [],
    lineas: [],
    chatId: 1,
    messageId: 2,
    creadoEn: 3,
    cuentaId: "cuenta-vieja-sin-viaje",
    cuentaTags: ["categoria-vieja"],
  } satisfies PropuestaGasto;

  let inferirCuentaLlamado = false;
  const final = await prepararPropuestaFinalGasto(
    propuesta,
    { empresa: "Footprint", concepto: propuesta.concepto, contextoDeViaje: true },
    {
      inferirCuenta: async () => {
        inferirCuentaLlamado = true;
        return { accountId: "cuenta-viaje-nueva", tags: ["viaje"], ejemplo: "precedente", aprendidoDe: "viaje" };
      },
      combinarTags: combinarTagsGastoAprendidos,
    }
  );

  assert.equal(inferirCuentaLlamado, true, "contextoDeViaje por sí solo debe disparar inferirCuenta, aunque ya haya un cuentaId y no se pida forzarReinferencia");
  assert.equal(final.cuentaId, "cuenta-viaje-nueva");
});

// Caso real de auditoría (Carlos, Droguería Pura / Simon Talloen, Footprint, 2026-10-01): "es un
// gasto de viaje de Simon Talloen" debe fijar contextoDeViaje y personaAsociada desde texto libre.
// Deliberadamente conservadora (ver su comentario en gastoCallbackHandler.ts): personaAsociada SOLO
// se extrae tras "viaje de", nunca cualquier "de <Nombre propio>" suelto, para no capturar mal un
// proveedor o un lugar en una corrección normal.
test("extraerContextoLibreDeCorreccion reconoce viaje/persona de forma conservadora", () => {
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("es un gasto de viaje de Simon Talloen"),
    { contextoDeViaje: true, personaAsociada: "Simon Talloen" }
  );
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("de viaje de Nuria Ortiz, parking aeropuerto"),
    { contextoDeViaje: true, personaAsociada: "Nuria Ortiz" }
  );
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("parking del viaje a Barcelona"),
    { contextoDeViaje: true, personaAsociada: undefined },
    "menciona 'viaje' pero no 'viaje de <Nombre>' — contextoDeViaje se activa, pero no se inventa una persona"
  );
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("Footprint, factura de Mediterránea"),
    { contextoDeViaje: undefined, personaAsociada: undefined },
    "un 'de <Nombre propio>' suelto sin la palabra 'viaje' nunca se confunde con una persona asociada"
  );
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("Footprint, parking aeropuerto"),
    { contextoDeViaje: undefined, personaAsociada: undefined },
    "una corrección normal sin ninguna mención de viaje no fija nada — se conserva lo que ya tenía la propuesta"
  );
});

// Hallazgo real de la revisión adversarial de este mismo cambio: la primera versión solo miraba si
// "viaje" aparecía en cualquier parte del texto, sin mirar si estaba siendo negado — una corrección
// que quería decir "esto NO es de viaje" terminaba fijando contextoDeViaje=true, justo lo contrario.
test("extraerContextoLibreDeCorreccion nunca fija contextoDeViaje=true ante una negación", () => {
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("no es un gasto de viaje"),
    { contextoDeViaje: undefined, personaAsociada: undefined }
  );
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("ya no es un viaje, es normal"),
    { contextoDeViaje: undefined, personaAsociada: undefined }
  );
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("nunca fue un gasto de viaje de Simon Talloen"),
    { contextoDeViaje: undefined, personaAsociada: undefined },
    "la negación también suprime personaAsociada — no tiene sentido extraer la persona de una cláusula que niega el viaje"
  );
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("es un gasto de viaje de Simon Talloen, no es reembolsable"),
    { contextoDeViaje: true, personaAsociada: "Simon Talloen" },
    "una negación LEJOS de 'viaje' (sobre otra cosa) no debe suprimir una mención real de viaje"
  );
});

// Hallazgo real de la revisión adversarial: exigir SIEMPRE mayúscula inicial perdía en silencio una
// corrección tecleada rápido y sin mayúsculas — contextoDeViaje se fijaba bien, pero personaAsociada
// se perdía sin ningún aviso.
test("extraerContextoLibreDeCorreccion reconoce una persona tecleada en minúsculas si el resto del texto tampoco usa mayúsculas", () => {
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("es un gasto de viaje de simon talloen"),
    { contextoDeViaje: true, personaAsociada: "simon talloen" }
  );
  assert.deepEqual(
    extraerContextoLibreDeCorreccion("viaje de Simon Talloen, pero el resto en minúsculas"),
    { contextoDeViaje: true, personaAsociada: "Simon Talloen" },
    "si el texto SÍ usa mayúsculas en algún lado tras 'viaje de', se mantiene la exigencia estricta (evita capturar una palabra genérica como 'trabajo')"
  );
});

test("sin cuenta aprendida la reinferencia falla cerrado y nunca usa default", async () => {
  const propuesta = {
    id: "p-sin-cuenta",
    empresa: "WOBA",
    proveedor: "Proveedor",
    monto: 10,
    moneda: "EUR",
    fecha: "2026-09-20",
    concepto: "Servicio",
    rutaLocal: "/tmp/recibo.pdf",
    nombreArchivoOriginal: "recibo.pdf",
    candidatos: [],
    lineas: [],
    chatId: 1,
    messageId: 2,
    creadoEn: 3,
  } satisfies PropuestaGasto;

  await assert.rejects(
    prepararPropuestaFinalGasto(
      propuesta,
      { empresa: "EWORKS", concepto: "Servicio corregido", forzarReinferencia: true },
      { inferirCuenta: async () => undefined, combinarTags: combinarTagsGastoAprendidos }
    ),
    (error) => error instanceof CuentaContableNoInferidaError
  );
});

test("persiste el siguiente estado antes de retirar botones y transfiere borradores a la identidad exacta", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");
  const corregir = fuente.slice(fuente.indexOf('if (accion === "gasto_corregir")'), fuente.indexOf('if (accion === "gasto_ajustarmonto")'));
  assert.ok(corregir.indexOf("guardarPendienteCorreccionGasto") < corregir.indexOf("editTelegramMessage("));

  const ajustar = fuente.slice(fuente.indexOf('if (accion === "gasto_ajustarmonto")'), fuente.indexOf('if (accion === "gasto_responder")'));
  assert.ok(ajustar.indexOf("guardarPendienteAjusteMontoGasto") < ajustar.indexOf("editTelegramMessageReplyMarkup"));

  const otras = fuente.slice(fuente.indexOf('if (accion === "gasto_otrasacciones")'), fuente.indexOf('if (accion === "gasto_toggle")'));
  assert.ok(otras.indexOf("guardarPendienteAccionGasto") < otras.indexOf("editTelegramMessageReplyMarkup"));

  assert.match(fuente, /vincularBorradorACola\(borradorNuevo\.id, identidadExacta!, unidadColaId\)/);
  assert.match(fuente, /borrador\.correoThreadId === identidad\.threadId[\s\S]*?borrador\.correoMensajeId === identidad\.mensajeId/);
});

test("Aprobar selección nunca deja un «Aplicando…» abierto ni el resultado fuera de vista", async () => {
  const fuente = await readFile(join(process.cwd(), "core/gastos/gastoCallbackHandler.ts"), "utf8");

  // Caso real 2026-09-22 (AEAT 255.2 EUR): el resultado solo editaba la propuesta original, arriba.
  const inicioVisible = fuente.indexOf("async function dispararDecisionFinalVisible(");
  const visible = fuente.slice(inicioVisible, fuente.indexOf("\n}\n", inicioVisible));
  const reapunte = visible.indexOf("actualizarMessageIdGasto(propuesta.id, idProgreso)");
  const disparo = visible.indexOf("await dispararDecisionFinal(propuesta, decisionKey)");
  assert.ok(reapunte > 0 && disparo > reapunte, "la propuesta debe re-apuntarse al progreso ANTES de decidir");
  assert.match(visible.slice(disparo), /catch \(error\) \{[\s\S]*editTelegramMessage\([\s\S]*no terminó limpiamente[\s\S]*throw error;/);
  assert.match(visible, /if \(progresoId !== undefined && !reapuntada\)/);
  // Propuesta ya resuelta por otro camino: se cierra el progreso en vez de disparar a ciegas.
  assert.match(visible, /if \(resultado === false\) \{[\s\S]*no se aplicó[\s\S]*return;/);
  // Botones obsoletos del mensaje anterior se retiran al re-apuntar.
  assert.match(visible, /editTelegramMessageReplyMarkup\(propuesta\.chatId, propuesta\.messageId, \[\]\)/);

  // Toda decisión final pasa por la versión visible; la única llamada directa vive dentro de ella.
  const directas = fuente.match(/await dispararDecisionFinal\(/g) ?? [];
  assert.equal(directas.length, 1);

  const inicioAprobar = fuente.indexOf("async function handleGastoAprobarCallback(");
  const aprobar = fuente.slice(inicioAprobar, fuente.indexOf("\n}\n", inicioAprobar));
  assert.match(aprobar, /const mensajeProgresoId = await sendTelegramMessageWithButtons\(propuesta\.chatId, "🔄 Aplicando tu selección\.\.\.", \[\]\)/);
  assert.match(aprobar, /dispararDecisionFinalVisible\(propuesta, decisionFinal, mensajeProgresoId\)/);
  assert.match(aprobar, /cerrarProgreso\("✅ Selección recibida/);
  assert.match(aprobar, /cerrarProgreso\("✅ Selección aplicada\."\)/);
  // Sin decisión final, el teclado vuelve AL FINAL del chat (aprendizaje del caso 2026-09-07), con un
  // único mecanismo compartido.
  assert.match(aprobar, /await reenviarTecladoGastoAlFinal\(/);
  const inicioReenvio = fuente.indexOf("async function reenviarTecladoGastoAlFinal(");
  const reenvio = fuente.slice(inicioReenvio, fuente.indexOf("\n}\n", inicioReenvio));
  assert.match(reenvio, /sendTelegramMessageWithButtons\([\s\S]*actualizarMessageIdGasto\(propuesta\.id, messageId\)/);
  assert.match(reenvio, /editTelegramMessageReplyMarkup\([\s\S]*No pude publicar los botones aquí abajo/);

  const inicioSeleccion = fuente.indexOf("export async function continuarConSeleccionGasto(");
  const seleccion = fuente.slice(inicioSeleccion, fuente.indexOf("\n}\n", inicioSeleccion));
  assert.match(seleccion, /await dispararDecisionFinalVisible\(propuestaFresca, pendiente\.decisionFinal\)/);
  // Ninguna salida deja la propuesta viva sin botones (hallazgos de auditoría 2026-09-22):
  assert.match(seleccion, /const reponerBotones = [\s\S]*reenviarTecladoGastoAlFinal\([\s\S]*No apliqué/);
  // 1) fallo posterior a efectos al aplicar el texto (TurnoConEfectosError, monto a medio escribir);
  assert.match(seleccion, /if \(esErrorTrasEjecucion\(error\)\) await reponerBotones\(sinAplicar\(\[actual, \.\.\.resto\]\)\);\s*throw error;/);
  // 2) acción de texto no completada;
  assert.match(seleccion, /if \(!resultado\.ok\) \{[\s\S]*?await reponerBotones\(sinAplicar\(resto\)\);\s*return;/);
  // 3) cualquier fallo tras aplicar el texto, salvo en la decisión final (que cierra su propio progreso).
  assert.match(seleccion, /enDecisionFinal = true;\s*await dispararDecisionFinalVisible/);
  assert.match(seleccion, /if \(!enDecisionFinal\) await reponerBotones\(sinAplicar\(resto\)\);\s*throw new ErrorTrasEjecucion/);
});

 test("aprobar conserva la persona del correo aunque no figure en el catálogo histórico", async () => {
  const propuesta = {
    id: "persona-persistida", empresa: "Footprint", proveedor: "Uber", monto: 8,
    moneda: "EUR", fecha: "2026-09-20", concepto: "Traslado taxi", rutaLocal: "/tmp/test.pdf",
    nombreArchivoOriginal: "test.pdf", candidatos: [], lineas: [], chatId: 1, messageId: 2,
    creadoEn: 3, cuentaId: "viajes", cuentaTags: ["taxi", "transporte"], personaAsociada: "Elena Ejemplo",
  } satisfies PropuestaGasto;
  const final = await prepararPropuestaFinalGasto(propuesta, { empresa: "Footprint", concepto: propuesta.concepto }, {
    inferirCuenta: async () => { throw new Error("No requiere reinferencia"); },
    combinarTags: combinarTagsGastoAprendidos,
  });
  assert.equal(final.personaAsociada, "Elena Ejemplo");
  assert.ok(final.cuentaTags?.includes("Elena Ejemplo"));
  assert.ok(final.cuentaTags?.includes("taxi"));
});

test("una propuesta antigua sin fecha no permite aprobar ni reinferir", async () => {
 const p = { id: "sin-fecha", empresa: "Footprint", proveedor: "Taxi", monto: 12,
 moneda: "EUR", fecha: "", concepto: "Taxi", rutaLocal: "/tmp/test.pdf", nombreArchivoOriginal: "test.pdf",
 candidatos: [], lineas: [], chatId: 1, messageId: 2, creadoEn: 3, cuentaId: "viajes" } satisfies PropuestaGasto;
 await assert.rejects(prepararPropuestaFinalGasto(p,{empresa:"Footprint",concepto:p.concepto},{
 inferirCuenta: async()=>{throw new Error("No debe consultar ni mutar");}, combinarTags: combinarTagsGastoAprendidos,
 }),/Falta fecha documental verificable/);
});

test("proveedor duplicado en Holded: se elige entre las fichas y no se ofrece crear otro contacto (caso CAFE DE SANTA BARBARA)", () => {
  const resolucion = {
    id: "resolucion-duplicado",
    propuesta: { id: "propuesta", proveedor: "CAFE DE SANTA BARBARA S.A.S" } as PropuestaGasto,
    empresaFinal: "Footprint" as const,
    conceptoFinal: "Alimentación",
    alternativas: [
      { contactId: "66d5", contactName: "CAFE DE SANTA BARBARA S.A.S", motivo: "nombre_parecido" as const },
      { contactId: "6859", contactName: "CAFE DE SANTA BARBARA SAS", motivo: "nombre_parecido" as const },
    ],
    chatId: 77,
    messageId: 801,
    creadoEn: Date.now(),
  };
  assert.deepEqual(
    botonesResolucionContacto(resolucion).flat().map((boton) => boton.text),
    ["✅ CAFE DE SANTA BARBARA S.A.S", "✅ CAFE DE SANTA BARBARA SAS", "🆗 Crear sin contacto", "✏️ Dar instrucciones específicas"]
  );
  const texto = textoResolucionContacto(resolucion);
  assert.match(texto, /está 2 veces en los contactos de Holded/);
  assert.match(texto, /lo recordaré y no volveré a preguntarlo/);
});
