import assert from "node:assert/strict";
import test from "node:test";
import { evaluarEvidenciaCierre, marcasDeOperacion, type HechosCierre } from "./cierreConEvidencia";
import { analisisFixture, configFixture, correoFixture, evidenciaFixture, reciboFixture } from "./fixtures";
import { evaluarAuto, VERSION_POLITICA, type AnalisisAuto, type OperacionAuto } from "./model";
import {
  mensajeOperacionBloqueada, mensajeYaRegistrado, REPOSO_MINIMO_MS, resolverOperacionAnterior,
  type DepsOperacionAnterior, type OperacionConEdad,
} from "./operacionAnterior";

function operacion(estado: OperacionAuto["estado"] = "incierta", extra: Partial<OperacionAuto> = {}): OperacionAuto {
  const correo = correoFixture();
  const decision = evaluarAuto(correo, analisisFixture(), reciboFixture(), evidenciaFixture(), configFixture);
  assert.ok(decision.apto, "el plan de prueba debe ser apto");
  const plan = structuredClone(decision.plan);
  plan.version = "correo-gastos-v-antigua";
  return { id: "509b5441-6534-454c-9d81-42bba3ff298f", revision: 3, plan, estado, compraId: "compra-1",
    pasoIncierto: estado === "incierta" ? "conciliando" : undefined, detalle: "Conciliación no verificada", ...extra };
}

function hechosCompletos(op: OperacionAuto): HechosCierre {
  return {
    compra: { id: op.compraId!, notas: `${marcasDeOperacion(op)[1]} nota del operador`, contactoId: op.plan.contactoId,
      moneda: "EUR", totalCentimos: 2000, pagadoCentimos: 2000, pendienteCentimos: 0,
      pagos: [{ bancoId: op.plan.movimiento.cuentaId, centimos: 2000 }] },
    adjuntos: 1,
    movimiento: { estado: "reconciled" },
  };
}

function escenario(ops: OperacionAuto[], opciones: { hechos?: (op: OperacionAuto) => HechosCierre | Promise<HechosCierre>;
  analisis?: AnalisisAuto; edadMs?: number; guardarFalla?: boolean } = {}) {
  const ahora = 1_000_000_000_000;
  const almacen = new Map(ops.map(o => [o.id, structuredClone(o)]));
  const registro = { lecturas: 0, guardados: [] as OperacionAuto[], auditorias: [] as Array<{ tipo: string; datos: unknown }>, finalizadas: 0 };
  const deps: DepsOperacionAnterior = {
    operacionesDeHilo: async () => [...almacen.values()].map((op): OperacionConEdad =>
      ({ op: structuredClone(op), actualizadaEn: ahora - (opciones.edadMs ?? 60 * 60_000) })),
    analisisDeMensaje: async () => opciones.analisis,
    leerHechos: async op => { registro.lecturas++; return (opciones.hechos ?? hechosCompletos)(op); },
    guardar: async op => {
      if (opciones.guardarFalla) throw new Error("Operación modificada por otra ejecución");
      registro.guardados.push(structuredClone(op)); almacen.set(op.id, structuredClone(op));
    },
    auditar: async e => { registro.auditorias.push(e); },
    registrarFinalizada: async () => { registro.finalizadas++; },
    ahora: () => ahora,
  };
  return { deps, registro, almacen };
}

test("evaluarEvidenciaCierre: compra propia, pagada, con comprobante y conciliada → completa", () => {
  const op = operacion();
  const r = evaluarEvidenciaCierre(op, hechosCompletos(op));
  assert.equal(r.veredicto, "completa");
  assert.deepEqual(r.faltan, []);
});

test("evaluarEvidenciaCierre: la marca antigua WOBI_AUTO también demuestra la identidad", () => {
  const op = operacion();
  const h = hechosCompletos(op);
  h.compra!.notas = `WOBI_AUTO:${op.id}`;
  assert.equal(evaluarEvidenciaCierre(op, h).veredicto, "completa");
});

