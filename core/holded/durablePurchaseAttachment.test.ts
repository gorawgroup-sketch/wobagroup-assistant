import assert from "node:assert/strict";
import test from "node:test";
import {
  AdjuntoCompraInciertoError,
  ConflictoAdjuntoCompraError,
  ejecutarAdjuntoCompraDurable,
  esArchivoLocalInexistente,
  identidadAdjuntoCompra,
  reconciliarAdjuntosCompraPendientes,
  type EstadoAdjuntoCompra,
  type RegistroAdjuntoCompra,
  type RepositorioAdjuntosCompra,
  type ResultadoAdjuntoCompra,
  type TransporteAdjuntoCompra,
} from "./durablePurchaseAttachment";
import { configuracionAdjuntosCompraDurables, validarTamanoAdjuntoHolded } from "./write";

class RepoMemoria implements RepositorioAdjuntosCompra {
  filas = new Map<string, RegistroAdjuntoCompra>();
  fallarCheckpoint = false;

  async reservar(registro: RegistroAdjuntoCompra) {
    const existente = this.filas.get(registro.clave);
    if (existente) return { registro: { ...existente }, nuevo: false };
    this.filas.set(registro.clave, { ...registro });
    return { registro: { ...registro }, nuevo: true };
  }
  async obtener(clave: string) { const r = this.filas.get(clave); return r ? { ...r } : undefined; }
  async actualizarPreparado(clave: string, registro: RegistroAdjuntoCompra) {
    const actual = this.filas.get(clave);
    if (!actual || actual.estado !== "preparado") return undefined;
    const siguiente = { ...actual, ...registro, estado: "preparado" as const };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
  async marcarSubiendo(clave: string) { return this.cambiar(clave, ["preparado"], "subiendo"); }
  async marcarPreparado(clave: string) { this.cambiar(clave, ["subiendo"], "preparado"); }
  async marcarIncierto(clave: string) { this.cambiar(clave, ["subiendo"], "incierto"); }
  async marcarVerificado(clave: string, resultado: ResultadoAdjuntoCompra) {
    if (this.fallarCheckpoint) throw new Error("Sheets no responde");
    const actual = this.filas.get(clave);
    if (!actual || actual.estado === "verificado") return;
    this.filas.set(clave, {
      ...actual,
      estado: "verificado",
      attachmentId: resultado.attachmentId,
      actualizadoEn: 500,
      verificadoEn: 500,
    });
  }
  async listarPendientes() {
    return [...this.filas.values()]
      .filter((r) => r.estado === "subiendo" || r.estado === "incierto")
      .map((r) => ({ ...r }));
  }
  private cambiar(clave: string, permitidos: EstadoAdjuntoCompra[], estado: EstadoAdjuntoCompra) {
    const actual = this.filas.get(clave);
    if (!actual || !permitidos.includes(actual.estado)) return undefined;
    const siguiente = { ...actual, estado, actualizadoEn: 500 };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
}

function transporte(opciones: { errorSubida?: unknown; aplicarAntesDeError?: boolean } = {}) {
  const existentes = new Map<string, ResultadoAdjuntoCompra>();
  const busquedas: string[] = [];
  const subidas: string[] = [];
  const valor: TransporteAdjuntoCompra & {
    existentes: Map<string, ResultadoAdjuntoCompra>;
    busquedas: string[];
    subidas: string[];
  } = {
    existentes,
    busquedas,
    subidas,
    async buscar(registro) {
      busquedas.push(registro.fileName);
      return existentes.get(registro.fileName);
    },
    async subir(fileName) {
      subidas.push(fileName);
      const resultado = { attachmentId: `holded-${fileName}`, fileName };
      if (opciones.aplicarAntesDeError) existentes.set(fileName, resultado);
      if (opciones.errorSubida) throw opciones.errorSubida;
      existentes.set(fileName, resultado);
      return resultado;
    },
  };
  return valor;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function identidad(id = "propuesta-1", hash = HASH_A, purchaseId = "purchase-1", ahora = 1) {
  return identidadAdjuntoCompra(id, "WOBA", purchaseId, hash, "pdf", "test", ahora);
}

test("una aprobación sube una sola vez y una repetición reutiliza el terminal", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  const primero = await ejecutarAdjuntoCompraDurable(identidad(), repo, holded);
  const segundo = await ejecutarAdjuntoCompraDurable(identidad("propuesta-1", HASH_A, "purchase-1", 2), repo, holded);
  assert.equal(primero.reutilizado, false);
  assert.equal(segundo.reutilizado, true);
  assert.equal(holded.subidas.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "verificado");
});

test("dos aprobaciones con los mismos bytes y compra convergen sin segundo POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  const a = identidad("propuesta-a");
  const b = identidad("propuesta-b");
  assert.equal(a.fileName, b.fileName);
  await ejecutarAdjuntoCompraDurable(a, repo, holded);
  const segundo = await ejecutarAdjuntoCompraDurable(b, repo, holded);
  assert.equal(segundo.reutilizado, true);
  assert.equal(holded.subidas.length, 1);
});

test("un estado interrumpido solo consulta y nunca sube", async () => {
  const repo = new RepoMemoria();
  const registro = { ...identidad(), estado: "subiendo" as const };
  repo.filas.set(registro.clave, registro);
  const holded = transporte();
  await assert.rejects(ejecutarAdjuntoCompraDurable(identidad(), repo, holded), AdjuntoCompraInciertoError);
  assert.equal(holded.subidas.length, 0);
  assert.equal(repo.filas.get(registro.clave)?.estado, "incierto");
});

test("timeout aplicado se recupera por lectura sin repetir POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ errorSubida: new Error("timeout"), aplicarAntesDeError: true });
  const resultado = await ejecutarAdjuntoCompraDurable(identidad(), repo, holded);
  assert.equal(resultado.reutilizado, true);
  assert.equal(holded.subidas.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "verificado");
});

