import assert from "node:assert/strict";
import test from "node:test";
import { generarControlDiario, type EntradaControlDiario } from "./controlDiario";

function entradaBase(): EntradaControlDiario {
  const resumen = {
    llamadas: 10,
    inputTokens: 1_000,
    outputTokens: 100,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ahorroNetoCacheUSD: 0,
    costoUSD: 1,
    costoEquivalenteSuscripcionUSD: 0,
    gastoRealApiUSD: 1,
  };
  return {
    costos: {
      hoy: resumen,
      ayer: resumen,
      semanaActual: resumen,
      mesActual: resumen,
      ultimos7Dias: [],
      promedio7DiasPreviosUSD: 1,
      umbralAnomaliaUSD: 2,
      esAnomaliaAyer: false,
      proyeccionMensualUSD: 10,
      porProcesoAyer: [
        { ...resumen, proceso: "chat_conversacional", gastoRealApiUSD: 0.3, costoUSD: 0.3 },
      ],
      porProcesoHoy: [],
      porProcesoSemana: [],
      ejecucionesConMuchasLlamadasAyer: 0,
    },
    memoria: { ok: true, filas: 2, filasCorruptas: 0, filasVencidas: 0 },
    politica: {
      modo: "allowlist",
      killSwitch: false,
      limiteDiarioUSD: 20,
      limiteMensualUSD: 100,
      procesosPermitidos: 4,
    },
    enviosCorreo: { preparado: 0, enviando: 0, verificado: 3, incierto: 0 },
    subidasDrive: { preparada: 0, subiendo: 0, verificada: 4, incierta: 0 },
    comprasHolded: { preparada: 0, creando: 0, verificada: 5, incierta: 0, empresasConIncertidumbre: [] },
    edicionesHolded: { preparada: 0, editando: 0, verificada: 2, incierta: 0, empresasConIncertidumbre: [] },
    adjuntosHolded: { preparado: 0, subiendo: 0, verificado: 3, incierto: 0, empresasConIncertidumbre: [] },
    conciliacionesHolded: { preparada: 0, conciliando: 0, verificada: 2, verificadaRevision: 0, incierta: 0, cancelada: 0, empresasConIncertidumbre: [], empresasConRevision: [] },
    contactosHolded: { preparada: 0, creando: 0, verificada: 2, incierta: 0, empresasConIncertidumbre: [] },
    generadoEn: new Date("2026-09-09T09:00:00Z"),
  };
}

test("el control queda estable cuando no hay incidencias", () => {
  const control = generarControlDiario(entradaBase());
  assert.equal(control.estado, "estable");
  assert.deepEqual(control.recomendaciones, []);
  assert.equal(control.costosDisponibles, true);
});

test("prioriza un gasto anómalo y una política todavía abierta", () => {
  const entrada = entradaBase();
  entrada.costos = {
    ...entrada.costos!,
    ayer: { ...entrada.costos!.ayer, gastoRealApiUSD: 11.58, costoUSD: 11.58 },
    esAnomaliaAyer: true,
    porProcesoAyer: [
      { ...entrada.costos!.ayer, proceso: "extraer_factura", gastoRealApiUSD: 5.63, costoUSD: 5.63 },
    ],
    // "Proceso principal" ya no mira ayer sino hoy (o la semana): el gasto de hoy es de 1 USD.
    porProcesoHoy: [
      { ...entrada.costos!.hoy, proceso: "extraer_factura", gastoRealApiUSD: 0.9, costoUSD: 0.9 },
    ],
  };
  entrada.politica = { ...entrada.politica, modo: "observe", limiteDiarioUSD: 0, limiteMensualUSD: 0 };

  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "atencion");
  assert.ok(control.recomendaciones.some((r) => r.id === "gasto-anomalo" && r.prioridad === "alta"));
  assert.ok(control.recomendaciones.some((r) => r.id === "politica-observe" && r.prioridad === "alta"));
  assert.ok(control.recomendaciones.some((r) => r.id === "proceso-principal"));
});

