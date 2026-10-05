import assert from "node:assert/strict";
import test from "node:test";
import type { CuentaTransferencia, MovimientoTransferencia } from "./deteccion";
import { ejecutarTransferencia, importeDeHolded, type DependenciasEjecucion, type LineaAsiento, type PagoTransferencia } from "./ejecucion";
import { casosAutorizados, ejecucionAutorizada, modoTransferencias } from "./modo";
import { importeEnPantalla } from "./navegadorTransferencia";
import type { RegistroTransferencia } from "./registro";

const O = "a".repeat(24), D = "b".repeat(24);
const HOY = "2026-10-03";
const SI = { permitirEscritura: true };
const registro = (extra: Partial<RegistroTransferencia> = {}): RegistroTransferencia => ({
  clave: `WOBA:${O}>${D}`, id: "abc123def456", empresa: "WOBA", tipo: "transferencia", fecha: "2026-10-01",
  origenCuenta: "main", origenMovimiento: O, origenFecha: "2026-10-01", destinoCuenta: "bbva", destinoMovimiento: D, destinoFecha: "2026-10-01",
  importeOrigen: -350, monedaOrigen: "EUR", importeDestino: 350, monedaDestino: "EUR", estado: "aprobada", versionRegla: "v1", asientoId: "",
  chatId: 1, messageId: 2, detalle: "", creadoEn: 1, actualizadoEn: 1, ...extra,
});

type LineaConFecha = LineaAsiento & { fecha: string };
interface Opciones {
  /** El robot no llega a pulsar el botón final (elemento no encontrado, sesión caducada, navegador ocupado). */
  robotNoPulsa?: string;
  /** El robot pulsa, pero Holded no registra la transferencia. */
  transferirSinEfecto?: boolean;
  conciliarFalla?: boolean; conciliarNoSurteEfecto?: boolean; noInequivoca?: string;
  /** Holded genera otro asiento además del de la transferencia, fechado el día indicado. */
  asientoExtraFechado?: string;
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
  const pagos: Array<PagoTransferencia & { movimiento: string }> = [];
  const escrituras: string[] = [];
  const guardados: RegistroTransferencia[] = [];
  /** Lo que deja «Transferir y conciliar» sobre el movimiento de entrada. */
  const transferirEnHolded = () => {
    lineas.push({ asientoId: "cobro-1", cuenta: "57200001", debe: 350, haber: 0, descripcion: "Transferencia propia", fecha: "2026-10-01" });
    lineas.push({ asientoId: "cobro-1", cuenta: "57200015", debe: 0, haber: 350, descripcion: "Transferencia propia", fecha: "2026-10-01" });
    movimientos.set(D, { ...movimientos.get(D)!, estado: "reconciled", conciliado: 350 });
    pagos.push({ id: "cobro-doc", tipo: "collection", cuentaId: "bbva", importe: 350, conciliado: true, movimiento: D });
    pagos.push({ id: "pago-doc", tipo: "payment", cuentaId: "main", importe: 350, conciliado: false, movimiento: D });
    if (opciones.asientoExtraFechado) lineas.push({ asientoId: "extra", cuenta: "57200001", debe: 350, haber: 0, descripcion: "cobro generado", fecha: opciones.asientoExtraFechado });
  };
  const deps: DependenciasEjecucion = {
    leerCuentas: async () => cuentas,
    leerMovimiento: async (_e, _c, id) => movimientos.get(id),
    leerLineas: async (_e, cuenta, desde, hasta) => lineas.filter((l) => l.cuenta === cuenta && l.fecha >= desde && l.fecha <= hasta),
    leerAsiento: async (_e, id) => {
      const suyas = lineas.filter((l) => l.asientoId === id);
      return suyas.length ? { id, fecha: suyas[0].fecha, lineas: suyas.map((l) => ({ cuenta: l.cuenta, debe: l.debe, haber: l.haber })) } : undefined;
    },
    leerPagosDeTransferencia: async (_e, movimientoId) => pagos.filter((p) => p.movimiento === movimientoId),
    motivoYaNoInequivoca: async () => opciones.noInequivoca,
    transferir: async (_e, orden) => {
      if (opciones.robotNoPulsa) return { estado: "elemento_no_encontrado", detalle: opciones.robotNoPulsa, pulsado: false };
      escrituras.push(`transferir:${orden.cuentaId}:${orden.movimientoId === D ? "destino" : "origen"}:${orden.cuentaContable}:${orden.importe}`);
      if (!opciones.transferirSinEfecto) transferirEnHolded();
      return { estado: "ok", pulsado: true };
    },
    conciliarConPago: async (_e, cuentaId, movimientoId, pagoId, tipo) => {
      escrituras.push(`conciliar:${cuentaId}:${movimientoId === O ? "origen" : "destino"}:${pagoId}:${tipo}`);
      if (opciones.conciliarFalla) throw new Error("Error de la API de Holded (502)");
      if (opciones.conciliarNoSurteEfecto) return;
      const m = movimientos.get(movimientoId)!;
      movimientos.set(movimientoId, { ...m, estado: "reconciled", conciliado: m.importe });
      pagos.find((p) => p.id === pagoId)!.conciliado = true;
    },
    guardar: async (r) => { guardados.push(r); },
    hoy: () => HOY,
    esperar: async () => undefined,
  };
  return { deps, cuentas, movimientos, lineas, pagos, escrituras, guardados, transferirEnHolded };
}

