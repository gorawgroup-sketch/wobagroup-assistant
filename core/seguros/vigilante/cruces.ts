/**
 * Cruce del registro de pólizas con el banco. TODO lo de este archivo es puro (sin Sheets, sin Holded, sin red):
 * recibe pólizas y apuntes ya leídos y devuelve decisiones. Así cada regla se prueba con los casos reales que la
 * motivaron y el vigilante (vigilante.ts) solo se ocupa de leer, escribir y avisar.
 *
 * Principio de todo el archivo: ante la duda, NO se concluye. Un pago se da por confirmado solo con importe exacto
 * al céntimo + contraparte reconocida + empresa correcta + salida de dinero + una única coincidencia posible + que el
 * cargo haya llegado de verdad al saldo de la cuenta (ver cadena.ts: el 01/09 Holded mostró como cobrados dos
 * adeudos que el banco devolvió).
 */
import type { PolizaConFila } from "../polizaRegistroSheet";
import type { EstadoLiquidacion } from "./cadena";
import { clasificarContraparte, clavesDePoliza, normalizarTexto, type Contraparte } from "./contrapartes";
import { restarDias } from "./fechas";
import { mismoImporte, parsearImporteSimple } from "./importes";
import { esEmpresaHolded, importeEnEur, type MovimientoBanco } from "./tipos";

const DIAS_VENTANA_PAGO = 60;
const MAX_POLIZAS_EN_PAGO_CONSOLIDADO = 10;

function salidaEnEur(m: MovimientoBanco): number | null {
  const eur = importeEnEur(m);
  return eur != null && eur < 0 ? -eur : null;
}

function claveDe(m: MovimientoBanco): string {
  return clasificarContraparte(m.descripcion)?.clave ?? "";
}

// ---------------------------------------------------------------------------------------------------------------
// Cómo se pagó y si el banco lo aplicó
// ---------------------------------------------------------------------------------------------------------------

export type FormaDePago = "transferencia" | "adeudo" | "otro";

/**
 * Una transferencia la ordenamos nosotros y no se puede devolver como un recibo; un adeudo lo pasa la aseguradora
 * y el banco puede rechazarlo días después, que es justo lo que ha ido pasando con las pólizas de WOBA.
 */
export function formaDePago(descripcion: string): FormaDePago {
  const texto = normalizarTexto(descripcion);
  if (/^to /.test(texto) || /\btransferencias?\b/.test(texto)) return "transferencia";
  if (/\b(adeudo|adeudos|domiciliacion|domiciliado)\b/.test(texto)) return "adeudo";
  return "otro";
}

export interface VeredictoLiquidacion {
  estado: EstadoLiquidacion;
  /** La cadena de saldos de la cuenta de este apunte es fiable (ver cadena.ts). */
  cuentaFiable: boolean;
}

export type EvaluadorLiquidacion = (m: MovimientoBanco) => VeredictoLiquidacion;

const SIEMPRE_LIQUIDADO: EvaluadorLiquidacion = () => ({ estado: "liquidado", cuentaFiable: true });

/** null = se puede dar por pagado; texto = por qué todavía no. */
export function motivoParaNoConfirmar(m: MovimientoBanco, evaluar: EvaluadorLiquidacion): string | null {
  const { estado, cuentaFiable } = evaluar(m);
  const forma = formaDePago(m.descripcion);
  if (forma === "transferencia") {
    return cuentaFiable && estado === "huerfano" ? "el saldo del banco no refleja esta transferencia" : null;
  }
  if (!cuentaFiable) {
    return forma === "adeudo"
      ? "es un adeudo domiciliado y esta cuenta no permite comprobar en su saldo que el banco lo aplicara"
      : null;
  }
  if (estado === "liquidado") return null;
  if (estado === "huerfano") return "el saldo del banco no lo refleja: probablemente se devolvió";
  return "el saldo del banco todavía no lo refleja (los cargos del último día no se pueden validar hasta que el banco asiente movimientos posteriores)";
}

// ---------------------------------------------------------------------------------------------------------------
// 1) Pagos pendientes que el banco ya muestra
// ---------------------------------------------------------------------------------------------------------------

export interface PagoConfirmado {
  /** Una póliza (pago simple) o varias (una transferencia que paga varios recibos juntos, como los 1.306,00 € de Acodrid). */
  polizas: PolizaConFila[];
  movimiento: MovimientoBanco;
  consolidado: boolean;
}

export interface PagoEnTransito {
  polizas: PolizaConFila[];
  movimiento: MovimientoBanco;
  consolidado: boolean;
  motivo: string;
}

