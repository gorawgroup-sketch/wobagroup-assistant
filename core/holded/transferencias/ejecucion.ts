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
export interface PagoTransferencia {
  id: string; tipo: "payment" | "collection"; cuentaId: string; importe: number; conciliado: boolean;
  /** Conciliado solo en parte (en una conversión, el cobro o pago de la otra cuenta queda con la diferencia de cambio). */
  parcial?: boolean;
  /** Importe ya aplicado a movimientos bancarios, en EUR y sin signo. */
  aplicado?: number;
}

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

/**
 * Cómo se ejecuta la pareja, igual que se viene haciendo a mano en Holded:
 *  - Transferencia en euros: «Transferir» sobre la ENTRADA (validado el 05-10-2026, WOBA 350 €).
 *  - Conversión de moneda: «Transferir» sobre la SALIDA; el cobro que queda en la cuenta de destino vale lo que la salida
 *    en EUR y la entrada se concilia contra él. Si la entrada vale menos en EUR, el cobro queda conciliado en parte con la
 *    diferencia de cambio pendiente (leído de conversiones reales de Footprint y eWorks, jun–ago 2026).
 */
interface Plan { pulsado: "origen" | "destino"; /** Importe en EUR del cobro y del pago que crea Holded. */ importePar: number; /** Valor en EUR del otro movimiento. */ valorOtroEur: number }
type Estado = Awaited<ReturnType<typeof leerEstado>>;

const valorEur = (m: MovimientoTransferencia) => (m.moneda === "EUR" ? Math.abs(m.importe) : Math.abs(m.equivalenteEur ?? 0));
const esConversion = (r: Pick<RegistroTransferencia, "tipo">) => r.tipo === "conversion";
/** Las valoraciones en EUR de Holded pueden bailar un céntimo por redondeo. */
const tolerancia = (r: Pick<RegistroTransferencia, "tipo">) => (esConversion(r) ? 0.011 : CENTIMO);
const DIFERENCIA_MAXIMA_CAMBIO = 0.03;

function planDe(r: RegistroTransferencia, e: Pick<Estado, "origen" | "destino">): Plan | undefined {
  if (!e.origen || !e.destino) return undefined;
  return esConversion(r)
    ? { pulsado: "origen", importePar: valorEur(e.origen), valorOtroEur: valorEur(e.destino) }
    : { pulsado: "destino", importePar: Math.abs(e.destino.importe), valorOtroEur: Math.abs(e.origen.importe) };
}

/** El movimiento sobre el que se pulsa «Transferir» y el otro, con el tipo de documento que Holded deja pendiente para este. */
function lados(r: RegistroTransferencia) {
  const origen = { cuenta: r.origenCuenta, movimiento: r.origenMovimiento, fecha: r.origenFecha };
  const destino = { cuenta: r.destinoCuenta, movimiento: r.destinoMovimiento, fecha: r.destinoFecha };
  return esConversion(r)
    ? { pulsado: origen, otro: destino, tipoOtro: "collection" as const, nombreOtro: "de entrada" }
    : { pulsado: destino, otro: origen, tipoOtro: "payment" as const, nombreOtro: "de salida" };
}

