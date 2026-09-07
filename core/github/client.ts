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

  const repoResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}`);
  if (!repoResp.ok) {
    resultado.error = `No se pudo autenticar / acceder al repo (HTTP ${repoResp.status}).`;
    return resultado;
  }
  resultado.auth = true;
  const repoData = (await repoResp.json()) as { full_name: string; default_branch: string };
  resultado.repo = repoData.full_name;
  resultado.defaultBranch = repoData.default_branch;

  const contentsResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/package.json`);
  resultado.contentsRead = contentsResp.ok;

  const refResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${repoData.default_branch}`);
  if (refResp.ok) {
    const refData = (await refResp.json()) as { object: { sha: string } };
    const ramaPrueba = `wobi-verificacion-token-${Date.now()}`;
    const crearResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${ramaPrueba}`, sha: refData.object.sha }),
    });
    resultado.contentsWrite = crearResp.ok;
    if (crearResp.ok) {
      await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/git/refs/heads/${ramaPrueba}`, { method: "DELETE" }).catch(() => undefined);
    }
  }

  const pullsResp = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open&per_page=1`);
  resultado.pullsRead = pullsResp.ok;

  return resultado;
}
