import { estaConciliado, holdedGet, listBankMovements, listTreasuryAccounts, type Empresa } from "../client";
import { conciliarMovimientoContraAsientoHolded, crearAsientoHolded } from "../write";
import type { CuentaTransferencia, MovimientoTransferencia } from "./deteccion";
import { aCuenta, aMovimiento } from "./lectura";
import { guardarRegistro, type RegistroTransferencia } from "./registro";

/**
 * Ejecución de UNA transferencia interna en la misma moneda.
 *
 * Reproduce lo que deja la interfaz de Holded con «Transferir»: un único asiento que carga la cuenta bancaria de
 * destino y abona la de origen (leído de una transferencia real conciliada a mano: WOBA, 02/09/2026, asiento 3126,
 * debe 57200001 / haber 57200015), y los dos movimientos conciliados contra ese asiento. No crea ingreso ni gasto.
 *
 * Garantías:
 *  - Antes de escribir relee las dos cuentas y los dos movimientos; cualquier diferencia cancela sin tocar Holded.
 *  - El estado «ejecutando» y el id del asiento se guardan ANTES de seguir: tras un corte no se repite ninguna escritura.
 *  - Una escritura incierta nunca se reintenta: se verifica por lectura y, si no cuadra, queda «fallida» para una persona.
 *  - No se da por bueno un HTTP 200: se exige estado conciliado, importe conciliado y el asiento exacto, sin otros nuevos.
 */

export interface LineaAsiento { asientoId: string; cuenta: string; debe: number; haber: number; descripcion: string; tipo: string }

export interface DependenciasEjecucion {
  leerCuentas(empresa: Empresa): Promise<CuentaTransferencia[]>;
  leerMovimiento(empresa: Empresa, cuenta: CuentaTransferencia, movimientoId: string, fecha: string): Promise<MovimientoTransferencia | undefined>;
  /** Líneas del libro diario de una cuenta contable entre dos fechas (YYYY-MM-DD). */
  leerLineas(empresa: Empresa, cuentaContable: string, desde: string, hasta: string): Promise<LineaAsiento[]>;
  crearAsiento(empresa: Empresa, asiento: { date: string; notes: string; lines: Array<{ account: number; description: string; debit: string; credit: string }> }): Promise<string>;
  conciliar(empresa: Empresa, cuentaId: string, movimientoId: string, asientoId: string): Promise<void>;
  guardar(registro: RegistroTransferencia): Promise<void>;
}

export interface ResultadoEjecucion { estado: RegistroTransferencia["estado"]; mensaje: string; registro: RegistroTransferencia }