const TRANSFERIR = "transferir:bbva:destino:57200015:350", CONCILIAR = "conciliar:main:origen:pago-doc:payment";

test("transferencia EUR↔EUR: «Transferir» sobre la entrada con la cuenta contable del origen, y la salida contra el pago generado", async () => {
  const h = holded();
  const r = await ejecutarTransferencia(registro(), h.deps, SI);
  assert.equal(r.estado, "verificada");
  assert.deepEqual(h.escrituras, [TRANSFERIR, CONCILIAR]);
  // «ejecutando» queda guardado antes de actuar; al final consta el asiento que creó Holded.
  assert.deepEqual(h.guardados.map((g) => [g.estado, g.asientoId]), [["ejecutando", ""], ["verificada", "cobro-1"]]);
  assert.match(r.mensaje, /Main → BBVA por 350\.00 EUR/);
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
    const r = await ejecutarTransferencia(registro(), h.deps, SI);
    assert.equal(r.estado, "propuesta", nombre);
    assert.match(r.mensaje, motivo, nombre);
    assert.deepEqual(h.escrituras, [], nombre);
  }
});

test("si al repetir la detección la pareja ya no es inequívoca (apareció otro candidato), no se escribe nada", async () => {
  const h = holded({ noInequivoca: "Ambiguo: alguno de estos movimientos también encaja con otro." });
  const r = await ejecutarTransferencia(registro(), h.deps, SI);
  assert.equal(r.estado, "propuesta");
  assert.match(r.mensaje, /Ambiguo/);
  assert.deepEqual(h.escrituras, []);
});

test("conversiones, transferencias que no son en EUR y registros que no coinciden con su clave no se ejecutan", async () => {
  const casos: Array<[Partial<RegistroTransferencia>, RegExp]> = [
    [{ tipo: "conversion" }, /las dos monedas son iguales/],
    [{ tipo: "conversion", monedaOrigen: "USD", monedaDestino: "COP" }, /una pata en euros/],
    // Un asiento de 1.000 «USD» se escribiría como 1.000 EUR en el diario.
    [{ monedaOrigen: "USD", monedaDestino: "USD" }, /solo se ejecutan transferencias en EUR/],
    [{ origenMovimiento: "c".repeat(24) }, /no coincide con su clave/],
    [{ empresa: "Footprint" }, /no coincide con su clave/],
  ];
  for (const [extra, motivo] of casos) {
    const h = holded();
    const r = await ejecutarTransferencia(registro(extra), h.deps, SI);
    assert.equal(r.estado, "propuesta");
    assert.match(r.mensaje, motivo);
    assert.deepEqual(h.escrituras, []);
  }
});

