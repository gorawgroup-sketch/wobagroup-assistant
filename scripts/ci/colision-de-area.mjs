// Guardarraíl «dueño único por área» (Carlos, 08-10-2026): dos PR abiertos no pueden tocar a la vez una misma área crítica.
// El PR más antiguo tiene prioridad; el nuevo no pasa hasta que el antiguo se fusione o se cierre, salvo etiqueta
// `colision-aceptada` (decisión explícita de Carlos). Lógica pura exportada para probarla sin GitHub.
import { readFileSync } from "node:fs";

export function areaDe(ruta, areas) {
  for (const [nombre, prefijos] of Object.entries(areas)) {
    if (prefijos.some((p) => (p.endsWith("/") ? ruta.startsWith(p) : ruta === p))) return nombre;
  }
  return undefined;
}

export function areasTocadas(rutas, areas) {
  return new Set(rutas.map((r) => areaDe(r, areas)).filter(Boolean));
}

/** Devuelve las colisiones de `actual` con PR abiertos MÁS ANTIGUOS (número menor). */
export function colisiones(actual, abiertos, areas) {
  const mias = areasTocadas(actual.archivos, areas);
  if (mias.size === 0) return [];
  const resultado = [];
  for (const otro of abiertos) {
    if (otro.numero >= actual.numero || otro.borrador) continue;
    const comunes = [...areasTocadas(otro.archivos, areas)].filter((a) => mias.has(a));
    if (comunes.length) resultado.push({ numero: otro.numero, titulo: otro.titulo, areas: comunes });
  }
  return resultado;
}

async function github(ruta, token) {
  const r = await fetch(`https://api.github.com${ruta}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(`GitHub ${r.status} en ${ruta}`);
  return r.json();
}

async function archivosDe(repo, numero, token) {
  const archivos = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const lote = await github(`/repos/${repo}/pulls/${numero}/files?per_page=100&page=${pagina}`, token);
    archivos.push(...lote.map((f) => f.filename));
    if (lote.length < 100) break;
  }
  return archivos;
}

export async function main(env = process.env) {
  const { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token, PR_NUMBER } = env;
  const numero = Number(PR_NUMBER);
  if (!repo || !token || !numero) { console.log("[colision-de-area] Sin PR (push a main u otro evento): nada que comprobar."); return 0; }
  const { areas } = JSON.parse(readFileSync(new URL("../../.github/areas-criticas.json", import.meta.url), "utf8"));
  let actual, abiertos;
  try {
    const pr = await github(`/repos/${repo}/pulls/${numero}`, token);
    if ((pr.labels ?? []).some((l) => l.name === "colision-aceptada")) { console.log("[colision-de-area] Etiqueta colision-aceptada: Carlos aceptó la colisión."); return 0; }
    actual = { numero, archivos: await archivosDe(repo, numero, token) };
    const lista = await github(`/repos/${repo}/pulls?state=open&per_page=100`, token);
    abiertos = [];
    for (const p of lista) {
      if (p.number === numero) continue;
      abiertos.push({ numero: p.number, titulo: p.title, borrador: Boolean(p.draft), archivos: await archivosDe(repo, p.number, token) });
    }
  } catch (error) {
    // Un fallo de la API de GitHub no debe parar el CI del repo entero: se avisa en claro y se deja pasar.
    console.log(`::warning::[colision-de-area] No se pudo comprobar la colisión (${error instanceof Error ? error.message : error}); se deja pasar.`);
    return 0;
  }
  const choques = colisiones(actual, abiertos, areas);
  if (choques.length === 0) { console.log(`[colision-de-area] Sin colisión: áreas tocadas ${[...areasTocadas(actual.archivos, areas)].join(", ") || "(ninguna crítica)"}.`); return 0; }
  for (const c of choques) {
    console.log(`::error::Colisión de área con el PR #${c.numero} «${c.titulo}» (${c.areas.join(", ")}). Regla: un dueño por área; espera a que ese PR se fusione o se cierre, coordina con esa sesión, o pide a Carlos la etiqueta colision-aceptada.`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().then((codigo) => process.exit(codigo)).catch((e) => { console.log(`::warning::[colision-de-area] ${e.message}; se deja pasar.`); process.exit(0); });
}
