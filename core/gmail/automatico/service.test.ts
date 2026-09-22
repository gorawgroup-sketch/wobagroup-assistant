import assert from "node:assert/strict";
import test from "node:test";
import { prioridadAnalisisAutomatico, resumenAutomatico, ServicioCorreoAutomatico, type PuertoAutomatico } from "./service";
import { evaluarAuto, hash, VERSION_POLITICA, type OperacionAuto, type StoreAuto } from "./model";
import { analisisFixture, configFixture, correoFixture, evidenciaFixture } from "./fixtures";
import { UsoApiNoAutorizadoError } from "../../ai/policy";

function escenario() {
  const ops = new Map<string, OperacionAuto>(); const eventos: string[] = [];
  const correos = [correoFixture()]; const a = analisisFixture(); let cuenta = 0;
  const analisisGuardados = new Map<string, ReturnType<typeof analisisFixture>>(); let analisisLlamadas = 0;
  const copiar = <T>(x: T): T => structuredClone(x);
  const store: StoreAuto = {
    buscarAnalisis: async (b, m, h, v) => copiar(analisisGuardados.get(`${b}:${m}:${h}:${v}`)),
    guardarAnalisis: async (b, m, h, v, analisis) => { analisisGuardados.set(`${b}:${m}:${h}:${v}`, copiar(analisis)); },
    buscarFuente: async (b, m, f) => copiar([...ops.values()].find(o => o.plan.correo.id === m && o.plan.recibo.fuente === f && o.estado !== "rechazada")),
    pendientes: async () => copiar([...ops.values()].filter(o => !["completada", "rechazada"].includes(o.estado))),
    recuperables: async (_b, version) => copiar([...ops.values()].filter(o => !["completada", "rechazada"].includes(o.estado) ||
      (o.estado === "completada" && Boolean(o.compraId) && o.plan.version !== version))),
    reservar: async plan => {
      const repetida = [...ops.values()].find(o => o.estado !== "rechazada" && o.plan.claves.some(k => plan.claves.includes(k)));
      if (repetida) throw new Error("Reserva duplicada");
      const op: OperacionAuto = { id: String(++cuenta), plan, estado: "reservada" }; ops.set(op.id, copiar(op)); return op;
    },
    guardar: async op => { eventos.push(op.estado); ops.set(op.id, copiar(op)); },
    auditar: async e => { eventos.push(e.tipo); },
  };
  const llamadas = { crear: 0, preparar: 0, adjuntar: 0, conciliar: 0, marcar: 0, registrar: 0 };
  const puerto: PuertoAutomatico = {
    listar: async () => correos, obtener: async (mensajeId) => correos.find(c => c.id === mensajeId),
    reservadoManualmente: async () => false,
    analizar: async () => { analisisLlamadas++; return a; }, evidencias: async () => evidenciaFixture(),
    crear: async () => { llamadas.crear++; assert.equal([...ops.values()][0].estado, "creando"); return "compra1"; },
    recuperarCreacion: async () => undefined,
    verificarCreacion: async () => true,
    prepararAdjunto: async op => {
      llamadas.preparar++;
      op.plan.soporteHash = hash("pdf-final");
      op.plan.soporteNombre = "comprobante.pdf";
      op.plan.soporteMime = "application/pdf";
    },
    adjuntar: async () => {
      llamadas.adjuntar++;
      const guardada = [...ops.values()][0];
      assert.equal(guardada.estado, "adjuntando");
      assert.equal(guardada.plan.soporteHash, hash("pdf-final"));
      assert.equal(guardada.plan.soporteMime, "application/pdf");
    }, verificarAdjunto: async () => true,
    conciliar: async () => { llamadas.conciliar++; assert.equal([...ops.values()][0].estado, "conciliando"); }, verificarConciliacion: async () => true,
    marcarResuelto: async () => { llamadas.marcar++; }, registrarFinalizada: async () => { llamadas.registrar++; },
    permitidoAhora: () => true, ejecutarProtegido: async (_op, f) => f(),
  };
  return { service: new ServicioCorreoAutomatico(store, puerto), store, puerto, ops, llamadas, eventos, correos, a,
    analisisLlamadas: () => analisisLlamadas };
}
test("crea, adjunta, concilia, verifica y solo entonces marca el correo como resuelto", async () => {
  const e = escenario(); const r = await e.service.revisar(configFixture);
  assert.equal(r.completados, 1); assert.equal(r.pendientes.length, 0);
  assert.equal(r.encontrados, 1); assert.equal(r.aplazados, 0); assert.equal(r.reservados, 0);
  assert.deepEqual(e.llamadas, { crear: 1, preparar: 1, adjuntar: 1, conciliar: 1, marcar: 1, registrar: 1 });
  assert.ok(e.eventos.indexOf("completada") < e.eventos.indexOf("correo_resuelto"));
});
test("el informe desglosa automatizaciones por empresa y conserva el detalle verificable", () => {
  const texto = resumenAutomatico({
    modo: "execute", encontrados: 5, revisados: 5, completados: 3, simulados: 0, pendientes: [],
    gastos: [
      { empresa: "WOBA", id: "w-1", centimos: 1250, moneda: "EUR" },
      { empresa: "Footprint", id: "f-1", centimos: 2000, moneda: "USD" },
      { empresa: "WOBA", id: "w-2", centimos: 399, moneda: "EUR" },
    ],
  });
  assert.match(texto, /Gastos creados, soportados y conciliados: 3\./);
  assert.match(texto, /Correos encontrados para el pase automático: 5\./);
  assert.match(texto, /Correos analizados automáticamente: 5\./);
  assert.match(texto, /✅ Automatizados por empresa/);
  assert.match(texto, /• WOBA: 2\./);
  assert.match(texto, /• Footprint · 20\.00 USD · compra f-1\./);
});
test("el informe consolidado explica el período sin inflar el último conteo de correos", () => {
  const texto = resumenAutomatico({ modo: "execute", revisados: 2, completados: 0, simulados: 0,
    pendientes: [], gastos: [] }, { revisionesConsolidadas: 5 });
  assert.match(texto, /Informe consolidado de revisión automática/);
  assert.match(texto, /Revisiones incluidas desde el informe anterior: 5/);
  assert.match(texto, /Correos analizados en la revisión más reciente: 2/);
});
test("el informe distingue encontrados, analizados y aplazados", () => {
  const texto = resumenAutomatico({ modo: "execute", encontrados: 25, revisados: 4, aplazados: 21,
    reservados: 0, completados: 0, simulados: 0, pendientes: [], gastos: [] });
  assert.match(texto, /Correos encontrados para el pase automático: 25\./);
  assert.match(texto, /Correos analizados automáticamente: 4\./);
  assert.match(texto, /Correos aplazados sin analizar en esta pasada: 21\./);
});
test("el informe organiza pendientes en lenguaje accionable sin códigos internos", () => {
  const texto = resumenAutomatico({ modo: "execute", revisados: 1, completados: 0, simulados: 0, gastos: [],
    pendientes: [{ mensajeId: "m1", asunto: "Ticket de supermercado", motivos: ["proveedor_no_verificado"],
      detalles: [{ proveedor: "Delhaize", empresa: "Footprint", monto: 64.71, moneda: "EUR",
        contacto: "Louis Delhaize Brugge", metodoContacto: "aproximado_unico",
        motivos: ["proveedor_no_verificado"] }] }],
  });
  assert.match(texto, /🟡 Por qué quedaron correos para revisión manual/);
  assert.match(texto, /• Footprint · Delhaize · 64\.71 EUR/);
  assert.match(texto, /Se encontró «Louis Delhaize Brugge», pero falta confirmar/);
  assert.doesNotMatch(texto, /proveedor_no_verificado|aproximado_unico|mensajeId/);
});
test("el informe oculta ids de operaciones y muestra una sola causa principal por caso", () => {
  const texto = resumenAutomatico({ modo: "execute", revisados: 1, completados: 0, simulados: 0, gastos: [],
    pendientes: [{ mensajeId: "m1", asunto: "Recibo", motivos: ["operacion_incierta:uuid-interno", "movimiento_no_libre"],
      detalles: [{ proveedor: "ALDI", empresa: "Footprint", monto: 82.31, moneda: "EUR",
        motivos: ["operacion_incierta:uuid-interno", "detalle:timeout privado"] }] }],
  });
  assert.match(texto, /La operación ya empezó, pero falta confirmar que quedó completa en Holded/);
  assert.doesNotMatch(texto, /uuid-interno|operacion_incierta|timeout privado|movimiento_no_libre/);
});
test("simulación analiza y audita sin reservas, escrituras ni marcado leído", async () => {
  const e = escenario(); const r = await e.service.revisar({ ...configFixture, modo: "simulate" });
  assert.equal(r.simulados, 1); assert.equal(e.ops.size, 0);
  assert.equal(e.llamadas.crear + e.llamadas.adjuntar + e.llamadas.conciliar + e.llamadas.marcar, 0);
});
test("un mensaje sin cambios reutiliza el análisis durable pero reevalúa evidencias", async () => {
  const e = escenario(); let evidencias = 0;
  e.puerto.evidencias = async () => { evidencias++; return evidenciaFixture(); };
  const config = { ...configFixture, modo: "simulate" as const };
  await e.service.revisar(config); await e.service.revisar(config);
  assert.equal(e.analisisLlamadas(), 1);
  assert.equal(evidencias, 2);
  assert.equal(e.eventos.filter(x => x === "analisis").length, 1);
});
test("analiza correos independientes con concurrencia dos y conserva el orden de verificación", async () => {
  const e = escenario();
  e.correos.push(...["m2", "m3", "m4"].map(id => ({ ...correoFixture(id), huella: hash(id) })));
  let activas = 0, maximas = 0;
  e.puerto.analizar = async correo => {
    activas++; maximas = Math.max(maximas, activas);
    await new Promise(resolve => setTimeout(resolve, correo.id === "m1" ? 8 : 1));
    activas--;
    return analisisFixture();
  };
  const service = new ServicioCorreoAutomatico(e.store, e.puerto, { concurrenciaAnalisis: 2 });
  const r = await service.revisar({ ...configFixture, modo: "simulate" });
  assert.equal(r.revisados, 4);
  assert.equal(maximas, 2);
  assert.deepEqual(r.pendientes.map(p => p.mensajeId), ["m1", "m2", "m3", "m4"]);
});
test("acota los análisis nuevos de una pasada y reutiliza los ya persistidos sin consumir el cupo", async () => {
  const e = escenario();
  e.correos.push(...["m2", "m3", "m4"].map(id => ({ ...correoFixture(id), huella: hash(id) })));
  const service = new ServicioCorreoAutomatico(e.store, e.puerto, {
    concurrenciaAnalisis: 2,
    maxAnalisisNuevos: 2,
  });
  const primera = await service.revisar({ ...configFixture, modo: "simulate" });
  assert.equal(e.analisisLlamadas(), 2);
  assert.equal(
    primera.pendientes.filter(p => p.motivos.includes("revision_pospuesta_por_limite_de_coste")).length,
    2
  );
  await service.revisar({ ...configFixture, modo: "simulate" });
  assert.equal(e.analisisLlamadas(), 4);
});
test("con presupuesto limitado analiza primero el recibo probable sin gastar más IA", async () => {
  const e = escenario();
  e.correos[0] = { ...correoFixture("mensaje-general"), recibidoEn: 1, asunto: "Seguimiento comercial",
    cuerpo: "Revisemos el proyecto durante la próxima reunión.", adjuntos: [], huella: hash("general") };
  e.correos.push({ ...correoFixture("mensaje-recibo"), recibidoEn: 2,
    asunto: "Fwd: Café - 6.00 EUR - Revolut", cuerpo: "Recibo pagado con Visa. Total 6,00 EUR.",
    adjuntos: [{ id: "ticket", nombre: "receipt.pdf", mime: "application/pdf", data: Buffer.from("pdf") }],
    huella: hash("recibo") });
  const analizados: string[] = [];
  e.puerto.analizar = async correo => { analizados.push(correo.id); return e.a; };
  const service = new ServicioCorreoAutomatico(e.store, e.puerto, {
    concurrenciaAnalisis: 1,
    maxAnalisisNuevos: 1,
  });
  const prioridadGeneral = prioridadAnalisisAutomatico(e.correos[0]);
  const prioridadRecibo = prioridadAnalisisAutomatico(e.correos[1]);

  const resultado = await service.revisar({ ...configFixture, modo: "simulate" });

  assert.deepEqual(analizados, ["mensaje-recibo"]);
  assert.equal(resultado.pendientes.some(p =>
    p.mensajeId === "mensaje-general" && p.motivos.includes("revision_pospuesta_por_limite_de_coste")
  ), true);
  assert.ok(prioridadRecibo > prioridadGeneral);
});
test("al agotar el tiempo informa el pendiente sin iniciar análisis ni escrituras nuevas", async () => {
  const e = escenario();
  const service = new ServicioCorreoAutomatico(e.store, e.puerto, { fechaLimite: Date.now() - 1 });
  const r = await service.revisar(configFixture);
  assert.equal(e.analisisLlamadas(), 0);
  assert.equal(e.llamadas.crear + e.llamadas.adjuntar + e.llamadas.conciliar, 0);
  assert.deepEqual(r.pendientes[0]?.motivos, ["revision_pospuesta_por_limite_de_tiempo"]);
});
test("un límite monetario de IA se informa como presupuesto y nunca como lectura incompleta", async () => {
  const e = escenario();
  e.puerto.analizar = async () => {
    throw new UsoApiNoAutorizadoError("correo_gastos_automatico_manual", "limite_diario_proceso_alcanzado");
  };
  const r = await e.service.revisar(configFixture);
  assert.equal(r.revisados, 0);
  assert.equal(r.aplazados, 1);
  assert.equal(r.bloqueadosPorPresupuestoIA, 1);
  assert.deepEqual(r.pendientes[0]?.motivos, ["revision_pospuesta_por_limite_de_ia"]);
  const texto = resumenAutomatico(r);
  assert.match(texto, /presupuesto diario de IA: 1/);
  assert.doesNotMatch(texto, /No se pudo leer o verificar todo el contenido/);
});
test("una consulta de evidencias bloqueada respeta el límite global y deja el correo pendiente", async () => {
  const e = escenario();
  e.puerto.evidencias = async () => new Promise(() => {});
  const service = new ServicioCorreoAutomatico(e.store, e.puerto, { fechaLimite: Date.now() + 20 });
  const inicio = Date.now();
  const r = await service.revisar({ ...configFixture, modo: "simulate" });
  assert.ok(Date.now() - inicio < 1_000);
  assert.equal(e.llamadas.crear + e.llamadas.adjuntar + e.llamadas.conciliar, 0);
  assert.ok(r.pendientes[0]?.motivos.some(motivo => motivo.startsWith("error:")));
});
test("correo mixto procesa el gasto, conserva la solicitud y no vuelve a crearlo", async () => {
  const e = escenario(); e.a.otrasAcciones = true;
  await e.service.revisar(configFixture); const segunda = await e.service.revisar(configFixture);
  assert.equal(e.llamadas.crear, 1); assert.equal(e.llamadas.marcar, 0);
  assert.equal(segunda.gastos.length, 0);
});
test("timeout de creación conserva la intención y no repite el POST tras reinicio", async () => {
  const e = escenario(); e.puerto.crear = async () => { e.llamadas.crear++; throw new Error("timeout"); };
  await e.service.revisar(configFixture);
  const otra = new ServicioCorreoAutomatico(e.store, e.puerto);
  await otra.revisar(configFixture);
  assert.equal(e.llamadas.crear, 1); assert.equal(e.llamadas.conciliar, 0); assert.equal(e.llamadas.marcar, 0);
  assert.equal([...e.ops.values()][0].estado, "incierta");
});
test("recupera compra creada tras timeout por su identidad sin repetir creación", async () => {
  const e = escenario(); e.puerto.crear = async () => { e.llamadas.crear++; throw new Error("timeout"); };
  await e.service.revisar(configFixture); e.puerto.recuperarCreacion = async () => "compra1";
  const r = await e.service.revisar(configFixture);
  assert.equal(r.completados, 1); assert.equal(e.llamadas.crear, 1); assert.equal(e.llamadas.conciliar, 1);
});
test("conciliación incierta solo se recupera leyendo, no repitiendo POST", async () => {
  const e = escenario(); e.puerto.conciliar = async () => { e.llamadas.conciliar++; throw new Error("timeout"); };
  e.puerto.verificarConciliacion = async () => false;
  await e.service.revisar(configFixture); await e.service.revisar(configFixture);
  assert.equal(e.llamadas.conciliar, 1); assert.equal(e.llamadas.marcar, 0);
  e.puerto.verificarConciliacion = async () => true;
  await e.service.revisar(configFixture);
  assert.equal(e.llamadas.conciliar, 1); assert.equal(e.llamadas.marcar, 1);
});
test("si falla el guardado final recupera la conciliación por lectura y no repite el POST", async () => {
  const e = escenario(); const guardar = e.store.guardar.bind(e.store); let fallo = true;
  e.store.guardar = async op => {
    if (op.estado === "completada" && fallo) { fallo = false; throw new Error("DB caída al cerrar"); }
    await guardar(op);
  };
  await e.service.revisar(configFixture);
  assert.equal(e.llamadas.conciliar, 1); assert.equal(e.llamadas.marcar, 0);
  await e.service.revisar(configFixture);
  assert.equal(e.llamadas.conciliar, 1); assert.equal(e.llamadas.marcar, 1);
});
test("fallo en Gmail no recrea ni vuelve a conciliar", async () => {
  const e = escenario(); e.puerto.marcarResuelto = async () => { throw new Error("Gmail caído"); };
  const r = await e.service.revisar(configFixture); assert.equal(r.pendientes.length, 1);
  e.puerto.marcarResuelto = async () => { e.llamadas.marcar++; };
  await e.service.revisar(configFixture);
  assert.equal(e.llamadas.crear, 1); assert.equal(e.llamadas.conciliar, 1); assert.equal(e.llamadas.marcar, 1);
});
test("fallo en memoria informa la compra completada y reintenta el registro sin duplicarla", async () => {
  const e = escenario(); e.puerto.registrarFinalizada = async () => { throw new Error("Sheets caído"); };
  const r = await e.service.revisar(configFixture);
  assert.equal(r.completados, 1); assert.equal(r.gastos[0].id, "compra1");
  assert.equal(e.llamadas.marcar, 0);
  e.puerto.registrarFinalizada = async () => { e.llamadas.registrar++; };
  await e.service.revisar(configFixture);
  assert.equal(e.llamadas.crear, 1); assert.equal(e.llamadas.registrar, 1); assert.equal(e.llamadas.marcar, 1);
});
test("revalidación detecta movimiento tomado y no escribe", async () => {
  const e = escenario(); let lecturas = 0;
  e.puerto.evidencias = async () => { const ev = evidenciaFixture(); if (++lecturas > 1) ev.movimientos[0].estado = "reconciled"; return ev; };
  await e.service.revisar(configFixture);
  assert.equal(e.llamadas.crear, 0); assert.equal([...e.ops.values()][0].estado, "rechazada");
});
test("correo activo manual no se toca; los demás siguen ordenados", async () => {
  const e = escenario(); e.puerto.reservadoManualmente = async () => true;
  const r = await e.service.revisar(configFixture); assert.equal(r.revisados, 0); assert.equal(e.llamadas.crear, 0);
});
test("dos mensajes con el mismo comprobante nunca generan dos gastos", async () => {
  const e = escenario(); e.correos.push({ ...correoFixture("m2"), huella: hash("reenviado") });
  const r = await e.service.revisar(configFixture);
  assert.equal(e.llamadas.crear, 1); assert.equal(r.pendientes.length, 1);
});
test("fallo de persistencia antes del POST impide creación", async () => {
  const e = escenario(); e.store.guardar = async () => { throw new Error("DB caída"); };
  const r = await e.service.revisar(configFixture); assert.equal(e.llamadas.crear, 0); assert.equal(r.pendientes.length, 1);
});
test("interruptor apagado entre lectura y ejecución impide escrituras", async () => {
  const e = escenario(); e.puerto.permitidoAhora = () => false;
  await e.service.revisar(configFixture); assert.equal(e.llamadas.crear, 0);
});

