import assert from "node:assert/strict";
import test from "node:test";
import {
  ConciliacionMovimientoInciertaError,
  ConflictoConciliacionMovimientoError,
  MovimientoYaConciliadoError,
  ejecutarConciliacionMovimientoDurable,
  esRechazoDefinitivoConciliacion,
  identidadConciliacionMovimiento,
  reconciliarConciliacionesMovimientoPendientes,
  type EstadoConciliacionMovimiento,
  type InspeccionConciliacionMovimiento,
  type RegistroConciliacionMovimiento,
  type RepositorioConciliacionesMovimiento,
  type TransporteConciliacionMovimiento,
} from "./durableBankReconciliation";
import { configuracionConciliacionesMovimientoDurables, verificarPagoCompraEnMovimiento } from "./write";

class RepoMemoria implements RepositorioConciliacionesMovimiento {
  filas = new Map<string, RegistroConciliacionMovimiento>();
  fallarCheckpoint = false;

  async reservar(registro: RegistroConciliacionMovimiento) {
    const existente = this.filas.get(registro.clave);
    if (existente) return { registro: { ...existente }, nuevo: false };
    this.filas.set(registro.clave, { ...registro });
    return { registro: { ...registro }, nuevo: true };
  }
  async obtener(clave: string) { const r = this.filas.get(clave); return r ? { ...r } : undefined; }
  async actualizarPreparada(clave: string, registro: RegistroConciliacionMovimiento) {
    const actual = this.filas.get(clave);
    if (!actual || actual.estado !== "preparada") return undefined;
    const siguiente = { ...actual, ...registro, estado: "preparada" as const };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
  async marcarConciliando(clave: string) { return this.cambiar(clave, ["preparada"], "conciliando"); }
  async marcarPreparada(clave: string) { this.cambiar(clave, ["conciliando"], "preparada"); }
  async marcarIncierta(clave: string) { this.cambiar(clave, ["conciliando"], "incierta"); }
  async marcarVerificada(clave: string) {
    if (this.fallarCheckpoint) throw new Error("Sheets no responde");
    this.cambiar(clave, ["conciliando", "incierta"], "verificada");
  }
  async listarPendientes() {
    return [...this.filas.values()]
      .filter((r) => r.estado === "conciliando" || r.estado === "incierta")
      .map((r) => ({ ...r }));
  }
  private cambiar(
    clave: string,
    permitidos: EstadoConciliacionMovimiento[],
    estado: EstadoConciliacionMovimiento
  ) {
    const actual = this.filas.get(clave);
    if (!actual || !permitidos.includes(actual.estado)) return undefined;
    const siguiente = {
      ...actual,
      estado,
      actualizadoEn: 500,
      ...(estado === "verificada" ? { verificadoEn: 500 } : {}),
    };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
}

function transporte(opciones: {
  aplicadaInicial?: boolean;
  encontrada?: boolean;
  errorConciliacion?: unknown;
  aplicarAntesDeError?: boolean;
  errorInspeccion?: unknown;
} = {}) {
  let aplicada = opciones.aplicadaInicial ?? false;
  const conciliaciones: string[] = [];
  const inspecciones: string[] = [];
  const resultado = { ok: true, statusFinal: "reconciled", montoEnlazado: 125.5 };
  const valor: TransporteConciliacionMovimiento & {
    conciliaciones: string[];
    inspecciones: string[];
    aplicar(): void;
  } = {
    conciliaciones,
    inspecciones,
    async inspeccionar(registro): Promise<InspeccionConciliacionMovimiento> {
      inspecciones.push(registro.movementId);
      if (opciones.errorInspeccion) throw opciones.errorInspeccion;
      if (opciones.encontrada === false) return { estado: "no_encontrada" };
      return aplicada
        ? { estado: "verificada", resultado }
        : { estado: "libre", resultado: { ok: false, statusFinal: "pending", montoEnlazado: 0 } };
    },
    async conciliar(registro) {
      conciliaciones.push(registro.documentId);
      if (opciones.aplicarAntesDeError) aplicada = true;
      if (opciones.errorConciliacion) throw opciones.errorConciliacion;
      aplicada = true;
    },
    aplicar() { aplicada = true; },
  };
  return valor;
}

function identidad(documentId = "purchase-1", ahora = 1) {
  return identidadConciliacionMovimiento(
    "WOBA", "account-1", "movement-1", documentId, "2026-09-11", "test", ahora
  );
}

test("una aprobación concilia una sola vez y una repetición solo relee", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  const primero = await ejecutarConciliacionMovimientoDurable(identidad(), repo, holded);
  const segundo = await ejecutarConciliacionMovimientoDurable(identidad("purchase-1", 2), repo, holded);
  assert.equal(primero.reutilizada, false);
  assert.equal(segundo.reutilizada, true);
  assert.equal(segundo.resultado.montoEnlazado, 125.5);
  assert.equal(holded.conciliaciones.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "verificada");
});

test("un movimiento ya conciliado antes de reservar nunca dispara POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ aplicadaInicial: true });
  await assert.rejects(ejecutarConciliacionMovimientoDurable(identidad(), repo, holded), MovimientoYaConciliadoError);
  assert.equal(holded.conciliaciones.length, 0);
  assert.equal(repo.filas.values().next().value?.estado, "preparada");
});