test("solo se ejecuta una operación aprobada; una ya verificada no repite nada; sin autorización no se escribe", async () => {
  for (const estado of ["propuesta", "saltada", "descartada", "verificada", "revision_manual"] as const) {
    const h = holded();
    const r = await ejecutarTransferencia(registro({ estado }), h.deps, SI);
    assert.equal(r.estado, estado);
    assert.deepEqual(h.escrituras, []);
  }
  const h = holded();
  const r = await ejecutarTransferencia(registro(), h.deps, { permitirEscritura: false });
  assert.equal(r.estado, "propuesta");
  assert.deepEqual(h.escrituras, []);
  // Por defecto (sin opciones) tampoco se escribe.
  assert.equal((await ejecutarTransferencia(registro(), holded().deps)).estado, "propuesta");
});

test("si el robot no llega a pulsar el botón final no se escribió nada: la propuesta vuelve a estar disponible", async () => {
  const h = holded({ robotNoPulsa: "No se encontró el botón «Transferir»" });
  const r = await ejecutarTransferencia(registro(), h.deps, SI);
  assert.equal(r.estado, "propuesta");
  assert.match(r.mensaje, /No se escribió nada.*No se encontró el botón/);
  assert.deepEqual(h.escrituras, []);
});

test("si se pulsó pero Holded no muestra la transferencia queda fallida; al volver, lee antes de actuar", async () => {
  const h = holded({ transferirSinEfecto: true });
  const r = await ejecutarTransferencia(registro(), h.deps, SI);
  assert.equal(r.estado, "fallida");
  assert.deepEqual(h.escrituras, [TRANSFERIR]);
  // Holded sí la había registrado (tardó): al volver NO se pulsa otra vez, solo se concilia la salida.
  h.transferirEnHolded();
  const segundo = await ejecutarTransferencia(r.registro, h.deps, SI);
  assert.equal(segundo.estado, "verificada");
  assert.deepEqual(h.escrituras, [TRANSFERIR, CONCILIAR]);
});

test("un corte tras «Transferir» no repite el clic: se concilia la salida contra el pago que ya existe", async () => {
  const h = holded();
  h.transferirEnHolded();
  const r = await ejecutarTransferencia(registro({ estado: "ejecutando" }), h.deps, SI);
  assert.equal(r.estado, "verificada");
  assert.deepEqual(h.escrituras, [CONCILIAR]);
  // Sin autorización para escribir, solo informa.
  const h2 = holded();
  h2.transferirEnHolded();
  const r2 = await ejecutarTransferencia(registro({ estado: "ejecutando" }), h2.deps, { permitirEscritura: false });
  assert.equal(r2.estado, "fallida");
  assert.deepEqual(h2.escrituras, []);
});

test("una conciliación de la salida que falla o no surte efecto queda fallida y no se repite sola dentro del intento", async () => {
  for (const opciones of [{ conciliarFalla: true }, { conciliarNoSurteEfecto: true }]) {
    const h = holded(opciones);
    const r = await ejecutarTransferencia(registro(), h.deps, SI);
    assert.equal(r.estado, "fallida");
    assert.match(r.mensaje, /movimiento de salida no quedó conciliado/);
    assert.deepEqual(h.escrituras, [TRANSFERIR, CONCILIAR]);
  }
});

test("un clic no basta: otro asiento generado (también si Holded lo fecha hoy) o documentos inesperados son un fallo", async () => {
  for (const fecha of ["2026-10-01", HOY]) {
    const h = holded({ asientoExtraFechado: fecha });
    const r = await ejecutarTransferencia(registro(), h.deps, SI);
    assert.equal(r.estado, "fallida", fecha);
    assert.match(r.mensaje, /único asiento nuevo/);
  }
  const h = holded();
  h.pagos.push({ id: "raro", tipo: "payment", cuentaId: "otra", importe: 350, conciliado: false, movimiento: D });
  const r = await ejecutarTransferencia(registro({ estado: "ejecutando" }), h.deps, SI);
  assert.equal(r.estado, "fallida");
  assert.deepEqual(h.escrituras, []);
});

