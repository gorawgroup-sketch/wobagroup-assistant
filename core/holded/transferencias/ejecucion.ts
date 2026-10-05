import { estaConciliado, holdedGet, listBankMovements, listTreasuryAccounts, type Empresa } from "../client";
import { conciliarMovimientoContraPagoHolded } from "../write";
import type { CuentaTransferencia, MovimientoTransferencia } from "./deteccion";
import { aCuenta, aMovimiento, detectarTransferenciasDeEmpresa } from "./lectura";
import { transferirMovimientoEnHolded, type OrdenTransferir, type ResultadoTransferir } from "./navegadorTransferencia";
import { guardarRegistro, type RegistroTransferencia } from "./registro";

/**
 * Ejecución de UNA transferencia interna en EUR, igual que se hace a mano en Holded:
 *
 *  1. Sobre el movimiento de ENTRADA se pulsa «Transferir» eligiendo la cuenta contable del banco de origen (lo hace el
 *     robot de navegador: la API no lo ofrece). Holded crea un asiento numerado (debe destino / haber origen), concilia
 *     ese movimiento y deja un cobro y un pago enlazados de tipo «trans» (leído de transferencias reales: WOBA 02/09/2026).
 *  2. El movimiento de SALIDA se concilia por la API contra ese pago, que queda pendiente en la cuenta de origen.
 *
 * El primer método (asiento por POST /ledger-entries + conciliación contra «entry») falló en la prueba del 05-10-2026:
 * el asiento queda sin número y Holded responde 200 sin enlazar nada.
 *
 * Garantías:
 *  - Antes de escribir relee cuentas y movimientos y repite la detección: la pareja debe seguir siendo inequívoca.
 *  - El estado «ejecutando» se guarda ANTES de actuar. Lo que pasó en Holded se decide siempre leyendo: si existe el
 *    par cobro/pago de la transferencia, el paso 1 ocurrió y no se repite jamás.
 *  - No se da por bueno un clic ni un HTTP 200: se exigen los dos movimientos conciliados, el cobro y el pago
 *    conciliados y un único asiento nuevo en las dos cuentas contables.
 */

export interface LineaAsiento { asientoId: string; cuenta: string; debe: number; haber: number; descripcion: string }
export interface AsientoHolded { id: string; fecha: string; lineas: Array<{ cuenta: string; debe: number; haber: number }> }
/** Cobro o pago que Holded crea al pulsar «Transferir» (document_type «trans», document_id = movimiento pulsado). */
export interface PagoTransferencia { id: string; tipo: "payment" | "collection"; cuentaId: string; importe: number; conciliado: boolean }

export interface DependenciasEjecucion {
  leerCuentas(empresa: Empresa): Promise<CuentaTransferencia[]>;
  leerMovimiento(empresa: Empresa, cuenta: CuentaTransferencia, movimientoId: string, fecha: string): Promise<MovimientoTransferencia | undefined>;
  /** Líneas del libro diario de una cuenta contable entre dos fechas (YYYY-MM-DD), ambas incluidas con holgura. */
  leerLineas(empresa: Empresa, cuentaContable: string, desde: string, hasta: string): Promise<LineaAsiento[]>;
  /** El asiento completo por su id; undefined si no existe. */
  leerAsiento(empresa: Empresa, asientoId: string): Promise<AsientoHolded | undefined>;
  /** Cobro y pago generados por «Transferir» sobre ese movimiento; vacío si no se ha transferido. */
  leerPagosDeTransferencia(empresa: Empresa, movimientoId: string, fecha: string): Promise<PagoTransferencia[]>;
  /** Motivo por el que la pareja YA NO es una transferencia inequívoca (otro candidato, descripción, sincronización); undefined si lo sigue siendo. */
  motivoYaNoInequivoca(registro: RegistroTransferencia): Promise<string | undefined>;
  /** Pulsa «Transferir» en la interfaz de Holded sobre un movimiento. */
  transferir(empresa: Empresa, orden: OrdenTransferir): Promise<ResultadoTransferir>;
  conciliarConPago(empresa: Empresa, cuentaId: string, movimientoId: string, pagoId: string, tipo: "payment" | "collection"): Promise<void>;
  guardar(registro: RegistroTransferencia): Promise<void>;
  hoy(): string;
  /** Espera entre lecturas mientras Holded termina de registrar la transferencia. */
  esperar(ms: number): Promise<void>;
}

