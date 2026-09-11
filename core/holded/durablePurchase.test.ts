import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictoCreacionCompraError,
  CreacionCompraInciertaError,
  consultarCreacionCompraDurable,
  ejecutarCreacionCompraDurable,
  esRechazoDefinitivoSinCompra,
  identidadCreacionCompra,
  reconciliarCreacionesCompraPendientes,
  type EstadoCreacionCompra,
  type RegistroCreacionCompra,
  type RepositorioCreacionesCompra,
  type ResultadoCreacionCompra,
  type TransporteCreacionCompra,
} from "./durablePurchase";
import { configuracionCreacionesCompraDurables } from "./write";

class RepoMemoria implements RepositorioCreacionesCompra {
  filas = new Map<string, RegistroCreacionCompra>();
  fallarCheckpoint = false;

  async reservar(registro: RegistroCreacionCompra) {
    const existente = this.filas.get(registro.clave);
    if (existente) return { registro: { ...existente }, nuevo: false };
    this.filas.set(registro.clave, { ...registro });
    return { registro: { ...registro }, nuevo: true };
  }
  async obtener(clave: string) { const r = this.filas.get(clave); return r ? { ...r } : undefined; }
  async actualizarPreparada(clave: string, registro: RegistroCreacionCompra) {
    const actual = this.filas.get(clave);
    if (!actual || actual.estado !== "preparada") return undefined;
    const siguiente = { ...actual, ...registro, estado: "preparada" as const };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
  async marcarCreando(clave: string) { return this.cambiar(clave, ["preparada"], "creando"); }
  async marcarPreparada(clave: string) { this.cambiar(clave, ["creando"], "preparada"); }
  async marcarIncierta(clave: string) { this.cambiar(clave, ["creando"], "incierta"); }
  async marcarVerificada(clave: string, resultado: ResultadoCreacionCompra) {
    if (this.fallarCheckpoint) throw new Error("Sheets no responde");
    const actual = this.filas.get(clave);
    if (!actual || actual.estado === "verificada") return;
    this.filas.set(clave, { ...actual, estado: "verificada", holdedPurchaseId: resultado.id, verificadoEn: 999 });
  }
  async listarPendientes() {
    return [...this.filas.values()]
      .filter((r) => r.estado === "creando" || r.estado === "incierta")
      .map((r) => ({ ...r }));
  }
  private cambiar(clave: string, permitidos: EstadoCreacionCompra[], estado: EstadoCreacionCompra) {
    const actual = this.filas.get(clave);
    if (!actual || !permitidos.includes(actual.estado)) return undefined;
    const siguiente = { ...actual, estado, actualizadoEn: 500 };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
}

function transporte(opciones: { encontrado?: ResultadoCreacionCompra; errorCreacion?: unknown } = {}) {
  const creaciones: string[] = [];
  const busquedas: string[] = [];
  const valor: TransporteCreacionCompra & { creaciones: string[]; busquedas: string[] } = {
    creaciones,
    busquedas,
    async buscar(registro) {
      busquedas.push(registro.marcador);
      return opciones.encontrado;
    },
    async crear(marcador) {
      creaciones.push(marcador);
      if (opciones.errorCreacion) throw opciones.errorCreacion;
      return { id: "purchase-1" };
    },
  };
  return valor;
}

const DATOS = { contact_id: "contact-1", date: "2026-09-11", description: "Servicio", items: [{ price: 10 }] };

function ejecutar(repo: RepoMemoria, holded: TransporteCreacionCompra, solicitud: unknown = DATOS, ahora = 1) {
  return ejecutarCreacionCompraDurable(
    "propuesta:gasto-1", "WOBA", "contact-1", "2026-09-11", solicitud, "gasto_aprobado", repo, holded, ahora
  );
}

test("una aprobación crea una compra una sola vez y reutiliza su id", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  const primero = await ejecutar(repo, holded, DATOS, 1);
  const segundo = await ejecutar(repo, holded, DATOS, 2);
  assert.equal(primero.reutilizado, false);
  assert.equal(segundo.reutilizado, true);
  assert.equal(segundo.resultado.id, "purchase-1");
  assert.equal(holded.creaciones.length, 1);
  assert.equal(holded.busquedas.length, 0);
});

test("dos aprobaciones distintas pueden crear dos compras legítimas aunque sus datos coincidan", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  await ejecutar(repo, holded, DATOS, 1);
  await ejecutarCreacionCompraDurable(
    "propuesta:gasto-2", "WOBA", "contact-1", "2026-09-11", DATOS, "gasto_aprobado", repo, holded, 2
  );
  assert.equal(holded.creaciones.length, 2);
  assert.notEqual(holded.creaciones[0], holded.creaciones[1]);
});

test("la consulta previa reutiliza solo si la huella aprobada coincide", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  await ejecutar(repo, holded, DATOS, 1);
  const igual = await consultarCreacionCompraDurable(
    "propuesta:gasto-1", "WOBA", "contact-1", "2026-09-11", DATOS, repo, holded.buscar
  );
  assert.equal(igual?.id, "purchase-1");
  await assert.rejects(
    consultarCreacionCompraDurable(
      "propuesta:gasto-1", "WOBA", "contact-1", "2026-09-11", { ...DATOS, description: "Otro" }, repo, holded.buscar
    ),
    ConflictoCreacionCompraError
  );
  assert.equal(holded.busquedas.length, 0);
});

test("una ejecución interrumpida solo consulta Holded y recupera la compra marcada", async () => {
  const repo = new RepoMemoria();
  const registro = { ...identidadCreacionCompra("propuesta:gasto-1", "WOBA", "contact-1", "2026-09-11", DATOS, 1), estado: "creando" as const };
  repo.filas.set(registro.clave, registro);
  const holded = transporte({ encontrado: { id: "ya-creada" } });
  const resultado = await ejecutar(repo, holded, DATOS, 2);
  assert.equal(resultado.resultado.id, "ya-creada");
  assert.equal(resultado.reutilizado, true);
  assert.equal(holded.creaciones.length, 0);
  assert.equal(repo.filas.get(registro.clave)?.estado, "verificada");
});

