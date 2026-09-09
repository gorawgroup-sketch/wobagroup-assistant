import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictoIdempotencia,
  procesarSolicitudChat,
  type RepositorioSolicitudesChat,
  type SolicitudChatGuardada,
} from "./webChatCoordinator";

function crearRepositorio(): RepositorioSolicitudesChat & { filas: Map<string, SolicitudChatGuardada> } {
  const filas = new Map<string, SolicitudChatGuardada>();
  const clave = (chatId: number, requestId: string) => `${chatId}:${requestId}`;
  return {
    filas,
    async obtener(chatId, requestId) {
      return filas.get(clave(chatId, requestId));
    },
    async reservar(solicitud) {
      filas.set(clave(solicitud.chatId, solicitud.requestId), { ...solicitud });
    },
    async completar(chatId, requestId, respuesta) {
      const actual = filas.get(clave(chatId, requestId));
      if (!actual) throw new Error("sin reserva");
      filas.set(clave(chatId, requestId), { ...actual, estado: "completado", respuesta, actualizadoEn: Date.now() });
    },
    async fallar(chatId, requestId) {
      const actual = filas.get(clave(chatId, requestId));
      if (!actual) throw new Error("sin reserva");
      filas.set(clave(chatId, requestId), { ...actual, estado: "fallido", actualizadoEn: Date.now() });
    },
  };
}

test("dos llamadas concurrentes con el mismo messageId ejecutan el modelo una sola vez", async () => {
  const repo = crearRepositorio();
  let llamadas = 0;
  let liberar!: () => void;
  const espera = new Promise<void>((resolve) => { liberar = resolve; });
  const responder = async () => {
    llamadas++;
    await espera;
    return "respuesta única";
  };

  const primera = procesarSolicitudChat({ requestId: "msg-1", chatId: 7, texto: "hola" }, repo, responder);
  const segunda = procesarSolicitudChat({ requestId: "msg-1", chatId: 7, texto: "hola" }, repo, responder);
  liberar();
  const [a, b] = await Promise.all([primera, segunda]);

  assert.equal(llamadas, 1);
  assert.equal(a.respuesta, "respuesta única");
  assert.equal(b.respuesta, "respuesta única");
});

test("un mensaje completado se devuelve desde la reserva persistente", async () => {
  const repo = crearRepositorio();
  let llamadas = 0;
  const entrada = { requestId: "msg-2", chatId: 8, texto: "saldo" };
  await procesarSolicitudChat(entrada, repo, async () => {
    llamadas++;
    return "42";
  });
  const repetida = await procesarSolicitudChat(entrada, repo, async () => {
    llamadas++;
    return "no debe ocurrir";
  });

  assert.equal(llamadas, 1);
  assert.equal(repetida.duplicada, true);
  assert.equal(repetida.respuesta, "42");
});

test("rechaza reutilizar el mismo messageId con contenido diferente", async () => {
  const repo = crearRepositorio();
  await procesarSolicitudChat({ requestId: "msg-3", chatId: 9, texto: "uno" }, repo, async () => "ok");
  await assert.rejects(
    procesarSolicitudChat({ requestId: "msg-3", chatId: 9, texto: "dos" }, repo, async () => "mal"),
    ConflictoIdempotencia
  );
});

test("rechaza contenido diferente también mientras la solicitud sigue en curso", async () => {
  const repo = crearRepositorio();
  let liberar!: () => void;
  const espera = new Promise<void>((resolve) => { liberar = resolve; });
  const primera = procesarSolicitudChat({ requestId: "en-curso", chatId: 10, texto: "uno" }, repo,
    async () => { await espera; return "ok"; });
  await assert.rejects(procesarSolicitudChat({ requestId: "en-curso", chatId: 10, texto: "dos" }, repo,
    async () => assert.fail("no debe ejecutar")), ConflictoIdempotencia);
  liberar();
  await primera;
});

test("una solicitud fallida no repite efectos con el mismo identificador", async () => {
  const repo = crearRepositorio();
  const entrada = { requestId: "fallo", chatId: 11, texto: "acción" };
  let llamadas = 0;
  await assert.rejects(procesarSolicitudChat(entrada, repo, async () => {
    llamadas++;
    throw new Error("resultado incierto");
  }));
  const repetida = await procesarSolicitudChat(entrada, repo, async () => { llamadas++; return "mal"; });
  assert.equal(repetida.estado, "fallido");
  assert.equal(llamadas, 1);
});