export interface ResultadoEjecucion { estado: RegistroTransferencia["estado"]; mensaje: string; registro: RegistroTransferencia }
export interface OpcionesEjecucion { /** false = solo se lee y se informa (modo no activo o pareja sin autorizar). */ permitirEscritura: boolean }

const CENTIMO = 0.005;
export const marcaDeOperacion = (r: Pick<RegistroTransferencia, "id">) => `[wobi:transferencia:${r.id}]`;
const cuentaContableValida = (c: string | undefined) => Boolean(c && /^(572|520)\d{5}$/.test(c));
const texto = (n: number) => Math.abs(n).toFixed(2);
const sumarDias = (fecha: string, dias: number) => new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);

/**
 * Ventana del libro diario que se vigila: desde antes del primer movimiento hasta mañana. Así se ve también un asiento
 * que Holded fechara el día de la conciliación (hoy) y no el del movimiento.
 */
function ventana(r: RegistroTransferencia, hoy: string): { desde: string; hasta: string } {
  const fechas = [r.origenFecha, r.destinoFecha, hoy].sort();
  return { desde: sumarDias(fechas[0], -3), hasta: sumarDias(fechas[fechas.length - 1], 1) };
}

async function leerEstado(r: RegistroTransferencia, d: DependenciasEjecucion) {
  const cuentas = await d.leerCuentas(r.empresa);
  const origenCuenta = cuentas.find((c) => c.id === r.origenCuenta), destinoCuenta = cuentas.find((c) => c.id === r.destinoCuenta);
  const origen = origenCuenta ? await d.leerMovimiento(r.empresa, origenCuenta, r.origenMovimiento, r.origenFecha) : undefined;
  const destino = destinoCuenta ? await d.leerMovimiento(r.empresa, destinoCuenta, r.destinoMovimiento, r.destinoFecha) : undefined;
  return { origenCuenta, destinoCuenta, origen, destino };
}

/** Por qué NO se puede ejecutar ahora; undefined si todo sigue como cuando se propuso. Solo lecturas. */
export function motivoParaNoEjecutar(
  r: RegistroTransferencia,
  e: Awaited<ReturnType<typeof leerEstado>>
): string | undefined {
  // La autorización se da por clave: lo que se ejecuta tiene que ser exactamente esa pareja.
  if (r.clave !== `${r.empresa}:${r.origenMovimiento}>${r.destinoMovimiento}`) return "El registro no coincide con su clave (¿editado a mano?).";
  if (r.tipo !== "transferencia" || r.monedaOrigen !== r.monedaDestino) return "Las conversiones de moneda todavía no se ejecutan: solo transferencias en la misma moneda.";
  // Un asiento se escribe en EUR: un traspaso USD↔USD necesita su valoración contable, que aún no está construida.
  if (r.monedaOrigen !== "EUR") return `Por ahora solo se ejecutan transferencias en EUR (esta es en ${r.monedaOrigen}).`;
  if (!e.origenCuenta || !e.destinoCuenta) return "Alguna de las dos cuentas ya no existe en Holded.";
  for (const c of [e.origenCuenta, e.destinoCuenta]) {
    if (c.archivada) return `La cuenta «${c.nombre}» está archivada.`;
    if (c.tipo !== "bank") return `La cuenta «${c.nombre}» no es una cuenta bancaria.`;
    if (c.moneda !== "EUR") return `La cuenta «${c.nombre}» no es en EUR.`;
    if (!cuentaContableValida(c.cuentaContable)) return `La cuenta «${c.nombre}» no tiene una cuenta contable 572/520 reconocible (${c.cuentaContable ?? "sin dato"}).`;
  }
  if (e.origenCuenta.cuentaContable === e.destinoCuenta.cuentaContable) return "Las dos cuentas bancarias comparten la misma cuenta contable.";
  if (!e.origen || !e.destino) return "Alguno de los dos movimientos ya no aparece en Holded.";
  for (const [m, nombre] of [[e.origen, "de salida"], [e.destino, "de entrada"]] as const) {
    if (m.estado !== "pending" || Math.abs(m.conciliado) > CENTIMO) return `El movimiento ${nombre} ya no está libre (estado ${m.estado}, conciliado ${m.conciliado.toFixed(2)}).`;
  }
  if (Math.abs(e.origen.importe - r.importeOrigen) > CENTIMO || Math.abs(e.destino.importe - r.importeDestino) > CENTIMO) return "El importe de algún movimiento cambió desde que se propuso.";
  if (!(e.origen.importe < 0) || !(e.destino.importe > 0) || Math.abs(Math.abs(e.origen.importe) - e.destino.importe) > CENTIMO) return "Los importes ya no son una salida y una entrada iguales.";
  return undefined;
}

