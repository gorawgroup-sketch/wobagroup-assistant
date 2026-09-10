import assert from "node:assert/strict";
import test from "node:test";
import {
  EnvioCorreoInciertoError,
  consultarEnvioCorreoDurable,
  ejecutarEnvioCorreoDurable,
  identidadEnvioCorreo,
  reconciliarEnviosCorreoPendientes,
  type EstadoEnvioCorreo,
  type RegistroEnvioCorreo,
  type RepositorioEnviosCorreo,
  type ResultadoEnvioCorreo,
  type TransporteCorreoDurable,
} from "./durableSend";

class RepoMemoria implements RepositorioEnviosCorreo {
  filas = new Map<string, RegistroEnvioCorreo>();
  async reservar(registro: RegistroEnvioCorreo) {
    const existente = this.filas.get(registro.clave);
    if (existente) return { registro: { ...existente }, nuevo: false };
    this.filas.set(registro.clave, { ...registro });
    return { registro: { ...registro }, nuevo: true };
  }
  async obtener(clave: string) { const r = this.filas.get(clave); return r ? { ...r } : undefined; }
  async marcarEnviando(clave: string) { return this.cambiar(clave, ["preparado"], "enviando"); }
  async marcarPreparado(clave: string) { this.cambiar(clave, ["enviando"], "preparado"); }
  async marcarIncierto(clave: string) { this.cambiar(clave, ["enviando"], "incierto"); }
  async marcarVerificado(clave: string, resultado: ResultadoEnvioCorreo) {
    const actual = this.filas.get(clave);
    if (!actual || actual.estado === "verificado") return;
    this.filas.set(clave, {
      ...actual,
      estado: "verificado",
      gmailMessageId: resultado.id,
      gmailThreadId: resultado.threadId,
      verificadoEn: 999,
    });
  }
  async listarPendientes() {
    return [...this.filas.values()].filter((r) => r.estado === "enviando" || r.estado === "incierto").map((r) => ({ ...r }));
  }
  private cambiar(clave: string, permitidos: EstadoEnvioCorreo[], estado: EstadoEnvioCorreo) {
    const actual = this.filas.get(clave);
    if (!actual || !permitidos.includes(actual.estado)) return undefined;
    const siguiente = { ...actual, estado, actualizadoEn: 500 };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
}

function transporte(opciones: {
  encontrado?: ResultadoEnvioCorreo;
  errorEnvio?: unknown;
} = {}): TransporteCorreoDurable & { envios: string[]; busquedas: string[] } {
  const envios: string[] = [];
  const busquedas: string[] = [];
  return {
    envios,
    busquedas,
    async buscar(messageId) { busquedas.push(messageId); return opciones.encontrado; },
    async enviar(messageId) {
      envios.push(messageId);
      if (opciones.errorEnvio) throw opciones.errorEnvio;
      return { id: "gmail-1", threadId: "thread-1" };
    },
  };
}

test("un envío nuevo se prepara, envía y verifica una sola vez", async () => {
  const repo = new RepoMemoria();
  const mail = transporte();
  const primero = await ejecutarEnvioCorreoDurable("borrador:abc", "borrador_aprobado", repo, mail, 1);
  const segundo = await ejecutarEnvioCorreoDurable("borrador:abc", "borrador_aprobado", repo, mail, 2);
  assert.equal(primero.reutilizado, false);
  assert.equal(segundo.reutilizado, true);
  assert.equal(mail.envios.length, 1);
  assert.equal(mail.busquedas.length, 0);
  assert.equal([...repo.filas.values()][0]?.estado, "verificado");
});

test("una ejecución interrumpida solo consulta Gmail y recupera el resultado existente", async () => {
  const repo = new RepoMemoria();
  const registro = { ...identidadEnvioCorreo("auto:mensaje-1", 1), estado: "enviando" as const };
  repo.filas.set(registro.clave, registro);
  const mail = transporte({ encontrado: { id: "ya-enviado", threadId: "hilo" } });
  const resultado = await ejecutarEnvioCorreoDurable("auto:mensaje-1", "autorespuesta", repo, mail, 2);
  assert.equal(resultado.reutilizado, true);
  assert.equal(resultado.resultado.id, "ya-enviado");
  assert.equal(mail.envios.length, 0);
  assert.equal(repo.filas.get(registro.clave)?.estado, "verificado");
});

test("una ejecución interrumpida sin confirmación queda incierta y nunca reenvía", async () => {
  const repo = new RepoMemoria();
  const registro = { ...identidadEnvioCorreo("auto:mensaje-2", 1), estado: "enviando" as const };
  repo.filas.set(registro.clave, registro);
  const mail = transporte();
  await assert.rejects(
    ejecutarEnvioCorreoDurable("auto:mensaje-2", "autorespuesta", repo, mail, 2),
    EnvioCorreoInciertoError
  );
  assert.equal(mail.envios.length, 0);
  assert.equal(repo.filas.get(registro.clave)?.estado, "incierto");
});

test("si send falla pero Gmail encuentra el Message-ID, se confirma sin duplicar", async () => {
  const repo = new RepoMemoria();
  const mail = transporte({ errorEnvio: new Error("timeout"), encontrado: { id: "aceptado", threadId: "hilo" } });
  const resultado = await ejecutarEnvioCorreoDurable("reporte:1", "reporte", repo, mail, 1);
  assert.equal(resultado.resultado.id, "aceptado");
  assert.equal(resultado.reutilizado, true);
  assert.equal(mail.envios.length, 1);
  assert.equal(mail.busquedas.length, 1);
});

test("un timeout sin confirmación queda incierto; un 403 inequívoco vuelve a preparado", async () => {
  const repoTimeout = new RepoMemoria();
  await assert.rejects(
    ejecutarEnvioCorreoDurable("reporte:2", "reporte", repoTimeout, transporte({ errorEnvio: new Error("timeout") }), 1),
    EnvioCorreoInciertoError
  );
  assert.equal([...repoTimeout.filas.values()][0]?.estado, "incierto");

  const repo403 = new RepoMemoria();
  const error403 = Object.assign(new Error("sin permiso"), { response: { status: 403 } });
  await assert.rejects(ejecutarEnvioCorreoDurable("reporte:3", "reporte", repo403, transporte({ errorEnvio: error403 }), 1), /sin permiso/);
  assert.equal([...repo403.filas.values()][0]?.estado, "preparado");
});

test("la identidad es estable, opaca y no acepta claves vacías", () => {
  const a = identidadEnvioCorreo("borrador:secreto", 1);
  const b = identidadEnvioCorreo("borrador:secreto", 2);
  const c = identidadEnvioCorreo("borrador:otro", 1);
  assert.equal(a.clave, b.clave);
  assert.equal(a.messageIdRfc, b.messageIdRfc);
  assert.notEqual(a.clave, c.clave);
  assert.equal(a.messageIdRfc.includes("secreto"), false);
  assert.throws(() => identidadEnvioCorreo(""), /obligatoria/);
});

test("la reconciliación de arranque confirma encontrados y conserva inciertos", async () => {
  const repo = new RepoMemoria();
  const a = { ...identidadEnvioCorreo("a", 1), estado: "enviando" as const };
  const b = { ...identidadEnvioCorreo("b", 1), estado: "incierto" as const };
  repo.filas.set(a.clave, a);
  repo.filas.set(b.clave, b);
  const resumen = await reconciliarEnviosCorreoPendientes(repo, async (messageId) =>
    messageId === a.messageIdRfc ? { id: "encontrado", threadId: "hilo" } : undefined
  );
  assert.deepEqual(resumen, { revisados: 2, verificados: 1, inciertos: 1, errores: 0 });
  assert.equal(repo.filas.get(a.clave)?.estado, "verificado");
  assert.equal(repo.filas.get(b.clave)?.estado, "incierto");
});

test("la consulta previa evita trabajo caro cuando ya se envió o quedó incierto", async () => {
  const repo = new RepoMemoria();
  const verificado = { ...identidadEnvioCorreo("previo:1", 1), estado: "verificado" as const, gmailMessageId: "gmail-1" };
  const incierto = { ...identidadEnvioCorreo("previo:2", 1), estado: "incierto" as const };
  repo.filas.set(verificado.clave, verificado);
  repo.filas.set(incierto.clave, incierto);
  let busquedas = 0;
  const encontrado = await consultarEnvioCorreoDurable("previo:1", repo, async () => { busquedas++; return undefined; });
  assert.equal(encontrado?.id, "gmail-1");
  assert.equal(busquedas, 0);
  await assert.rejects(
    consultarEnvioCorreoDurable("previo:2", repo, async () => { busquedas++; return undefined; }),
    EnvioCorreoInciertoError
  );
  assert.equal(busquedas, 1);
});