test("una creación incierta no bloquea otro gasto con recursos distintos de la misma empresa", async () => {
  const e = escenario();
  e.a.recibos[0].numero = undefined;
  e.correos.push({ ...correoFixture("m2"), cuerpo: "otro comprobante", huella: hash("otro") });
  e.puerto.evidencias = async c => {
    const ev = evidenciaFixture(); ev.movimientos[0].id = `b-${c.id}`; return ev;
  };
  e.puerto.crear = async () => { e.llamadas.crear++; throw new Error("timeout"); };
  const r = await e.service.revisar(configFixture);
  assert.equal(e.ops.size, 2);
  assert.equal(e.llamadas.crear, 2);
  assert.equal(r.pendientes.some(p => p.motivos.includes("empresa_con_operacion_pendiente_de_verificar")), false);
});

test("reanuda tras apagar entre compra y adjunto sin duplicar la compra", async () => {
  const e = escenario(); let activo = true;
  e.puerto.permitidoAhora = () => activo;
  e.puerto.verificarCreacion = async () => { activo = false; return true; };
  await e.service.revisar(configFixture);
  assert.equal([...e.ops.values()][0].pasoIncierto, "creada");
  activo = true; e.puerto.verificarCreacion = async () => true;
  const r = await e.service.revisar(configFixture);
  assert.equal(r.completados, 1);
  assert.equal(e.llamadas.crear, 1);
  assert.equal(e.llamadas.adjuntar, 1);
  assert.equal([...e.ops.values()][0].pasoIncierto, undefined);
});