/** El par cobro/pago de la transferencia, si es exactamente el esperado: un pago en la cuenta de origen y un cobro en la de destino. */
function parDeTransferencia(r: RegistroTransferencia, pagos: PagoTransferencia[]): { pago: PagoTransferencia; cobro: PagoTransferencia } | undefined {
  const importe = Math.abs(r.importeDestino);
  const pagosOrigen = pagos.filter((p) => p.tipo === "payment" && p.cuentaId === r.origenCuenta && Math.abs(p.importe - importe) <= CENTIMO);
  const cobrosDestino = pagos.filter((p) => p.tipo === "collection" && p.cuentaId === r.destinoCuenta && Math.abs(p.importe - importe) <= CENTIMO);
  return pagos.length === 2 && pagosOrigen.length === 1 && cobrosDestino.length === 1 ? { pago: pagosOrigen[0], cobro: cobrosDestino[0] } : undefined;
}

/**
 * Comprueba por lectura que la operación quedó exactamente como debe. Devuelve los fallos (vacío = correcta) y el asiento
 * de la transferencia cuando se identifica. `asientosAntes` = ids de asiento que ya había en cada cuenta contable.
 */
export async function verificarTransferencia(
  r: RegistroTransferencia,
  d: DependenciasEjecucion,
  asientosAntes?: { origen: string[]; destino: string[] }
): Promise<{ fallos: string[]; asientoId: string }> {
  const fallos: string[] = [];
  const e = await leerEstado(r, d);
  if (!e.origenCuenta || !e.destinoCuenta || !e.origen || !e.destino) return { fallos: ["No se pudieron releer las cuentas o los movimientos."], asientoId: r.asientoId };
  for (const [m, nombre, esperado] of [[e.origen, "de salida", r.importeOrigen], [e.destino, "de entrada", r.importeDestino]] as const) {
    if (!estaConciliado(m.estado)) fallos.push(`El movimiento ${nombre} no quedó conciliado (estado ${m.estado}).`);
    if (Math.abs(Math.abs(m.conciliado) - Math.abs(esperado)) > CENTIMO) fallos.push(`El movimiento ${nombre} tiene conciliados ${m.conciliado.toFixed(2)} en lugar de ${texto(esperado)}.`);
  }
  const pagos = await d.leerPagosDeTransferencia(r.empresa, r.destinoMovimiento, r.destinoFecha);
  const par = parDeTransferencia(r, pagos);
  if (!par) fallos.push(`Holded no muestra exactamente un cobro y un pago de transferencia por ${texto(r.importeDestino)} para este movimiento (hay ${pagos.length}).`);
  else if (!par.pago.conciliado || !par.cobro.conciliado) fallos.push("El cobro o el pago de la transferencia sigue pendiente de conciliar.");

  // Un único asiento: debe la cuenta de destino, haber la de origen. Nada más (ni ingreso ni gasto).
  const importe = Math.abs(r.importeDestino);
  const { desde, hasta } = ventana(r, d.hoy());
  const lineasDestino = await d.leerLineas(r.empresa, e.destinoCuenta.cuentaContable!, desde, hasta);
  const lineasOrigen = await d.leerLineas(r.empresa, e.origenCuenta.cuentaContable!, desde, hasta);
  let asientoId = r.asientoId;
  if (asientosAntes) {
    const nuevosDestino = [...new Set(lineasDestino.map((l) => l.asientoId))].filter((id) => !asientosAntes.destino.includes(id));
    const nuevosOrigen = [...new Set(lineasOrigen.map((l) => l.asientoId))].filter((id) => !asientosAntes.origen.includes(id));
    if (nuevosDestino.length !== 1 || nuevosOrigen.length !== 1 || nuevosDestino[0] !== nuevosOrigen[0]) {
      fallos.push(`Se esperaba un único asiento nuevo en las dos cuentas contables y hay ${nuevosDestino.length} en la de destino y ${nuevosOrigen.length} en la de origen.`);
    } else asientoId = nuevosDestino[0];
  } else if (!asientoId) {
    const candidatos = lineasDestino.filter((l) => Math.abs(l.debe - importe) <= CENTIMO && lineasOrigen.some((o) => o.asientoId === l.asientoId && Math.abs(o.haber - importe) <= CENTIMO));
    if (candidatos.length === 1) asientoId = candidatos[0].asientoId;
  }
  if (!asientoId) fallos.push("No se identificó el asiento de la transferencia en el libro diario.");
  else {
    const asiento = await d.leerAsiento(r.empresa, asientoId);
    const debe = asiento?.lineas.filter((l) => l.cuenta === e.destinoCuenta!.cuentaContable && Math.abs(l.debe - importe) <= CENTIMO && l.haber <= CENTIMO) ?? [];
    const haber = asiento?.lineas.filter((l) => l.cuenta === e.origenCuenta!.cuentaContable && Math.abs(l.haber - importe) <= CENTIMO && l.debe <= CENTIMO) ?? [];
    if (!asiento || asiento.lineas.length !== 2 || debe.length !== 1 || haber.length !== 1) {
      fallos.push(`El asiento ${asientoId} no tiene exactamente un cargo de ${texto(importe)} en la cuenta de destino y un abono en la de origen.`);
    }
  }
  return { fallos, asientoId };
}

