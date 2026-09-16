import test from "node:test";
import assert from "node:assert/strict";
import { crearIssue } from "./client";

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