const CENTIMO = 0.005;
const marcador = (r: RegistroTransferencia) => `[wobi:transferencia:${r.id}]`;
const cuentaContableValida = (c: string | undefined) => Boolean(c && /^(572|520)\d{5}$/.test(c));
const texto = (n: number) => Math.abs(n).toFixed(2);

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
  if (r.tipo !== "transferencia" || r.monedaOrigen !== r.monedaDestino) return "Las conversiones de moneda todavía no se ejecutan: solo transferencias en la misma moneda.";
  if (!e.origenCuenta || !e.destinoCuenta) return "Alguna de las dos cuentas ya no existe en Holded.";
  for (const c of [e.origenCuenta, e.destinoCuenta]) {
    if (c.archivada) return `La cuenta «${c.nombre}» está archivada.`;
    if (c.tipo !== "bank") return `La cuenta «${c.nombre}» no es una cuenta bancaria.`;
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

/** Comprueba por lectura que la operación quedó exactamente como debe. Devuelve los fallos encontrados (vacío = correcta). */
export async function verificarTransferencia(
  r: RegistroTransferencia,
  d: DependenciasEjecucion,
  lineasAntes?: { origen: number; destino: number }
): Promise<string[]> {
  const fallos: string[] = [];
  const e = await leerEstado(r, d);
  if (!e.origenCuenta || !e.destinoCuenta || !e.origen || !e.destino) return ["No se pudieron releer las cuentas o los movimientos."];
  for (const [m, nombre, esperado] of [[e.origen, "de salida", r.importeOrigen], [e.destino, "de entrada", r.importeDestino]] as const) {
    if (!estaConciliado(m.estado)) fallos.push(`El movimiento ${nombre} no quedó conciliado (estado ${m.estado}).`);
    if (Math.abs(Math.abs(m.conciliado) - Math.abs(esperado)) > CENTIMO) fallos.push(`El movimiento ${nombre} tiene conciliados ${m.conciliado.toFixed(2)} en lugar de ${texto(esperado)}.`);
  }
  const importe = Math.abs(r.importeDestino);
  const [desde, hasta] = [r.origenFecha, r.destinoFecha].sort();
  const lineasDestino = await d.leerLineas(r.empresa, e.destinoCuenta.cuentaContable!, desde, hasta);
  const lineasOrigen = await d.leerLineas(r.empresa, e.origenCuenta.cuentaContable!, desde, hasta);
  const delAsiento = [...lineasDestino, ...lineasOrigen].filter((l) => l.asientoId === r.asientoId);
  const debeDestino = delAsiento.filter((l) => l.cuenta === e.destinoCuenta!.cuentaContable && Math.abs(l.debe - importe) <= CENTIMO && l.haber <= CENTIMO);
  const haberOrigen = delAsiento.filter((l) => l.cuenta === e.origenCuenta!.cuentaContable && Math.abs(l.haber - importe) <= CENTIMO && l.debe <= CENTIMO);
  if (!r.asientoId) fallos.push("No hay asiento registrado para esta operación.");
  else if (debeDestino.length !== 1 || haberOrigen.length !== 1 || delAsiento.length !== 2) {
    fallos.push(`El asiento ${r.asientoId} no tiene exactamente un cargo de ${texto(importe)} en la cuenta de destino y un abono en la de origen.`);
  }
  // La conciliación no debe haber generado otros asientos (un cobro, un pago, un gasto) además del nuestro.
  if (lineasAntes) {
    if (lineasDestino.length !== lineasAntes.destino + 1) fallos.push(`En la cuenta contable de destino aparecieron ${lineasDestino.length - lineasAntes.destino} líneas nuevas; se esperaba 1.`);
    if (lineasOrigen.length !== lineasAntes.origen + 1) fallos.push(`En la cuenta contable de origen aparecieron ${lineasOrigen.length - lineasAntes.origen} líneas nuevas; se esperaba 1.`);
  }
  return fallos;
}

export async function ejecutarTransferencia(registro: RegistroTransferencia, d: DependenciasEjecucion = dependenciasHolded): Promise<ResultadoEjecucion> {
  let r = registro;
  const cerrar = async (estado: RegistroTransferencia["estado"], mensaje: string): Promise<ResultadoEjecucion> => {
    r = { ...r, estado, detalle: mensaje };
    await d.guardar(r);
    return { estado, mensaje, registro: r };
  };

  if (r.estado === "verificada") return { estado: "verificada", mensaje: "Esta transferencia ya estaba conciliada y verificada.", registro: r };
  // Un intento anterior se cortó a medias: no se repite ninguna escritura; solo se mira cómo quedó.
  if (r.estado === "ejecutando" || r.estado === "fallida") {
    const fallos = r.asientoId ? await verificarTransferencia(r, d) : ["El intento anterior se interrumpió antes de registrar el asiento."];
    return fallos.length === 0
      ? cerrar("verificada", "El intento anterior sí había quedado completo: verificado por lectura.")
      : cerrar("fallida", `El intento anterior quedó incompleto y no se repite solo. Revísalo en Holded${r.asientoId ? ` (asiento ${r.asientoId})` : ""}: ${fallos.join(" ")}`);
  }
  if (r.estado !== "aprobada") return { estado: r.estado, mensaje: `La operación está en estado «${r.estado}»; no se ejecuta.`, registro: r };

  // 1) Relectura: nada cambió desde la propuesta.
  const antes = await leerEstado(r, d);
  const motivo = motivoParaNoEjecutar(r, antes);
  if (motivo) return cerrar("revision_manual", `No se escribió nada en Holded. ${motivo}`);
  const origenCuenta = antes.origenCuenta!, destinoCuenta = antes.destinoCuenta!;
  const importe = Math.abs(r.importeDestino);
  const [desde, hasta] = [r.origenFecha, r.destinoFecha].sort();

  // 2) Si el asiento de esta operación ya existe (marcador), no se crea otro.
  const lineasDestinoAntes = await d.leerLineas(r.empresa, destinoCuenta.cuentaContable!, desde, hasta);
  const lineasOrigenAntes = await d.leerLineas(r.empresa, origenCuenta.cuentaContable!, desde, hasta);
  if ([...lineasDestinoAntes, ...lineasOrigenAntes].some((l) => l.descripcion.includes(marcador(r)))) {
    return cerrar("fallida", "Ya existe en Holded un asiento con la marca de esta operación sin que conste terminada. No se escribió nada más; revísalo.");
  }

  // 3) A partir de aquí se escribe. El estado queda guardado antes de cada paso.
  r = { ...r, estado: "ejecutando", detalle: "Creando el asiento de la transferencia." };
  await d.guardar(r);
  const descripcion = `Transferencia entre cuentas propias: ${origenCuenta.nombre} → ${destinoCuenta.nombre} ${marcador(r)}`;
  let asientoId: string;
  try {
    asientoId = await d.crearAsiento(r.empresa, {
      date: r.destinoFecha,
      notes: descripcion,
      lines: [
        { account: Number(destinoCuenta.cuentaContable), description: descripcion, debit: importe.toFixed(2), credit: "0.00" },
        { account: Number(origenCuenta.cuentaContable), description: descripcion, debit: "0.00", credit: importe.toFixed(2) },
      ],
    });
  } catch (error) {
    return cerrar("fallida", `Holded no confirmó la creación del asiento (${error instanceof Error ? error.message.slice(0, 200) : "error"}). No se concilió nada y no se reintenta solo; comprueba en Holded si el asiento existe.`);
  }
  r = { ...r, asientoId, detalle: `Asiento ${asientoId} creado; conciliando los dos movimientos.` };
  await d.guardar(r);

  try {
    await d.conciliar(r.empresa, r.destinoCuenta, r.destinoMovimiento, asientoId);
    await d.conciliar(r.empresa, r.origenCuenta, r.origenMovimiento, asientoId);
  } catch (error) {
    const fallos = await verificarTransferencia(r, d, { origen: lineasOrigenAntes.length, destino: lineasDestinoAntes.length }).catch(() => ["No se pudo verificar por lectura."]);
    if (fallos.length === 0) return cerrar("verificada", "Holded devolvió un error al conciliar, pero la lectura confirma que quedó completa.");
    return cerrar("fallida", `El asiento ${asientoId} se creó, pero la conciliación no quedó completa (${error instanceof Error ? error.message.slice(0, 200) : "error"}). No se reintenta solo. ${fallos.join(" ")}`);
  }

  // 4) Verificación completa por lectura.
  const fallos = await verificarTransferencia(r, d, { origen: lineasOrigenAntes.length, destino: lineasDestinoAntes.length });
  return fallos.length === 0
    ? cerrar("verificada", `Transferencia conciliada: asiento ${asientoId}, debe ${destinoCuenta.cuentaContable} (${destinoCuenta.nombre}) / haber ${origenCuenta.cuentaContable} (${origenCuenta.nombre}) por ${importe.toFixed(2)} ${r.monedaDestino}; los dos movimientos conciliados.`)
    : cerrar("fallida", `Se escribió en Holded, pero la verificación no cuadra y no se continúa. Asiento ${asientoId}. ${fallos.join(" ")}`);
}

const numero = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Dependencias reales: lecturas por la API de Holded y escrituras por la guardia de write.ts. */
export const dependenciasHolded: DependenciasEjecucion = {
  leerCuentas: async (empresa) => (await listTreasuryAccounts(empresa)).map(aCuenta),
  leerMovimiento: async (empresa, cuenta, movimientoId, fecha) => {
    const movimientos = await listBankMovements(empresa, cuenta.id, fecha, fecha);
    const crudo = movimientos.find((m) => m.id === movimientoId);
    return crudo ? aMovimiento(cuenta.id, cuenta.moneda, crudo) : undefined;
  },
  leerLineas: async (empresa, cuentaContable, desde, hasta) => {
    const lineas: LineaAsiento[] = [];
    let cursor: string | undefined;
    for (let pagina = 0; pagina < 25; pagina++) {
      const parametros: Record<string, string> = { start_date: desde, end_date: hasta, account: cuentaContable, limit: "200" };
      if (cursor) parametros.cursor = cursor;
      const data = (await holdedGet(empresa, "/ledger-entries", parametros)) as { items?: Array<Record<string, unknown>>; cursor?: string; has_more?: boolean };
      for (const l of data.items ?? []) {
        lineas.push({ asientoId: String(l.id ?? ""), cuenta: String(l.account ?? ""), debe: numero(l.debit), haber: numero(l.credit), descripcion: String(l.description ?? ""), tipo: String(l.type ?? "") });
      }
      if (!data.has_more || !data.cursor) return lineas;
      cursor = data.cursor;
    }
    throw new Error("Holded devolvió demasiadas páginas del libro diario; no se puede verificar con seguridad.");
  },
  crearAsiento: crearAsientoHolded,
  conciliar: conciliarMovimientoContraAsientoHolded,
  guardar: guardarRegistro,
};
