import { esRutaSegura } from "./rutasSeguras";

const GITHUB_API_BASE = "https://api.github.com";
const REPO_OWNER = "gorawgroup-sketch";
const REPO_NAME = "wobagroup-assistant";

function token(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error("GITHUB_TOKEN no configurado en el servidor.");
  return t;
}

async function githubFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
}

/** Borra una rama sin propagar el error — se usa siempre en limpieza best-effort (nunca es la causa raíz de un fallo). */
async function borrarRamaSilenciosamente(rama: string): Promise<void> {
  await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/refs/heads/${rama}`, { method: "DELETE" }).catch(() => undefined);
}

/** SHA del último commit de la rama por defecto (main) — punto de partida para leer y para crear ramas nuevas. */
async function obtenerShaRamaDefault(): Promise<{ sha: string; ramaDefault: string }> {
  const repoResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}`);
  if (!repoResp.ok) throw new Error(`No se pudo leer el repo (HTTP ${repoResp.status}).`);
  const repoData = (await repoResp.json()) as { default_branch: string };

  const refResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${repoData.default_branch}`);
  if (!refResp.ok) throw new Error(`No se pudo leer la rama por defecto (HTTP ${refResp.status}).`);
  const refData = (await refResp.json()) as { object: { sha: string } };

  return { sha: refData.object.sha, ramaDefault: repoData.default_branch };
}

interface ResultadoVerificacionToken {
  auth: boolean;
  repo?: string;
  defaultBranch?: string;
  contentsRead: boolean;
  contentsWrite: boolean;
  pullsRead: boolean;
  error?: string;
}

/**
 * Diagnóstico de una sola vez para confirmar que GITHUB_TOKEN (recién creado
 * por Carlos, fine-grained, acotado solo a este repo) sirve de verdad para lo
 * que necesitará la autorrevisión nocturna: leer código, y poder escribir una
 * rama/PR (nunca directo a main). No modifica nada permanente — la prueba de
 * escritura crea una rama de prueba apuntando al mismo commit que ya existe
 * (sin archivos ni commits nuevos) y la borra en el mismo diagnóstico.
 */
export async function verificarGithubToken(): Promise<ResultadoVerificacionToken> {
  const resultado: ResultadoVerificacionToken = {
    auth: false,
    contentsRead: false,
    contentsWrite: false,
    pullsRead: false,
  };

  let base: { sha: string; ramaDefault: string };
  try {
    base = await obtenerShaRamaDefault();
  } catch (error) {
    resultado.error = error instanceof Error ? error.message : String(error);
    return resultado;
  }
  resultado.auth = true;
  resultado.repo = `${REPO_OWNER}/${REPO_NAME}`;
  resultado.defaultBranch = base.ramaDefault;

  const contentsResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/package.json`);
  resultado.contentsRead = contentsResp.ok;

  const ramaPrueba = `wobi-verificacion-token-${Date.now()}`;
  const crearResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${ramaPrueba}`, sha: base.sha }),
  });
  resultado.contentsWrite = crearResp.ok;
  if (crearResp.ok) await borrarRamaSilenciosamente(ramaPrueba);

  const pullsResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open&per_page=1`);
  resultado.pullsRead = pullsResp.ok;

  return resultado;
}

interface ArchivoLeido {
  contenido: string;
  sha: string;
}

/**
 * Árbol completo de archivos .ts del repo (main), excluyendo node_modules,
 * dist, el frontend separado (frontend-cerebro/), y todo lo que no esté en
 * la lista blanca de rutas seguras (ver rutasSeguras.ts) — el universo de
 * candidatos para la autorrevisión.
 */