/** Por qué NO se puede ejecutar ahora; undefined si todo sigue como cuando se propuso. Solo lecturas. */
export function motivoParaNoEjecutar(r: RegistroTransferencia, e: Estado): string | undefined {
  // La autorización se da por clave: lo que se ejecuta tiene que ser exactamente esa pareja.
  if (r.clave !== `${r.empresa}:${r.origenMovimiento}>${r.destinoMovimiento}`) return "El registro no coincide con su clave (¿editado a mano?).";
  if (esConversion(r)) {
    if (r.monedaOrigen === r.monedaDestino) return "El registro dice conversión pero las dos monedas son iguales.";
    if (r.monedaOrigen !== "EUR" && r.monedaDestino !== "EUR") return `Por ahora solo se ejecutan conversiones con una pata en euros (esta es ${r.monedaOrigen} → ${r.monedaDestino}).`;
  } else {
    if (r.tipo !== "transferencia" || r.monedaOrigen !== r.monedaDestino) return "El registro no es una transferencia en la misma moneda ni una conversión.";
    // Un traspaso USD↔USD necesita su valoración contable en EUR, que aún no está construida.
    if (r.monedaOrigen !== "EUR") return `Por ahora solo se ejecutan transferencias en EUR (esta es en ${r.monedaOrigen}).`;
  }
  if (!e.origenCuenta || !e.destinoCuenta) return "Alguna de las dos cuentas ya no existe en Holded.";
  for (const [c, moneda] of [[e.origenCuenta, r.monedaOrigen], [e.destinoCuenta, r.monedaDestino]] as const) {
    if (c.archivada) return `La cuenta «${c.nombre}» está archivada.`;
    if (c.tipo !== "bank") return `La cuenta «${c.nombre}» no es una cuenta bancaria.`;
    if (c.moneda !== moneda) return `La cuenta «${c.nombre}» no es en ${moneda}.`;
    if (!cuentaContableValida(c.cuentaContable)) return `La cuenta «${c.nombre}» no tiene una cuenta contable 572/520 reconocible (${c.cuentaContable ?? "sin dato"}).`;
  }
  if (e.origenCuenta.cuentaContable === e.destinoCuenta.cuentaContable) return "Las dos cuentas bancarias comparten la misma cuenta contable.";
  if (!e.origen || !e.destino) return "Alguno de los dos movimientos ya no aparece en Holded.";
  for (const [m, nombre] of [[e.origen, "de salida"], [e.destino, "de entrada"]] as const) {
    if (m.estado !== "pending" || Math.abs(m.conciliado) > CENTIMO) return `El movimiento ${nombre} ya no está libre (estado ${m.estado}, conciliado ${m.conciliado.toFixed(2)}).`;
  }
  if (Math.abs(e.origen.importe - r.importeOrigen) > CENTIMO || Math.abs(e.destino.importe - r.importeDestino) > CENTIMO) return "El importe de algún movimiento cambió desde que se propuso.";
  if (!(e.origen.importe < 0) || !(e.destino.importe > 0)) return "Los movimientos ya no son una salida y una entrada.";
  if (!esConversion(r)) {
    return Math.abs(Math.abs(e.origen.importe) - e.destino.importe) > CENTIMO ? "Los importes ya no son una salida y una entrada iguales." : undefined;
  }
  return motivoLimitesConversion(planDe(r, e)!, r.monedaDestino === "EUR");
}

/**
 * Para decidir si una propuesta de conversión lleva botón de conciliar: mismos límites que aplica después el ejecutor.
 * Devuelve el motivo por el que todavía no se ejecuta desde aquí, o undefined si se puede.
 */
export function motivoConversionNoEjecutable(origen: MovimientoTransferencia, destino: MovimientoTransferencia): string | undefined {
  if (origen.moneda !== "EUR" && destino.moneda !== "EUR") return `Por ahora solo se ejecutan conversiones con una pata en euros (esta es ${origen.moneda} → ${destino.moneda}).`;
  return motivoLimitesConversion({ pulsado: "origen", importePar: valorEur(origen), valorOtroEur: valorEur(destino) }, destino.moneda === "EUR");
}

/** Límites de una conversión; se comprueban antes de pulsar y también antes de conciliar la entrada al retomar un intento. */
function motivoLimitesConversion(plan: Plan, entradaEnEuros: boolean): string | undefined {
  if (!(plan.importePar > 0) || !(plan.valorOtroEur > 0)) return "Holded no da la valoración en euros de la pata en otra moneda; sin ella no se puede comprobar la conversión.";
  if (Math.abs(plan.valorOtroEur - plan.importePar) > plan.importePar * DIFERENCIA_MAXIMA_CAMBIO) return `La diferencia entre las dos patas en euros (${plan.importePar.toFixed(2)} y ${plan.valorOtroEur.toFixed(2)}) supera el ${DIFERENCIA_MAXIMA_CAMBIO * 100} %.`;
  // Entrada que vale MÁS que la salida: el resto del movimiento de entrada se lleva a la cuenta de diferencias con un segundo
  // «Transferir». Solo cuando la entrada es en euros (el resto es entonces un importe en euros de un movimiento en euros).
  if (restoAFavor(plan) > 0 && !entradaEnEuros) return `La entrada vale más en euros (${plan.valorOtroEur.toFixed(2)}) que la salida (${plan.importePar.toFixed(2)}) y no es una cuenta en euros: esa diferencia a favor todavía no se registra desde aquí; hazla a mano en Holded.`;
  return undefined;
}