test("repara una operación completada con política anterior usando el correo original", async () => {
  const e = escenario();
  await e.service.revisar(configFixture);
  const op = [...e.ops.values()][0];
  op.plan.version = "correo-gastos-v6";
  e.ops.set(op.id, structuredClone(op));
  let recuperaciones = 0;
  e.puerto.recuperarCreacion = async actual => { recuperaciones++; return actual.compraId; };
  const r = await e.service.revisar(configFixture);
  assert.equal(recuperaciones, 1);
  assert.equal(r.reparados?.length, 1);
  assert.equal([...e.ops.values()][0].plan.version, VERSION_POLITICA);
  assert.equal(e.llamadas.crear, 1);
});

test("una reparación incierta de política anterior vuelve a corregirse aunque el correo siga sin leer", async () => {
  const e = escenario();
  await e.service.revisar(configFixture);
  const op = [...e.ops.values()][0];
  op.estado = "incierta";
  op.pasoIncierto = "completada";
  op.plan.version = "correo-gastos-v11";
  e.ops.set(op.id, structuredClone(op));
  let recuperaciones = 0;
  e.puerto.recuperarCreacion = async actual => { recuperaciones++; return actual.compraId; };
  const r = await e.service.revisar(configFixture);
  assert.equal(recuperaciones, 1);
  assert.equal(r.reparados?.length, 1);
  const guardada = [...e.ops.values()][0];
  assert.equal(guardada.estado, "completada");
  assert.equal(guardada.pasoIncierto, undefined);
  assert.equal(guardada.plan.version, VERSION_POLITICA);
  assert.equal(e.llamadas.crear, 1);
});