test("el asiento suelto del primer método bloquea mientras exista; una vez borrado, la transferencia se ejecuta", async () => {
  const h = holded();
  h.lineas.push({ asientoId: "suelto", cuenta: "57200001", debe: 350, haber: 0, descripcion: "[wobi:transferencia:abc123def456]", fecha: "2026-10-01" });
  h.lineas.push({ asientoId: "suelto", cuenta: "57200015", debe: 0, haber: 350, descripcion: "[wobi:transferencia:abc123def456]", fecha: "2026-10-01" });
  const r = await ejecutarTransferencia(registro({ estado: "fallida", asientoId: "suelto" }), h.deps, SI);
  assert.equal(r.estado, "fallida");
  assert.match(r.mensaje, /asiento suelto suelto.*Bórralo/);
  assert.deepEqual(h.escrituras, []);
  h.lineas.splice(-2, 2);
  const segundo = await ejecutarTransferencia(r.registro, h.deps, SI);
  assert.equal(segundo.estado, "verificada");
  assert.equal(segundo.registro.asientoId, "cobro-1");
  assert.deepEqual(h.escrituras, [TRANSFERIR, CONCILIAR]);
});

test("tras un intento anterior, un movimiento que ya no está libre no se da por «no escrito»: queda para comprobar", async () => {
  const h = holded();
  h.movimientos.set(D, { ...h.movimientos.get(D)!, estado: "reconciled", conciliado: 350 });
  const r = await ejecutarTransferencia(registro({ estado: "fallida" }), h.deps, SI);
  assert.equal(r.estado, "fallida");
  assert.doesNotMatch(r.mensaje, /No se escribió nada/);
  assert.deepEqual(h.escrituras, []);
});

/** Conversión real de eWorks (02/09/2026): −433,96 EUR → +500 USD, que Holded valora en 431,85 EUR. */
function conversion(valorEntradaEur = 431.85) {
  const h = holded();
  h.cuentas[1].moneda = "USD";
  h.movimientos.set(O, { ...h.movimientos.get(O)!, importe: -433.96 });
  h.movimientos.set(D, { ...h.movimientos.get(D)!, importe: 500, moneda: "USD", equivalenteEur: valorEntradaEur });
  const r = registro({ tipo: "conversion", importeOrigen: -433.96, importeDestino: 500, monedaDestino: "USD" });
  // En una conversión se pulsa sobre la SALIDA: pago conciliado en origen y cobro pendiente en destino, por el valor de la salida.
  h.deps.transferir = async (_e, orden) => {
    h.escrituras.push(`transferir:${orden.cuentaId}:${orden.movimientoId === O ? "origen" : "destino"}:${orden.cuentaContable}:${orden.importe}`);
    h.lineas.push({ asientoId: "pago-1", cuenta: "57200001", debe: 433.96, haber: 0, descripcion: "Exchanged", fecha: "2026-10-01" });
    h.lineas.push({ asientoId: "pago-1", cuenta: "57200015", debe: 0, haber: 433.96, descripcion: "Exchanged", fecha: "2026-10-01" });
    h.movimientos.set(O, { ...h.movimientos.get(O)!, estado: "reconciled", conciliado: -433.96 });
    h.pagos.push({ id: "pago-doc", tipo: "payment", cuentaId: "main", importe: 433.96, conciliado: true, movimiento: O });
    h.pagos.push({ id: "cobro-doc", tipo: "collection", cuentaId: "bbva", importe: 433.96, conciliado: false, movimiento: O });
    return { estado: "ok", pulsado: true };
  };
  h.deps.conciliarConPago = async (_e, cuentaId, movimientoId, pagoId, tipo) => {
    h.escrituras.push(`conciliar:${cuentaId}:${movimientoId === O ? "origen" : "destino"}:${pagoId}:${tipo}`);
    h.movimientos.set(D, { ...h.movimientos.get(D)!, estado: "reconciled", conciliado: 500 });
    const cobro = h.pagos.find((p) => p.id === pagoId)!;
    cobro.parcial = true; cobro.aplicado = valorEntradaEur;
  };
  return { h, r };
}

