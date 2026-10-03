import assert from "node:assert/strict";
import test from "node:test";
import type { CuentaTransferencia, MovimientoTransferencia } from "./deteccion";
import { ejecutarTransferencia, type DependenciasEjecucion, type LineaAsiento } from "./ejecucion";
import { casosAutorizados, ejecucionAutorizada, modoTransferencias } from "./modo";
import type { RegistroTransferencia } from "./registro";

const O = "a".repeat(24), D = "b".repeat(24);
const registro = (extra: Partial<RegistroTransferencia> = {}): RegistroTransferencia => ({
  clave: `WOBA:${O}>${D}`, id: "abc123def456", empresa: "WOBA", tipo: "transferencia", fecha: "2026-10-01",
  origenCuenta: "main", origenMovimiento: O, origenFecha: "2026-10-01", destinoCuenta: "bbva", destinoMovimiento: D, destinoFecha: "2026-10-01",
  importeOrigen: -350, monedaOrigen: "EUR", importeDestino: 350, monedaDestino: "EUR", estado: "aprobada", versionRegla: "v1", asientoId: "",
  chatId: 1, messageId: 2, detalle: "", creadoEn: 1, actualizadoEn: 1, ...extra,
});

/** Holded simulado: las escrituras cambian el estado que después devuelven las lecturas. */
function holded(opciones: { conciliarFalla?: boolean; asientoExtra?: boolean; conciliarNoSurteEfecto?: boolean } = {}) {
  const cuentas: CuentaTransferencia[] = [
    { id: "main", nombre: "Main", tipo: "bank", moneda: "EUR", archivada: false, proveedor: "Revolut", sincronizadaEn: "2026-10-03", cuentaContable: "57200015" },
    { id: "bbva", nombre: "BBVA", tipo: "bank", moneda: "EUR", archivada: false, proveedor: "BBVA", sincronizadaEn: "2026-10-03", cuentaContable: "57200001" },
  ];
  const movimientos = new Map<string, MovimientoTransferencia>([
    [O, { id: O, cuentaId: "main", fecha: "2026-10-01", importe: -350, moneda: "EUR", descripcion: "To Business Atelier Europa", estado: "pending", conciliado: 0 }],
    [D, { id: D, cuentaId: "bbva", fecha: "2026-10-01", importe: 350, moneda: "EUR", descripcion: "Transferencia propia", estado: "pending", conciliado: 0 }],
  ]);
  const lineas: LineaAsiento[] = [{ asientoId: "previo", cuenta: "57200001", debe: 12, haber: 0, descripcion: "otro cobro", tipo: "collect" }];
  const escrituras: string[] = [];
  const guardados: RegistroTransferencia[] = [];
  const deps: DependenciasEjecucion = {
    leerCuentas: async () => cuentas,
    leerMovimiento: async (_e, _c, id) => movimientos.get(id),
    leerLineas: async (_e, cuenta) => lineas.filter((l) => l.cuenta === cuenta),
    crearAsiento: async (_e, asiento) => {
      escrituras.push(`asiento:${asiento.date}:${asiento.lines.map((l) => `${l.account}/${l.debit}/${l.credit}`).join("|")}`);
      for (const l of asiento.lines) lineas.push({ asientoId: "asiento-1", cuenta: String(l.account), debe: Number(l.debit), haber: Number(l.credit), descripcion: l.description, tipo: "entry" });
      return "asiento-1";
    },
    conciliar: async (_e, _cuenta, movimientoId, asientoId) => {
      escrituras.push(`conciliar:${movimientoId === O ? "origen" : "destino"}:${asientoId}`);
      if (opciones.conciliarFalla && movimientoId === O) throw new Error("Error de la API de Holded (502)");
      if (opciones.conciliarNoSurteEfecto) return;
      const m = movimientos.get(movimientoId)!;
      movimientos.set(movimientoId, { ...m, estado: "forced_reconciled", conciliado: m.importe });
      if (opciones.asientoExtra && movimientoId === D) lineas.push({ asientoId: "cobro-extra", cuenta: "57200001", debe: 350, haber: 0, descripcion: "cobro generado", tipo: "collect" });
    },
    guardar: async (r) => { guardados.push(r); },
  };
  return { deps, cuentas, movimientos, lineas, escrituras, guardados };
}

test("transferencia EUR↔EUR: un asiento debe destino / haber origen, las dos patas conciliadas y verificado por lectura", async () => {
  const h = holded();
  const r = await ejecutarTransferencia(registro(), h.deps);
  assert.equal(r.estado, "verificada");
  assert.deepEqual(h.escrituras, ["asiento:2026-10-01:57200001/350.00/0.00|57200015/0.00/350.00", "conciliar:destino:asiento-1", "conciliar:origen:asiento-1"]);
  // El estado «ejecutando» y el id del asiento quedan guardados antes de seguir.
  assert.deepEqual(h.guardados.map((g) => [g.estado, g.asientoId]), [["ejecutando", ""], ["ejecutando", "asiento-1"], ["verificada", "asiento-1"]]);
  assert.match(r.mensaje, /debe 57200001 \(BBVA\) \/ haber 57200015 \(Main\) por 350\.00 EUR/);
});

