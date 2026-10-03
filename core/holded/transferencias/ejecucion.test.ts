import assert from "node:assert/strict";
import test from "node:test";
import { EscrituraHoldedNoIniciadaError } from "../../gmail/automatico/postgres";
import type { CuentaTransferencia, MovimientoTransferencia } from "./deteccion";
import { ejecutarTransferencia, importeDeHolded, type DependenciasEjecucion, type LineaAsiento } from "./ejecucion";
import { casosAutorizados, ejecucionAutorizada, modoTransferencias } from "./modo";
import type { RegistroTransferencia } from "./registro";

const O = "a".repeat(24), D = "b".repeat(24);
const HOY = "2026-10-03";
const registro = (extra: Partial<RegistroTransferencia> = {}): RegistroTransferencia => ({
  clave: `WOBA:${O}>${D}`, id: "abc123def456", empresa: "WOBA", tipo: "transferencia", fecha: "2026-10-01",
  origenCuenta: "main", origenMovimiento: O, origenFecha: "2026-10-01", destinoCuenta: "bbva", destinoMovimiento: D, destinoFecha: "2026-10-01",
  importeOrigen: -350, monedaOrigen: "EUR", importeDestino: 350, monedaDestino: "EUR", estado: "aprobada", versionRegla: "v1", asientoId: "",
  chatId: 1, messageId: 2, detalle: "", creadoEn: 1, actualizadoEn: 1, ...extra,
});

type LineaConFecha = LineaAsiento & { fecha: string };
interface Opciones {
  conciliarFalla?: boolean; conciliarNoSurteEfecto?: boolean; noInequivoca?: string;
  /** La conciliación genera otro asiento, fechado el día indicado. */
  asientoExtraFechado?: string;
  errorAlCrear?: Error;
}

