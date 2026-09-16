import test from "node:test";
import assert from "node:assert/strict";
import { abrirPullRequestAutofixDesdeRama, crearIssue } from "./client";

type Llamada = { url: string; method: string; body?: unknown };

function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("crearIssue crea y verifica la etiqueta de autofix antes de afirmar que Development arrancará", async () => {
  const fetchOriginal = globalThis.fetch;
  const tokenOriginal = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "token-prueba";
  const llamadas: Llamada[] = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    llamadas.push({ url, method, body });

    if (url.endsWith("/labels/wobi-auto-fix") && method === "GET") return respuesta(404, {});
    if (url.endsWith("/issues/82/labels") && method === "POST") {
      return respuesta(200, [{ name: "wobi-auto-fix" }]);
    }
    if (url.endsWith("/labels") && method === "POST") return respuesta(201, { name: "wobi-auto-fix" });
    if (url.endsWith("/issues") && method === "POST") {
      // Reproduce el fallo real de #82: GitHub crea el issue pero omite la etiqueta en la respuesta.
      return respuesta(201, { number: 82, html_url: "https://github.test/issues/82", labels: [] });
    }
    return respuesta(500, { unexpected: { url, method } });
  };

  try {
    const issue = await crearIssue({ titulo: "Prueba", cuerpo: "Caso real", labels: ["wobi-auto-fix"] });
    assert.equal(issue.numero, 82);
    assert.equal(issue.labelsVerificadas, true);
    assert.deepEqual(issue.labels, ["wobi-auto-fix"]);
    assert.deepEqual(
      llamadas.map(({ method, url }) => `${method} ${new URL(url).pathname}`),
      [
        "GET /repos/gorawgroup-sketch/wobagroup-assistant/labels/wobi-auto-fix",
        "POST /repos/gorawgroup-sketch/wobagroup-assistant/labels",
        "POST /repos/gorawgroup-sketch/wobagroup-assistant/issues",
        "POST /repos/gorawgroup-sketch/wobagroup-assistant/issues/82/labels",
      ]
    );
  } finally {
    globalThis.fetch = fetchOriginal;
    if (tokenOriginal === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = tokenOriginal;
  }
});

test("crearIssue no abre un issue si no puede asegurar previamente la etiqueta que inicia Development", async () => {
  const fetchOriginal = globalThis.fetch;
  const tokenOriginal = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "token-prueba";
  let intentoCrearIssue = false;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url.endsWith("/issues") && method === "POST") intentoCrearIssue = true;
    return respuesta(403, { message: "Forbidden" });
  };

  try {
    await assert.rejects(
      crearIssue({ titulo: "Prueba", cuerpo: "Caso real", labels: ["wobi-auto-fix"] }),
      /No se pudo verificar la etiqueta/
    );
    assert.equal(intentoCrearIssue, false);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (tokenOriginal === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = tokenOriginal;
  }
});

test("abrirPullRequestAutofixDesdeRama solo abre el PR de la rama exacta del issue", async () => {
  const fetchOriginal = globalThis.fetch;
  const tokenOriginal = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "token-prueba";
  const llamadas: Llamada[] = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    llamadas.push({ url, method, body });

    if (url.includes("/pulls?state=open&")) return respuesta(200, []);
    if (url.endsWith("/wobagroup-assistant") && method === "GET") return respuesta(200, { default_branch: "main" });
    if (url.endsWith("/git/ref/heads/main")) return respuesta(200, { object: { sha: "abc123" } });
    if (url.endsWith("/pulls") && method === "POST") {
      return respuesta(201, { number: 90, html_url: "https://github.test/pull/90" });
    }
    return respuesta(500, { unexpected: { url, method } });
  };

  try {
    const pr = await abrirPullRequestAutofixDesdeRama({
      issueNumero: 82,
      rama: "wobi-autofix/issue-82-descartar-pendiente",
      titulo: "Permite descartar el pendiente",
      cuerpo: "Fixes #82",
    });
    assert.deepEqual(pr, {
      numero: 90,
      url: "https://github.test/pull/90",
      rama: "wobi-autofix/issue-82-descartar-pendiente",
      existente: false,
    });
    assert.deepEqual(llamadas.at(-1)?.body, {
      title: "Permite descartar el pendiente",
      body: "Fixes #82",
      head: "wobi-autofix/issue-82-descartar-pendiente",
      base: "main",
    });
  } finally {
    globalThis.fetch = fetchOriginal;
    if (tokenOriginal === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = tokenOriginal;
  }
});

test("abrirPullRequestAutofixDesdeRama rechaza ramas ajenas antes de llamar a GitHub", async () => {
  const fetchOriginal = globalThis.fetch;
  const tokenOriginal = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "token-prueba";
  let llamadas = 0;
  globalThis.fetch = async () => {
    llamadas += 1;
    return respuesta(500, {});
  };

  try {
    await assert.rejects(
      abrirPullRequestAutofixDesdeRama({
        issueNumero: 82,
        rama: "main",
        titulo: "No permitido",
        cuerpo: "Fixes #82",
      }),
      /Rama de Development inválida/
    );
    assert.equal(llamadas, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (tokenOriginal === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = tokenOriginal;
  }
});

test("abrirPullRequestAutofixDesdeRama reutiliza un PR abierto en reintentos", async () => {
  const fetchOriginal = globalThis.fetch;
  const tokenOriginal = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "token-prueba";
  let posts = 0;

  globalThis.fetch = async (input, init = {}) => {
    if ((init.method ?? "GET") === "POST") posts += 1;
    const url = String(input);
    if (url.includes("/pulls?state=open&")) {
      return respuesta(200, [{ number: 91, html_url: "https://github.test/pull/91" }]);
    }
    return respuesta(500, {});
  };

  try {
    const pr = await abrirPullRequestAutofixDesdeRama({
      issueNumero: 82,
      rama: "wobi-autofix/issue-82-descartar-pendiente",
      titulo: "Permite descartar el pendiente",
      cuerpo: "Fixes #82",
    });
    assert.equal(pr.numero, 91);
    assert.equal(pr.existente, true);
    assert.equal(posts, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (tokenOriginal === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = tokenOriginal;
  }
});
