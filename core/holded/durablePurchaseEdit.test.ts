import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictoEdicionCompraError,
  EdicionCompraInciertaError,
  ejecutarEdicionCompraDurable,
  identidadEdicionCompra,
  reconciliarEdicionesCompraPendientes,
  type EstadoEdicionCompra,
  type PreparacionEdicionCompra,
  type RegistroEdicionCompra,
  type RepositorioEdicionesCompra,
  type ResultadoEdicionCompra,
  type TransporteEdicionCompra,
} from "./durablePurchaseEdit";
import { configuracionEdicionesCompraDurables, huellaEstadoCompra } from "./write";

interface DocumentoPrueba { id: string; numero: string; }

class RepoMemoria implements RepositorioEdicionesCompra {
  filas = new Map<string, RegistroEdicionCompra>();
  fallarCheckpoint = false;

  async reservar(registro: RegistroEdicionCompra) {
    const existente = this.filas.get(registro.clave);
    if (existente) return { registro: { ...existente }, nuevo: false };
    this.filas.set(registro.clave, { ...registro });
    return { registro: { ...registro }, nuevo: true };
  }
  async obtener(clave: string) { const r = this.filas.get(clave); return r ? { ...r } : undefined; }
  async actualizarPreparada(clave: string, registro: RegistroEdicionCompra) {
    const actual = this.filas.get(clave);
    if (!actual || actual.estado !== "preparada") return undefined;
    const siguiente = { ...actual, ...registro, estado: "preparada" as const };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
  async marcarEditando(clave: string, huellaEsperada: string, verificarTotal: boolean) {
    const actual = this.filas.get(clave);
    if (!actual || actual.estado !== "preparada") return undefined;
    const siguiente = { ...actual, estado: "editando" as const, huellaEsperada, verificarTotal };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
  async marcarPreparada(clave: string) { this.cambiar(clave, ["editando"], "preparada", true); }
  async marcarIncierta(clave: string) { this.cambiar(clave, ["editando"], "incierta"); }
  async marcarVerificada(clave: string) {
    if (this.fallarCheckpoint) throw new Error("Sheets no responde");
    this.cambiar(clave, ["editando", "incierta"], "verificada");
  }
  async listarPendientes() {
    return [...this.filas.values()]
      .filter((r) => r.estado === "editando" || r.estado === "incierta")
      .map((r) => ({ ...r }));
  }
  private cambiar(
    clave: string,
    permitidos: EstadoEdicionCompra[],
    estado: EstadoEdicionCompra,
    limpiar = false
  ) {
    const actual = this.filas.get(clave);
    if (!actual || !permitidos.includes(actual.estado)) return undefined;
    const siguiente = {
      ...actual,
      estado,
      ...(limpiar ? { huellaEsperada: undefined, verificarTotal: undefined } : {}),
      actualizadoEn: 500,
    };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
}

function transporte(opciones: { errorEdicion?: unknown; aplicadaInicial?: boolean } = {}) {
  let aplicada = opciones.aplicadaInicial ?? false;
  const preparaciones: PreparacionEdicionCompra[] = [];
  const ediciones: PreparacionEdicionCompra[] = [];
  const verificaciones: string[] = [];
  const valor: TransporteEdicionCompra<DocumentoPrueba> & {
    preparaciones: PreparacionEdicionCompra[];
    ediciones: PreparacionEdicionCompra[];
    verificaciones: string[];
    aplicar(): void;
  } = {
    preparaciones,
    ediciones,
    verificaciones,
    async preparar() {
      const preparacion = { huellaEsperada: "huella-final", verificarTotal: true, payload: { numero: "B" } };
      preparaciones.push(preparacion);
      return preparacion;
    },
    async editar(preparacion) {
      ediciones.push(preparacion);
      if (opciones.errorEdicion) throw opciones.errorEdicion;
      aplicada = true;
    },
    async verificar(registro) {
      verificaciones.push(registro.huellaEsperada ?? "");
      return aplicada && registro.huellaEsperada === "huella-final"
        ? { id: registro.purchaseId, valor: { id: registro.purchaseId, numero: "B" } }
        : undefined;
    },
    aplicar() { aplicada = true; },
  };
  return valor;
}

const CAMBIOS = { numeroDocumento: "B" };

function ejecutar(
  repo: RepoMemoria,
  holded: TransporteEdicionCompra<DocumentoPrueba>,
  cambios: unknown = CAMBIOS,
  ahora = 1
) {
  return ejecutarEdicionCompraDurable(
    "propuesta-edicion:abc", "WOBA", "purchase-1", cambios, "edicion_compra_aprobada", repo, holded, ahora
  );
}

test("una aprobación edita una sola vez y una repetición solo verifica", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  const primero = await ejecutar(repo, holded, CAMBIOS, 1);
  const segundo = await ejecutar(repo, holded, CAMBIOS, 2);
  assert.equal(primero.reutilizado, false);
  assert.equal(segundo.reutilizado, true);
  assert.equal(segundo.resultado.valor.numero, "B");
  assert.equal(holded.ediciones.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "verificada");
});

test("timeout aplicado se recupera por lectura sin repetir PUT", async () => {
  const repo = new RepoMemoria();
  const timeout = new Error("timeout");
  const holded = transporte({ errorEdicion: timeout, aplicadaInicial: true });
  const resultado = await ejecutar(repo, holded);
  assert.equal(resultado.reutilizado, true);
  assert.equal(holded.ediciones.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "verificada");
});

test("timeout no verificable queda incierto y nunca repite PUT", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ errorEdicion: new Error("timeout") });
  await assert.rejects(ejecutar(repo, holded, CAMBIOS, 1), EdicionCompraInciertaError);
  await assert.rejects(ejecutar(repo, holded, CAMBIOS, 2), EdicionCompraInciertaError);
  assert.equal(holded.ediciones.length, 1);
  assert.equal(holded.preparaciones.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "incierta");
});