test("un movimiento ocupado por otro documento nunca dispara POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  holded.inspeccionar = async () => ({
    estado: "ocupada",
    resultado: { ok: false, statusFinal: "reconciled", montoEnlazado: 125.5 },
  });
  await assert.rejects(ejecutarConciliacionMovimientoDurable(identidad(), repo, holded), MovimientoYaConciliadoError);
  assert.equal(holded.conciliaciones.length, 0);
});

test("un movimiento inexistente falla cerrado antes del POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ encontrada: false });
  await assert.rejects(ejecutarConciliacionMovimientoDurable(identidad(), repo, holded), /no aparece/);
  assert.equal(holded.conciliaciones.length, 0);
});

test("una ejecución interrumpida aplicada se recupera únicamente por lectura", async () => {
  const repo = new RepoMemoria();
  const registro = { ...identidad(), estado: "conciliando" as const };
  repo.filas.set(registro.clave, registro);
  const holded = transporte({ aplicadaInicial: true });
  const resultado = await ejecutarConciliacionMovimientoDurable(identidad(), repo, holded);
  assert.equal(resultado.reutilizada, true);
  assert.equal(holded.conciliaciones.length, 0);
  assert.equal(repo.filas.get(registro.clave)?.estado, "verificada");
});

test("una ejecución interrumpida no confirmada queda incierta y nunca repite", async () => {
  const repo = new RepoMemoria();
  const registro = { ...identidad(), estado: "conciliando" as const };
  repo.filas.set(registro.clave, registro);
  const holded = transporte();
  await assert.rejects(ejecutarConciliacionMovimientoDurable(identidad(), repo, holded), ConciliacionMovimientoInciertaError);
  await assert.rejects(ejecutarConciliacionMovimientoDurable(identidad(), repo, holded), ConciliacionMovimientoInciertaError);
  assert.equal(holded.conciliaciones.length, 0);
  assert.equal(repo.filas.get(registro.clave)?.estado, "incierta");
});

test("timeout aplicado se confirma por lectura sin repetir POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ errorConciliacion: new Error("timeout"), aplicarAntesDeError: true });
  const resultado = await ejecutarConciliacionMovimientoDurable(identidad(), repo, holded);
  assert.equal(resultado.reutilizada, true);
  assert.equal(holded.conciliaciones.length, 1);
});

test("timeout no verificable queda incierto y nunca repite POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ errorConciliacion: new Error("timeout") });
  await assert.rejects(ejecutarConciliacionMovimientoDurable(identidad(), repo, holded), ConciliacionMovimientoInciertaError);
  await assert.rejects(ejecutarConciliacionMovimientoDurable(identidad("purchase-1", 2), repo, holded), ConciliacionMovimientoInciertaError);
  assert.equal(holded.conciliaciones.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "incierta");
});

test("422 nunca permite repetir: puede significar que la conciliación ya estaba aplicada", async () => {
  const repo = new RepoMemoria();
  const error422 = Object.assign(new Error("document already paid"), { status: 422 });
  const holded = transporte({ errorConciliacion: error422, aplicarAntesDeError: true });
  const resultado = await ejecutarConciliacionMovimientoDurable(identidad(), repo, holded);
  assert.equal(resultado.reutilizada, true);
  assert.equal(holded.conciliaciones.length, 1);
  assert.equal(esRechazoDefinitivoConciliacion(error422), false);
});

test("422 sin confirmación queda incierto en vez de volver a preparada", async () => {
  const repo = new RepoMemoria();
  const error422 = Object.assign(new Error("remaining amount is zero"), { status: 422 });
  const holded = transporte({ errorConciliacion: error422 });
  await assert.rejects(ejecutarConciliacionMovimientoDurable(identidad(), repo, holded), ConciliacionMovimientoInciertaError);
  assert.equal(repo.filas.values().next().value?.estado, "incierta");
});

test("un 403 inequívoco vuelve a preparada y permite reintento explícito", async () => {
  const repo = new RepoMemoria();
  const error403 = Object.assign(new Error("forbidden"), { status: 403 });
  await assert.rejects(
    ejecutarConciliacionMovimientoDurable(identidad(), repo, transporte({ errorConciliacion: error403 })),
    error403
  );
  assert.equal(repo.filas.values().next().value?.estado, "preparada");
  const recuperado = transporte();
  await ejecutarConciliacionMovimientoDurable(identidad(), repo, recuperado);
  assert.equal(recuperado.conciliaciones.length, 1);
});