test("el umbral diario alerta sin confundirlo con el techo que bloquea", () => {
  const entrada = entradaBase();
  entrada.costos = {
    ...entrada.costos!,
    hoy: { ...entrada.costos!.hoy, gastoRealApiUSD: 12, costoUSD: 12 },
  };
  entrada.politica = {
    ...entrada.politica,
    umbralAlertaDiariaUSD: 10,
    limiteDiarioUSD: 30,
  };
  const control = generarControlDiario(entrada);
  const aviso = control.recomendaciones.find((r) => r.id === "umbral-diario-coste-ia");
  assert.ok(aviso);
  assert.match(aviso.detalle, /operación sigue disponible/i);
});

function puntosSemana(gastos: number[]) {
  return gastos.map((gasto, i) => ({ fecha: `2026-09-${String(13 + i).padStart(2, "0")}`, llamadas: 10, gastoRealApiUSD: gasto }));
}

test("caso real 2026-09-20: avisa del gasto de HOY sin esperar al día siguiente y nombra el proceso que lo genera", () => {
  const entrada = entradaBase();
  const base = entrada.costos!;
  entrada.costos = {
    ...base,
    hoy: { ...base.hoy, gastoRealApiUSD: 22.91, costoUSD: 22.91, llamadas: 410 },
    ayer: { ...base.ayer, gastoRealApiUSD: 0.06, costoUSD: 0.06 },
    ultimos7Dias: puntosSemana([0, 4.15, 7.19, 3.42, 6.73, 5.53, 0.06]),
    porProcesoHoy: [
      { ...base.hoy, proceso: "correo_gastos_automatico", llamadas: 405, gastoRealApiUSD: 22.75, costoUSD: 22.75 },
      { ...base.hoy, proceso: "chat_conversacional", llamadas: 2, gastoRealApiUSD: 0.06, costoUSD: 0.06 },
    ],
    porProcesoAyer: [{ ...base.hoy, proceso: "chat_conversacional", llamadas: 2, gastoRealApiUSD: 0.058, costoUSD: 0.058 }],
  };
  const control = generarControlDiario(entrada);
  const rec = control.recomendaciones.find((r) => r.id === "gasto-hoy-elevado");
  assert.ok(rec, "debe avisar del gasto de hoy");
  assert.equal(rec.prioridad, "alta");
  assert.match(rec.detalle, /22\.91/);
  assert.match(rec.detalle, /análisis automático de correo/);
  assert.match(rec.detalle, /99%/);
  assert.match(rec.detalle, /405 llamadas/);
  assert.match(rec.siguientePaso, /repite el análisis de los mismos datos/);
  assert.ok((rec.pasos?.length ?? 0) >= 3, "debe dar pasos exactos");
  const principal = control.recomendaciones.find((r) => r.id === "proceso-principal");
  assert.match(principal?.detalle ?? "", /gasto de hoy/, "el proceso principal se calcula sobre hoy, no sobre ayer");
  assert.match(principal?.titulo ?? "", /análisis automático de correo/);
});

test("un gasto de hoy normal no dispara aviso, y sin media de referencia tampoco se inventa una normalidad", () => {
  const normal = entradaBase();
  normal.costos = { ...normal.costos!, hoy: { ...normal.costos!.hoy, gastoRealApiUSD: 3 }, ultimos7Dias: puntosSemana([4, 5, 3, 4, 6, 3, 5]) };
  assert.ok(!generarControlDiario(normal).recomendaciones.some((r) => r.id === "gasto-hoy-elevado"));

  const sinReferencia = entradaBase();
  sinReferencia.costos = { ...sinReferencia.costos!, hoy: { ...sinReferencia.costos!.hoy, gastoRealApiUSD: 50 }, ultimos7Dias: [] };
  assert.ok(!generarControlDiario(sinReferencia).recomendaciones.some((r) => r.id === "gasto-hoy-elevado"));
});