test("un rechazo 422 vuelve a preparada y permite una propuesta corregida", async () => {
  const repo = new RepoMemoria();
  const rechazo = Object.assign(new Error("fecha bloqueada"), { status: 422 });
  await assert.rejects(ejecutar(repo, transporte({ errorEdicion: rechazo }), CAMBIOS, 1), rechazo);
  assert.equal(repo.filas.values().next().value?.estado, "preparada");

  const resultado = await ejecutar(repo, transporte(), { numeroDocumento: "C" }, 2);
  assert.equal(resultado.resultado.valor.numero, "B");
  assert.equal(repo.filas.values().next().value?.estado, "verificada");
});

test("datos distintos se bloquean si la primera edición quedó incierta", async () => {
  const repo = new RepoMemoria();
  await assert.rejects(ejecutar(repo, transporte({ errorEdicion: new Error("timeout") })), EdicionCompraInciertaError);
  await assert.rejects(ejecutar(repo, transporte(), { numeroDocumento: "C" }, 2), ConflictoEdicionCompraError);
});

test("fallo del checkpoint posterior al PUT no permite un segundo PUT", async () => {
  const repo = new RepoMemoria();
  repo.fallarCheckpoint = true;
  const holded = transporte();
  await assert.rejects(ejecutar(repo, holded, CAMBIOS, 1), EdicionCompraInciertaError);
  await assert.rejects(ejecutar(repo, holded, CAMBIOS, 2), EdicionCompraInciertaError);
  assert.equal(holded.ediciones.length, 1);
});

test("la reconciliación confirma encontrados y conserva el resto sin editar", async () => {
  const repo = new RepoMemoria();
  const a = {
    ...identidadEdicionCompra("a", "WOBA", "purchase-a", CAMBIOS, "test", 1),
    estado: "editando" as const,
    huellaEsperada: "huella-final",
    verificarTotal: true,
  };
  const b = {
    ...identidadEdicionCompra("b", "WOBA", "purchase-b", CAMBIOS, "test", 1),
    estado: "incierta" as const,
    huellaEsperada: "otra",
    verificarTotal: true,
  };
  repo.filas.set(a.clave, a);
  repo.filas.set(b.clave, b);
  const holded = transporte({ aplicadaInicial: true });
  const resumen = await reconciliarEdicionesCompraPendientes(repo, holded.verificar);
  assert.deepEqual(resumen, { revisadas: 2, verificadas: 1, inciertas: 1, errores: 0 });
  assert.equal(repo.filas.get(a.clave)?.estado, "verificada");
  assert.equal(repo.filas.get(b.clave)?.estado, "incierta");
  assert.equal(holded.ediciones.length, 0);
});

