import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { crearRouterProponerAccion, HERRAMIENTAS_PERMITIDAS } from "./proponerAccionAdmin";
import { proponerEdicionCompraHoldedTool } from "./editarCompraHolded";

async function servidor(opciones: { chat?: number | undefined; llamadas?: Array<{ tool: string; input: unknown; chatId: number }> } = {}) {
  const app = express();
  app.use("/", crearRouterProponerAccion({
    secreto: () => "s3creto",
    chatSuperadmin: async () => ("chat" in opciones ? opciones.chat : 42),
    ejecutar: async (tool, input, chatId) => { opciones.llamadas?.push({ tool, input, chatId }); return "propuesta mostrada"; },
  }));
  const srv = app.listen(0); await once(srv, "listening");
  const puerto = (srv.address() as { port: number }).port;
  return { srv, post: (cuerpo: unknown, secreto = "s3creto") => fetch(`http://127.0.0.1:${puerto}/`, { method: "POST", headers: { "content-type": "application/json", "x-admin-secret": secreto }, body: JSON.stringify(cuerpo) }) };
}

test("sin secreto o con secreto erróneo: 403 y no ejecuta nada", async () => {
  const llamadas: Array<{ tool: string; input: unknown; chatId: number }> = [];
  const { srv, post } = await servidor({ llamadas });
  try {
    assert.equal((await post({ tool: "revisar_correo_puntual", input: {} }, "otro")).status, 403);
    assert.equal(llamadas.length, 0);
  } finally { srv.close(); }
});

test("solo las herramientas que proponen con botones; nunca una que escriba", async () => {
  const llamadas: Array<{ tool: string; input: unknown; chatId: number }> = [];
  const { srv, post } = await servidor({ llamadas });
  try {
    for (const tool of ["conciliar_movimiento", "crear_gasto", "enviar_correo", "proponer_envio_correo"]) assert.equal((await post({ tool, input: {} })).status, 400, tool);
    assert.equal(llamadas.length, 0);
    const ok = await post({ tool: "proponer_edicion_compra_holded", input: { empresa: "Footprint", compra_id: "6acdf917b4a4326e68069ed0", monto_nuevo: 245.33 } });
    assert.equal(ok.status, 200); assert.deepEqual(llamadas, [{ tool: "proponer_edicion_compra_holded", input: { empresa: "Footprint", compra_id: "6acdf917b4a4326e68069ed0", monto_nuevo: 245.33 }, chatId: 42 }]);
  } finally { srv.close(); }
});

test("sin superadministrador no se propone nada; sin input válido, 400", async () => {
  const { srv, post } = await servidor({ chat: undefined });
  try {
    assert.equal((await post({ tool: "revisar_correo_puntual", input: { busqueda: "x" } })).status, 409);
    assert.equal((await post({ tool: "revisar_correo_puntual", input: [] })).status, 400);
  } finally { srv.close(); }
});

test("la lista de herramientas permitidas es cerrada y ninguna es de escritura directa", () => {
  assert.deepEqual([...HERRAMIENTAS_PERMITIDAS].sort(), ["proponer_correo_a_audiencia", "proponer_edicion_compra_holded", "reenviar_botones_propuesta_gasto", "revisar_correo_puntual"]);
});

test("proponer_edicion_compra_holded: compra_id inválido o ni contacto ni id → error sin tocar Holded", async () => {
  const h = proponerEdicionCompraHoldedTool.handler;
  assert.match(await h({ empresa: "Footprint", compra_id: "no-es-un-id", monto_nuevo: 1 }, { chatId: 1 }), /24 caracteres/);
  assert.match(await h({ empresa: "Footprint", monto_nuevo: 1 }, { chatId: 1 }), /contacto.*compra_id/);
});