test("sin gasto material hoy, el proceso principal se calcula sobre la semana en curso", () => {
  const entrada = entradaBase();
  const base = entrada.costos!;
  entrada.costos = {
    ...base,
    hoy: { ...base.hoy, gastoRealApiUSD: 0.1 },
    semanaActual: { ...base.semanaActual, gastoRealApiUSD: 50 },
    porProcesoHoy: [{ ...base.hoy, proceso: "chat_conversacional", gastoRealApiUSD: 0.1 }],
    porProcesoSemana: [
      { ...base.hoy, proceso: "correo_gastos_automatico", gastoRealApiUSD: 30 },
      { ...base.hoy, proceso: "chat_conversacional", gastoRealApiUSD: 20 },
    ],
  };
  const principal = generarControlDiario(entrada).recomendaciones.find((r) => r.id === "proceso-principal");
  assert.match(principal?.detalle ?? "", /60% del gasto de la semana/);
});

test("cada incidencia crítica dice exactamente qué hacer y las de resultado incierto ofrecen botones", () => {
  const entrada = entradaBase();
  entrada.edicionesHolded = { preparada: 0, editando: 0, verificada: 1, incierta: 63, empresasConIncertidumbre: ["Footprint"] };
  entrada.comprasHolded = { preparada: 0, creando: 0, verificada: 2, incierta: 1, empresasConIncertidumbre: ["WOBA"] };
  entrada.enviosCorreo = null;
  const control = generarControlDiario(entrada);

  const ediciones = control.recomendaciones.find((r) => r.id === "ediciones-holded-inciertas");
  assert.deepEqual(ediciones?.acciones?.map((a) => a.id), ["verificar", "revisar"]);
  assert.ok((ediciones?.pasos?.length ?? 0) === 3);
  assert.match(ediciones?.pasos?.[0] ?? "", /Verificar ahora/);

  const compras = control.recomendaciones.find((r) => r.id === "compras-holded-inciertas");
  assert.deepEqual(compras?.acciones?.map((a) => a.id), ["verificar"]);

  const ledger = control.recomendaciones.find((r) => r.id === "ledger-correo-no-disponible");
  assert.ok((ledger?.pasos?.length ?? 0) >= 3);
  assert.equal(ledger?.acciones, undefined, "un fallo de lectura no tiene botón: requiere acceso a la hoja");

  for (const r of control.recomendaciones.filter((x) => x.prioridad === "critica")) {
    assert.ok(r.pasos && r.pasos.length > 0, `la incidencia crítica ${r.id} debe traer pasos exactos`);
  }
});

test("muestra ahorro de caché sin convertirlo en una incidencia", () => {
  const entrada = entradaBase();
  entrada.costos = {
    ...entrada.costos!,
    ayer: {
      ...entrada.costos!.ayer,
      cacheCreationTokens: 10_000,
      cacheReadTokens: 100_000,
      ahorroNetoCacheUSD: 0.17,
    },
  };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "estable");
  assert.ok(control.recomendaciones.some((r) => r.id === "cache-efectiva" && r.prioridad === "informativa"));
});

test("avisa si se paga por crear una caché grande que nunca se reutiliza", () => {
  const entrada = entradaBase();
  entrada.costos = {
    ...entrada.costos!,
    ayer: {
      ...entrada.costos!.ayer,
      cacheCreationTokens: 75_000,
      cacheReadTokens: 0,
      ahorroNetoCacheUSD: -0.04,
    },
  };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "atencion");
  assert.ok(control.recomendaciones.some((r) => r.id === "cache-sin-reuso"));
});

test("un fallo de memoria se muestra como crítico y nunca como cero", () => {
  const entrada = entradaBase();
  entrada.costos = null;
  entrada.memoria = { ok: false, filas: 0, filasCorruptas: 0, filasVencidas: 0, error: "Error" };

  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.equal(control.costosDisponibles, false);
  assert.equal(control.costos, null);
  assert.ok(control.recomendaciones.some((r) => r.id === "costos-no-disponibles"));
  assert.ok(control.recomendaciones.some((r) => r.id === "memoria-no-integra"));
});