test("una reparación relee el recibo y corrige el contacto antes de tocar Holded", async () => {
  const e = escenario();
  const decision = evaluarAuto(e.correos[0], e.a, e.a.recibos[0], evidenciaFixture(), configFixture);
  assert.ok(decision.apto);
  const op: OperacionAuto = { id: "legada", estado: "completada", compraId: "compra-legada",
    plan: { ...decision.plan, version: "correo-gastos-v8" } };
  e.ops.set(op.id, structuredClone(op));
  e.a.recibos[0].proveedor = "Jumbo";
  e.a.recibos[0].concepto = "Compra supermercado Jumbo";
  e.puerto.evidencias = async () => ({ ...evidenciaFixture(), contacto: {
    id: "contacto-jumbo", nombre: "JUMBO SUPERMARKTEN", exacto: false,
    metodo: "aproximado_unico", similitud: 0.45,
  } });
  let contactoAlCorregir = "";
  e.puerto.recuperarCreacion = async actual => { contactoAlCorregir = actual.plan.contactoId; return actual.compraId; };
  const r = await e.service.revisar(configFixture);
  assert.equal(contactoAlCorregir, "contacto-jumbo");
  assert.equal(r.reparados?.length, 1);
});

test("una reparación bloquea un alias no relacionado aunque el importe sea exacto", async () => {
  const e = escenario();
  const decision = evaluarAuto(e.correos[0], e.a, e.a.recibos[0], evidenciaFixture(), configFixture);
  assert.ok(decision.apto);
  const op: OperacionAuto = { id: "legada", estado: "completada", compraId: "compra-legada",
    plan: { ...decision.plan, version: "correo-gastos-v8" } };
  e.ops.set(op.id, structuredClone(op));
  e.a.recibos[0].proveedor = "Parking Moraleja";
  e.puerto.evidencias = async () => ({ ...evidenciaFixture(), contacto: {
    id: "contacto-oxxo", nombre: "CADENA COMERCIAL OXXO SA", exacto: false,
    metodo: "alias_confirmado", similitud: 0,
  } });
  let recuperaciones = 0;
  e.puerto.recuperarCreacion = async actual => { recuperaciones++; return actual.compraId; };
  const r = await e.service.revisar(configFixture);
  assert.equal(recuperaciones, 0);
  assert.ok(r.pendientes.some(p => p.motivos.includes("proveedor_no_verificado")));
});

