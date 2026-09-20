import assert from "node:assert/strict";
import test from "node:test";
import { resumenAutomatico, ServicioCorreoAutomatico, type PuertoAutomatico } from "./service";
import { hash, type OperacionAuto, type StoreAuto } from "./model";
import { analisisFixture, configFixture, correoFixture, evidenciaFixture } from "./fixtures";

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
    reservar: async plan => {
      const repetida = [...ops.values()].find(o => o.estado !== "rechazada" && o.plan.claves.some(k => plan.claves.includes(k)));
      if (repetida) throw new Error("Reserva duplicada");
      const op: OperacionAuto = { id: String(++cuenta), plan, estado: "reservada" }; ops.set(op.id, copiar(op)); return op;
    },
    guardar: async op => { eventos.push(op.estado); ops.set(op.id, copiar(op)); },
    auditar: async e => { eventos.push(e.tipo); },
  };
  const llamadas = { crear: 0, adjuntar: 0, conciliar: 0, marcar: 0, registrar: 0 };
  const puerto: PuertoAutomatico = {
    listar: async () => correos, reservadoManualmente: async () => false,
    analizar: async () => { analisisLlamadas++; return a; }, evidencias: async () => evidenciaFixture(),
    crear: async () => { llamadas.crear++; assert.equal([...ops.values()][0].estado, "creando"); return "compra1"; },
    recuperarCreacion: async () => undefined,
    verificarCreacion: async () => true,
    adjuntar: async () => { llamadas.adjuntar++; assert.equal([...ops.values()][0].estado, "adjuntando"); }, verificarAdjunto: async () => true,
    conciliar: async () => { llamadas.conciliar++; assert.equal([...ops.values()][0].estado, "conciliando"); }, verificarConciliacion: async () => true,
    marcarResuelto: async () => { llamadas.marcar++; }, registrarFinalizada: async () => { llamadas.registrar++; },
    permitidoAhora: () => true, ejecutarProtegido: async (_op, f) => f(),
  };
  return { service: new ServicioCorreoAutomatico(store, puerto), store, puerto, ops, llamadas, eventos, correos, a,
    analisisLlamadas: () => analisisLlamadas };
}
test("crea, adjunta, concilia, verifica y solo entonces marca leído", async () => {
  const e = escenario(); const r = await e.service.revisar(configFixture);
  assert.equal(r.completados, 1); assert.equal(r.pendientes.length, 0);
  assert.deepEqual(e.llamadas, { crear: 1, adjuntar: 1, conciliar: 1, marcar: 1, registrar: 1 });
  assert.ok(e.eventos.indexOf("completada") < e.eventos.indexOf("correo_resuelto"));
});
test("el informe desglosa automatizaciones por empresa y conserva el detalle verificable", () => {
  const texto = resumenAutomatico({
    modo: "execute", revisados: 5, completados: 3, simulados: 0, pendientes: [],
    gastos: [
      { empresa: "WOBA", id: "w-1", centimos: 1250, moneda: "EUR" },
      { empresa: "Footprint", id: "f-1", centimos: 2000, moneda: "USD" },
      { empresa: "WOBA", id: "w-2", centimos: 399, moneda: "EUR" },
    ],
  });
  assert.match(texto, /3 gasto\(s\) creado\(s\) y conciliado\(s\)/);
  assert.match(texto, /Automatizados por empresa: WOBA: 2; Footprint: 1\./);
  assert.match(texto, /• Footprint: 20\.00 USD — compra f-1/);
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

test("una creación incierta no acumula reservas que impidan recuperar la primera", async () => {
  const e = escenario();
  e.correos.push({ ...correoFixture("m2"), cuerpo: "otro comprobante", huella: hash("otro") });
  e.puerto.evidencias = async c => {
    const ev = evidenciaFixture(); ev.movimientos[0].id = `b-${c.id}`; return ev;
  };
  e.puerto.crear = async () => { e.llamadas.crear++; throw new Error("timeout"); };
  const r = await e.service.revisar(configFixture);
  assert.equal(e.ops.size, 1);
  assert.equal(e.llamadas.crear, 1);
  assert.ok(r.pendientes.some(p => p.motivos.includes("empresa_con_operacion_pendiente_de_verificar")));
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