export async function listarArchivosTsRepo(): Promise<string[]> {
  const { sha } = await obtenerShaRamaDefault();
  const treeResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${sha}?recursive=1`);
  if (!treeResp.ok) throw new Error(`No se pudo leer el árbol de archivos (HTTP ${treeResp.status}).`);
  const treeData = (await treeResp.json()) as { tree: { path: string; type: string }[]; truncated: boolean };

  if (treeData.truncated) {
    console.error("[github/client] El árbol de archivos vino truncado por la API de GitHub — la cobertura de la autorrevisión de esta noche puede ser incompleta.");
  }

  return treeData.tree
    .filter((n) => n.type === "blob" && n.path.endsWith(".ts"))
    .map((n) => n.path)
    .filter((ruta) => !ruta.startsWith("node_modules/") && !ruta.startsWith("dist/") && !ruta.startsWith("frontend-cerebro/"))
    .filter((ruta) => esRutaSegura(ruta));
}

/** Contenido y sha (necesario para actualizar el archivo después) de un archivo en main. */
export async function leerArchivoRepo(ruta: string): Promise<ArchivoLeido | undefined> {
  const resp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${ruta}`);
  if (!resp.ok) return undefined;
  const data = (await resp.json()) as { content?: string; encoding?: string; sha: string };
  // La API de GitHub omite "content" para archivos sin contenido inline (ej. mayores a 1MB) — no
  // debería pasar con el código de este repo, pero se evita un throw en vez de un "no encontrado" limpio.
  if (!data.content) return undefined;
  const contenido = Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf-8").toString("utf-8");
  return { contenido, sha: data.sha };
}

/**
 * Crea una rama nueva desde main, sube en ella la corrección de un solo
 * archivo, y abre el Pull Request — nunca escribe directo a main. Devuelve
 * el número y la URL del PR para que la aprobación por Telegram lo
 * referencie. shaArchivoEnMain es el sha devuelto por leerArchivoRepo,
 * requerido por la API de GitHub para confirmar que se está reemplazando
 * el contenido que de verdad se leyó (evita pisar un cambio manual
 * concurrente sin darse cuenta).
 */
