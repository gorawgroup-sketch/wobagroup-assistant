import assert from "node:assert/strict";
import test from "node:test";
import {
  AjusteCambioInciertoError,
  ejecutarAjusteCambioDurable,
  identidadAjusteCambio,
  reconciliarAjustesCambioPendientes,
  type EstadoAjusteCambio,
  type RegistroAjusteCambio,
  type RepositorioAjustesCambio,
  type TransporteAjusteCambio,
} from "./durableFxResidualAdjustment";

class RepoMemoria implements RepositorioAjustesCambio {
  filas = new Map<string, RegistroAjusteCambio>();
  async reservar(registro: RegistroAjusteCambio) {
    const existente = this.filas.get(registro.clave);
    if (existente) return { registro: { ...existente }, nuevo: false };
    this.filas.set(registro.clave, { ...registro });
    return { registro: { ...registro }, nuevo: true };
  }
  async obtener(clave: string) { const r = this.filas.get(clave); return r ? { ...r } : undefined; }
  async actualizarPreparado(clave: string, registro: RegistroAjusteCambio) {
    const actual = this.filas.get(clave);
    if (!actual || actual.estado !== "preparado") return undefined;
    const siguiente = { ...actual, ...registro, estado: "preparado" as const };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
  async marcarAplicando(clave: string) { return this.cambiar(clave, ["preparado"], "aplicando"); }
  async marcarPreparado(clave: string) { this.cambiar(clave, ["aplicando"], "preparado"); }
  async marcarIncierto(clave: string) { this.cambiar(clave, ["aplicando"], "incierto"); }
  async marcarVerificado(clave: string, resultado: { paymentId: string }) {
    const r = this.cambiar(clave, ["preparado", "aplicando", "incierto"], "verificado");
    if (r) {
      r.paymentId = resultado.paymentId;
      this.filas.set(clave, r);
    }
  }
  async listarPendientes() {
    return [...this.filas.values()].filter((r) => r.estado === "aplicando" || r.estado === "incierto").map((r) => ({ ...r }));
  }
  private cambiar(clave: string, permitidos: EstadoAjusteCambio[], estado: EstadoAjusteCambio) {
    const actual = this.filas.get(clave);
    if (!actual || !permitidos.includes(actual.estado)) return undefined;
    const siguiente = { ...actual, estado, actualizadoEn: 500 };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
}

function registro() {
  return identidadAjusteCambio({
    empresa: "Footprint",
    purchaseId: "purchase-1",
    movementId: "movement-1",
    sourceAccountId: "ftg-usd",
    targetTreasuryId: "main-eur",
    fecha: "2026-09-16",
    monto: 0.01,
    totalNativoCompra: 100,
  }, "test", 1);
}

function transporte(opciones: { aplicadoInicial?: boolean; falla?: boolean; aplicaAntesDeFallar?: boolean } = {}) {
  let aplicado = opciones.aplicadoInicial ?? false;
  const llamadas: string[] = [];
  const valor: TransporteAjusteCambio & { llamadas: string[] } = {
    llamadas,
    async inspeccionar() {
      return aplicado ? { paymentId: "payment-fx", monto: 0.01, pendienteFinal: 0 } : undefined;
    },
    async aplicar(r) {
      llamadas.push(`${r.purchaseId}:${r.targetTreasuryId}`);
      if (opciones.aplicaAntesDeFallar) aplicado = true;
      if (opciones.falla) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      aplicado = true;
    },
  };
  return valor;
}

test("crea una identidad opaca y solo acepta un residuo dentro del margen de la compra", () => {
  const a = registro();
  const b = registro();
  assert.equal(a.clave, b.clave);
  assert.equal(a.clave.includes("purchase-1"), false);
  // Compra chica (total 1): margen = piso de 0,02 — 0,03 queda fuera.
  assert.throws(() => identidadAjusteCambio({
    empresa: "Footprint", purchaseId: "p", movementId: "m", sourceAccountId: "a", targetTreasuryId: "b",
    fecha: "2026-09-16", monto: 0.03, totalNativoCompra: 1,
  }), /margen/);
  assert.throws(() => identidadAjusteCambio({
    empresa: "Footprint", purchaseId: "p", movementId: "m", sourceAccountId: "a", targetTreasuryId: "a",
    fecha: "2026-09-16", monto: 0.01, totalNativoCompra: 100,
  }), /misma cuenta/);
  // Compra grande (total 255,68, caso real Airbnb MEX): 0,26 cabe dentro del margen (techo 1).
  const grande = identidadAjusteCambio({
    empresa: "Footprint", purchaseId: "p", movementId: "m", sourceAccountId: "a", targetTreasuryId: "b",
    fecha: "2026-09-16", monto: 0.26, totalNativoCompra: 255.68,
  });
  assert.equal(grande.montoCentimos, 26);
});

test("aplica una vez y verifica el saldo cero", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  const resultado = await ejecutarAjusteCambioDurable(registro(), repo, holded);
  assert.equal(resultado.reutilizado, false);
  assert.equal(resultado.resultado.pendienteFinal, 0);
  assert.deepEqual(holded.llamadas, ["purchase-1:main-eur"]);

  const repetido = await ejecutarAjusteCambioDurable(registro(), repo, holded);
  assert.equal(repetido.reutilizado, true);
  assert.equal(holded.llamadas.length, 1);
});

test("reconoce un ajuste manual previo sin crear otro pago", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ aplicadoInicial: true });
  const resultado = await ejecutarAjusteCambioDurable(registro(), repo, holded);
  assert.equal(resultado.reutilizado, true);
  assert.equal(holded.llamadas.length, 0);
});

test("si el POST pudo aplicarse antes del timeout, relee y no lo repite", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ falla: true, aplicaAntesDeFallar: true });
  const resultado = await ejecutarAjusteCambioDurable(registro(), repo, holded);
  assert.equal(resultado.reutilizado, true);
  assert.equal(holded.llamadas.length, 1);
});

test("si no puede verificar un timeout, bloquea la repetición", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ falla: true });
  await assert.rejects(() => ejecutarAjusteCambioDurable(registro(), repo, holded), AjusteCambioInciertoError);
  await assert.rejects(() => ejecutarAjusteCambioDurable(registro(), repo, holded), AjusteCambioInciertoError);
  assert.equal(holded.llamadas.length, 1);
});

test("la recuperación de arranque es de solo lectura", async () => {
  const repo = new RepoMemoria();
  const r = registro();
  repo.filas.set(r.clave, { ...r, estado: "aplicando" });
  const holded = transporte({ aplicadoInicial: true });
  const resumen = await reconciliarAjustesCambioPendientes(repo, (x) => holded.inspeccionar(x));
  assert.deepEqual(resumen, { revisados: 1, verificados: 1, inciertos: 0, errores: 0 });
  assert.equal(holded.llamadas.length, 0);
});