test("otro documento se bloquea si el mismo movimiento quedó incierto", async () => {
  const repo = new RepoMemoria();
  await assert.rejects(
    ejecutarConciliacionMovimientoDurable(identidad(), repo, transporte({ errorConciliacion: new Error("timeout") })),
    ConciliacionMovimientoInciertaError
  );
  await assert.rejects(
    ejecutarConciliacionMovimientoDurable(identidad("purchase-2", 2), repo, transporte()),
    ConflictoConciliacionMovimientoError
  );
});

test("fallo del checkpoint posterior al POST nunca permite un segundo POST", async () => {
  const repo = new RepoMemoria();
  repo.fallarCheckpoint = true;
  const holded = transporte();
  await assert.rejects(ejecutarConciliacionMovimientoDurable(identidad(), repo, holded), ConciliacionMovimientoInciertaError);
  await assert.rejects(ejecutarConciliacionMovimientoDurable(identidad(), repo, holded), ConciliacionMovimientoInciertaError);
  assert.equal(holded.conciliaciones.length, 1);
});

test("la reconciliación de arranque confirma sin ejecutar escrituras", async () => {
  const repo = new RepoMemoria();
  const a = { ...identidad("purchase-a"), estado: "conciliando" as const };
  const bBase = identidadConciliacionMovimiento(
    "WOBA", "account-1", "movement-2", "purchase-b", "2026-09-11", "test", 1
  );
  const b = { ...bBase, estado: "incierta" as const };
  repo.filas.set(a.clave, a);
  repo.filas.set(b.clave, b);
  const holded = transporte({ aplicadaInicial: true });
  const resumen = await reconciliarConciliacionesMovimientoPendientes(repo, async (registro) =>
    registro.movementId === "movement-1"
      ? holded.inspeccionar(registro)
      : { estado: "libre", resultado: { ok: false, statusFinal: "pending", montoEnlazado: 0 } }
  );
  assert.deepEqual(resumen, { revisadas: 2, verificadas: 1, inciertas: 1, errores: 0 });
  assert.equal(repo.filas.get(a.clave)?.estado, "verificada");
  assert.equal(repo.filas.get(b.clave)?.estado, "incierta");
  assert.equal(holded.conciliaciones.length, 0);
});

test("la identidad es estable, opaca y única por movimiento", () => {
  const a = identidadConciliacionMovimiento("WOBA", "cuenta-secreta", "mov-secreto", "doc-secreto", "2026-09-11", "test", 1);
  const b = identidadConciliacionMovimiento("WOBA", "cuenta-secreta", "mov-secreto", "doc-secreto", "2026-09-11", "test", 2);
  const c = identidadConciliacionMovimiento("WOBA", "cuenta-secreta", "otro-mov", "doc-secreto", "2026-09-11", "test", 1);
  assert.equal(a.clave, b.clave);
  assert.notEqual(a.clave, c.clave);
  assert.equal(a.clave.includes("secreto"), false);
  assert.equal(a.huellaSolicitud.includes("secreto"), false);
  assert.throws(
    () => identidadConciliacionMovimiento("WOBA", "a", "m", "d", "11/09/2026", "test"),
    /YYYY-MM-DD/
  );
});

test("la protección solo se desactiva con false explícito", () => {
  assert.equal(configuracionConciliacionesMovimientoDurables({} as NodeJS.ProcessEnv).habilitado, true);
  assert.equal(
    configuracionConciliacionesMovimientoDurables({ WOBI_HOLDED_RECONCILIATION_DURABLE_ENABLED: " false " } as NodeJS.ProcessEnv).habilitado,
    false
  );
  assert.equal(
    configuracionConciliacionesMovimientoDurables({ WOBI_HOLDED_RECONCILIATION_DURABLE_ENABLED: "falso" } as NodeJS.ProcessEnv).habilitado,
    true
  );
});

test("confirma el pago del documento por cuenta, fecha e importe enlazado", () => {
  const resultado = verificarPagoCompraEnMovimiento(
    {
      payments_detail: [{ id: "payment-1", bank_id: "account-1", date: "2026-09-11", amount: "24,20" }],
      payments_pending: "0,00",
    },
    "account-1",
    "2026-09-11",
    24.2
  );
  assert.deepEqual(resultado, { montoPago: 24.2 });
});

test("no atribuye al documento un pago de otra cuenta, fecha o importe", () => {
  const compra = {
    payments_detail: [{ id: "payment-1", bank_id: "account-2", date: "2026-09-10", amount: "25,20" }],
    payments_pending: "0,00",
  };
  assert.equal(verificarPagoCompraEnMovimiento(compra, "account-1", "2026-09-11", 24.2), undefined);
});

test("conserva el saldo pendiente de una compra aunque el vínculo esté confirmado", () => {
  const resultado = verificarPagoCompraEnMovimiento(
    {
      payments_detail: [{ bank_id: "account-1", date: "2026-09-11T10:00:00Z", amount: "554,84" }],
      payments_pending: "76,45",
    },
    "account-1",
    "2026-09-11",
    554.84
  );
  assert.deepEqual(resultado, { montoPago: 554.84, pendienteEnCompra: 76.45 });
});