export interface PagoAmbiguo {
  poliza: PolizaConFila;
  motivo: string;
  candidatos: MovimientoBanco[];
}

export interface PagoNoVerificable {
  poliza: PolizaConFila;
  motivo: string;
}

export interface ResultadoConfirmacion {
  confirmados: PagoConfirmado[];
  /** Hay un cargo que encaja, pero todavía no se puede dar por cobrado. */
  enTransito: PagoEnTransito[];
  ambiguos: PagoAmbiguo[];
  noVerificables: PagoNoVerificable[];
  /** Pólizas con pago pendiente cuyo cargo NO aparece en lo leído (solo es una afirmación válida si la lectura fue completa). */
  sinPago: PolizaConFila[];
}

interface Pendiente {
  poliza: PolizaConFila;
  importe: number;
  empresa: string;
  claves: string[];
}

function subconjuntos<T>(items: T[], tamano: number): T[][] {
  const salida: T[][] = [];
  const recorrer = (desde: number, actual: T[]) => {
    if (actual.length === tamano) { salida.push([...actual]); return; }
    for (let i = desde; i < items.length; i++) { actual.push(items[i]); recorrer(i + 1, actual); actual.pop(); }
  };
  recorrer(0, []);
  return salida;
}

export function confirmarPagos(
  polizas: PolizaConFila[],
  movimientos: MovimientoBanco[],
  hoy: string,
  evaluar: EvaluadorLiquidacion = SIEMPRE_LIQUIDADO
): ResultadoConfirmacion {
  const resultado: ResultadoConfirmacion = { confirmados: [], enTransito: [], ambiguos: [], noVerificables: [], sinPago: [] };
  const desde = restarDias(hoy, DIAS_VENTANA_PAGO);

  const pendientes: Pendiente[] = [];
  for (const poliza of polizas) {
    if (poliza.estadoPago !== "pendiente" && poliza.estadoPago !== "sin_confirmar") continue;
    if (poliza.estado !== "vigente" && poliza.estado !== "pendiente_confirmacion") continue;
    const importe = parsearImporteSimple(poliza.prima);
    if (importe == null) {
      resultado.noVerificables.push({ poliza, motivo: `la prima («${poliza.prima || "vacía"}») no es un importe limpio` });
      continue;
    }
    if (!esEmpresaHolded(poliza.empresaHolded)) {
      resultado.noVerificables.push({ poliza, motivo: `la empresa «${poliza.empresaHolded}» no tiene banco en Holded` });
      continue;
    }
    const claves = clavesDePoliza(poliza.aseguradora, poliza.correduria);
    if (claves.length === 0) {
      resultado.noVerificables.push({ poliza, motivo: "no sé reconocer su aseguradora ni su correduría en el banco" });
      continue;
    }
    pendientes.push({ poliza, importe, empresa: poliza.empresaHolded, claves });
  }

  const salidas = movimientos.filter((m) => m.fecha >= desde && salidaEnEur(m) != null);
  const usados = new Set<string>();
  const resueltas = new Set<string>();

  const clasificar = (polizasDelPago: PolizaConFila[], movimiento: MovimientoBanco, consolidado: boolean) => {
    const motivo = motivoParaNoConfirmar(movimiento, evaluar);
    if (motivo) resultado.enTransito.push({ polizas: polizasDelPago, movimiento, consolidado, motivo });
    else resultado.confirmados.push({ polizas: polizasDelPago, movimiento, consolidado });
    usados.add(movimiento.id);
  };

  // Pago simple: un movimiento por póliza.
  const candidatosDe = new Map<string, MovimientoBanco[]>();
  for (const p of pendientes) {
    candidatosDe.set(
      p.poliza.id,
      salidas.filter((m) => m.empresa === p.empresa && mismoImporte(salidaEnEur(m) as number, p.importe) && p.claves.includes(claveDe(m)))
    );
  }
  const pendientesQueEncajanCon = (m: MovimientoBanco) =>
    pendientes.filter((q) => (candidatosDe.get(q.poliza.id) ?? []).some((c) => c.id === m.id));
  for (const p of pendientes) {
    const candidatos = candidatosDe.get(p.poliza.id) ?? [];
    if (candidatos.length === 0) continue;
    resueltas.add(p.poliza.id);
    if (candidatos.length > 1) {
      resultado.ambiguos.push({ poliza: p.poliza, motivo: `hay ${candidatos.length} cargos posibles con ese importe`, candidatos });
    } else if (pendientesQueEncajanCon(candidatos[0]).length > 1) {
      resultado.ambiguos.push({ poliza: p.poliza, motivo: "otro pago pendiente tiene el mismo importe y la misma contraparte", candidatos });
    } else {
      clasificar([p.poliza], candidatos[0], false);
    }
  }

  // Pago consolidado: una transferencia a la correduría que paga varios recibos pendientes a la vez.
  for (const m of salidas) {
    if (usados.has(m.id)) continue;
    const importe = salidaEnEur(m) as number;
    const clave = claveDe(m);
    if (!clave) continue;
    const elegibles = pendientes
      .filter((p) => !resueltas.has(p.poliza.id) && p.empresa === m.empresa && p.claves.includes(clave))
      .slice(0, MAX_POLIZAS_EN_PAGO_CONSOLIDADO);
    if (elegibles.length < 2) continue;
    const encajan: Pendiente[][] = [];
    for (let tamano = 2; tamano <= Math.min(4, elegibles.length); tamano++) {
      for (const grupo of subconjuntos(elegibles, tamano)) {
        if (mismoImporte(grupo.reduce((suma, p) => suma + p.importe, 0), importe)) encajan.push(grupo);
      }
    }
    if (encajan.length === 1) {
      for (const p of encajan[0]) resueltas.add(p.poliza.id);
      clasificar(encajan[0].map((p) => p.poliza), m, true);
    } else if (encajan.length > 1) {
      for (const p of new Set(encajan.flat())) {
        resueltas.add(p.poliza.id);
        resultado.ambiguos.push({ poliza: p.poliza, motivo: "el mismo cargo podría pagar combinaciones distintas de recibos pendientes", candidatos: [m] });
      }
    }
  }

  for (const p of pendientes) if (!resueltas.has(p.poliza.id)) resultado.sinPago.push(p.poliza);
  return resultado;
}