test("timeout no verificable queda incierto y nunca repite POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ errorSubida: new Error("timeout") });
  await assert.rejects(ejecutarAdjuntoCompraDurable(identidad(), repo, holded), AdjuntoCompraInciertoError);
  await assert.rejects(ejecutarAdjuntoCompraDurable(identidad("propuesta-1", HASH_A, "purchase-1", 2), repo, holded), AdjuntoCompraInciertoError);
  assert.equal(holded.subidas.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "incierto");
});

test("un rechazo 403 vuelve a preparado y permite reintento explícito", async () => {
  const repo = new RepoMemoria();
  const rechazo = Object.assign(new Error("sin permiso"), { status: 403 });
  const fallido = transporte({ errorSubida: rechazo });
  await assert.rejects(ejecutarAdjuntoCompraDurable(identidad(), repo, fallido), rechazo);
  assert.equal(repo.filas.values().next().value?.estado, "preparado");
  const recuperado = transporte();
  await ejecutarAdjuntoCompraDurable(identidad(), repo, recuperado);
  assert.equal(recuperado.subidas.length, 1);
});

test("datos distintos se bloquean si la primera subida quedó incierta", async () => {
  const repo = new RepoMemoria();
  await assert.rejects(
    ejecutarAdjuntoCompraDurable(identidad(), repo, transporte({ errorSubida: new Error("timeout") })),
    AdjuntoCompraInciertoError
  );
  await assert.rejects(
    ejecutarAdjuntoCompraDurable(identidad("propuesta-1", HASH_B, "purchase-1", 2), repo, transporte()),
    ConflictoAdjuntoCompraError
  );
});

test("fallo del checkpoint posterior al POST nunca permite un segundo POST", async () => {
  const repo = new RepoMemoria();
  repo.fallarCheckpoint = true;
  const holded = transporte();
  await assert.rejects(ejecutarAdjuntoCompraDurable(identidad(), repo, holded), AdjuntoCompraInciertoError);
  await assert.rejects(ejecutarAdjuntoCompraDurable(identidad(), repo, holded), AdjuntoCompraInciertoError);
  assert.equal(holded.subidas.length, 1);
});

test("la reconciliación confirma encontrados y conserva el resto sin subir", async () => {
  const repo = new RepoMemoria();
  const a = { ...identidad("a"), estado: "subiendo" as const };
  const b = { ...identidad("b", HASH_B), estado: "incierto" as const };
  repo.filas.set(a.clave, a);
  repo.filas.set(b.clave, b);
  const holded = transporte();
  holded.existentes.set(a.fileName, { attachmentId: "attachment-a", fileName: a.fileName });
  const resumen = await reconciliarAdjuntosCompraPendientes(repo, holded.buscar);
  assert.deepEqual(resumen, { revisados: 2, verificados: 1, inciertos: 1, errores: 0 });
  assert.equal(repo.filas.get(a.clave)?.estado, "verificado");
  assert.equal(repo.filas.get(b.clave)?.estado, "incierto");
  assert.equal(holded.subidas.length, 0);
});

test("la identidad y el nombre son estables, opacos y cambian con compra o contenido", () => {
  const a = identidadAdjuntoCompra("aprobacion:secreta", "WOBA", "purchase-1", HASH_A, "PDF!!", "test", 1);
  const b = identidadAdjuntoCompra("aprobacion:secreta", "WOBA", "purchase-1", HASH_A, "pdf", "test", 2);
  const otraCompra = identidadAdjuntoCompra("otra", "WOBA", "purchase-2", HASH_A, "pdf", "test", 1);
  const otroContenido = identidadAdjuntoCompra("otra", "WOBA", "purchase-1", HASH_B, "pdf", "test", 1);
  assert.equal(a.clave, b.clave);
  assert.equal(a.fileName, b.fileName);
  assert.match(a.fileName, /^comprobante_wobi_[a-f0-9]{24}\.pdf$/);
  assert.equal(a.clave.includes("secreta"), false);
  assert.equal(a.fileName.includes("purchase"), false);
  assert.notEqual(a.fileName, otraCompra.fileName);
  assert.notEqual(a.fileName, otroContenido.fileName);
});

test("solo false explícito desactiva la protección", () => {
  assert.equal(configuracionAdjuntosCompraDurables({} as NodeJS.ProcessEnv).habilitado, true);
  assert.equal(
    configuracionAdjuntosCompraDurables({ WOBI_HOLDED_ATTACHMENT_DURABLE_ENABLED: " false " } as NodeJS.ProcessEnv).habilitado,
    false
  );
  assert.equal(
    configuracionAdjuntosCompraDurables({ WOBI_HOLDED_ATTACHMENT_DURABLE_ENABLED: "falso" } as NodeJS.ProcessEnv).habilitado,
    true
  );
});

test("solo ENOENT autoriza reconstruir la copia temporal", () => {
  assert.equal(esArchivoLocalInexistente(Object.assign(new Error("missing"), { code: "ENOENT" })), true);
  assert.equal(esArchivoLocalInexistente(new Error("timeout")), false);
  assert.equal(esArchivoLocalInexistente(Object.assign(new Error("forbidden"), { status: 403 })), false);
});

test("el límite oficial de 10 MB se aplica antes de cualquier transporte", () => {
  assert.doesNotThrow(() => validarTamanoAdjuntoHolded(10 * 1024 * 1024));
  assert.throws(() => validarTamanoAdjuntoHolded(0), /vacío/);
  assert.throws(() => validarTamanoAdjuntoHolded(10 * 1024 * 1024 + 1), /10 MB/);
});
