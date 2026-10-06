import assert from "node:assert/strict";
import test from "node:test";
import type { CuentaTransferencia, MovimientoTransferencia } from "./deteccion";
import { ejecutarTransferencia, importeDeHolded, motivoConversionNoEjecutable, type DependenciasEjecucion, type LineaAsiento, type PagoTransferencia } from "./ejecucion";
import { casosAutorizados, diferenciaAFavorAutorizada, ejecucionAutorizada, modoTransferencias } from "./modo";
import { importeEnPantalla } from "./navegadorTransferencia";
import type { RegistroTransferencia } from "./registro";

const O = "a".repeat(24), D = "b".repeat(24);
const HOY = "2026-10-03";
const SI = { permitirEscritura: true, permitirDiferenciaAFavor: true };
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

test("conversión: si Holded no da la valoración o la diferencia supera el 3 %, no se escribe nada", async () => {
  for (const [valor, motivo] of [[0, /valoración en euros/], [300, /supera el 3 %/], [460, /supera el 3 %/]] as const) {
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

/** Conversión real de eWorks (16/09/2026): −593 USD (513,70 EUR) → +513,73 EUR: 3 céntimos a favor. */
function conversionAFavor(opciones: { segundoRobotNoPulsa?: boolean } = {}) {
  const h = holded();
  h.cuentas[0].moneda = "USD";
  h.movimientos.set(O, { ...h.movimientos.get(O)!, importe: -593, moneda: "USD", equivalenteEur: -513.7 });
  h.movimientos.set(D, { ...h.movimientos.get(D)!, importe: 513.73 });
  const r = registro({ tipo: "conversion", importeOrigen: -593, monedaOrigen: "USD", importeDestino: 513.73 });
  h.deps.transferir = async (_e, orden) => {
    const sobreOrigen = orden.movimientoId === O;
    if (!sobreOrigen && opciones.segundoRobotNoPulsa) return { estado: "elemento_no_encontrado", detalle: "El formulario no muestra el importe 0,03", pulsado: false };
    h.escrituras.push(`transferir:${orden.cuentaId}:${sobreOrigen ? "origen" : "destino"}:${orden.cuentaContable}:${orden.importe}${orden.restante !== undefined ? `:resto${orden.restante}` : ""}`);
    if (sobreOrigen) {
      h.lineas.push({ asientoId: "pago-1", cuenta: "57200001", debe: 513.7, haber: 0, descripcion: "Exchanged", fecha: "2026-10-01" });
      h.lineas.push({ asientoId: "pago-1", cuenta: "57200015", debe: 0, haber: 513.7, descripcion: "Exchanged", fecha: "2026-10-01" });
      h.movimientos.set(O, { ...h.movimientos.get(O)!, estado: "reconciled", conciliado: -593 });
      h.pagos.push({ id: "pago-doc", tipo: "payment", cuentaId: "main", importe: 513.7, conciliado: true, movimiento: O });
      h.pagos.push({ id: "cobro-doc", tipo: "collection", cuentaId: "bbva", importe: 513.7, conciliado: false, movimiento: O });
    } else {
      h.lineas.push({ asientoId: "resto-1", cuenta: "57200001", debe: 0.03, haber: 0, descripcion: "Exchanged", fecha: "2026-10-01" });
      h.lineas.push({ asientoId: "resto-1", cuenta: "62600000", debe: 0, haber: 0.03, descripcion: "Exchanged", fecha: "2026-10-01" });
      h.movimientos.set(D, { ...h.movimientos.get(D)!, estado: "reconciled", conciliado: 513.73 });
      h.pagos.push({ id: "cobro-resto", tipo: "collection", cuentaId: "bbva", importe: 0.03, conciliado: true, movimiento: D });
    }
    return { estado: "ok", pulsado: true };
  };
  h.deps.conciliarConPago = async (_e, cuentaId, movimientoId, pagoId, tipo) => {
    h.escrituras.push(`conciliar:${cuentaId}:${movimientoId === O ? "origen" : "destino"}:${pagoId}:${tipo}`);
    h.movimientos.set(D, { ...h.movimientos.get(D)!, estado: "partial", conciliado: 513.7 });
    h.pagos.find((p) => p.id === pagoId)!.conciliado = true;
  };
  return { h, r };
}

test("conversión con diferencia a favor: tras conciliar la entrada, el resto va a la 62600000 con un segundo «Transferir»", async () => {
  const { h, r } = conversionAFavor();
  const res = await ejecutarTransferencia(r, h.deps, SI);
  assert.equal(res.estado, "verificada", res.mensaje);
  assert.deepEqual(h.escrituras, ["transferir:main:origen:57200001:513.7", "conciliar:bbva:destino:cobro-doc:collection", "transferir:bbva:destino:62600000:513.73:resto0.03"]);
  assert.match(res.mensaje, /diferencia a favor de 0\.03 EUR quedó en la cuenta 62600000/);
  assert.equal(res.registro.asientoId, "pago-1");
});

test("diferencia a favor con entrada en otra moneda (USD → COP): el resto se pasa a euros con la valoración de Holded", async () => {
  const { h, r } = conversionAFavor();
  // Entrada de 4.750.000 COP valorada en 1.300,71 EUR; la salida vale 1.300,00 EUR → 0,71 EUR a favor.
  h.cuentas[1].moneda = "COP";
  h.movimientos.set(O, { ...h.movimientos.get(O)!, importe: -1531.63, equivalenteEur: -1300 });
  h.movimientos.set(D, { ...h.movimientos.get(D)!, importe: 4750000, moneda: "COP", equivalenteEur: 1300.71 });
  const reg = { ...r, importeOrigen: -1531.63, importeDestino: 4750000, monedaDestino: "COP" };
  const original = h.deps.transferir;
  h.deps.transferir = async (e, orden) => {
    if (orden.movimientoId === O) {
      h.escrituras.push(`transferir:origen:${orden.cuentaContable}:${orden.importe}`);
      h.lineas.push({ asientoId: "pago-1", cuenta: "57200001", debe: 1300, haber: 0, descripcion: "x", fecha: "2026-10-01" }, { asientoId: "pago-1", cuenta: "57200015", debe: 0, haber: 1300, descripcion: "x", fecha: "2026-10-01" });
      h.movimientos.set(O, { ...h.movimientos.get(O)!, estado: "reconciled", conciliado: -1531.63 });
      h.pagos.push({ id: "pago-doc", tipo: "payment", cuentaId: "main", importe: 1300, conciliado: true, movimiento: O }, { id: "cobro-doc", tipo: "collection", cuentaId: "bbva", importe: 1300, conciliado: false, movimiento: O });
      return { estado: "ok", pulsado: true };
    }
    h.escrituras.push(`transferir:destino:${orden.cuentaContable}:${orden.importe}:resto${orden.restante}`);
    h.lineas.push({ asientoId: "resto-1", cuenta: "57200001", debe: 0.71, haber: 0, descripcion: "x", fecha: "2026-10-01" }, { asientoId: "resto-1", cuenta: "62600000", debe: 0, haber: 0.71, descripcion: "x", fecha: "2026-10-01" });
    h.movimientos.set(D, { ...h.movimientos.get(D)!, estado: "reconciled", conciliado: 4750000 });
    h.pagos.push({ id: "cobro-resto", tipo: "collection", cuentaId: "bbva", importe: 0.71, conciliado: true, movimiento: D });
    void e; void original;
    return { estado: "ok", pulsado: true };
  };
  h.deps.conciliarConPago = async (_e, _c, _m, pagoId) => {
    // Holded aplica 1.300 EUR: en COP quedan sin conciliar los que equivalen a 0,71 EUR.
    h.movimientos.set(D, { ...h.movimientos.get(D)!, estado: "partial", conciliado: Math.round(4750000 * (1300 / 1300.71)) });
    h.pagos.find((p) => p.id === pagoId)!.conciliado = true;
  };
  const res = await ejecutarTransferencia(reg, h.deps, SI);
  assert.equal(res.estado, "verificada", res.mensaje);
  assert.deepEqual(h.escrituras, ["transferir:origen:57200001:1300", "transferir:destino:62600000:1300.71:resto0.71"]);
});

test("diferencia a favor: si el segundo «Transferir» no se pulsa queda fallida y al retomar solo se hace ese paso", async () => {
  const fallo = conversionAFavor({ segundoRobotNoPulsa: true });
  const res = await ejecutarTransferencia(fallo.r, fallo.h.deps, SI);
  assert.equal(res.estado, "fallida");
  assert.match(res.mensaje, /falta llevar la diferencia a favor de 0\.03 EUR/);
  assert.equal(fallo.h.escrituras.length, 2);
  // Al retomar: la transferencia y la conciliación ya existen; solo se pulsa el resto.
  const { h } = fallo;
  h.deps.transferir = async (_e, orden) => {
    h.escrituras.push(`transferir:${orden.cuentaId}:destino:${orden.cuentaContable}:${orden.importe}:resto${orden.restante}`);
    h.lineas.push({ asientoId: "resto-1", cuenta: "57200001", debe: 0.03, haber: 0, descripcion: "x", fecha: "2026-10-01" });
    h.lineas.push({ asientoId: "resto-1", cuenta: "62600000", debe: 0, haber: 0.03, descripcion: "x", fecha: "2026-10-01" });
    h.movimientos.set(D, { ...h.movimientos.get(D)!, estado: "reconciled", conciliado: 513.73 });
    h.pagos.push({ id: "cobro-resto", tipo: "collection", cuentaId: "bbva", importe: 0.03, conciliado: true, movimiento: D });
    return { estado: "ok", pulsado: true };
  };
  const segundo = await ejecutarTransferencia(res.registro, h.deps, SI);
  assert.equal(segundo.estado, "verificada", segundo.mensaje);
  assert.deepEqual(h.escrituras.slice(2), ["transferir:bbva:destino:62600000:513.73:resto0.03"]);
});

test("la diferencia a favor sigue pareja a pareja: sin su autorización no se pulsa nada", async () => {
  const { h, r } = conversionAFavor();
  const res = await ejecutarTransferencia(r, h.deps, { permitirEscritura: true });
  assert.equal(res.estado, "propuesta");
  assert.match(res.mensaje, /diferencia a favor.*en prueba/);
  assert.deepEqual(h.escrituras, []);
  const clave = `EWORKS:${O}>${D}`;
  const abierto = { WOBI_TRANSFERENCIAS_MODO: "activo", WOBI_TRANSFERENCIAS_ALCANCE: "eur,conversiones" };
  assert.equal(diferenciaAFavorAutorizada(clave, abierto), false);
  assert.equal(diferenciaAFavorAutorizada(clave, { ...abierto, WOBI_TRANSFERENCIAS_CASOS: clave }), true);
  assert.equal(diferenciaAFavorAutorizada(clave, { ...abierto, WOBI_TRANSFERENCIAS_ALCANCE: "eur,conversiones,conversiones_a_favor" }), true);
});

test("las conversiones solo se autorizan pareja a pareja, aunque las transferencias en euros estén abiertas", () => {
  const clave = `EWORKS:${O}>${D}`;
  const abierto = { WOBI_TRANSFERENCIAS_MODO: "activo", WOBI_TRANSFERENCIAS_ALCANCE: "eur" };
  assert.equal(ejecucionAutorizada(clave, abierto, "transferencia"), true);
  assert.equal(ejecucionAutorizada(clave, abierto, "conversion"), false);
  assert.equal(ejecucionAutorizada(clave, { ...abierto, WOBI_TRANSFERENCIAS_CASOS: clave }, "conversion"), true);
  // Cada alcance abre solo lo suyo.
  const conversiones = { WOBI_TRANSFERENCIAS_MODO: "activo", WOBI_TRANSFERENCIAS_ALCANCE: " EUR , Conversiones " };
  assert.equal(ejecucionAutorizada(clave, conversiones, "conversion"), true);
  assert.equal(ejecucionAutorizada(clave, conversiones, "transferencia"), true);
  assert.equal(ejecucionAutorizada(clave, { WOBI_TRANSFERENCIAS_MODO: "activo", WOBI_TRANSFERENCIAS_ALCANCE: "conversiones" }, "transferencia"), false);
  assert.equal(ejecucionAutorizada(clave, { WOBI_TRANSFERENCIAS_MODO: "observacion", WOBI_TRANSFERENCIAS_ALCANCE: "conversiones" }, "conversion"), false);
});

test("una conversión solo lleva botón si cabe en los límites (valoración en euros, 3 %)", () => {
  const mov = (importe: number, moneda: string, equivalenteEur?: number): MovimientoTransferencia =>
    ({ id: "x", cuentaId: "c", fecha: "2026-09-02", importe, moneda, equivalenteEur, descripcion: "", estado: "pending", conciliado: 0 });
  assert.equal(motivoConversionNoEjecutable(mov(-433.96, "EUR"), mov(500, "USD", 431.85)), undefined);
  assert.equal(motivoConversionNoEjecutable(mov(-593, "USD", -513.70), mov(513.70, "EUR")), undefined);
  // Diferencia a favor: se ejecuta sea cual sea la moneda de la entrada (el resto va a la cuenta de diferencias).
  assert.equal(motivoConversionNoEjecutable(mov(-593, "USD", -513.70), mov(513.73, "EUR")), undefined);
  assert.equal(motivoConversionNoEjecutable(mov(-433.96, "EUR"), mov(500, "USD", 436)), undefined);
  // Sin pata en euros (USD → COP) también vale: Holded valora las dos patas en euros.
  assert.equal(motivoConversionNoEjecutable(mov(-1531.63, "USD", -1300), mov(4750000, "COP", 1290)), undefined);
  assert.equal(motivoConversionNoEjecutable(mov(-1531.63, "USD", -1300), mov(4750000, "COP", 1300.71)), undefined);
  assert.match(motivoConversionNoEjecutable(mov(-100, "EUR"), mov(110, "USD")) ?? "", /valoración en euros/);
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