const motivoDe = (error: unknown) => (error instanceof Error ? error.message.slice(0, 220) : "error desconocido");
const LECTURAS_TRAS_TRANSFERIR = 8;

export async function ejecutarTransferencia(
  registro: RegistroTransferencia,
  d: DependenciasEjecucion = dependenciasHolded,
  opciones: OpcionesEjecucion = { permitirEscritura: false }
): Promise<ResultadoEjecucion> {
  let r = registro;
  const cerrar = async (estado: RegistroTransferencia["estado"], mensaje: string): Promise<ResultadoEjecucion> => {
    r = { ...r, estado, detalle: mensaje };
    await d.guardar(r);
    return { estado, mensaje, registro: r };
  };
  /** Paso 2 y verificación: el par cobro/pago ya existe en Holded. */
  const completar = async (pagos: PagoTransferencia[], asientosAntes?: { origen: string[]; destino: string[] }): Promise<ResultadoEjecucion> => {
    const par = parDeTransferencia(r, pagos);
    if (!par) return cerrar("fallida", `Holded registró una transferencia sobre este movimiento, pero no es el cobro y el pago esperados (${pagos.length} documento(s)). No se continúa; revísalo en Holded.`);
    const estado = await leerEstado(r, d);
    const origenLibre = estado.origen?.estado === "pending" && Math.abs(estado.origen.conciliado) <= CENTIMO;
    if (!par.pago.conciliado && origenLibre) {
      if (!opciones.permitirEscritura) return cerrar("fallida", "La transferencia ya está creada en Holded, pero falta conciliar el movimiento de salida y esta pareja no está autorizada para escribir.");
      try {
        await d.conciliarConPago(r.empresa, r.origenCuenta, r.origenMovimiento, par.pago.id, "payment");
      } catch (error) {
        // Rechazada sin efecto o incierta: en los dos casos decide la lectura de abajo y no se repite sola.
        console.error(`[transferencias] Conciliación del movimiento de salida de ${r.clave}:`, motivoDe(error));
      }
    }
    const v = await verificarTransferencia(r, d, asientosAntes);
    r = { ...r, asientoId: v.asientoId };
    if (v.fallos.length > 0) return cerrar("fallida", `La transferencia se creó en Holded, pero la verificación no cuadra y no se continúa sola. ${v.fallos.join(" ")}`);
    const c = await d.leerCuentas(r.empresa);
    const nombre = (id: string) => c.find((x) => x.id === id)?.nombre ?? id;
    return cerrar("verificada", `Transferencia conciliada: ${nombre(r.origenCuenta)} → ${nombre(r.destinoCuenta)} por ${Math.abs(r.importeDestino).toFixed(2)} ${r.monedaDestino}. Un único asiento (${v.asientoId}) y los dos movimientos conciliados.`);
  };

  if (r.estado === "verificada") return { estado: "verificada", mensaje: "Esta transferencia ya estaba conciliada y verificada.", registro: r };
  if (!["aprobada", "ejecutando", "fallida"].includes(r.estado)) return { estado: r.estado, mensaje: `La operación está en estado «${r.estado}»; no se ejecuta.`, registro: r };

  // 0) Lo primero es mirar si la transferencia YA existe en Holded (un intento anterior): entonces el paso 1 no se repite.
  const previos = await d.leerPagosDeTransferencia(r.empresa, r.destinoMovimiento, r.destinoFecha);
  if (previos.length > 0) return completar(previos);

  // Asiento suelto del primer método (creado por API, sin enlazar): mientras exista duplicaría la transferencia.
  if (r.asientoId) {
    if (await d.leerAsiento(r.empresa, r.asientoId)) {
      return cerrar("fallida", `Sigue existiendo en Holded el asiento suelto ${r.asientoId} del intento anterior (no está enlazado a ningún movimiento). Bórralo en Contabilidad → Libro diario y vuelve a pulsar: no escribí nada.`);
    }
    r = { ...r, asientoId: "" };
  }
  if (!opciones.permitirEscritura) {
    return r.estado === "aprobada"
      ? cerrar("propuesta", "No escribí nada en Holded: esta transferencia no está autorizada para ejecutarse.")
      : cerrar("fallida", "En Holded no hay ninguna transferencia registrada sobre estos movimientos. No está autorizada para ejecutarse de nuevo.");
  }

  // 1) Relectura: nada cambió desde la propuesta, y la pareja sigue siendo la única posible.
  const antes = await leerEstado(r, d);
  const motivo = motivoParaNoEjecutar(r, antes) ?? await d.motivoYaNoInequivoca(r);
  if (motivo) return cerrar("revision_manual", `No se escribió nada en Holded. ${motivo}`);
  const origenCuenta = antes.origenCuenta!, destinoCuenta = antes.destinoCuenta!;
  const { desde, hasta } = ventana(r, d.hoy());
  const asientosAntes = {
    destino: [...new Set((await d.leerLineas(r.empresa, destinoCuenta.cuentaContable!, desde, hasta)).map((l) => l.asientoId))],
    origen: [...new Set((await d.leerLineas(r.empresa, origenCuenta.cuentaContable!, desde, hasta)).map((l) => l.asientoId))],
  };

  // 2) «Transferir» en la interfaz sobre el movimiento de entrada. El estado queda guardado antes.
  r = { ...r, estado: "ejecutando", detalle: "Pulsando «Transferir» en Holded sobre el movimiento de entrada." };
  await d.guardar(r);
  const robot = await d.transferir(r.empresa, { cuentaId: r.destinoCuenta, movimientoId: r.destinoMovimiento, cuentaContable: origenCuenta.cuentaContable!, importe: r.importeDestino });
  console.log(`[transferencias] Robot «Transferir» para ${r.clave}: ${robot.estado} (pulsado: ${robot.pulsado}) ${robot.detalle ?? ""}`);
  if (!robot.pulsado) return cerrar("propuesta", `No se escribió nada en Holded: no llegué a pulsar «Transferir y conciliar» (${robot.detalle ?? robot.estado}). Puedes volver a intentarlo.`);

  // 3) Se pulsó: lo ocurrido se decide leyendo. Holded puede tardar unos segundos en mostrar el cobro y el pago.
  let pagos: PagoTransferencia[] = [];
  for (let lectura = 0; lectura < LECTURAS_TRAS_TRANSFERIR && pagos.length < 2; lectura++) {
    if (lectura > 0) await d.esperar(4000);
    pagos = await d.leerPagosDeTransferencia(r.empresa, r.destinoMovimiento, r.destinoFecha);
  }
  if (pagos.length === 0) return cerrar("fallida", `Pulsé «Transferir y conciliar», pero Holded no muestra la transferencia (${robot.detalle ?? robot.estado}). No se repite sola: al verificar volveré a leer cómo quedó.`);
  return completar(pagos, asientosAntes);
}

