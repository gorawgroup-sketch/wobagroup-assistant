import assert from "node:assert/strict";
import test from "node:test";
import { PlanificadorHerramientas, configuracionConcurrencia, type AccesoHerramienta } from "./scheduler";
import { ejecutarHerramienta } from "./execution";
import type { ToolDefinition } from "./types";

const turno = () => new Promise<void>((resolve) => setImmediate(resolve));
function pendiente<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const config = { paralelo: true, global: 2, porIdentidad: 1, cashflow: 2, maxPendientes: 8, esperaMs: 500 };
const leer = (identidad: string, recurso = "cashflow"): AccesoHerramienta => ({ identidad, modo: "lectura", recursos: [recurso] });
const escribir = (recurso = "*"): AccesoHerramienta => ({ identidad: "writer", modo: "escritura", recursos: [recurso] });

test("configuración conservadora, desactivación y valores inválidos", () => {
  assert.equal(configuracionConcurrencia({}).porIdentidad, 2);
  assert.equal(configuracionConcurrencia({}).cashflow, 1);
  assert.equal(configuracionConcurrencia({ WOBI_PARALLEL_READS_ENABLED: "false" }).paralelo, false);
  assert.equal(configuracionConcurrencia({ WOBI_PARALLEL_READS_ENABLED: "typo" }).paralelo, false);
  assert.equal(configuracionConcurrencia({ WOBI_READ_CONCURRENCY_GLOBAL: "100" }).global, 8);
  assert.equal(configuracionConcurrencia({ WOBI_TOOL_QUEUE_MAX_PENDING: "1" }).maxPendientes, 8);
});

test("respeta cupos globales y por identidad sin bloquear otra identidad", async () => {
  const s = new PlanificadorHerramientas(config);
  const liberar = pendiente();
  const iniciadas: string[] = [];
  const trabajo = (id: string) => s.ejecutar(leer(id), async () => { iniciadas.push(id); await liberar.promise; });
  const tareas = [trabajo("a"), trabajo("a"), trabajo("b"), trabajo("c")];
  await turno();
  assert.deepEqual(iniciadas, ["a", "b"]);
  assert.deepEqual(s.estado, { activas: 2, pendientes: 2 });
  liberar.resolve();
  await Promise.all(tareas);
  assert.deepEqual(s.estado, { activas: 0, pendientes: 0 });
});

test("cashflow conserva una sola lectura simultánea para no agravar su cuota", async () => {
  const s = new PlanificadorHerramientas({ ...config, global: 4, porIdentidad: 4, cashflow: 1 });
  const liberar = pendiente();
  let activas = 0, pico = 0;
  const trabajo = (id: string) => s.ejecutar(leer(id, "cashflow"), async () => {
    pico = Math.max(pico, ++activas);
    await liberar.promise;
    activas--;
  });
  const tareas = [trabajo("a"), trabajo("b")];
  await turno();
  assert.equal(pico, 1);
  liberar.resolve();
  await Promise.all(tareas);
});

test("una escritura espera lecturas anteriores y no es adelantada por nuevas lecturas", async () => {
  const s = new PlanificadorHerramientas(config);
  const primera = pendiente();
  const escritura = pendiente();
  const orden: string[] = [];
  const a = s.ejecutar(leer("a"), async () => { orden.push("read1"); await primera.promise; });
  const b = s.ejecutar(escribir(), async () => { orden.push("write"); await escritura.promise; });
  const c = s.ejecutar(leer("b"), async () => { orden.push("read2"); });
  await turno();
  assert.deepEqual(orden, ["read1"]);
  primera.resolve();
  await a;
  assert.deepEqual(orden, ["read1", "write"]);
  escritura.resolve();
  await Promise.all([b, c]);
  assert.deepEqual(orden, ["read1", "write", "read2"]);
});

test("recursos disjuntos pueden avanzar; un recurso común no admite dos escrituras", async () => {
  const s = new PlanificadorHerramientas(config);
  const primera = pendiente();
  let segundaInicio = false;
  const a = s.ejecutar(escribir("cashflow"), () => primera.promise);
  const b = s.ejecutar(escribir("cashflow"), async () => { segundaInicio = true; });
  assert.equal(await s.ejecutar(leer("b", "holded:WOBA"), async () => "ok"), "ok");
  assert.equal(segundaInicio, false);
  primera.resolve();
  await Promise.all([a, b]);
  assert.equal(segundaInicio, true);
});