/** Holded simulado: las escrituras cambian el estado que después devuelven las lecturas. */
function holded(opciones: Opciones = {}) {
  const cuentas: CuentaTransferencia[] = [
    { id: "main", nombre: "Main", tipo: "bank", moneda: "EUR", archivada: false, proveedor: "Revolut", sincronizadaEn: "2026-10-03", cuentaContable: "57200015" },
    { id: "bbva", nombre: "BBVA", tipo: "bank", moneda: "EUR", archivada: false, proveedor: "BBVA", sincronizadaEn: "2026-10-03", cuentaContable: "57200001" },
  ];
  const movimientos = new Map<string, MovimientoTransferencia>([
    [O, { id: O, cuentaId: "main", fecha: "2026-10-01", importe: -350, moneda: "EUR", descripcion: "To Business Atelier Europa", estado: "pending", conciliado: 0 }],
    [D, { id: D, cuentaId: "bbva", fecha: "2026-10-01", importe: 350, moneda: "EUR", descripcion: "Transferencia propia", estado: "pending", conciliado: 0 }],
  ]);
  const lineas: LineaConFecha[] = [{ asientoId: "previo", cuenta: "57200001", debe: 12, haber: 0, descripcion: "otro cobro", fecha: "2026-10-01" }];
  const escrituras: string[] = [];
  const guardados: RegistroTransferencia[] = [];
  const deps: DependenciasEjecucion = {
    leerCuentas: async () => cuentas,
    leerMovimiento: async (_e, _c, id) => movimientos.get(id),
    leerLineas: async (_e, cuenta, desde, hasta) => lineas.filter((l) => l.cuenta === cuenta && l.fecha >= desde && l.fecha <= hasta),
    leerAsiento: async (_e, id) => {
      const suyas = lineas.filter((l) => l.asientoId === id);
      return suyas.length ? { id, fecha: suyas[0].fecha, lineas: suyas.map((l) => ({ cuenta: l.cuenta, debe: l.debe, haber: l.haber })) } : undefined;
    },
    motivoYaNoInequivoca: async () => opciones.noInequivoca,
    crearAsiento: async (_e, asiento) => {
      escrituras.push(`asiento:${asiento.date}:${asiento.lines.map((l) => `${l.account}/${l.debit}/${l.credit}`).join("|")}`);
      if (opciones.errorAlCrear) throw opciones.errorAlCrear;
      for (const l of asiento.lines) lineas.push({ asientoId: "asiento-1", cuenta: String(l.account), debe: Number(l.debit), haber: Number(l.credit), descripcion: l.description, fecha: asiento.date });
      return "asiento-1";
    },
    conciliar: async (_e, _cuenta, movimientoId, asientoId) => {
      escrituras.push(`conciliar:${movimientoId === O ? "origen" : "destino"}:${asientoId}`);
      if (opciones.conciliarFalla && movimientoId === O) throw new Error("Error de la API de Holded (502)");
      if (opciones.conciliarNoSurteEfecto) return;
      const m = movimientos.get(movimientoId)!;
      movimientos.set(movimientoId, { ...m, estado: "forced_reconciled", conciliado: m.importe });
      if (opciones.asientoExtraFechado && movimientoId === D) lineas.push({ asientoId: "cobro-extra", cuenta: "57200001", debe: 350, haber: 0, descripcion: "cobro generado", fecha: opciones.asientoExtraFechado });
    },
    guardar: async (r) => { guardados.push(r); },
    hoy: () => HOY,
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

test("si al repetir la detección la pareja ya no es inequívoca (apareció otro candidato), no se escribe nada", async () => {
  const h = holded({ noInequivoca: "Ambiguo: alguno de estos movimientos también encaja con otro." });
  const r = await ejecutarTransferencia(registro(), h.deps);
  assert.equal(r.estado, "revision_manual");
  assert.match(r.mensaje, /Ambiguo/);
  assert.deepEqual(h.escrituras, []);
});

test("conversiones, transferencias que no son en EUR y registros que no coinciden con su clave no se ejecutan", async () => {
  const casos: Array<[Partial<RegistroTransferencia>, RegExp]> = [
    [{ tipo: "conversion", monedaOrigen: "USD", importeOrigen: -400 }, /conversiones de moneda/],
    // Un asiento de 1.000 «USD» se escribiría como 1.000 EUR en el diario.
    [{ monedaOrigen: "USD", monedaDestino: "USD" }, /solo se ejecutan transferencias en EUR/],
    [{ origenMovimiento: "c".repeat(24) }, /no coincide con su clave/],
    [{ empresa: "Footprint" }, /no coincide con su clave/],
  ];
  for (const [extra, motivo] of casos) {
    const h = holded();
    const r = await ejecutarTransferencia(registro(extra), h.deps);
    assert.equal(r.estado, "revision_manual");
    assert.match(r.mensaje, motivo);
    assert.deepEqual(h.escrituras, []);
  }
});

test("solo se ejecuta una operación aprobada; una ya verificada no repite nada", async () => {
  for (const estado of ["propuesta", "detectada", "saltada", "descartada", "ambigua", "verificada"] as const) {
    const h = holded();
    const r = await ejecutarTransferencia(registro({ estado }), h.deps);
    assert.equal(r.estado, estado);
    assert.deepEqual(h.escrituras, []);
  }
});

test("un rechazo de Holded antes de crear el asiento no quema la operación: vuelve a estar disponible", async () => {
  for (const error of [new EscrituraHoldedNoIniciadaError(new Error("Recurso reservado")), Object.assign(Object.create((await import("../write")).HoldedApiError.prototype), { status: 422, message: "Error de la API de Holded (422)" })]) {
    const h = holded({ errorAlCrear: error as Error });
    const r = await ejecutarTransferencia(registro(), h.deps);
    assert.equal(r.estado, "propuesta");
    assert.match(r.mensaje, /No se escribió nada en Holded/);
    assert.equal(h.escrituras.filter((e) => e.startsWith("conciliar")).length, 0);
  }
});

test("una creación de asiento sin respuesta clara queda fallida y, al verificar, se busca por su marca", async () => {
  const h = holded({ errorAlCrear: new Error("The operation was aborted due to timeout") });
  const r = await ejecutarTransferencia(registro(), h.deps);
  assert.equal(r.estado, "fallida");
  assert.equal(r.registro.asientoId, "");
  // El asiento SÍ se había creado en Holded y quedó sin conciliar: la verificación lo encuentra por la marca.
  h.lineas.push({ asientoId: "huerfano", cuenta: "57200001", debe: 350, haber: 0, descripcion: "Transferencia [wobi:transferencia:abc123def456]", fecha: "2026-10-01" },
    { asientoId: "huerfano", cuenta: "57200015", debe: 0, haber: 350, descripcion: "Transferencia [wobi:transferencia:abc123def456]", fecha: "2026-10-01" });
  const escriturasAntes = h.escrituras.length;
  const otra = await ejecutarTransferencia(r.registro, h.deps);
  assert.equal(otra.estado, "fallida");
  assert.equal(otra.registro.asientoId, "huerfano");
  assert.match(otra.mensaje, /asiento huerfano/);
  assert.equal(h.escrituras.length, escriturasAntes);
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

  // El intento anterior sí terminó en Holded, pero el proceso murió antes de anotarlo (ni siquiera el id del asiento).
  const completo = holded();
  await ejecutarTransferencia(registro(), completo.deps);
  const escriturasPrevias = completo.escrituras.length;
  const r2 = await ejecutarTransferencia(registro({ estado: "ejecutando", asientoId: "" }), completo.deps);
  assert.equal(r2.estado, "verificada");
  assert.equal(r2.registro.asientoId, "asiento-1");
  assert.equal(completo.escrituras.length, escriturasPrevias);
});

test("HTTP 200 no basta: movimientos sin conciliar, u otro asiento generado (también si Holded lo fecha hoy), son un fallo", async () => {
  const sinEfecto = holded({ conciliarNoSurteEfecto: true });
  const r1 = await ejecutarTransferencia(registro(), sinEfecto.deps);
  assert.equal(r1.estado, "fallida");
  assert.match(r1.mensaje, /no quedó conciliado/);

  for (const fecha of ["2026-10-01", HOY]) {
    const duplicado = holded({ asientoExtraFechado: fecha });
    const r2 = await ejecutarTransferencia(registro(), duplicado.deps);
    assert.equal(r2.estado, "fallida", `asiento extra fechado ${fecha}`);
    assert.match(r2.mensaje, /aparecieron 2 líneas nuevas; se esperaba 1/);
  }
});

test("si ya existe un asiento con la marca de la operación, no se crea otro", async () => {
  const h = holded();
  h.lineas.push({ asientoId: "viejo", cuenta: "57200001", debe: 350, haber: 0, descripcion: "Transferencia [wobi:transferencia:abc123def456]", fecha: "2026-10-02" });
  const r = await ejecutarTransferencia(registro(), h.deps);
  assert.equal(r.estado, "fallida");
  assert.deepEqual(h.escrituras, []);
});

test("Holded devuelve los importes con punto en el listado y con coma en el asiento por id", () => {
  assert.equal(importeDeHolded("1300.00"), 1300);
  assert.equal(importeDeHolded("1300,00"), 1300);
  assert.equal(importeDeHolded("1.300,50"), 1300.5);
  assert.equal(importeDeHolded(350), 350);
  assert.equal(importeDeHolded(null), 0);
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