test("un envío de correo incierto se eleva como crítico", () => {
  const entrada = entradaBase();
  entrada.enviosCorreo = { preparado: 0, enviando: 0, verificado: 2, incierto: 1 };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "envios-correo-inciertos"));
});

test("un fallo leyendo el ledger nunca se representa como cero", () => {
  const entrada = entradaBase();
  entrada.enviosCorreo = null;
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "ledger-correo-no-disponible"));
});

test("una subida a Drive incierta se eleva como crítica", () => {
  const entrada = entradaBase();
  entrada.subidasDrive = { preparada: 0, subiendo: 0, verificada: 2, incierta: 1 };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "subidas-drive-inciertas"));
});

test("un fallo leyendo el ledger de Drive nunca se representa como cero", () => {
  const entrada = entradaBase();
  entrada.subidasDrive = null;
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "ledger-drive-no-disponible"));
});

test("una compra de Holded incierta se eleva como crítica y dice en qué empresa mirar", () => {
  const entrada = entradaBase();
  entrada.comprasHolded = { preparada: 0, creando: 0, verificada: 2, incierta: 1, empresasConIncertidumbre: ["Footprint"] };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  const recomendacion = control.recomendaciones.find((r) => r.id === "compras-holded-inciertas");
  assert.ok(recomendacion);
  assert.match(recomendacion.detalle, /Footprint/);
});

test("un fallo leyendo el ledger de Holded nunca se representa como cero", () => {
  const entrada = entradaBase();
  entrada.comprasHolded = null;
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "ledger-holded-no-disponible"));
});

test("una edición de Holded incierta se eleva como crítica", () => {
  const entrada = entradaBase();
  entrada.edicionesHolded = { preparada: 0, editando: 0, verificada: 1, incierta: 1, empresasConIncertidumbre: ["WOBA"] };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "ediciones-holded-inciertas"));
});

test("un fallo leyendo el ledger de ediciones nunca se representa como cero", () => {
  const entrada = entradaBase();
  entrada.edicionesHolded = null;
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "ledger-ediciones-holded-no-disponible"));
});

test("un adjunto de Holded incierto se eleva como crítico", () => {
  const entrada = entradaBase();
  entrada.adjuntosHolded = { preparado: 0, subiendo: 0, verificado: 1, incierto: 1, empresasConIncertidumbre: ["EWORKS"] };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "adjuntos-holded-inciertos"));
});

test("un fallo leyendo el ledger de adjuntos nunca se representa como cero", () => {
  const entrada = entradaBase();
  entrada.adjuntosHolded = null;
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "ledger-adjuntos-holded-no-disponible"));
});

test("una conciliación bancaria incierta se eleva como crítica y dice en qué empresa mirar", () => {
  const entrada = entradaBase();
  entrada.conciliacionesHolded = { preparada: 0, conciliando: 0, verificada: 1, verificadaRevision: 0, incierta: 1, cancelada: 0, empresasConIncertidumbre: ["Footprint"], empresasConRevision: [] };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  const recomendacion = control.recomendaciones.find((r) => r.id === "conciliaciones-holded-inciertas");
  assert.ok(recomendacion);
  assert.match(recomendacion.detalle, /Footprint/);
});

test("una conciliación confirmada con saldo residual queda visible como revisión sin pedir repetirla", () => {
  const entrada = entradaBase();
  entrada.conciliacionesHolded = {
    preparada: 0,
    conciliando: 0,
    verificada: 1,
    verificadaRevision: 1,
    incierta: 0,
    cancelada: 0,
    empresasConIncertidumbre: [],
    empresasConRevision: ["Footprint"],
  };
  const control = generarControlDiario(entrada);
  const recomendacion = control.recomendaciones.find((r) => r.id === "conciliaciones-holded-revision");
  assert.equal(recomendacion?.prioridad, "alta");
  assert.match(recomendacion?.detalle ?? "", /Footprint/);
  assert.match(recomendacion?.siguientePaso ?? "", /no repetir/i);
});