test("cancelar una admisión pendiente garantiza que nunca se ejecuta", async () => {
  const s = new PlanificadorHerramientas(config);
  const liberar = pendiente();
  const a = s.ejecutar(escribir(), () => liberar.promise);
  const abortar = new AbortController();
  const b = s.ejecutar(leer("a"), async () => assert.fail("tarea fantasma"), abortar.signal);
  const rechazo = assert.rejects(b, /cancelado/);
  abortar.abort(new Error("cancelado"));
  await rechazo;
  liberar.resolve();
  await a;
  assert.deepEqual(s.estado, { activas: 0, pendientes: 0 });
});

test("cola llena y espera agotada no ejecutan escrituras ni marcan efectos", async () => {
  const s = new PlanificadorHerramientas({ ...config, maxPendientes: 1, esperaMs: 15 });
  const liberar = pendiente();
  const a = s.ejecutar(escribir(), () => liberar.promise);
  const b = s.ejecutar(escribir(), async () => assert.fail("fuera de plazo"));
  const rechazo = assert.rejects(b, /cola_herramientas/);
  await assert.rejects(s.ejecutar(leer("b"), async () => assert.fail()), /saturada/);
  await rechazo;
  liberar.resolve();
  await a;
});

test("un fallo libera reservas y la siguiente escritura puede continuar", async () => {
  const s = new PlanificadorHerramientas(config);
  const a = s.ejecutar(escribir(), async () => { throw new Error("fallo"); });
  const rechazo = assert.rejects(a, /fallo/);
  const b = s.ejecutar(escribir(), async () => "ok");
  await rechazo;
  assert.equal(await b, "ok");
});

test("herramientas anidadas reutilizan reserva exclusiva sin interbloqueo", async () => {
  const s = new PlanificadorHerramientas(config);
  assert.equal(await s.ejecutar(escribir(), async () =>
    s.ejecutar(leer("a"), async () => "anidada")), "anidada");
  assert.deepEqual(s.estado, { activas: 0, pendientes: 0 });
});

test("una reserva de lectura nunca escala a escritura silenciosamente", async () => {
  const s = new PlanificadorHerramientas(config);
  await assert.rejects(s.ejecutar(leer("a"), async () =>
    s.ejecutar(escribir(), async () => assert.fail())), /excede la reserva/);
});

test("el timeout visible no libera un cupo de lectura mientras la operación real sigue viva", async () => {
  const s = new PlanificadorHerramientas({ ...config, global: 1 });
  const liberar = pendiente<string>();
  const tool: ToolDefinition = {
    name: "read", description: "", input_schema: { type: "object" },
    seguraParaModoRapido: true, lecturaAcotable: true, lecturaParalela: "cashflow", handler: () => liberar.promise,
  };
  await assert.rejects(ejecutarHerramienta(tool, {}, { chatId: 1 }, 10, s), /Tiempo máximo/);
  assert.equal(s.estado.activas, 1);
  let inicio = false;
  const b = s.ejecutar(leer("b"), async () => { inicio = true; });
  await turno();
  assert.equal(inicio, false);
  liberar.resolve("tardío");
  await b;
  assert.equal(inicio, true);
  assert.equal(s.estado.activas, 0);
});

test("una escritura que vence esperando cupo nunca inicia ni marca efectos", async () => {
  const s = new PlanificadorHerramientas({ ...config, esperaMs: 10 });
  const liberar = pendiente();
  const a = s.ejecutar(escribir(), () => liberar.promise);
  let efectos = false;
  const tool: ToolDefinition = { name: "write", description: "", input_schema: { type: "object" }, handler: () => assert.fail() };
  await assert.rejects(ejecutarHerramienta(tool, {}, { antesDeEfecto: () => { efectos = true; } }, 100, s), /cola_herramientas/);
  assert.equal(efectos, false);
  liberar.resolve();
  await a;
});