test("evaluarEvidenciaCierre: sin la marca de la operación nunca se cierra, aunque importe y proveedor coincidan", () => {
  const op = operacion();
  const h = hechosCompletos(op);
  h.compra!.notas = "otra nota cualquiera";
  const r = evaluarEvidenciaCierre(op, h);
  assert.equal(r.veredicto, "no_concluyente");
  assert.ok(r.faltan.includes("identidad"));
});

test("evaluarEvidenciaCierre: otro proveedor, moneda o importe → no concluyente", () => {
  const op = operacion();
  for (const cambio of [
    (h: HechosCierre) => { h.compra!.contactoId = "otro"; },
    (h: HechosCierre) => { h.compra!.moneda = "USD"; },
    (h: HechosCierre) => { h.compra!.totalCentimos = 2001; h.compra!.pagadoCentimos = 2001; },
  ]) {
    const h = hechosCompletos(op); cambio(h);
    assert.equal(evaluarEvidenciaCierre(op, h).veredicto, "no_concluyente");
  }
});

test("evaluarEvidenciaCierre: falta pago, comprobante, cuenta o conciliación → parcial, con lo que falta", () => {
  const op = operacion();
  const casos: Array<[string, (h: HechosCierre) => void]> = [
    ["pagoCompleto", h => { h.compra!.pagadoCentimos = 0; h.compra!.pendienteCentimos = 2000; h.compra!.pagos = []; }],
    ["comprobante", h => { h.adjuntos = 0; }],
    ["pagoEnLaCuentaPrevista", h => { h.compra!.pagos = [{ bancoId: "otra-cuenta", centimos: 2000 }]; }],
    ["movimientoConciliado", h => { h.movimiento = { estado: "pending" }; }],
    ["movimientoConciliado", h => { h.movimiento = null; }],
  ];
  for (const [esperado, cambio] of casos) {
    const h = hechosCompletos(op); cambio(h);
    const r = evaluarEvidenciaCierre(op, h);
    assert.equal(r.veredicto, "parcial", esperado);
    assert.ok(r.faltan.includes(esperado as never), esperado);
  }
});

test("evaluarEvidenciaCierre: una compra que no existe no se da por buena", () => {
  const op = operacion();
  assert.equal(evaluarEvidenciaCierre(op, { compra: null, adjuntos: 0, movimiento: null }).veredicto, "no_concluyente");
});

test("resolver: operación incierta con Holded completo se cierra sin escribir en Holded y el correo queda como ya registrado", async () => {
  const op = operacion();
  const e = escenario([op], { analisis: analisisFixture() });
  const r = await resolverOperacionAnterior(op.plan.correo.threadId, op.plan.correo.id, e.deps);
  assert.equal(r.tipo, "ya_registrado");
  assert.equal(e.registro.guardados.length, 1);
  const cerrada = e.registro.guardados[0];
  assert.equal(cerrada.estado, "completada");
  assert.equal(cerrada.pasoIncierto, undefined);
  assert.equal(cerrada.plan.version, VERSION_POLITICA, "la versión vigente evita que la próxima pasada la «repare» editando la compra");
  assert.equal(e.registro.auditorias.map(a => a.tipo).join(), "cierre_por_evidencia");
  assert.equal(e.registro.finalizadas, 1);
  if (r.tipo === "ya_registrado") {
    assert.equal(r.cerradas, 1);
    assert.equal(r.gastos[0].compraId, "compra-1");
    assert.match(mensajeYaRegistrado(r, "Fwd: JetBlue"), /ya estaba registrado y conciliado/);
    assert.match(mensajeYaRegistrado(r, "Fwd: JetBlue"), /No creé ni concilié nada nuevo/);
  }
});

test("resolver: sin análisis que pruebe la cobertura, cierra la operación pero deja seguir la revisión normal", async () => {
  const op = operacion();
  const e = escenario([op], { analisis: undefined });
  assert.equal((await resolverOperacionAnterior(op.plan.correo.threadId, op.plan.correo.id, e.deps)).tipo, "libre");
  assert.equal(e.registro.guardados.length, 1);
});

test("resolver: un correo con más recibos que operaciones completadas no se da por registrado", async () => {
  const op = operacion();
  const dos: AnalisisAuto = { ...analisisFixture(), recibos: [reciboFixture(), { ...reciboFixture(), fuente: "adjunto-2" }] };
  const e = escenario([op], { analisis: dos });
  assert.equal((await resolverOperacionAnterior(op.plan.correo.threadId, op.plan.correo.id, e.deps)).tipo, "libre");
});