test("caso real Carlos: descartar una recomendación quita la tarjeta y recalcula el estado general", () => {
  const entrada = entradaBase();
  entrada.conciliacionesHolded = { preparada: 0, conciliando: 0, verificada: 1, verificadaRevision: 0, incierta: 1, cancelada: 0, empresasConIncertidumbre: ["Footprint"], empresasConRevision: [] };
  entrada.recomendacionesDescartadas = new Set(["conciliaciones-holded-inciertas"]);
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "estable");
  assert.ok(!control.recomendaciones.some((r) => r.id === "conciliaciones-holded-inciertas"));
});

test("descartar una recomendación no oculta las demás que sigan vigentes", () => {
  const entrada = entradaBase();
  entrada.conciliacionesHolded = { preparada: 0, conciliando: 0, verificada: 1, verificadaRevision: 0, incierta: 1, cancelada: 0, empresasConIncertidumbre: ["Footprint"], empresasConRevision: [] };
  entrada.contactosHolded = { preparada: 0, creando: 0, verificada: 1, incierta: 1, empresasConIncertidumbre: ["WOBA"] };
  entrada.recomendacionesDescartadas = new Set(["conciliaciones-holded-inciertas"]);
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(!control.recomendaciones.some((r) => r.id === "conciliaciones-holded-inciertas"));
  assert.ok(control.recomendaciones.some((r) => r.id === "contactos-holded-inciertos"));
});

test("un fallo leyendo el ledger de conciliaciones nunca se representa como cero", () => {
  const entrada = entradaBase();
  entrada.conciliacionesHolded = null;
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "ledger-conciliaciones-holded-no-disponible"));
});

test("un contacto de Holded incierto se eleva como crítico", () => {
  const entrada = entradaBase();
  entrada.contactosHolded = { preparada: 0, creando: 0, verificada: 1, incierta: 1, empresasConIncertidumbre: ["EWORKS"] };
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "contactos-holded-inciertos"));
});

test("un fallo leyendo el ledger de contactos nunca se representa como cero", () => {
  const entrada = entradaBase();
  entrada.contactosHolded = null;
  const control = generarControlDiario(entrada);
  assert.equal(control.estado, "critico");
  assert.ok(control.recomendaciones.some((r) => r.id === "ledger-contactos-holded-no-disponible"));
});

test("EXHAUSTIVO: toda incidencia crítica que el panel puede mostrar trae pasos exactos, y toda acción va con pasos", () => {
  const fallo = entradaBase();
  fallo.costos = null;
  fallo.memoria = { ok: false, filas: 0, filasCorruptas: 0, filasVencidas: 0, error: "Error" };
  fallo.enviosCorreo = null;
  fallo.subidasDrive = null;
  fallo.comprasHolded = null;
  fallo.edicionesHolded = null;
  fallo.adjuntosHolded = null;
  fallo.conciliacionesHolded = null;
  fallo.contactosHolded = null;

  const inciertos = entradaBase();
  inciertos.memoria = { ok: false, filas: 3, filasCorruptas: 2, filasVencidas: 0 };
  inciertos.costos = { ...inciertos.costos!, ejecucionesConMuchasLlamadasAyer: 2 };
  inciertos.enviosCorreo = { preparado: 0, enviando: 0, verificado: 0, incierto: 1 };
  inciertos.subidasDrive = { preparada: 0, subiendo: 0, verificada: 0, incierta: 1 };
  inciertos.comprasHolded = { preparada: 0, creando: 0, verificada: 0, incierta: 1, empresasConIncertidumbre: ["WOBA"] };
  inciertos.edicionesHolded = { preparada: 0, editando: 0, verificada: 0, incierta: 1, empresasConIncertidumbre: ["WOBA"] };
  inciertos.adjuntosHolded = { preparado: 0, subiendo: 0, verificado: 0, incierto: 1, empresasConIncertidumbre: ["WOBA"] };
  inciertos.conciliacionesHolded = {
    preparada: 0, conciliando: 0, verificada: 0, verificadaRevision: 1, incierta: 1, cancelada: 0,
    empresasConIncertidumbre: ["WOBA"], empresasConRevision: ["WOBA"],
  };
  inciertos.contactosHolded = { preparada: 0, creando: 0, verificada: 0, incierta: 1, empresasConIncertidumbre: ["WOBA"] };

  const criticas = [...generarControlDiario(fallo).recomendaciones, ...generarControlDiario(inciertos).recomendaciones].filter(
    (r) => r.prioridad === "critica"
  );
  // 7 ledgers x (no disponible | incierto) + costos no disponible + memoria (dos formas) = 17 ids distintos como mínimo.
  assert.ok(new Set(criticas.map((r) => r.id)).size >= 17, "el escenario debe recorrer todas las críticas conocidas");
  for (const r of criticas) {
    assert.ok(r.pasos && r.pasos.length >= 3, `la crítica ${r.id} debe traer pasos exactos`);
  }
  for (const r of [...generarControlDiario(fallo).recomendaciones, ...generarControlDiario(inciertos).recomendaciones]) {
    if (r.acciones?.length) assert.ok((r.pasos?.length ?? 0) > 0, `${r.id} ofrece botones, así que también debe explicar los pasos`);
  }
});

