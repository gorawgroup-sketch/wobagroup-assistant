import assert from "node:assert/strict";
import test from "node:test";
import { listProjects, matchProject, type HoldedProject } from "./client";
import { proyectosHoldedTool } from "../tools/proyectosHolded";

const projects: HoldedProject[] = [
  { id: "p-1", name: "SINFONÍA MIAMI", archived: false },
  { id: "p-2", name: "Footprint Internal", archived: false },
  { id: "p-3", name: "Proyecto duplicado", archived: false },
  { id: "p-4", name: "Proyecto duplicado", archived: false },
  { id: "p-5", name: "Antiguo", archived: true },
];

test("matchProject acepta un id único", () => {
  assert.equal(matchProject(projects, "p-2").exact?.id, "p-2");
});

test("matchProject normaliza mayúsculas y acentos para un nombre exacto", () => {
  assert.equal(matchProject(projects, "sinfonia miami").exact?.id, "p-1");
});

test("matchProject nunca convierte una coincidencia parcial en exacta", () => {
  const match = matchProject(projects, "Footprint");
  assert.equal(match.exact, undefined);
  assert.deepEqual(match.candidates.map((project) => project.id), ["p-2"]);
});

test("matchProject mantiene ambiguos los nombres duplicados", () => {
  const match = matchProject(projects, "Proyecto duplicado");
  assert.equal(match.exact, undefined);
  assert.deepEqual(match.candidates.map((project) => project.id), ["p-3", "p-4"]);
});

test("matchProject excluye archivados salvo autorización explícita", () => {
  assert.equal(matchProject(projects, "Antiguo").exact, undefined);
  assert.equal(matchProject(projects, "Antiguo", true).exact?.id, "p-5");
});

test("matchProject no casa una consulta con un proyecto de nombre demasiado corto", () => {
  const cortos: HoldedProject[] = [{ id: "c-1", name: "A", archived: false }];
  assert.deepEqual(matchProject(cortos, "Alquiler anual").candidates, []);
});

// --- Lectura contra la API (fetch simulado). Nunca toca Holded real. ---

const fetchOriginal = global.fetch;
const claveOriginal = process.env.HOLDED_API_KEY_EWORKS;

test.afterEach(() => {
  global.fetch = fetchOriginal;
  if (claveOriginal === undefined) delete process.env.HOLDED_API_KEY_EWORKS;
  else process.env.HOLDED_API_KEY_EWORKS = claveOriginal;
});

test("listProjects pagina por cursor, usa solo GET y cachea el catálogo", async () => {
  process.env.HOLDED_API_KEY_EWORKS = "clave-de-prueba";
  const llamadas: Array<{ metodo: string; ruta: string }> = [];
  global.fetch = (async (input, init) => {
    const url = new URL(String(input));
    llamadas.push({ metodo: init?.method ?? "GET", ruta: url.pathname });
    if (!url.searchParams.get("cursor")) return Response.json({ items: [{ id: "a", name: "Uno" }], has_more: true, cursor: "c2" });
    return Response.json({ items: [{ id: "b", name: "Dos" }], has_more: false, cursor: null });
  }) as typeof fetch;

  const primera = await listProjects("EWORKS", true);
  const segunda = await listProjects("EWORKS");
  assert.deepEqual(primera.map((p) => p.id), ["a", "b"]);
  assert.deepEqual(segunda.map((p) => p.id), ["a", "b"]);
  assert.equal(llamadas.length, 2, "la segunda lectura sale de la caché");
  assert.ok(llamadas.every((l) => l.metodo === "GET" && l.ruta.endsWith("/projects")));
});

test("un fallo de Holded no se convierte en un catálogo vacío", async () => {
  process.env.HOLDED_API_KEY_EWORKS = "clave-de-prueba";
  global.fetch = (async () => new Response("caído", { status: 400 })) as typeof fetch;
  await assert.rejects(listProjects("EWORKS", true), /Holded \(400\)/);
});

test("la herramienta lista, resume un proyecto y nunca afirma que no existe uno invisible", async () => {
  process.env.HOLDED_API_KEY_EWORKS = "clave-de-prueba";
  const metodos: string[] = [];
  global.fetch = (async (input, init) => {
    const url = new URL(String(input));
    metodos.push(init?.method ?? "GET");
    if (url.pathname.endsWith("/summary")) {
      assert.match(url.pathname, /\/projects\/p-9\/summary$/);
      return Response.json({
        profitability: { sales: 1000, expenses: { documents: 200, personnel: 100, total: 300 }, profit: 700 },
        economicStatus: { quoted: 1500, billed: 1000, collected: 400, remaining: 600 },
        projectEvolution: { tasks: { total: 10, completed: 4 } },
      });
    }
    return Response.json({
      items: [
        { id: "p-9", name: "Sinfonía Miami", contact_name: "Cliente SA", billable: true },
        { id: "p-8", name: "Antiguo", archived: true },
      ],
      has_more: false,
    });
  }) as typeof fetch;
  await listProjects("EWORKS", true);

  const listado = await proyectosHoldedTool.handler({ empresa: "EWORKS" });
  assert.match(listado, /1 proyecto\(s\) activos/);
  assert.doesNotMatch(listado, /Antiguo/);

  const informe = await proyectosHoldedTool.handler({ empresa: "EWORKS", proyecto: "sinfonia miami" });
  assert.match(informe, /Proyecto: Sinfonía Miami/);
  assert.match(informe, /Beneficio: 700,00/);
  assert.match(informe, /Tareas: 4\/10/);

  const ausente = await proyectosHoldedTool.handler({ empresa: "EWORKS", proyecto: "Proyecto fantasma" });
  assert.match(ausente, /No afirmo que no exista/);

  assert.ok(metodos.every((m) => m === "GET"), "la capacidad es solo lectura");
});

test("la herramienta rechaza una empresa desconocida y está marcada como lectura segura", async () => {
  assert.match(await proyectosHoldedTool.handler({ empresa: "OTRA" }), /^Error/);
  assert.equal(proyectosHoldedTool.seguraParaModoRapido, true);
});