test("si algo cambió desde la propuesta no se escribe nada en Holded", async () => {
  const casos: Array<[string, (h: ReturnType<typeof holded>) => void, RegExp]> = [
    ["movimiento ya conciliado", (h) => h.movimientos.set(D, { ...h.movimientos.get(D)!, estado: "reconciled", conciliado: 350 }), /ya no está libre/],
    ["conciliado en parte", (h) => h.movimientos.set(O, { ...h.movimientos.get(O)!, conciliado: -100 }), /ya no está libre/],
    ["movimiento desaparecido", (h) => h.movimientos.delete(O), /ya no aparece/],
    ["importe distinto", (h) => h.movimientos.set(D, { ...h.movimientos.get(D)!, importe: 351 }), /importe de algún movimiento cambió/],
    ["cuenta archivada", (h) => { h.cuentas[1].archivada = true; }, /archivada/],
    ["cuenta sin 572/520", (h) => { h.cuentas[1].cuentaContable = "43000001"; }, /572\/520/],
    ["pasarela", (h) => { h.cuentas[0].tipo = "gateway"; }, /no es una cuenta bancaria/],
  ];
  for (const [nombre, alterar, motivo] of casos) {
    const h = holded();
    alterar(h);
    const r = await ejecutarTransferencia(registro(), h.deps);
    assert.equal(r.estado, "revision_manual", nombre);
    assert.match(r.mensaje, motivo, nombre);
    assert.deepEqual(h.escrituras, [], nombre);
  }
});

test("las conversiones de moneda no se ejecutan en esta fase", async () => {
  const h = holded();
  const r = await ejecutarTransferencia(registro({ tipo: "conversion", monedaOrigen: "USD", importeOrigen: -400 }), h.deps);
  assert.equal(r.estado, "revision_manual");
  assert.deepEqual(h.escrituras, []);
});

test("solo se ejecuta una operación aprobada; una ya verificada no repite nada", async () => {
  for (const estado of ["propuesta", "detectada", "saltada", "descartada", "verificada"] as const) {
    const h = holded();
    const r = await ejecutarTransferencia(registro({ estado }), h.deps);
    assert.equal(r.estado, estado);
    assert.deepEqual(h.escrituras, []);
  }
});

test("una conciliación que falla tras crear el asiento no se reintenta: queda fallida con el asiento a la vista", async () => {
  const h = holded({ conciliarFalla: true });
  const r = await ejecutarTransferencia(registro(), h.deps);
  assert.equal(r.estado, "fallida");
  assert.match(r.mensaje, /asiento asiento-1 se creó.*No se reintenta solo/);
  assert.equal(h.escrituras.filter((e) => e.startsWith("asiento")).length, 1);
  // Volver a pulsar no escribe nada: solo verifica por lectura.
  const antes = h.escrituras.length;
  const otra = await ejecutarTransferencia(r.registro, h.deps);
  assert.equal(otra.estado, "fallida");
  assert.equal(h.escrituras.length, antes);
});

test("un corte en mitad de la ejecución no repite escrituras: se verifica cómo quedó", async () => {
  const sinAsiento = holded();
  const r1 = await ejecutarTransferencia(registro({ estado: "ejecutando" }), sinAsiento.deps);
  assert.equal(r1.estado, "fallida");
  assert.deepEqual(sinAsiento.escrituras, []);

  // El intento anterior sí terminó en Holded, pero el proceso murió antes de anotarlo.
  const completo = holded();
  await ejecutarTransferencia(registro(), completo.deps);
  const escriturasPrevias = completo.escrituras.length;
  const r2 = await ejecutarTransferencia(registro({ estado: "ejecutando", asientoId: "asiento-1" }), completo.deps);
  assert.equal(r2.estado, "verificada");
  assert.equal(completo.escrituras.length, escriturasPrevias);
});

test("HTTP 200 no basta: si los movimientos no quedan conciliados o aparece otro asiento, es un fallo y se detiene", async () => {
  const sinEfecto = holded({ conciliarNoSurteEfecto: true });
  const r1 = await ejecutarTransferencia(registro(), sinEfecto.deps);
  assert.equal(r1.estado, "fallida");
  assert.match(r1.mensaje, /no quedó conciliado/);

  const duplicado = holded({ asientoExtra: true });
  const r2 = await ejecutarTransferencia(registro(), duplicado.deps);
  assert.equal(r2.estado, "fallida");
  assert.match(r2.mensaje, /aparecieron 2 líneas nuevas; se esperaba 1/);
});

test("si ya existe un asiento con la marca de la operación, no se crea otro", async () => {
  const h = holded();
  h.lineas.push({ asientoId: "viejo", cuenta: "57200001", debe: 350, haber: 0, descripcion: "Transferencia [wobi:transferencia:abc123def456]", tipo: "entry" });
  const r = await ejecutarTransferencia(registro(), h.deps);
  assert.equal(r.estado, "fallida");
  assert.deepEqual(h.escrituras, []);
});

test("el interruptor: apagado por defecto, y en activo solo ejecuta las parejas autorizadas por escrito", () => {
  const clave = `WOBA:${O}>${D}`;
  assert.equal(modoTransferencias({}), "apagado");
  assert.equal(modoTransferencias({ WOBI_TRANSFERENCIAS_MODO: "cualquiera" }), "apagado");
  assert.equal(modoTransferencias({ WOBI_TRANSFERENCIAS_MODO: "Observación" }), "observacion");
  assert.equal(ejecucionAutorizada(clave, { WOBI_TRANSFERENCIAS_MODO: "observacion", WOBI_TRANSFERENCIAS_CASOS: clave }), false);
  assert.equal(ejecucionAutorizada(clave, { WOBI_TRANSFERENCIAS_MODO: "activo" }), false);
  assert.equal(ejecucionAutorizada(clave, { WOBI_TRANSFERENCIAS_MODO: "activo", WOBI_TRANSFERENCIAS_CASOS: ` ${clave} , basura, WOBA:xx>yy` }), true);
  assert.equal(ejecucionAutorizada(`WOBA:${D}>${O}`, { WOBI_TRANSFERENCIAS_MODO: "activo", WOBI_TRANSFERENCIAS_CASOS: clave }), false);
  assert.equal(casosAutorizados({ WOBI_TRANSFERENCIAS_CASOS: "*,todas" }).size, 0);
});