test("las recomendaciones salen ordenadas por prioridad (crítica → alta → media → informativa), de forma estable", () => {
  const entrada = entradaBase();
  const base = entrada.costos!;
  entrada.edicionesHolded = { preparada: 0, editando: 0, verificada: 1, incierta: 2, empresasConIncertidumbre: ["Footprint"] };
  entrada.politica = { ...entrada.politica, modo: "observe", limiteDiarioUSD: 20, limiteMensualUSD: 100 };
  entrada.costos = {
    ...base,
    hoy: { ...base.hoy, gastoRealApiUSD: 22.91, llamadas: 410 },
    ultimos7Dias: puntosSemana([4, 5, 3, 4, 6, 3, 5]),
    porProcesoHoy: [{ ...base.hoy, proceso: "correo_gastos_automatico", gastoRealApiUSD: 22.75, llamadas: 405 }],
  };
  const ids = generarControlDiario(entrada).recomendaciones.map((r) => `${r.prioridad}:${r.id}`);
  const rango = { critica: 0, alta: 1, media: 2, informativa: 3 } as const;
  const prioridades = ids.map((id) => rango[id.split(":")[0] as keyof typeof rango]);
  assert.deepEqual(prioridades, [...prioridades].sort((a, b) => a - b), `orden inesperado: ${ids.join(", ")}`);
  assert.equal(ids[0], "critica:ediciones-holded-inciertas");
  assert.ok(ids.indexOf("alta:gasto-hoy-elevado") < ids.indexOf("media:politica-observe"), "el gasto de hoy va antes que el ajuste de política");
});

test("si ya salta el umbral diario configurado, el gasto de hoy no duplica la tarjeta: la completa con el proceso y los pasos", () => {
  const entrada = entradaBase();
  const base = entrada.costos!;
  entrada.politica = { ...entrada.politica, umbralAlertaDiariaUSD: 10, limiteDiarioUSD: 30 };
  entrada.costos = {
    ...base,
    hoy: { ...base.hoy, gastoRealApiUSD: 22.91, llamadas: 410 },
    ultimos7Dias: puntosSemana([4, 5, 3, 4, 6, 3, 5]),
    porProcesoHoy: [{ ...base.hoy, proceso: "correo_gastos_automatico", gastoRealApiUSD: 22.75, llamadas: 405 }],
  };
  const recs = generarControlDiario(entrada).recomendaciones;
  assert.ok(!recs.some((r) => r.id === "gasto-hoy-elevado"), "no debe haber dos tarjetas sobre el gasto de hoy");
  const umbral = recs.find((r) => r.id === "umbral-diario-coste-ia");
  assert.ok(umbral);
  assert.match(umbral.detalle, /operación sigue disponible/i, "conserva el texto original");
  assert.match(umbral.detalle, /análisis automático de correo/);
  assert.match(umbral.detalle, /405 llamadas/);
  assert.ok((umbral.pasos?.length ?? 0) >= 3);
});
