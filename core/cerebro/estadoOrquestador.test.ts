import { test } from "node:test";
import assert from "node:assert/strict";
import { crearOrquestadorEstado, type DefinicionSeccion } from "./estadoOrquestador";
import type { ConteosHolded } from "./conteosHolded";

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { resolve, promise }; };

function conteosFalsos(estado: Partial<ConteosHolded> = {}) {
  const llamadas = { refrescar: [] as Array<number | undefined>, necesita: false };
  return {
    llamadas,
    fuente: {
      edadMs: () => 90_000,
      leer: (): ConteosHolded => ({ porEmpresa: {}, gastosSinComprobante: 7, movimientosSinConciliar: 9, actualizadoEn: "2026-09-25T10:00:00.000Z", refrescando: false, conservado: false, ...estado }),
      refrescar: async (min?: number) => { llamadas.refrescar.push(min); },
      necesitaRefresco: () => llamadas.necesita,
    },
  };
}

function seccion(nombre: string, ttlMs: number, contador: { n: number }, extra: Partial<DefinicionSeccion> = {}): DefinicionSeccion {
  return { nombre, ttlMs, cargar: async () => ({ datos: { nombre, v: ++contador.n }, fuentes: [{ fuente: `${nombre}.f`, ok: true, verificadoEn: "x", ultimoExitoEn: "x", conservado: false }] }),
    fallback: { datos: { nombre, v: 0, vacio: true }, fuentes: [] }, ...extra };
}

function crear(opciones: { secciones: DefinicionSeccion[]; conteos?: ReturnType<typeof conteosFalsos>; publicados?: string[]; hayNavegadores?: () => boolean; ahora?: () => number; esperaAvisoMs?: number }) {
  const c = opciones.conteos ?? conteosFalsos();
  const publicados = opciones.publicados ?? [];
  const o = crearOrquestadorEstado({ secciones: opciones.secciones, conteos: c.fuente, publicar: (t) => publicados.push(t),
    hayNavegadoresConectados: opciones.hayNavegadores ?? (() => true), esperaCoalescerMs: 0, esperaAvisoMs: opciones.esperaAvisoMs ?? 20, ahora: opciones.ahora });
  return { o, c, publicados };
}

test("compone todas las secciones, junta las fuentes y devuelve la antigüedad del dato MÁS antiguo", async () => {
  let t = 1_000;
  const a = { n: 0 }, b = { n: 0 };
  const { o } = crear({ secciones: [seccion("cashflow", 60_000, a), seccion("correo", 60_000, b)], ahora: () => t });
  const e1 = await o.obtener();
  assert.deepEqual(Object.keys(e1.datos).sort(), ["cashflow", "correo"]);
  assert.equal(e1.fuentes.length, 2);
  assert.equal(e1.obtenidoEn, 1_000);
  assert.equal(e1.conteos.gastosSinComprobante, 7);
  t = 5_000;
  await o.invalidar(["correo"]); await esperar(20);
  const e2 = await o.obtener();
  assert.equal(e2.obtenidoEn, 1_000, "cashflow sigue siendo de t=1000: la frescura real es la del más antiguo");
  assert.equal((e2.datos.correo as { v: number }).v, 2);
  assert.equal((e2.datos.cashflow as { v: number }).v, 1, "solo se recalculó la sección invalidada");
});

test("una lectura vencida no bloquea: responde al instante lo último y marca refrescando", async () => {
  let t = 0;
  const lenta = deferred<void>();
  const cuenta = { n: 0 };
  const def = seccion("cashflow", 10, cuenta, { cargar: async () => { const v = ++cuenta.n; if (v > 1) await lenta.promise; return { datos: { v }, fuentes: [] }; } });
  const { o } = crear({ secciones: [def], ahora: () => t });
  await o.obtener();
  t = 50;
  const inicio = Date.now();
  const e = await o.obtener();
  assert.ok(Date.now() - inicio < 100, "no esperó al recálculo colgado");
  assert.equal((e.datos.cashflow as { v: number }).v, 1);
  assert.equal(e.refrescando, true);
  lenta.resolve();
  await esperar(20);
  assert.equal((await o.obtener()).refrescando, false);
});

test("una sección que nunca pudo leerse usa su valor por defecto y cuenta como sin verificar (fecha 0), nunca como reciente", async () => {
  const rota: DefinicionSeccion = { nombre: "drive", ttlMs: 10, cargar: async () => { throw new Error("Drive caído"); }, fallback: { datos: { archivos: 0, porDefecto: true }, fuentes: [] } };
  const { o } = crear({ secciones: [seccion("cashflow", 60_000, { n: 0 }), rota] });
  const e = await o.obtener();
  assert.deepEqual(e.datos.drive, { archivos: 0, porDefecto: true });
  assert.equal(e.obtenidoEn, 0);
  assert.equal(e.refrescando, true);
});