test("una ejecución sin confirmación queda incierta y nunca repite POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ errorCreacion: new Error("timeout") });
  await assert.rejects(ejecutar(repo, holded, DATOS, 1), CreacionCompraInciertaError);
  await assert.rejects(ejecutar(repo, holded, DATOS, 2), CreacionCompraInciertaError);
  assert.equal(holded.creaciones.length, 1);
  assert.equal(holded.busquedas.length, 2);
  assert.equal([...repo.filas.values()][0]?.estado, "incierta");
});

test("si el POST da timeout pero la consulta encuentra el marcador, se confirma", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ errorCreacion: new Error("timeout"), encontrado: { id: "aceptada" } });
  const resultado = await ejecutar(repo, holded);
  assert.equal(resultado.resultado.id, "aceptada");
  assert.equal(resultado.reutilizado, true);
  assert.equal(holded.creaciones.length, 1);
  assert.equal(holded.busquedas.length, 1);
});

test("un 422 inequívoco permite corregir los datos; timeout y 429 no", async () => {
  const error422 = Object.assign(new Error("fecha bloqueada"), { status: 422 });
  assert.equal(esRechazoDefinitivoSinCompra(error422), true);
  assert.equal(esRechazoDefinitivoSinCompra(Object.assign(new Error("rate"), { status: 429 })), false);
  assert.equal(esRechazoDefinitivoSinCompra(new Error("timeout")), false);

  const repo = new RepoMemoria();
  await assert.rejects(ejecutar(repo, transporte({ errorCreacion: error422 })), error422);
  assert.equal([...repo.filas.values()][0]?.estado, "preparada");

  const corregida = { ...DATOS, date: "2026-09-12" };
  const resultado = await ejecutarCreacionCompraDurable(
    "propuesta:gasto-1", "WOBA", "contact-1", "2026-09-12", corregida, "gasto_aprobado", repo, transporte(), 2
  );
  assert.equal(resultado.resultado.id, "purchase-1");
});

test("la misma aprobación con datos distintos se bloquea si la primera sigue incierta", async () => {
  const repo = new RepoMemoria();
  await assert.rejects(ejecutar(repo, transporte({ errorCreacion: new Error("timeout") })), CreacionCompraInciertaError);
  await assert.rejects(
    ejecutarCreacionCompraDurable(
      "propuesta:gasto-1", "WOBA", "contact-1", "2026-09-12", { ...DATOS, date: "2026-09-12" },
      "gasto_aprobado", repo, transporte(), 2
    ),
    ConflictoCreacionCompraError
  );
});

test("la identidad es estable, opaca y distingue empresa y aprobación", () => {
  const a = identidadCreacionCompra("propuesta:secreta", "WOBA", "contact-1", "2026-09-11", DATOS, 1);
  const b = identidadCreacionCompra("propuesta:secreta", "WOBA", "contact-1", "2026-09-11", DATOS, 2);
  const c = identidadCreacionCompra("propuesta:secreta", "EWORKS", "contact-1", "2026-09-11", DATOS, 1);
  assert.equal(a.clave, b.clave);
  assert.notEqual(a.clave, c.clave);
  assert.equal(a.marcador.includes("secreta"), false);
  assert.equal(a.huellaSolicitud.includes("Servicio"), false);
  assert.throws(() => identidadCreacionCompra("", "WOBA", "contact-1", "2026-09-11", DATOS), /obligatoria/);
});

test("la reconciliación confirma encontrados y conserva inciertos sin crear", async () => {
  const repo = new RepoMemoria();
  const a = { ...identidadCreacionCompra("a", "WOBA", "contact-1", "2026-09-11", DATOS, 1), estado: "creando" as const };
  const b = { ...identidadCreacionCompra("b", "WOBA", "contact-1", "2026-09-11", DATOS, 1), estado: "incierta" as const };
  repo.filas.set(a.clave, a);
  repo.filas.set(b.clave, b);
  const resumen = await reconciliarCreacionesCompraPendientes(repo, async (registro) =>
    registro.marcador === a.marcador ? { id: "encontrada" } : undefined
  );
  assert.deepEqual(resumen, { revisadas: 2, verificadas: 1, inciertas: 1, errores: 0 });
  assert.equal(repo.filas.get(a.clave)?.estado, "verificada");
  assert.equal(repo.filas.get(b.clave)?.estado, "incierta");
});

test("si falla el checkpoint posterior al POST, nunca se crea una segunda compra", async () => {
  const repo = new RepoMemoria();
  repo.fallarCheckpoint = true;
  const holded = transporte();
  await assert.rejects(ejecutar(repo, holded, DATOS, 1), CreacionCompraInciertaError);
  await assert.rejects(ejecutar(repo, holded, DATOS, 2), CreacionCompraInciertaError);
  assert.equal(holded.creaciones.length, 1);
});

test("la protección de Holded solo se desactiva con false explícito", () => {
  assert.equal(configuracionCreacionesCompraDurables({} as NodeJS.ProcessEnv).habilitado, true);
  assert.equal(configuracionCreacionesCompraDurables({ WOBI_HOLDED_PURCHASE_DURABLE_ENABLED: "false" } as NodeJS.ProcessEnv).habilitado, false);
  assert.equal(configuracionCreacionesCompraDurables({ WOBI_HOLDED_PURCHASE_DURABLE_ENABLED: "falso" } as NodeJS.ProcessEnv).habilitado, true);
});
