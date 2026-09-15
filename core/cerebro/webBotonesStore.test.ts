import assert from "node:assert/strict";
import test from "node:test";
import {
  AlmacenBotonesWeb,
  type BotonesActivosMensaje,
  type RepositorioBotonesWeb,
} from "./webBotonesStore";

class RepositorioMemoria implements RepositorioBotonesWeb {
  readonly filas = new Map<string, BotonesActivosMensaje>();

  constructor(iniciales: BotonesActivosMensaje[] = []) {
    for (const mensaje of iniciales) this.filas.set(`${mensaje.chatId}:${mensaje.messageId}`, structuredClone(mensaje));
  }

  async listar() {
    return Array.from(this.filas.values()).map((mensaje) => structuredClone(mensaje));
  }

  async guardar(mensaje: BotonesActivosMensaje) {
    this.filas.set(`${mensaje.chatId}:${mensaje.messageId}`, structuredClone(mensaje));
  }

  async eliminar(chatId: number, messageId: number) {
    this.filas.delete(`${chatId}:${messageId}`);
  }
}

test("recupera todos los botones después de un reinicio", async () => {
  const repo = new RepositorioMemoria([
    {
      chatId: 10,
      messageId: 101,
      texto: "¿Seguimos?",
      botones: [[{ text: "▶️ Sí, siguiente", callback_data: "colacorreo_siguiente" }]],
      actualizadoEn: 1,
    },
    {
      chatId: 10,
      messageId: 102,
      texto: "Confirma",
      botones: [[
        { text: "✅ Confirmar", callback_data: "confirmar:1" },
        { text: "❌ Cancelar", callback_data: "cancelar:1" },
      ]],
      actualizadoEn: 2,
    },
  ]);
  const store = new AlmacenBotonesWeb(repo, () => 10, 3_000);

  const activos = await store.obtenerActivos(10);
  assert.equal(activos.length, 2);
  assert.equal(activos[0].botones[0][0].callback_data, "colacorreo_siguiente");
});

test("conserva una decisión de segundo nivel aunque el mensaje no estuviera antes en memoria", async () => {
  const repo = new RepositorioMemoria();
  let ahora = 20;
  const store = new AlmacenBotonesWeb(repo, () => ahora, 0);

  await store.registrar(10, 200, "Nivel 1", [[{ text: "Continuar", callback_data: "nivel_1" }]]);
  ahora = 21;
  await store.registrar(10, 200, "Nivel 2", [[{ text: "▶️ Sí, siguiente", callback_data: "colacorreo_siguiente" }]]);

  const mensaje = await store.obtenerMensaje(10, 200);
  assert.equal(mensaje?.texto, "Nivel 2");
  assert.equal(mensaje?.botones[0][0].callback_data, "colacorreo_siguiente");
  assert.equal(repo.filas.size, 1);
});

test("retira el teclado en los dos canales al resolver una decisión", async () => {
  const repo = new RepositorioMemoria();
  const store = new AlmacenBotonesWeb(repo, () => 30, 0);
  await store.registrar(10, 300, "Pendiente", [[{ text: "✅ Aplicar", callback_data: "aplicar:1" }]]);

  await store.actualizar(10, 300, []);

  assert.equal(await store.obtenerMensaje(10, 300), undefined);
  assert.equal(repo.filas.size, 0);
});

test("actualiza un teclado recuperado de la persistencia aunque el proceso sea nuevo", async () => {
  const repo = new RepositorioMemoria([
    {
      chatId: 10,
      messageId: 350,
      texto: "Selecciona",
      botones: [[{ text: "Opción inicial", callback_data: "seleccion:inicial" }]],
      actualizadoEn: 1,
    },
  ]);
  const store = new AlmacenBotonesWeb(repo, () => 40, 0);

  await store.actualizar(10, 350, [[{ text: "▶️ Aprobar selección", callback_data: "seleccion:aprobar" }]]);

  const recuperado = await store.obtenerMensaje(10, 350);
  assert.equal(recuperado?.botones[0][0].callback_data, "seleccion:aprobar");
  assert.equal(repo.filas.get("10:350")?.botones[0][0].callback_data, "seleccion:aprobar");
});

test("no descarta botones antiguos por un límite artificial de cantidad", async () => {
  const repo = new RepositorioMemoria();
  let ahora = 100;
  const store = new AlmacenBotonesWeb(repo, () => ahora++, 0);
  for (let i = 1; i <= 25; i++) {
    await store.registrar(10, i, `Decisión ${i}`, [[{ text: `Botón ${i}`, callback_data: `accion:${i}` }]]);
  }

  assert.equal((await store.obtenerActivos(10)).length, 25);
  assert.equal((await store.obtenerActivos(11)).length, 0);
});
