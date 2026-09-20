import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ejecutarAccionLateralGastoConReserva,
  finalizarGastoCorreoAntesDeRender,
  gastoPermiteCerrarCorreo,
  prepararPropuestaFinalGasto,
  reponerResolucionContactoTrasFallo,
  validarTotalFiscalGasto,
  CuentaContableNoInferidaError,
  DescuadreFiscalGastoError,
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
  });
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