test("una reparación acepta un alias confirmado solo cuando los nombres siguen siendo compatibles", async () => {
  const e = escenario();
  const decision = evaluarAuto(e.correos[0], e.a, e.a.recibos[0], evidenciaFixture(), configFixture);
  assert.ok(decision.apto);
  const op: OperacionAuto = { id: "legada", estado: "completada", compraId: "compra-legada",
    plan: { ...decision.plan, version: "correo-gastos-v12" } };
  e.ops.set(op.id, structuredClone(op));
  e.a.recibos[0].proveedor = "Jumbo";
  e.a.recibos[0].concepto = "Compra supermercado Jumbo";
  e.puerto.evidencias = async () => ({ ...evidenciaFixture(), contacto: {
    id: "contacto-jumbo", nombre: "JUMBO SUPERMARKTEN", exacto: false,
    metodo: "alias_confirmado", similitud: 0,
  } });
  let contactoAlCorregir = "";
  e.puerto.recuperarCreacion = async actual => { contactoAlCorregir = actual.plan.contactoId; return actual.compraId; };
  const r = await e.service.revisar(configFixture);
  assert.equal(contactoAlCorregir, "contacto-jumbo");
  assert.equal(r.reparados?.length, 1);
});

test("diagnóstico conserva validación y HTTP sin exponer respuestas remotas", async () => {
  const { diagnosticoAnalisis } = await import('./service');
  assert.match(diagnosticoAnalisis(new Error('Datos extraídos incompletos o fuente desconocida.')), /fuente desconocida/);
  assert.equal(diagnosticoAnalisis(Object.assign(new Error('secret remote body'),{status:429})), 'Error: HTTP 429');
});
test("pendientes no se presentan como hilos sin leer y no se ocultan motivos", () => {
  const texto=resumenAutomatico({modo:'execute',revisados:0,completados:0,simulados:0,gastos:[],pendientes:[]});
  assert.match(texto,/incluye operaciones anteriores; no equivale a hilos sin leer/);
});