test("la identidad es estable y no filtra la aprobación ni los cambios", () => {
  const a = identidadEdicionCompra("propuesta:secreta", "WOBA", "purchase-1", CAMBIOS, "test", 1);
  const b = identidadEdicionCompra("propuesta:secreta", "WOBA", "purchase-1", CAMBIOS, "test", 2);
  const c = identidadEdicionCompra("propuesta:secreta", "EWORKS", "purchase-1", CAMBIOS, "test", 1);
  assert.equal(a.clave, b.clave);
  assert.notEqual(a.clave, c.clave);
  assert.equal(a.clave.includes("secreta"), false);
  assert.equal(a.huellaSolicitud.includes("B"), false);
  assert.throws(() => identidadEdicionCompra("", "WOBA", "purchase-1", CAMBIOS, "test"), /obligatoria/);
});

test("la protección solo se desactiva con false explícito", () => {
  assert.equal(configuracionEdicionesCompraDurables({} as NodeJS.ProcessEnv).habilitado, true);
  assert.equal(
    configuracionEdicionesCompraDurables({ WOBI_HOLDED_EDIT_DURABLE_ENABLED: " false " } as NodeJS.ProcessEnv).habilitado,
    false
  );
  assert.equal(
    configuracionEdicionesCompraDurables({ WOBI_HOLDED_EDIT_DURABLE_ENABLED: "falso" } as NodeJS.ProcessEnv).habilitado,
    true
  );
});

test("la huella compara formatos reales de Holded sin exponer los valores", () => {
  const esperada = huellaEstadoCompra(
    {
      id: "purchase-1",
      document_number: "F-100",
      date: "2026-09-11",
      due_date: null,
      currency: "usd",
      currency_change: 1.16,
      contact_id: "contact-1",
      design_id: null,
      total: 1234.56,
      lines: [{}, {}],
    },
    true
  );
  const releida = huellaEstadoCompra(
    {
      id: "purchase-1",
      document_number: "F-100",
      date: "2026-09-11",
      due_date: "",
      currency: "USD",
      currency_change: "1.16",
      contact_id: "contact-1",
      design_id: "",
      total: "1.234,56",
      lines: [{ name: "A" }, { name: "B" }],
    },
    true
  );
  const alterada = huellaEstadoCompra(
    {
      id: "purchase-1",
      document_number: "F-100",
      date: "2026-09-11",
      currency: "USD",
      currency_change: "1.16",
      contact_id: "contact-1",
      total: "1.235,56",
      lines: [{}, {}],
    },
    true
  );
  assert.equal(esperada, releida);
  assert.notEqual(esperada, alterada);
  assert.equal(esperada.includes("F-100"), false);
});

test("la huella de una corrección contable verifica cada cuenta sin romper huellas anteriores", () => {
  const base = {
    id: "purchase-1",
    document_number: "1313",
    date: "2026-09-11",
    currency: "EUR",
    currency_change: "1.00",
    contact_id: "contact-1",
    total: "2.200,00",
    lines: [{ name: "Consulting Service", account: "profesionales" }],
  };
  const cuentaDistinta = {
    ...base,
    lines: [{ name: "Consulting Service", account: "woba-services" }],
  };

  // Compatibilidad: las ediciones antiguas siguen usando exactamente la
  // huella histórica, que deliberadamente no incluía el detalle de cuenta.
  assert.equal(huellaEstadoCompra(base, true), huellaEstadoCompra(cuentaDistinta, true));

  const esperada = huellaEstadoCompra(base, true, true);
  assert.match(esperada, /^cuentas-v1:[a-f0-9]{64}$/);
  assert.notEqual(esperada, huellaEstadoCompra(cuentaDistinta, true, true));
  assert.equal(esperada.includes("profesionales"), false);
});