// ---------------------------------------------------------------------------------------------------------------
// 2) Pagos ya confirmados que el banco podría devolver
// ---------------------------------------------------------------------------------------------------------------

/**
 * Por qué existe: los recibos devueltos son EL fallo recurrente de las pólizas de WOBA (Allianz y Markel, 09/2026).
 * Un cargo domiciliado puede aparecer hoy y devolverse días después; dar el pago por bueno para siempre escondería
 * justo ese impago.
 */
export const DIAS_VIGILANCIA_DEVOLUCION = 14;

export interface PagoVigilado {
  poliza: PolizaConFila;
  movimiento: MovimientoBanco;
  claves: string[];
}

export interface PosibleDevolucion {
  vigilado: PagoVigilado;
  /** Apunte contrario que delata la devolución; null si el cargo salió de la cadena de saldos sin dejar apunte contrario. */
  entrada: MovimientoBanco | null;
  /**
   * probable → se revierte el registro (la entrada nombra a la misma contraparte, o el saldo del banco dejó de
   * reflejar el cargo). posible → solo el texto de «devolución»: se avisa, no se toca el registro.
   */
  certeza: "probable" | "posible";
}

const PATRON_DEVOLUCION = /\b(devol\w*|return\w*|refund\w*|reembols\w*|anulaci\w*|rechaz\w*|impag\w*)\b/;

/**
 * Pagos recientes vigilados: los apuntes del banco que el registro cita como prueba (su id de 24 hexadecimales, tal
 * como lo escribe el vigilante en `notas`) en pólizas hoy marcadas como pagadas. Sin almacén aparte: la propia
 * prueba escrita en el registro es la lista de lo que hay que seguir mirando, incluso si la escribió una persona.
 */
export function pagosVigilados(polizas: PolizaConFila[], movimientos: MovimientoBanco[], hoy: string): PagoVigilado[] {
  const desde = restarDias(hoy, DIAS_VIGILANCIA_DEVOLUCION);
  const porId = new Map(movimientos.map((m) => [m.id, m]));
  const vigilados: PagoVigilado[] = [];
  const vistos = new Set<string>();
  for (const poliza of polizas) {
    if (poliza.estadoPago !== "pagado") continue;
    for (const id of poliza.notas.match(/\b[0-9a-f]{24}\b/g) ?? []) {
      const m = porId.get(id);
      if (!m || vistos.has(`${poliza.id}:${id}`) || m.fecha < desde || salidaEnEur(m) == null) continue;
      vistos.add(`${poliza.id}:${id}`);
      vigilados.push({ poliza, movimiento: m, claves: clavesDePoliza(poliza.aseguradora, poliza.correduria) });
    }
  }
  return vigilados;
}