test("«actualizar» (forzar) recalcula todas las secciones ligeras, espera y pide los conteos pesados en segundo plano sin bloquear", async () => {
  const cuenta = { n: 0 };
  const conteos = conteosFalsos();
  const { o } = crear({ secciones: [seccion("a", 60_000, cuenta), seccion("b", 60_000, cuenta)], conteos });
  await o.obtener();
  assert.equal(cuenta.n, 2);
  const e = await o.obtener(true);
  assert.equal(cuenta.n, 4, "las dos secciones se recalcularon y se esperó al resultado");
  assert.deepEqual([(e.datos.a as { v: number }).v, (e.datos.b as { v: number }).v].sort(), [3, 4]);
  assert.deepEqual(conteos.llamadas.refrescar, [2 * 60_000], "los conteos pesados: refresco en segundo plano con edad mínima de 2 min");
});

test("una orden «actualizar» nunca se ignora en silencio: si llega con otra en curso o justo después, espera a la actual, agenda otro recálculo y la respuesta sale marcada refrescando", async () => {
  const cuenta = { n: 0 };
  const { o } = crear({ secciones: [seccion("a", 60_000, cuenta)] });
  await o.obtener();
  const respuestas = await Promise.all([o.obtener(true), o.obtener(true), o.obtener(true)]);
  assert.equal(cuenta.n >= 2, true, "la primera recalculó");
  const trasForzar = cuenta.n;
  const inmediata = await o.obtener(true); // dentro de la ventana mínima
  assert.equal(inmediata.refrescando, true, "avisa de que hay un recálculo agendado en vez de fingir que ya está");
  await esperar(30);
  assert.ok(cuenta.n > trasForzar, "y el recálculo agendado ocurre");
  assert.ok(respuestas.length === 3);
});

test("invalidar sin nombres marca todas las secciones ligeras pero NO los conteos pesados; con nombres, solo esas", async () => {
  const a = { n: 0 }, b = { n: 0 };
  const conteos = conteosFalsos();
  const { o } = crear({ secciones: [seccion("cashflow", 60_000, a), seccion("usuarios", 60_000, b)], conteos });
  await o.obtener();
  o.invalidar(["usuarios"]); await esperar(20);
  assert.deepEqual([a.n, b.n], [1, 2]);
  o.invalidar(); await esperar(20);
  assert.deepEqual([a.n, b.n], [2, 3]);
  assert.deepEqual(conteos.llamadas.refrescar, []);
  assert.doesNotThrow(() => o.invalidar(["seccion-que-no-existe"]));
});

test("una ráfaga de invalidaciones publica UN solo aviso «estado_actualizado» cuando termina el recálculo", async () => {
  const cuenta = { n: 0 };
  const { o, publicados } = crear({ secciones: [seccion("a", 60_000, cuenta), seccion("b", 60_000, cuenta)] });
  await o.obtener();
  for (let i = 0; i < 40; i++) o.invalidar();
  await esperar(200);
  assert.deepEqual(publicados, ["estado_actualizado"]);
  assert.ok(cuenta.n <= 6, `lecturas=${cuenta.n}`);
});

test("sin nadie mirando, invalidar es perezoso (solo marca): no relee ninguna fuente; el siguiente visitante recibe lo último y dispara el recálculo", async () => {
  let mirando = true;
  const cuenta = { n: 0 };
  const { o, publicados } = crear({ secciones: [seccion("a", 60_000, cuenta), seccion("b", 60_000, cuenta)], hayNavegadores: () => mirando, ahora: () => 1_000 });
  await o.obtener();
  const base = cuenta.n;
  mirando = false;
  // la última consulta fue en t=1000 = ahora: para que cuente como «sin interés» se usa un reloj adelantado
  const { o: o2 } = crear({ secciones: [seccion("a", 60_000, cuenta)], hayNavegadores: () => false, ahora: (() => { let t = 0; return () => (t += 20 * 60_000); })() });
  await o2.obtener();
  const n0 = cuenta.n;
  for (let i = 0; i < 25; i++) o2.invalidar();
  await esperar(30);
  assert.equal(cuenta.n, n0, "ninguna lectura por las 25 invalidaciones");
  assert.equal(publicados.length, 0);
  assert.ok(base >= 2);
  const e = await o2.obtener();
  assert.equal(e.refrescando, true, "el visitante recibe lo último marcado como refrescando");
  await esperar(30);
  assert.equal(cuenta.n, n0 + 1, "y ese primer visitante dispara UN recálculo");
});