export async function proponerCorreccionComoPR(params: {
  ruta: string;
  shaArchivoEnMain: string;
  contenidoNuevo: string;
  mensajeCommit: string;
  tituloPR: string;
  cuerpoPR: string;
}): Promise<{ numero: number; url: string; rama: string }> {
  const { sha: shaBase, ramaDefault } = await obtenerShaRamaDefault();
  const rama = `wobi-autorrepair-${Date.now()}`;

  const crearRamaResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${rama}`, sha: shaBase }),
  });
  if (!crearRamaResp.ok) throw new Error(`No se pudo crear la rama (HTTP ${crearRamaResp.status}).`);

  const commitResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${params.ruta}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: params.mensajeCommit,
      content: Buffer.from(params.contenidoNuevo, "utf-8").toString("base64"),
      sha: params.shaArchivoEnMain,
      branch: rama,
    }),
  });
  if (!commitResp.ok) {
    // Limpieza best-effort: no dejar una rama huérfana sin commit si el PUT falló.
    await borrarRamaSilenciosamente(rama);
    throw new Error(`No se pudo subir el cambio a la rama (HTTP ${commitResp.status}).`);
  }

  const prResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: params.tituloPR, body: params.cuerpoPR, head: rama, base: ramaDefault }),
  });
  if (!prResp.ok) {
    await borrarRamaSilenciosamente(rama);
    throw new Error(`No se pudo abrir el Pull Request (HTTP ${prResp.status}).`);
  }
  const prData = (await prResp.json()) as { number: number; html_url: string };

  return { numero: prData.number, url: prData.html_url, rama };
}

/**
 * Abre un PR para una rama que ya fue creada y subida por la sesión aislada de Development.
 * El token del runner de GitHub Actions NO recibe permiso global para aprobar PRs: el runner solo
 * puede empujar la rama, y WOBI abre el PR con su token fine-grained ya acotado a este repositorio.
 *
 * La rama debe pertenecer inequívocamente al issue indicado. Esto evita que el webhook autenticado
 * pueda usarse para abrir un PR de una rama arbitraria o ajena a la sesión que lo originó.
 */
export async function abrirPullRequestAutofixDesdeRama(params: {
  issueNumero: number;
  rama: string;
  titulo: string;
  cuerpo: string;
}): Promise<{ numero: number; url: string; rama: string; existente: boolean }> {
  if (!Number.isInteger(params.issueNumero) || params.issueNumero <= 0) {
    throw new Error("Número de issue inválido para abrir el Pull Request de Development.");
  }

  const prefijo = `wobi-autofix/issue-${params.issueNumero}-`;
  const sufijo = params.rama.slice(prefijo.length);
  if (!params.rama.startsWith(prefijo) || !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(sufijo)) {
    throw new Error(`Rama de Development inválida: debe comenzar por ${prefijo}.`);
  }

  const titulo = params.titulo.trim();
  const cuerpo = params.cuerpo.trim();
  if (!titulo || titulo.length > 256 || !cuerpo) {
    throw new Error("Título o cuerpo inválido para el Pull Request de Development.");
  }

  const head = `${REPO_OWNER}:${params.rama}`;
  const existentesResp = await githubFetch(
    `/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=1`
  );
  if (!existentesResp.ok) {
    throw new Error(`No se pudo verificar si la rama ya tenía un Pull Request (HTTP ${existentesResp.status}).`);
  }
  const existentes = (await existentesResp.json()) as { number: number; html_url: string }[];
  const existente = existentes[0];
  if (existente) {
    return { numero: existente.number, url: existente.html_url, rama: params.rama, existente: true };
  }

  const { ramaDefault } = await obtenerShaRamaDefault();
  const prResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: titulo, body: cuerpo, head: params.rama, base: ramaDefault }),
  });
  if (!prResp.ok) {
    const detalle = await prResp.text().catch(() => "");
    // La rama contiene trabajo ya verificado: nunca borrarla si abrir el PR falla. Así se puede
    // reintentar sin volver a gastar otra sesión de IA.
    throw new Error(`No se pudo abrir el Pull Request de Development (HTTP ${prResp.status}). ${detalle}`.trim());
  }
  const prData = (await prResp.json()) as { number: number; html_url: string };
  return { numero: prData.number, url: prData.html_url, rama: params.rama, existente: false };
}

/**
 * Sincroniza la rama del PR con main antes de habilitar la aprobación. GitHub responde 422 tanto
 * para algunos errores como cuando la rama ya está al día; solo este último mensaje se considera
 * éxito. Cualquier otra respuesta falla cerrada y evita mostrar un botón de despliegue prematuro.
 */
export async function actualizarRamaPullRequest(numero: number): Promise<"actualizada" | "ya_actualizada"> {
  if (!Number.isInteger(numero) || numero <= 0) throw new Error("Número de Pull Request inválido.");

  const resp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${numero}/update-branch`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (resp.ok) return "actualizada";

  const detalle = await resp.text().catch(() => "");
  if (resp.status === 422 && /not behind|already up[ -]to[ -]date|no está detrás|ya está actualizada/i.test(detalle)) {
    return "ya_actualizada";
  }
  throw new Error(`No se pudo sincronizar la rama del Pull Request #${numero} (HTTP ${resp.status}). ${detalle}`.trim());
}