/**
 * Cuenta contable a la que va la diferencia a favor de una conversión (decisión de Carlos, 05-10-2026: la 62600000 en las
 * tres empresas, la misma que ya se usaba a mano en Footprint). Existe en el plan contable de las tres.
 */
export const CUENTA_DIFERENCIAS_CAMBIO = "62600000";

/** Euros que la entrada vale de más respecto a la salida (0 si no hay diferencia a favor). */
function restoAFavor(plan: Plan): number {
  const resto = Math.round((plan.valorOtroEur - plan.importePar) * 100) / 100;
  return resto > CENTIMO ? resto : 0;
}

/** El par cobro/pago de la transferencia, si es exactamente el esperado: un pago en la cuenta de origen y un cobro en la de destino. */
function parDeTransferencia(r: RegistroTransferencia, pagos: PagoTransferencia[], importe: number): { pago: PagoTransferencia; cobro: PagoTransferencia } | undefined {
  const cuadra = (p: PagoTransferencia) => Math.abs(Math.abs(p.importe) - importe) <= tolerancia(r);
  const pagosOrigen = pagos.filter((p) => p.tipo === "payment" && p.cuentaId === r.origenCuenta && cuadra(p));
  const cobrosDestino = pagos.filter((p) => p.tipo === "collection" && p.cuentaId === r.destinoCuenta && cuadra(p));
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
  const plan = planDe(r, e)!;
  const lado = lados(r);
  const tol = tolerancia(r);
  const pagos = await d.leerPagosDeTransferencia(r.empresa, lado.pulsado.movimiento, lado.pulsado.fecha);
  const par = parDeTransferencia(r, pagos, plan.importePar);
  if (!par) fallos.push(`Holded no muestra exactamente un cobro y un pago de transferencia por ${plan.importePar.toFixed(2)} EUR para este movimiento (hay ${pagos.length}).`);
  else {
    const [docPulsado, docOtro] = lado.tipoOtro === "collection" ? [par.pago, par.cobro] : [par.cobro, par.pago];
    if (!docPulsado.conciliado) fallos.push("El documento de la transferencia del movimiento pulsado no quedó conciliado.");
    // En una conversión el documento de la otra cuenta puede quedar conciliado en parte: lo aplicado debe ser lo que vale en
    // EUR el otro movimiento, y la diferencia de cambio queda pendiente (igual que al hacerlo a mano).
    const parcialCorrecto = esConversion(r) && docOtro.parcial === true && Math.abs((docOtro.aplicado ?? 0) - plan.valorOtroEur) <= 0.02 && (docOtro.aplicado ?? 0) <= plan.importePar + tol;
    if (!docOtro.conciliado && !parcialCorrecto) fallos.push(`El ${lado.tipoOtro === "collection" ? "cobro" : "pago"} de la transferencia en la otra cuenta sigue pendiente de conciliar.`);
  }
  // Diferencia a favor: un segundo «Transferir» sobre la entrada la lleva a la cuenta de diferencias (cobro conciliado en destino).
  const resto = esConversion(r) ? restoAFavor(plan) : 0;
  if (resto > 0) {
    const cobrosResto = (await d.leerPagosDeTransferencia(r.empresa, r.destinoMovimiento, r.destinoFecha))
      .filter((p) => p.tipo === "collection" && p.cuentaId === r.destinoCuenta && Math.abs(Math.abs(p.importe) - resto) <= tol);
    if (cobrosResto.length !== 1 || !cobrosResto[0].conciliado) fallos.push(`No consta conciliado el cobro de ${resto.toFixed(2)} EUR que lleva la diferencia a favor a la cuenta ${CUENTA_DIFERENCIAS_CAMBIO}.`);
  }

  // Un único asiento: debe la cuenta de destino, haber la de origen. Nada más (ni ingreso ni gasto).
  const importe = plan.importePar;
  const { desde, hasta } = ventana(r, d.hoy());
  const lineasDestino = await d.leerLineas(r.empresa, e.destinoCuenta.cuentaContable!, desde, hasta);
  const lineasOrigen = await d.leerLineas(r.empresa, e.origenCuenta.cuentaContable!, desde, hasta);
  let asientoId = r.asientoId;
  let nuevosDestino: string[] | undefined;
  if (asientosAntes) {
    nuevosDestino = [...new Set(lineasDestino.map((l) => l.asientoId))].filter((id) => !asientosAntes.destino.includes(id));
    const nuevosOrigen = [...new Set(lineasOrigen.map((l) => l.asientoId))].filter((id) => !asientosAntes.origen.includes(id));
    // Con diferencia a favor hay un segundo asiento, solo en la cuenta de destino (el del resto).
    const esperadosDestino = resto > 0 ? 2 : 1;
    if (nuevosDestino.length !== esperadosDestino || nuevosOrigen.length !== 1 || !nuevosDestino.includes(nuevosOrigen[0])) {
      fallos.push(`Se esperaba un único asiento nuevo en las dos cuentas contables${resto > 0 ? " (más el de la diferencia en la de destino)" : ""} y hay ${nuevosDestino.length} en la de destino y ${nuevosOrigen.length} en la de origen.`);
    } else asientoId = nuevosOrigen[0];
  } else if (!asientoId) {
    const candidatos = lineasDestino.filter((l) => Math.abs(l.debe - importe) <= tol && lineasOrigen.some((o) => o.asientoId === l.asientoId && Math.abs(o.haber - importe) <= tol));
    if (candidatos.length === 1) asientoId = candidatos[0].asientoId;
  }
  if (!asientoId) fallos.push("No se identificó el asiento de la transferencia en el libro diario.");
  else {
    const asiento = await d.leerAsiento(r.empresa, asientoId);
    const debe = asiento?.lineas.filter((l) => l.cuenta === e.destinoCuenta!.cuentaContable && Math.abs(l.debe - importe) <= tol && l.haber <= CENTIMO) ?? [];
    const haber = asiento?.lineas.filter((l) => l.cuenta === e.origenCuenta!.cuentaContable && Math.abs(l.haber - importe) <= tol && l.debe <= CENTIMO) ?? [];
    if (!asiento || asiento.lineas.length !== 2 || debe.length !== 1 || haber.length !== 1) {
      fallos.push(`El asiento ${asientoId} no tiene exactamente un cargo de ${texto(importe)} en la cuenta de destino y un abono en la de origen.`);
    }
  }
  if (resto > 0) {
    // El asiento del resto: debe la cuenta de destino, haber la cuenta de diferencias, y nada más.
    // Si se sabe qué asientos son nuevos, solo se miran esos: otra conversión con un resto parecido no debe confundir.
    let correctos = 0;
    const delResto = lineasDestino.filter((l) => l.asientoId !== asientoId && Math.abs(l.debe - resto) <= tol && (!nuevosDestino || nuevosDestino.includes(l.asientoId)));
    for (const id of [...new Set(delResto.map((l) => l.asientoId))]) {
      const a = await d.leerAsiento(r.empresa, id);
      if (a && a.lineas.length === 2 && a.lineas.some((l) => l.cuenta === CUENTA_DIFERENCIAS_CAMBIO && Math.abs(l.haber - resto) <= tol && l.debe <= CENTIMO)) correctos++;
    }
    if (nuevosDestino ? correctos !== 1 : correctos < 1) fallos.push(`No se identificó un único asiento de ${resto.toFixed(2)} EUR con debe en la cuenta de destino y haber en la ${CUENTA_DIFERENCIAS_CAMBIO} (hay ${correctos}).`);
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
  const lado = lados(r);
  /** Paso 2 y verificación: el par cobro/pago ya existe en Holded. */
  const completar = async (pagos: PagoTransferencia[], asientosAntes?: { origen: string[]; destino: string[] }): Promise<ResultadoEjecucion> => {
    const estado = await leerEstado(r, d);
    const plan = planDe(r, estado);
    if (!plan) return cerrar("fallida", "No se pudieron releer los dos movimientos en Holded; no hice nada. Vuelve a comprobar en unos minutos.");
    const par = parDeTransferencia(r, pagos, plan.importePar);
    if (!par) return cerrar("fallida", `Holded registró una transferencia sobre este movimiento, pero no es el cobro y el pago esperados (${pagos.length} documento(s)). No se continúa; revísalo en Holded.`);
    const docOtro = lado.tipoOtro === "collection" ? par.cobro : par.pago;
    const movimientoOtro = lado.tipoOtro === "collection" ? estado.destino : estado.origen;
    const otroLibre = movimientoOtro?.estado === "pending" && Math.abs(movimientoOtro.conciliado) <= CENTIMO;
    if (!docOtro.conciliado && !docOtro.parcial && otroLibre) {
      if (!opciones.permitirEscritura) return cerrar("fallida", `La transferencia ya está creada en Holded, pero falta conciliar el movimiento ${lado.nombreOtro} y esta pareja no está autorizada para escribir.`);
      const limite = esConversion(r) ? motivoLimitesConversion(plan, r.monedaDestino === "EUR") : undefined;
      if (limite) return cerrar("fallida", `La transferencia ya está creada en Holded, pero no concilié el movimiento ${lado.nombreOtro}: ${limite}`);
      try {
        await d.conciliarConPago(r.empresa, lado.otro.cuenta, lado.otro.movimiento, docOtro.id, lado.tipoOtro);
      } catch (error) {
        // Rechazada sin efecto o incierta: en los dos casos decide la lectura de abajo y no se repite sola.
        console.error(`[transferencias] Conciliación del movimiento ${lado.nombreOtro} de ${r.clave}:`, motivoDe(error));
      }
    }
    // Diferencia a favor: la entrada quedó conciliada solo por lo que vale la salida; el resto se lleva a la cuenta de
    // diferencias con un segundo «Transferir» sobre la entrada. Se decide leyendo: si ese cobro ya existe, no se repite.
    const resto = esConversion(r) ? restoAFavor(plan) : 0;
    if (resto > 0 && (await d.leerPagosDeTransferencia(r.empresa, r.destinoMovimiento, r.destinoFecha)).length === 0) {
      const entrada = (await leerEstado(r, d)).destino;
      // El resto real es lo que le falta por conciliar a la entrada; debe coincidir con la diferencia calculada. Se vuelven a
      // exigir entrada en euros, cobro principal ya conciliado y los límites de la conversión antes de pulsar nada.
      const restoReal = entrada ? Math.round((Math.abs(entrada.importe) - Math.abs(entrada.conciliado)) * 100) / 100 : 0;
      const cobroPrincipal = parDeTransferencia(r, await d.leerPagosDeTransferencia(r.empresa, lado.pulsado.movimiento, lado.pulsado.fecha), plan.importePar)?.cobro;
      const lista = entrada && r.monedaDestino === "EUR" && entrada.moneda === "EUR" && restoReal > CENTIMO && Math.abs(restoReal - resto) <= tolerancia(r) &&
        cobroPrincipal?.conciliado === true && !motivoLimitesConversion(plan, true);
      if (lista) {
        if (!opciones.permitirEscritura) return cerrar("fallida", `La conversión está hecha salvo la diferencia a favor de ${resto.toFixed(2)} EUR, y esta pareja no está autorizada para escribir.`);
        r = { ...r, estado: "ejecutando", detalle: `Llevando la diferencia a favor de ${resto.toFixed(2)} EUR a la cuenta ${CUENTA_DIFERENCIAS_CAMBIO}.` };
        await d.guardar(r);
        const robot = await d.transferir(r.empresa, { cuentaId: r.destinoCuenta, movimientoId: r.destinoMovimiento, cuentaContable: CUENTA_DIFERENCIAS_CAMBIO, importe: restoReal, descripcion: entrada.descripcion });
        console.log(`[transferencias] Robot «Transferir» (diferencia a favor) para ${r.clave}: ${robot.estado} (pulsado: ${robot.pulsado}) ${robot.detalle ?? ""}`);
        if (!robot.pulsado) {
          return cerrar("fallida", `La conversión quedó hecha en Holded (asiento y los dos movimientos enlazados), pero falta llevar la diferencia a favor de ${resto.toFixed(2)} EUR a la cuenta ${CUENTA_DIFERENCIAS_CAMBIO}: no llegué a pulsar (${robot.detalle ?? robot.estado}). Puedes reintentar solo ese paso o hacerlo a mano con «Transferir» sobre la entrada.`);
        }
        for (let lectura = 0; lectura < LECTURAS_TRAS_TRANSFERIR; lectura++) {
          if (lectura > 0) await d.esperar(4000);
          if ((await d.leerPagosDeTransferencia(r.empresa, r.destinoMovimiento, r.destinoFecha)).length > 0) break;
        }
      }
    }
    const v = await verificarTransferencia(r, d, asientosAntes);
    r = { ...r, asientoId: v.asientoId };
    if (v.fallos.length > 0) return cerrar("fallida", `La transferencia se creó en Holded, pero la verificación no cuadra y no se continúa sola. ${v.fallos.join(" ")}`);
    const c = await d.leerCuentas(r.empresa);
    const nombre = (id: string) => c.find((x) => x.id === id)?.nombre ?? id;
    if (!esConversion(r)) {
      return cerrar("verificada", `Transferencia conciliada: ${nombre(r.origenCuenta)} → ${nombre(r.destinoCuenta)} por ${Math.abs(r.importeDestino).toFixed(2)} ${r.monedaDestino}. Un único asiento (${v.asientoId}) y los dos movimientos conciliados.`);
    }
    const diferencia = plan.importePar - plan.valorOtroEur;
    return cerrar("verificada", `Conversión conciliada: ${nombre(r.origenCuenta)} ${Math.abs(r.importeOrigen).toFixed(2)} ${r.monedaOrigen} → ${nombre(r.destinoCuenta)} ${Math.abs(r.importeDestino).toFixed(2)} ${r.monedaDestino}. ` +
      `Un único asiento (${v.asientoId}) por ${plan.importePar.toFixed(2)} EUR y los dos movimientos conciliados.` +
      (diferencia > tolerancia(r) ? ` Queda una diferencia de cambio de ${diferencia.toFixed(2)} EUR pendiente en el cobro de la cuenta de destino, igual que cuando se hace a mano.` : "") +
      (resto > 0 ? ` La diferencia a favor de ${resto.toFixed(2)} EUR quedó en la cuenta ${CUENTA_DIFERENCIAS_CAMBIO}.` : ""));
  };

  if (r.estado === "verificada") return { estado: "verificada", mensaje: "Esta transferencia ya estaba conciliada y verificada.", registro: r };
  if (!["aprobada", "ejecutando", "fallida"].includes(r.estado)) return { estado: r.estado, mensaje: `La operación está en estado «${r.estado}»; no se ejecuta.`, registro: r };

  // 0) Lo primero es mirar si la transferencia YA existe en Holded (un intento anterior): entonces el paso 1 no se repite.
  const previos = await d.leerPagosDeTransferencia(r.empresa, lado.pulsado.movimiento, lado.pulsado.fecha);
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
  if (motivo) {
    // Tras un intento anterior no se puede afirmar que no se escribió: queda para comprobar. Si es el primer intento, la
    // propuesta sigue viva con sus botones (el motivo puede ser pasajero: una lectura vacía, una sincronización atrasada).
    return registro.estado === "aprobada"
      ? cerrar("propuesta", `No se escribió nada en Holded. ${motivo}`)
      : cerrar("fallida", `No continué: ${motivo} Revisa en Holded cómo quedaron los dos movimientos.`);
  }
  const origenCuenta = antes.origenCuenta!, destinoCuenta = antes.destinoCuenta!;
  const { desde, hasta } = ventana(r, d.hoy());
  const asientosAntes = {
    destino: [...new Set((await d.leerLineas(r.empresa, destinoCuenta.cuentaContable!, desde, hasta)).map((l) => l.asientoId))],
    origen: [...new Set((await d.leerLineas(r.empresa, origenCuenta.cuentaContable!, desde, hasta)).map((l) => l.asientoId))],
  };

  // 2) «Transferir» en la interfaz sobre el movimiento que toca (la entrada en una transferencia, la salida en una
  //    conversión), eligiendo la cuenta contable del otro banco. El estado queda guardado antes.
  const plan = planDe(r, antes)!;
  const pulsaOrigen = plan.pulsado === "origen";
  r = { ...r, estado: "ejecutando", detalle: `Pulsando «Transferir» en Holded sobre el movimiento ${pulsaOrigen ? "de salida" : "de entrada"}.` };
  await d.guardar(r);
  const robot = await d.transferir(r.empresa, {
    cuentaId: lado.pulsado.cuenta, movimientoId: lado.pulsado.movimiento,
    cuentaContable: (pulsaOrigen ? destinoCuenta : origenCuenta).cuentaContable!, importe: plan.importePar,
    descripcion: (pulsaOrigen ? antes.origen : antes.destino)?.descripcion,
  });
  console.log(`[transferencias] Robot «Transferir» para ${r.clave}: ${robot.estado} (pulsado: ${robot.pulsado}) ${robot.detalle ?? ""}`);
  if (!robot.pulsado) return cerrar("propuesta", `No se escribió nada en Holded: no llegué a pulsar «Transferir y conciliar» (${robot.detalle ?? robot.estado}). Puedes volver a intentarlo.`);

  // 3) Se pulsó: lo ocurrido se decide leyendo. Holded puede tardar unos segundos en mostrar el cobro y el pago.
  let pagos: PagoTransferencia[] = [];
  for (let lectura = 0; lectura < LECTURAS_TRAS_TRANSFERIR && pagos.length < 2; lectura++) {
    if (lectura > 0) await d.esperar(4000);
    pagos = await d.leerPagosDeTransferencia(r.empresa, lado.pulsado.movimiento, lado.pulsado.fecha);
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
      // Hasta mañana: Holded podría fechar el cobro y el pago el día en que se pulsa y no el del movimiento.
      const hasta = [sumarDias(fecha, 4), sumarDias(new Date().toISOString().slice(0, 10), 1)].sort()[1];
      const parametros: Record<string, string> = { start_date: sumarDias(fecha, -4), end_date: hasta, limit: "200" };
      if (cursor) parametros.cursor = cursor;
      const data = (await holdedGet(empresa, "/payments", parametros)) as { items?: Array<Record<string, unknown>>; cursor?: string; next_cursor?: string; has_more?: boolean };
      // Una respuesta con otra forma no es «no hay transferencia»: sin esta lectura no se puede decidir nada.
      if (!Array.isArray(data?.items)) throw new Error("Holded devolvió los pagos y cobros con un formato inesperado.");
      const items = data.items;
      for (const p of items) {
        if (p.document_type !== "trans" || p.document_id !== movimientoId || (p.type !== "payment" && p.type !== "collection")) continue;
        pagos.push({
          id: String(p.id ?? ""), tipo: p.type, cuentaId: String(p.bank_account_id ?? ""), importe: importeDeHolded(p.amount),
          conciliado: p.reconciliation_status === "reconciled", parcial: p.reconciliation_status === "partial_reconciled",
          aplicado: Math.abs(importeDeHolded(p.total_transactions)),
        });
      }
      const siguiente = data.next_cursor ?? data.cursor;
      if (items.length === 0 || data.has_more === false) return pagos;
      if (!siguiente || siguiente === cursor) {
        if (data.has_more === true) throw new Error("Holded indica más páginas de pagos y cobros pero no da cómo seguir.");
        return pagos;
      }
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