export function detectarDevoluciones(
  vigilados: PagoVigilado[],
  movimientos: MovimientoBanco[],
  evaluar: EvaluadorLiquidacion = SIEMPRE_LIQUIDADO
): PosibleDevolucion[] {
  const salida: PosibleDevolucion[] = [];
  for (const v of vigilados) {
    const pagado = salidaEnEur(v.movimiento);
    if (pagado == null) continue;
    let conEntrada = false;
    for (const m of movimientos) {
      const eur = importeEnEur(m);
      if (m.id === v.movimiento.id || m.empresa !== v.movimiento.empresa || m.fecha < v.movimiento.fecha) continue;
      if (eur == null || eur <= 0 || !mismoImporte(eur, pagado)) continue;
      if (v.claves.includes(claveDe(m))) { salida.push({ vigilado: v, entrada: m, certeza: "probable" }); conEntrada = true; }
      else if (PATRON_DEVOLUCION.test(normalizarTexto(m.descripcion))) { salida.push({ vigilado: v, entrada: m, certeza: "posible" }); conEntrada = true; }
    }
    // Sin apunte contrario: el saldo del banco ya no lo refleja (así se devolvieron Allianz y Aegon el 01/09).
    const { estado, cuentaFiable } = evaluar(v.movimiento);
    if (!conEntrada && cuentaFiable && estado === "huerfano" && formaDePago(v.movimiento.descripcion) !== "transferencia") {
      salida.push({ vigilado: v, entrada: null, certeza: "probable" });
    }
  }
  return salida;
}

// ---------------------------------------------------------------------------------------------------------------
// 3) Cargos a aseguradoras que el registro no explica
// ---------------------------------------------------------------------------------------------------------------

export type TipoCargoAnomalo = "no_registrada" | "sin_poliza_vigente" | "dada_de_baja" | "no_aplicado";

export interface CargoAnomalo {
  movimiento: MovimientoBanco;
  contraparte: Contraparte;
  tipo: TipoCargoAnomalo;
  /** Clave de no repetición: una vez por contraparte (no registrada), una vez al mes (baja / sin póliza vigente) o una vez por apunte. */
  claveAviso: string;
}

/** Un cargo que el saldo no refleja solo se avisa si es reciente: lo más antiguo ya es historia conocida. */
const DIAS_AVISO_NO_APLICADO = 14;

export function detectarCargosAnomalos(
  polizas: PolizaConFila[],
  movimientos: MovimientoBanco[],
  hoy: string,
  evaluar: EvaluadorLiquidacion = SIEMPRE_LIQUIDADO
): CargoAnomalo[] {
  const anomalos: CargoAnomalo[] = [];
  const desdeNoAplicado = restarDias(hoy, DIAS_AVISO_NO_APLICADO);
  for (const m of movimientos) {
    if (m.importe >= 0) continue;
    const contraparte = clasificarContraparte(m.descripcion);
    if (!contraparte || contraparte.modo === "fuera_de_alcance" || contraparte.modo === "puntual") continue;

    const mes = m.fecha.slice(0, 7);
    if (contraparte.modo === "baja") {
      anomalos.push({ movimiento: m, contraparte, tipo: "dada_de_baja", claveAviso: `cargo:${m.empresa}:${contraparte.clave}:${mes}` });
      continue;
    }

    // Un cargo de una aseguradora conocida que el saldo del banco no refleja: probablemente devuelto.
    const { estado, cuentaFiable } = evaluar(m);
    if (cuentaFiable && estado === "huerfano" && formaDePago(m.descripcion) !== "transferencia") {
      if (m.fecha >= desdeNoAplicado) anomalos.push({ movimiento: m, contraparte, tipo: "no_aplicado", claveAviso: `huerfano:${m.id}` });
      continue;
    }

    const deLaEmpresa = polizas.filter((p) => p.empresaHolded === m.empresa && clavesDePoliza(p.aseguradora, p.correduria).includes(contraparte.clave));
    if (contraparte.modo === "poliza" && deLaEmpresa.some((p) => p.estado === "vigente" || p.estado === "pendiente_confirmacion")) continue;
    if (contraparte.modo === "desconocida" && deLaEmpresa.length > 0) continue;

    if (contraparte.modo === "poliza" && deLaEmpresa.length > 0) {
      anomalos.push({ movimiento: m, contraparte, tipo: "sin_poliza_vigente", claveAviso: `cargo:${m.empresa}:${contraparte.clave}:${mes}` });
    } else {
      anomalos.push({ movimiento: m, contraparte, tipo: "no_registrada", claveAviso: `cargo:${m.empresa}:${contraparte.clave}` });
    }
  }
  return anomalos;
}