/** Aprobación desde Telegram: fusiona el PR a main (dispara el redeploy de Railway) y borra la rama. */
export async function fusionarPullRequest(numero: number, rama: string): Promise<boolean> {
  const mergeResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${numero}/merge`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merge_method: "squash" }),
  });
  if (!mergeResp.ok) return false;

  await borrarRamaSilenciosamente(rama);
  return true;
}

const CONFIG_ETIQUETAS_DEVELOPMENT: Record<string, { color: string; description: string }> = {
  "wobi-auto-fix": {
    color: "1d76db",
    description: "Inicia una sesión aislada de Claude Code para investigar y proponer un arreglo.",
  },
  urgente: {
    color: "d73a4a",
    description: "Incidencia operativa urgente reportada desde WOBI.",
  },
};

function nombresEtiquetas(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => (typeof label === "string" ? label : (label as { name?: unknown })?.name))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * Garantiza que la etiqueta exista ANTES de abrir el issue. GitHub puede aceptar la creación de un
 * issue y omitir silenciosamente una etiqueta inexistente; eso ocurrió en producción con el issue
 * #82: el issue sí se creó, pero `wobi-auto-fix` no quedó aplicada y el workflow se saltó entero.
 */
async function asegurarEtiquetaRepositorio(nombre: string): Promise<void> {
  const path = `/repos/${REPO_OWNER}/${REPO_NAME}/labels/${encodeURIComponent(nombre)}`;
  const existente = await githubFetch(path);
  if (existente.ok) return;
  if (existente.status !== 404) {
    throw new Error(`No se pudo verificar la etiqueta "${nombre}" (HTTP ${existente.status}).`);
  }

  const config = CONFIG_ETIQUETAS_DEVELOPMENT[nombre] ?? {
    color: "ededed",
    description: "Etiqueta creada por WOBI.",
  };
  const creada = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nombre, color: config.color, description: config.description }),
  });
  if (creada.ok) return;

  // Un 422 puede ser una carrera: otra ejecución creó la etiqueta entre el GET y el POST.
  if (creada.status === 422) {
    const relectura = await githubFetch(path);
    if (relectura.ok) return;
  }
  const detalle = await creada.text().catch(() => "");
  throw new Error(`No se pudo crear la etiqueta "${nombre}" (HTTP ${creada.status}). ${detalle}`.trim());
}

export interface IssueCreado {
  numero: number;
  url: string;
  labels: string[];
  /** Solo true cuando GitHub devolvió todas las etiquetas requeridas tras releer/aplicar. */
  labelsVerificadas: boolean;
  advertenciaLabels?: string;
}

/**
 * Crea un GitHub Issue real en el repo y verifica que las etiquetas que disparan Development hayan
 * quedado aplicadas. No toca main ni ninguna rama; la sesión de Claude Code corre después en un
 * runner aislado de GitHub Actions.
 */
export async function crearIssue(params: { titulo: string; cuerpo: string; labels?: string[] }): Promise<IssueCreado> {
  const labelsRequeridas = [...new Set((params.labels ?? []).map((label) => label.trim()).filter(Boolean))];
  for (const label of labelsRequeridas) await asegurarEtiquetaRepositorio(label);

  const resp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: params.titulo, body: params.cuerpo, labels: labelsRequeridas }),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => "");
    throw new Error(`No se pudo crear el issue (HTTP ${resp.status}). ${detalle}`.trim());
  }
  const data = (await resp.json()) as { number: number; html_url: string; labels?: unknown };
  let labelsAplicadas = nombresEtiquetas(data.labels);
  const faltantes = labelsRequeridas.filter((label) => !labelsAplicadas.includes(label));

  if (faltantes.length > 0) {
    // Aplicarlas después de crear también emite el evento `issues:labeled`, por lo que el workflow
    // arranca incluso si GitHub omitió alguna en el POST inicial.
    const aplicar = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/issues/${data.number}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: faltantes }),
    });
    if (aplicar.ok) labelsAplicadas = nombresEtiquetas(await aplicar.json());
    else {
      const detalle = await aplicar.text().catch(() => "");
      return {
        numero: data.number,
        url: data.html_url,
        labels: labelsAplicadas,
        labelsVerificadas: false,
        advertenciaLabels: `GitHub creó el issue, pero no permitió aplicar ${faltantes.join(", ")} (HTTP ${aplicar.status}). ${detalle}`.trim(),
      };
    }
  }

  const labelsVerificadas = labelsRequeridas.every((label) => labelsAplicadas.includes(label));
  return {
    numero: data.number,
    url: data.html_url,
    labels: labelsAplicadas,
    labelsVerificadas,
    ...(!labelsVerificadas
      ? { advertenciaLabels: `GitHub creó el issue, pero no confirmó las etiquetas: ${labelsRequeridas.join(", ")}.` }
      : {}),
  };
}

/** Descarte desde Telegram: cierra el PR sin fusionar y borra la rama. Devuelve false si el cierre en sí falló. */
export async function cerrarPullRequestYBorrarRama(numero: number, rama: string): Promise<boolean> {
  const cerrarResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${numero}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  }).catch(() => undefined);

  if (!cerrarResp || !cerrarResp.ok) return false;

  await borrarRamaSilenciosamente(rama);
  return true;
}