test("resolver: si el análisis detecta otras acciones pendientes no se da por registrado", async () => {
  const op = operacion();
  const e = escenario([op], { analisis: { ...analisisFixture(), otrasAcciones: true } });
  assert.equal((await resolverOperacionAnterior(op.plan.correo.threadId, op.plan.correo.id, e.deps)).tipo, "libre");
});

test("resolver: si Holded no muestra el resultado completo, bloquea con el detalle y no toca nada", async () => {
  const op = operacion();
  const e = escenario([op], { hechos: o => { const h = hechosCompletos(o); h.adjuntos = 0; return h; } });
  const r = await resolverOperacionAnterior(op.plan.correo.threadId, op.plan.correo.id, e.deps);
  assert.equal(r.tipo, "bloqueada");
  assert.equal(e.registro.guardados.length, 0);
  assert.equal(e.registro.auditorias.length, 0);
  if (r.tipo === "bloqueada") {
    assert.equal(r.motivo, "sin_pruebas");
    const texto = mensajeOperacionBloqueada(r);
    assert.match(texto, /509b5441…/);
    assert.match(texto, /no tiene comprobante adjunto/);
    assert.match(texto, /No se repetirán escrituras/);
  }
});

test("resolver: una operación con actividad reciente no se cierra ni se lee (puede estar ejecutándose)", async () => {
  const op = operacion("conciliando");
  const e = escenario([op], { edadMs: REPOSO_MINIMO_MS - 1 });
  const r = await resolverOperacionAnterior(op.plan.correo.threadId, op.plan.correo.id, e.deps);
  assert.equal(r.tipo === "bloqueada" && r.motivo, "en_curso");
  assert.equal(e.registro.lecturas, 0);
  assert.equal(e.registro.guardados.length, 0);
});

test("resolver: un fallo al leer Holded se distingue de «falta algo» y no cierra nada", async () => {
  const op = operacion();
  const e = escenario([op], { hechos: () => { throw new Error("Consulta Holded falló (503)"); } });
  const r = await resolverOperacionAnterior(op.plan.correo.threadId, op.plan.correo.id, e.deps);
  assert.equal(r.tipo === "bloqueada" && r.motivo, "lectura_fallida");
  assert.equal(e.registro.guardados.length, 0);
  if (r.tipo === "bloqueada") assert.match(mensajeOperacionBloqueada(r), /no pude comprobar Holded/);
});

test("resolver: si otra ejecución modificó la operación, no se fuerza el cierre", async () => {
  const op = operacion();
  const e = escenario([op], { guardarFalla: true });
  const r = await resolverOperacionAnterior(op.plan.correo.threadId, op.plan.correo.id, e.deps);
  assert.equal(r.tipo, "bloqueada");
  assert.equal(e.registro.auditorias.length, 0);
  assert.equal(e.registro.finalizadas, 0);
});

test("resolver: sin operaciones anteriores el correo queda libre; con una completada que cubre todo, ya registrado", async () => {
  const vacio = escenario([]);
  assert.equal((await resolverOperacionAnterior("t-m1", "m1", vacio.deps)).tipo, "libre");
  const completada = operacion("completada");
  const e = escenario([completada], { analisis: analisisFixture() });
  const r = await resolverOperacionAnterior(completada.plan.correo.threadId, completada.plan.correo.id, e.deps);
  assert.equal(r.tipo, "ya_registrado");
  assert.equal(e.registro.lecturas, 0, "una operación ya completada no se vuelve a consultar en Holded");
  assert.equal(r.tipo === "ya_registrado" && r.cerradas, 0);
});

test("resolver: una operación completada de otro mensaje del hilo no da por registrado este mensaje", async () => {
  const completada = operacion("completada");
  const e = escenario([completada], { analisis: analisisFixture() });
  assert.equal((await resolverOperacionAnterior(completada.plan.correo.threadId, "otro-mensaje", e.deps)).tipo, "libre");
});