test("conversión EUR→USD: «Transferir» sobre la salida, la entrada contra el cobro, y la diferencia de cambio queda en el cobro", async () => {
  const { h, r } = conversion();
  const res = await ejecutarTransferencia(r, h.deps, SI);
  assert.equal(res.estado, "verificada");
  assert.deepEqual(h.escrituras, ["transferir:main:origen:57200001:433.96", "conciliar:bbva:destino:cobro-doc:collection"]);
  assert.match(res.mensaje, /Conversión conciliada: Main 433\.96 EUR → BBVA 500\.00 USD.*433\.96 EUR.*diferencia de cambio de 2\.11 EUR/);
  assert.equal(res.registro.asientoId, "pago-1");
});

test("conversión: si la entrada vale más en euros que la salida, o Holded no da la valoración, no se escribe nada", async () => {
  for (const [valor, motivo] of [[440, /vale más en euros/], [433.97, /vale más en euros/], [0, /valoración en euros/], [300, /supera el 3 %/]] as const) {
    const { h, r } = conversion(valor);
    const res = await ejecutarTransferencia(r, h.deps, SI);
    assert.equal(res.estado, "propuesta");
    assert.match(res.mensaje, motivo);
    assert.deepEqual(h.escrituras, []);
  }
});

test("conversión: un cobro conciliado por un importe que no es el valor de la entrada es un fallo", async () => {
  const { h, r } = conversion();
  const original = h.deps.conciliarConPago;
  h.deps.conciliarConPago = async (...a) => { await original(...a); h.pagos.find((p) => p.id === "cobro-doc")!.aplicado = 100; };
  const res = await ejecutarTransferencia(r, h.deps, SI);
  assert.equal(res.estado, "fallida");
  assert.match(res.mensaje, /cobro de la transferencia en la otra cuenta sigue pendiente/);
});

test("las conversiones solo se autorizan pareja a pareja, aunque las transferencias en euros estén abiertas", () => {
  const clave = `EWORKS:${O}>${D}`;
  const abierto = { WOBI_TRANSFERENCIAS_MODO: "activo", WOBI_TRANSFERENCIAS_ALCANCE: "eur" };
  assert.equal(ejecucionAutorizada(clave, abierto, "transferencia"), true);
  assert.equal(ejecucionAutorizada(clave, abierto, "conversion"), false);
  assert.equal(ejecucionAutorizada(clave, { ...abierto, WOBI_TRANSFERENCIAS_CASOS: clave }, "conversion"), true);
});

test("los importes se buscan en pantalla como los escribe Holded", () => {
  assert.equal(importeEnPantalla(350), "350,00");
  assert.equal(importeEnPantalla(-1300), "1.300,00");
  assert.equal(importeEnPantalla(1234567.5), "1.234.567,50");
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
  // Alcance abierto a euros (validado con la prueba del 05-10-2026): cualquier pareja bien formada, solo en modo activo.
  assert.equal(ejecucionAutorizada(clave, { WOBI_TRANSFERENCIAS_MODO: "activo", WOBI_TRANSFERENCIAS_ALCANCE: "EUR" }), true);
  assert.equal(ejecucionAutorizada(clave, { WOBI_TRANSFERENCIAS_MODO: "observacion", WOBI_TRANSFERENCIAS_ALCANCE: "eur" }), false);
  assert.equal(ejecucionAutorizada("WOBA:xx>yy", { WOBI_TRANSFERENCIAS_MODO: "activo", WOBI_TRANSFERENCIAS_ALCANCE: "eur" }), false);
  assert.equal(ejecucionAutorizada(clave, { WOBI_TRANSFERENCIAS_MODO: "activo", WOBI_TRANSFERENCIAS_ALCANCE: "todo" }), false);
});
