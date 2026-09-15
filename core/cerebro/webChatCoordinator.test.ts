import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictoIdempotencia,
  hashTextoChat,
  iniciarSolicitudChat,
  obtenerSolicitudChatViva,
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
    async marcarIncierto(chatId, requestId) {
      const actual = filas.get(clave(chatId, requestId));
      if (!actual) throw new Error("sin reserva");
      filas.set(clave(chatId, requestId), { ...actual, estado: "incierto", actualizadoEn: Date.now() });
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

test("una solicitud con resultado incierto no repite efectos con el mismo identificador", async () => {
  const repo = crearRepositorio();
  const entrada = { requestId: "fallo", chatId: 11, texto: "acción" };
  let llamadas = 0;
  const primera = await procesarSolicitudChat(entrada, repo, async () => {
    llamadas++;
    throw new Error("resultado incierto");
  });
  const repetida = await procesarSolicitudChat(entrada, repo, async () => { llamadas++; return "mal"; });
  assert.equal(primera.estado, "incierto");
  assert.equal(repetida.estado, "incierto");
  assert.equal(llamadas, 1);
});

test("publica procesando, aplicado y completado en memoria sin consultar la persistencia", async () => {
  const repo = crearRepositorio();
  const estados: string[] = [];
  const entrada = { requestId: "estado-vivo-1", chatId: 13, texto: "acción segura" };

  const resultado = await procesarSolicitudChat(entrada, repo, async () => "listo", (solicitud) => {
    estados.push(solicitud.estado);
  });

  assert.equal(resultado.estado, "completado");
  assert.deepEqual(estados, ["procesando", "aplicado", "completado"]);
  assert.equal(obtenerSolicitudChatViva(13, "estado-vivo-1")?.estado, "completado");
});

test("un fallo del canal visual no cambia ni repite la operación real", async () => {
  const repo = crearRepositorio();
  let llamadas = 0;
  const resultado = await procesarSolicitudChat(
    { requestId: "evento-fallido", chatId: 16, texto: "acción" },
    repo,
    async () => { llamadas++; return "listo"; },
    () => { throw new Error("stream desconectado"); }
  );

  assert.equal(resultado.estado, "completado");
  assert.equal(repo.filas.get("16:evento-fallido")?.estado, "completado");
  assert.equal(llamadas, 1);
});

test("si el efecto terminó pero falla su confirmación durable, lo bloquea como incierto", async () => {
  const repo = crearRepositorio();
  repo.completar = async () => { throw new Error("Sheets temporalmente fuera de línea"); };
  const entrada = { requestId: "confirmacion-incierta", chatId: 14, texto: "crear y conciliar" };
  let llamadas = 0;

  const primera = await procesarSolicitudChat(entrada, repo, async () => {
    llamadas++;
    return "efecto ejecutado";
  });
  const repetida = await procesarSolicitudChat(entrada, repo, async () => {
    llamadas++;
    return "no debe repetirse";
  });

  assert.equal(primera.estado, "incierto");
  assert.equal(repetida.estado, "incierto");
  assert.equal(repo.filas.get("14:confirmacion-incierta")?.estado, "incierto");
  assert.equal(llamadas, 1);
});

test("una reserva antigua sin cierre se vuelve incierta y no ejecuta otra vez", async () => {
  const repo = crearRepositorio();
  const haceOnceMinutos = Date.now() - 11 * 60 * 1000;
  repo.filas.set("15:reserva-antigua", {
    requestId: "reserva-antigua",
    chatId: 15,
    textoHash: hashTextoChat("acción contable"),
    estado: "procesando",
    creadoEn: haceOnceMinutos,
    actualizadoEn: haceOnceMinutos,
  });
  let llamadas = 0;

  const resultado = await procesarSolicitudChat(
    { requestId: "reserva-antigua", chatId: 15, texto: "acción contable" },
    repo,
    async () => { llamadas++; return "no debe ejecutarse"; }
  );

  assert.equal(resultado.estado, "incierto");
  assert.equal(repo.filas.get("15:reserva-antigua")?.estado, "incierto");
  assert.equal(llamadas, 0);
});

test("el modo asíncrono confirma la reserva sin esperar la respuesta del modelo", async () => {
  const repo = crearRepositorio();
  let liberar!: () => void;
  const espera = new Promise<void>((resolve) => { liberar = resolve; });
  let termino = false;

  const inicio = await iniciarSolicitudChat(
    { requestId: "asincrono-1", chatId: 12, texto: "analiza esto" },
    repo,
    async () => {
      await espera;
      termino = true;
      return "listo";
    }
  );

  assert.equal(inicio.estado, "procesando");
  assert.equal(termino, false);
  assert.equal(repo.filas.get("12:asincrono-1")?.estado, "procesando");

  liberar();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(termino, true);
  assert.equal(repo.filas.get("12:asincrono-1")?.estado, "completado");
});
