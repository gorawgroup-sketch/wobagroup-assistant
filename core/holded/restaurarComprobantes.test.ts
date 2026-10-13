import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { MANIFIESTO_RESTAURACION, restaurarComprobante, type DepsRestauracion, type EntradaRestauracion } from "./restaurarComprobantes";
import { crearRouterRestaurarComprobantes } from "./restaurarComprobantesRouter";

/**
 * Reposición de comprobantes rescatados: solo el manifiesto, solo sobre compras sin adjuntos, solo el archivo exacto, una sola vez por intento.
 */
const BYTES = Buffer.from("contenido-del-comprobante-rescatado");
const ENTRADA: EntradaRestauracion = {
  empresa: "Footprint", purchaseId: "a".repeat(24), etiqueta: "Proveedor 7,60 EUR (2026-09-09)", driveFileId: "drive-1", nombreArchivo: "FTG_x.jpg",
  mimeType: "image/jpeg", bytes: BYTES.length, sha256: createHash("sha256").update(BYTES).digest("hex"),
};
const MANIFIESTO = [ENTRADA] as const;

function montar(opciones: { adjuntos?: number | Error; adjuntosTrasSubir?: number; bytesDrive?: Buffer; errorAdjuntar?: Error } = {}) {
  const llamadas = { contar: 0, descargar: 0, adjuntar: [] as Array<{ clave: string; nombre: string; mime: string; bytes: number }> };
  let subido = false;
  const deps: DepsRestauracion = {
    contarAdjuntos: async () => {
      llamadas.contar++;
      if (subido) return opciones.adjuntosTrasSubir ?? 1;
      const v = opciones.adjuntos ?? 0; if (v instanceof Error) throw v; return v;
    },
    descargarDeDrive: async () => { llamadas.descargar++; return { bytes: opciones.bytesDrive ?? BYTES }; },
    adjuntar: async (_e, _id, archivo, clave) => {
      if (opciones.errorAdjuntar) throw opciones.errorAdjuntar;
      llamadas.adjuntar.push({ clave, nombre: archivo.nombreArchivo, mime: archivo.mimeType, bytes: archivo.bytes.length }); subido = true; return { attachmentId: "adj-1" };
    },
  };
  return { deps, llamadas };
}

test("compra SIN adjuntos y archivo exacto: sube una vez con clave idempotente y verifica que queda 1", async () => {
  const m = montar();
  const r = await restaurarComprobante(ENTRADA.purchaseId, m.deps, "1", MANIFIESTO);
  assert.equal(r.estado, "restaurado");
  if (r.estado === "restaurado") { assert.equal(r.adjuntosDespues, 1); assert.equal(r.verificado, true); assert.equal(r.attachmentId, "adj-1"); }
  assert.equal(m.llamadas.adjuntar.length, 1);
  assert.deepEqual([m.llamadas.adjuntar[0].nombre, m.llamadas.adjuntar[0].mime, m.llamadas.adjuntar[0].bytes], ["FTG_x.jpg", "image/jpeg", BYTES.length]);
  assert.match(m.llamadas.adjuntar[0].clave, /^restaurar-comprobante:a{24}:[0-9a-f]{16}:1$/);
});

test("si la compra YA tiene adjuntos NO se sube otro (no puede crear un duplicado) y ni siquiera se descarga el archivo", async () => {
  for (const n of [1, 2, 32768]) {
    const m = montar({ adjuntos: n });
    const r = await restaurarComprobante(ENTRADA.purchaseId, m.deps, "1", MANIFIESTO);
    assert.equal(r.estado, "rechazado"); assert.equal(r.estado === "rechazado" && r.motivo, "ya_tiene_adjuntos"); assert.equal(r.estado === "rechazado" && r.adjuntos, n);
    assert.equal(m.llamadas.adjuntar.length, 0); assert.equal(m.llamadas.descargar, 0);
  }
});

test("una lectura de adjuntos fallida NO se toma por «sin adjuntos»: no se sube nada", async () => {
  const m = montar({ adjuntos: new Error("Holded 503") });
  const r = await restaurarComprobante(ENTRADA.purchaseId, m.deps, "1", MANIFIESTO);
  assert.equal(r.estado === "rechazado" && r.motivo, "adjuntos_ilegibles"); assert.equal(m.llamadas.adjuntar.length, 0);
});

test("si el archivo de Drive no es EXACTAMENTE el rescatado (huella o tamaño) no se sube", async () => {
  for (const bytes of [Buffer.from("otro contenido"), Buffer.concat([BYTES, Buffer.from("x")]), Buffer.alloc(0)]) {
    const m = montar({ bytesDrive: bytes });
    const r = await restaurarComprobante(ENTRADA.purchaseId, m.deps, "1", MANIFIESTO);
    assert.equal(r.estado === "rechazado" && r.motivo, "archivo_de_drive_distinto"); assert.equal(m.llamadas.adjuntar.length, 0);
  }
});

test("solo compras del manifiesto: cualquier otra se rechaza sin tocar Holded ni Drive", async () => {
  const m = montar();
  const r = await restaurarComprobante("b".repeat(24), m.deps, "1", MANIFIESTO);
  assert.equal(r.estado === "rechazado" && r.motivo, "no_esta_en_el_manifiesto");
  assert.equal(m.llamadas.contar, 0); assert.equal(m.llamadas.descargar, 0); assert.equal(m.llamadas.adjuntar.length, 0);
});