test("el mantenimiento sin espectadores no toca los conteos pesados; con espectadores sí", async () => {
  let mirando = false;
  const conteos = conteosFalsos();
  conteos.llamadas.necesita = true;
  let t = 0;
  const { o } = crear({ secciones: [seccion("a", 60_000, { n: 0 })], conteos, hayNavegadores: () => mirando, ahora: () => t });
  await o.obtener();
  conteos.llamadas.refrescar.length = 0;
  t = 60 * 60_000; // la consulta queda fuera de la ventana de interés
  o.mantener();
  assert.equal(conteos.llamadas.refrescar.length, 0);
  mirando = true;
  o.mantener();
  assert.equal(conteos.llamadas.refrescar.length, 1);
});

test("expone actualizadoEn (recálculo más reciente) además de la antigüedad del dato más antiguo", async () => {
  let t = 1_000;
  const { o } = crear({ secciones: [seccion("a", 60_000, { n: 0 }), seccion("b", 60_000, { n: 0 })], ahora: () => t });
  await o.obtener();
  t = 9_000;
  o.invalidar(["b"]); await esperar(20);
  const e = await o.obtener();
  assert.equal(e.obtenidoEn, 1_000);
  assert.equal(e.actualizadoEn, 9_000);
});

test("el mantenimiento recalcula lo vencido solo si hay quien mire; sin nadie, solo lo que supera 5 min", async () => {
  let t = 0, navegadores = false;
  const cuenta = { n: 0 };
  const conteos = conteosFalsos();
  const { o } = crear({ secciones: [seccion("a", 30_000, cuenta)], conteos, hayNavegadores: () => navegadores, ahora: () => t });
  await o.obtener(); // n=1, ultimaConsultaEn=0 → sin interés hasta que pase la ventana
  t = 20 * 60_000; // la última consulta quedó fuera de la ventana de 10 min
  o.mantener(); await esperar(10);
  assert.equal(cuenta.n, 2, "sin espectadores pero con la lectura de más de 5 min: se refresca (para el primer visitante)");
  t += 60_000;
  o.mantener(); await esperar(10);
  assert.equal(cuenta.n, 2, "sin espectadores y con un dato de 1 min: no gasta cuota");
  navegadores = true;
  t += 40_000;
  o.mantener(); await esperar(10);
  assert.equal(cuenta.n, 3, "con un navegador conectado se mantiene fresco (TTL 30 s)");
  conteos.llamadas.necesita = true;
  o.mantener();
  assert.equal(conteos.llamadas.refrescar.length, 1, "los conteos pesados siguen su ritmo de 15 min con o sin espectadores");
});

test("precalentar deja todas las secciones listas para el primer visitante y pide los conteos", async () => {
  const cuenta = { n: 0 };
  const conteos = conteosFalsos();
  const { o } = crear({ secciones: [seccion("a", 60_000, cuenta), seccion("b", 60_000, cuenta)], conteos });
  await o.precalentar();
  assert.equal(cuenta.n, 2);
  const inicio = Date.now();
  await o.obtener();
  assert.equal(cuenta.n, 2, "la primera lectura real no recalcula");
  assert.ok(Date.now() - inicio < 50);
  assert.equal(conteos.llamadas.refrescar.length, 1);
});

test("una lectura del panel arranca el cálculo de los conteos pesados si nunca se hizo o están caducados, sin esperar por él", async () => {
  const conteos = conteosFalsos();
  conteos.llamadas.necesita = true;
  const { o } = crear({ secciones: [seccion("a", 60_000, { n: 0 })], conteos });
  const inicio = Date.now();
  await o.obtener();
  assert.ok(Date.now() - inicio < 100);
  assert.equal(conteos.llamadas.refrescar.length, 1);
  conteos.llamadas.necesita = false;
  await o.obtener();
  assert.equal(conteos.llamadas.refrescar.length, 1, "vigentes: no se repite");
});

test("los conteos en curso o conservados se reflejan en refrescando", async () => {
  const { o } = crear({ secciones: [seccion("a", 60_000, { n: 0 })], conteos: conteosFalsos({ refrescando: true }) });
  assert.equal((await o.obtener()).refrescando, true);
});

test("el diagnóstico para /health da la antigüedad de cada sección sin exponer datos de negocio", async () => {
  const { o } = crear({ secciones: [seccion("cashflow", 60_000, { n: 0 })] });
  await o.obtener();
  const d = o.diagnostico();
  assert.equal(d.secciones.cashflow.refrescando, false);
  assert.ok((d.secciones.cashflow.edadSegundos ?? 99) <= 1);
  assert.equal(d.conteosPesados.edadSegundos, 90);
  assert.doesNotMatch(JSON.stringify(d), /"v":|datos/);
});
