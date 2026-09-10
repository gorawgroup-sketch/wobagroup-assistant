import assert from "node:assert/strict";
import test from "node:test";
import { ejecutarLoteOrdenado } from "./batch";
import { PlanificadorHerramientas } from "./scheduler";

test("lecturas en paralelo devuelven resultados en orden original aunque terminen al revés", async () => {
  const iniciadas: number[] = [];
  const liberar: (() => void)[] = [];
  const tarea = ejecutarLoteOrdenado([0, 1], () => true, async (id) => {
    iniciadas.push(id);
    await new Promise<void>((r) => { liberar[id] = r; });
    return `resultado-${id}`;
  });
  assert.deepEqual(iniciadas, [0, 1]);
  liberar[1]();
  liberar[0]();
  assert.deepEqual(await tarea, ["resultado-0", "resultado-1"]);
});

test("las escrituras y herramientas no auditadas son barreras entre grupos de lecturas", async () => {
  const orden: string[] = [];
  const resultado = await ejecutarLoteOrdenado(["read1", "read2", "write", "read3"],
    (s) => s.startsWith("read"), async (s) => {
      orden.push(`inicio:${s}`);
      await new Promise<void>((r) => setImmediate(r));
      orden.push(`fin:${s}`);
      return s;
    });
  assert.ok(orden.indexOf("inicio:write") > orden.indexOf("fin:read2"));
  assert.ok(orden.indexOf("inicio:read3") > orden.indexOf("fin:write"));
  assert.deepEqual(resultado, ["read1", "read2", "write", "read3"]);
});

test("fallo de lectura cancela admisiones restantes y no inicia la escritura siguiente", async () => {
  const s = new PlanificadorHerramientas({ paralelo: true, global: 1, porIdentidad: 1, cashflow: 1, maxPendientes: 8, esperaMs: 100 });
  let escrituras = 0;
  let lecturas = 0;
  await assert.rejects(ejecutarLoteOrdenado(["read1", "read2", "write"], (x) => x !== "write", async (x, signal) => {
    if (x === "write") { escrituras++; return x; }
    return s.ejecutar({ modo: "lectura", identidad: "1", recursos: ["a"] }, async () => {
      lecturas++;
      if (x === "read1") throw new Error("lectura fallida");
      return x;
    }, signal);
  }), /lectura fallida/);
  assert.equal(escrituras, 0);
  // Como máximo una lectura adicional ya admitida; nunca una escritura ni reintentos.
  assert.ok(lecturas <= 2);
  assert.deepEqual(s.estado, { activas: 0, pendientes: 0 });
});

test("modo desactivado reproduce ejecución secuencial", async () => {
  let activas = 0;
  let pico = 0;
  await ejecutarLoteOrdenado([1, 2, 3], () => true, async (id) => {
    pico = Math.max(pico, ++activas);
    await new Promise<void>((r) => setImmediate(r));
    activas--;
    return id;
  }, false);
  assert.equal(pico, 1);
});