test("un fallo al adjuntar se propaga (no se da por hecho) y el intento forma parte de la clave", async () => {
  const m = montar({ errorAdjuntar: new Error("subida incierta") });
  await assert.rejects(() => restaurarComprobante(ENTRADA.purchaseId, m.deps, "1", MANIFIESTO), /subida incierta/);
  const m2 = montar(); await restaurarComprobante(ENTRADA.purchaseId, m2.deps, "2", MANIFIESTO);
  assert.match(m2.llamadas.adjuntar[0].clave, /:2$/);
});

test("si tras subir quedan ≠1 adjuntos se informa como NO verificado (nunca se afirma que quedó bien)", async () => {
  const m = montar({ adjuntosTrasSubir: 2 });
  const r = await restaurarComprobante(ENTRADA.purchaseId, m.deps, "1", MANIFIESTO);
  assert.equal(r.estado === "restaurado" && r.verificado, false);
});

test("el manifiesto real: 10 compras de Footprint, ids y huellas bien formados, sin repetidos", () => {
  assert.equal(MANIFIESTO_RESTAURACION.length, 10);
  assert.equal(new Set(MANIFIESTO_RESTAURACION.map((e) => e.purchaseId)).size, 10);
  assert.equal(new Set(MANIFIESTO_RESTAURACION.map((e) => e.driveFileId)).size, 10);
  for (const e of MANIFIESTO_RESTAURACION) {
    assert.equal(e.empresa, "Footprint"); assert.match(e.purchaseId, /^[a-f0-9]{24}$/); assert.match(e.sha256, /^[a-f0-9]{64}$/);
    assert.ok(e.bytes > 0 && e.bytes < 25 * 1024 * 1024); assert.match(e.mimeType, /^(image\/jpeg|application\/pdf)$/);
  }
});

/* ───────── router ───────── */

async function conRouter(secreto: string | undefined, m: ReturnType<typeof montar>, escenario: (url: string) => Promise<void>) {
  const app = express(); app.use(express.json());
  app.use("/r", crearRouterRestaurarComprobantes({ secreto: () => secreto, deps: m.deps, manifiesto: MANIFIESTO }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const dir = server.address(); assert.ok(dir && typeof dir !== "string");
  try { await escenario(`http://127.0.0.1:${dir.port}/r`); } finally { server.closeAllConnections(); server.close(); }
}
const cab = (secreto?: string) => ({ "Content-Type": "application/json", ...(secreto ? { "x-admin-secret": secreto } : {}) });

test("router: sin secreto configurado 503; sin cabecera o con otro secreto 403 (el secreto no viaja por la URL)", async () => {
  const m = montar();
  await conRouter(undefined, m, async (url) => assert.equal((await fetch(url, { headers: cab("x") })).status, 503));
  await conRouter("secreto-bueno", m, async (url) => {
    for (const h of [cab(), cab("malo"), cab("secreto-bueno-mas-largo")]) {
      assert.equal((await fetch(url, { headers: h })).status, 403);
      assert.equal((await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ purchaseId: ENTRADA.purchaseId }) })).status, 403);
    }
    assert.equal((await fetch(`${url}?secret=secreto-bueno`)).status, 403);
  });
  assert.equal(m.llamadas.adjuntar.length, 0);
});

test("router: GET lista el estado de cada comprobante; POST valida la entrada y devuelve 200/409/404 según el resultado", async () => {
  const m = montar({ adjuntos: 0 });
  await conRouter("s", m, async (url) => {
    const g = await (await fetch(url, { headers: cab("s") })).json() as { comprobantes: Array<{ estado: string; adjuntos: number }> };
    assert.deepEqual(g.comprobantes.map((c) => [c.estado, c.adjuntos]), [["lista_para_restaurar", 0]]);
    for (const malo of [{}, { purchaseId: "corto" }, { purchaseId: ENTRADA.purchaseId, intento: "con espacio" }, { purchaseId: ENTRADA.purchaseId, intento: 5 }, { purchaseId: "../etc/passwd" }]) {
      assert.equal((await fetch(url, { method: "POST", headers: cab("s"), body: JSON.stringify(malo) })).status, 400, JSON.stringify(malo));
    }
    assert.equal((await fetch(url, { method: "POST", headers: cab("s"), body: JSON.stringify({ purchaseId: "c".repeat(24) }) })).status, 404);
    const ok = await fetch(url, { method: "POST", headers: cab("s"), body: JSON.stringify({ purchaseId: ENTRADA.purchaseId }) });
    assert.equal(ok.status, 200); assert.equal(((await ok.json()) as { estado: string }).estado, "restaurado");
    // Segunda petición: ya tiene adjunto → 409 y no sube otro.
    const dup = await fetch(url, { method: "POST", headers: cab("s"), body: JSON.stringify({ purchaseId: ENTRADA.purchaseId }) });
    assert.equal(dup.status, 409);
  });
  assert.equal(m.llamadas.adjuntar.length, 1, "doble petición = una sola subida");
});

test("router: un fallo interno no filtra detalles y dice que se compruebe el estado antes de reintentar", async () => {
  const m = montar({ errorAdjuntar: new Error("clave secreta /srv/ruta") });
  await conRouter("s", m, async (url) => {
    const r = await fetch(url, { method: "POST", headers: cab("s"), body: JSON.stringify({ purchaseId: ENTRADA.purchaseId }) });
    assert.equal(r.status, 502); const t = await r.text(); assert.doesNotMatch(t, /secreta|srv/); assert.match(t, /Comprueba el estado/);
  });
});