/** «1300,00» (asiento por id) o «1300.00» (listado): los dos formatos que devuelve Holded. */
export const importeDeHolded = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v ?? "").trim();
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? n : 0;
};

/** Dependencias reales: lecturas por la API de Holded y escrituras por la guardia de write.ts. */
export const dependenciasHolded: DependenciasEjecucion = {
  leerCuentas: async (empresa) => (await listTreasuryAccounts(empresa)).map(aCuenta),
  // Con ventana de ±3 días: la consulta por un único día exacto a veces devuelve vacío (comprobado el 03-10-2026).
  leerMovimiento: async (empresa, cuenta, movimientoId, fecha) => {
    const movimientos = await listBankMovements(empresa, cuenta.id, sumarDias(fecha, -3), sumarDias(fecha, 3));
    const crudo = movimientos.find((m) => m.id === movimientoId);
    return crudo ? aMovimiento(cuenta.id, cuenta.moneda, crudo) : undefined;
  },
  leerLineas: async (empresa, cuentaContable, desde, hasta) => {
    const lineas: LineaAsiento[] = [];
    let cursor: string | undefined;
    for (let pagina = 0; pagina < 40; pagina++) {
      const parametros: Record<string, string> = { start_date: desde, end_date: hasta, account: cuentaContable, limit: "200" };
      if (cursor) parametros.cursor = cursor;
      const data = (await holdedGet(empresa, "/ledger-entries", parametros)) as { items?: Array<Record<string, unknown>>; cursor?: string; has_more?: boolean };
      for (const l of data.items ?? []) {
        lineas.push({ asientoId: String(l.id ?? ""), cuenta: String(l.account ?? ""), debe: importeDeHolded(l.debit), haber: importeDeHolded(l.credit), descripcion: String(l.description ?? "") });
      }
      if (!data.has_more || !data.cursor) return lineas;
      cursor = data.cursor;
    }
    throw new Error("Holded devolvió demasiadas páginas del libro diario; no se puede verificar con seguridad.");
  },
  leerAsiento: async (empresa, asientoId) => {
    try {
      const a = (await holdedGet(empresa, `/ledger-entries/${encodeURIComponent(asientoId)}`)) as { id?: string; date?: string; lines?: Array<Record<string, unknown>> };
      if (!a?.id) return undefined;
      return { id: String(a.id), fecha: String(a.date ?? "").slice(0, 10), lineas: (a.lines ?? []).map((l) => ({ cuenta: String(l.account ?? ""), debe: importeDeHolded(l.debit), haber: importeDeHolded(l.credit) })) };
    } catch (error) {
      if (error instanceof Error && /\(404\)/.test(error.message)) return undefined;
      throw error;
    }
  },
  // Repite la detección completa de la empresa: cubre unicidad, descripciones y frescura de la sincronización.
  motivoYaNoInequivoca: async (r) => {
    const hoy = new Date().toISOString().slice(0, 10);
    const lectura = await detectarTransferenciasDeEmpresa(r.empresa, sumarDias([r.origenFecha, r.destinoFecha].sort()[0], -5), hoy, hoy);
    const actual = lectura.propuestas.find((p) => p.clave === r.clave);
    if (!actual) return "Al repetir la detección, esta pareja ya no aparece como transferencia entre cuentas propias.";
    return actual.confianza === "automatica" ? undefined : `Al repetir la detección, la pareja ya no es inequívoca: ${actual.motivos[actual.motivos.length - 1]}`;
  },
  // GET /payments: el cobro y el pago de una transferencia llevan document_type «trans» y document_id = movimiento pulsado.
  leerPagosDeTransferencia: async (empresa, movimientoId, fecha) => {
    const pagos: PagoTransferencia[] = [];
    let cursor: string | undefined;
    for (let pagina = 0; pagina < 40; pagina++) {
      const parametros: Record<string, string> = { start_date: sumarDias(fecha, -4), end_date: sumarDias(fecha, 4), limit: "200" };
      if (cursor) parametros.cursor = cursor;
      const data = (await holdedGet(empresa, "/payments", parametros)) as { items?: Array<Record<string, unknown>>; cursor?: string; next_cursor?: string; has_more?: boolean };
      const items = data.items ?? [];
      for (const p of items) {
        if (p.document_type !== "trans" || p.document_id !== movimientoId || (p.type !== "payment" && p.type !== "collection")) continue;
        pagos.push({ id: String(p.id ?? ""), tipo: p.type, cuentaId: String(p.bank_account_id ?? ""), importe: importeDeHolded(p.amount), conciliado: p.reconciliation_status === "reconciled" });
      }
      const siguiente = data.next_cursor ?? data.cursor;
      if (items.length === 0 || data.has_more === false || !siguiente || siguiente === cursor) return pagos;
      cursor = siguiente;
    }
    throw new Error("Holded devolvió demasiadas páginas de pagos y cobros; no se puede verificar con seguridad.");
  },
  transferir: transferirMovimientoEnHolded,
  conciliarConPago: conciliarMovimientoContraPagoHolded,
  esperar: (ms) => new Promise((resolver) => setTimeout(resolver, ms)),
  guardar: guardarRegistro,
  hoy: () => new Date().toISOString().slice(0, 10),
};
