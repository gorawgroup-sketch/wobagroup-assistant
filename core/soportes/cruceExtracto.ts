import type { FilaExtracto } from "./extractoRevolut";

/**
 * Cruce puro entre los pagos con tarjeta del extracto de Revolut y los movimientos de Bancos de Holded.
 *
 * «Con soporte» = el movimiento ya está conciliado con un gasto. El extracto no trae ese estado (solo Holded lo sabe) y
 * Holded no trae el titular (solo el extracto lo sabe): hace falta cruzarlos por importe, moneda y fecha.
 * Un cargo del extracto sin movimiento en Holded NO es un cargo sin soporte: es un banco aún no sincronizado, y no se
 * le reclama nada a nadie por eso.
 */

export interface MovimientoBanco {
  id: string;
  cuentaId: string;
  cuenta: string;
  /** YYYY-MM-DD */
  fecha: string;
  /** Con signo, en la moneda de la cuenta. */
  importe: number;
  moneda: string;
  estado: string;
  descripcion: string;
}

export type EstadoCargo = "conciliado" | "sin_conciliar" | "parcial" | "no_sincronizado" | "ambiguo";

export interface CargoCruzado {
  fila: FilaExtracto;
  estado: EstadoCargo;
  movimiento?: MovimientoBanco;
}

/** Días de diferencia admitidos entre la fecha del extracto y la del movimiento de Holded (autorización vs. liquidación). */
export const VENTANA_DIAS_CRUCE = 5;

const dias = (a: string, b: string): number => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
const centimos = (n: number): number => Math.round(Math.abs(n) * 100);

function estadoDeMovimiento(estado: string): EstadoCargo {
  if (estado === "reconciled" || estado === "forced_reconciled") return "conciliado";
  if (estado === "partial") return "parcial";
  return "sin_conciliar";
}

const normalizar = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function cruzarConBanco(cargos: FilaExtracto[], movimientos: MovimientoBanco[]): CargoCruzado[] {
  const resultado = new Map<FilaExtracto, CargoCruzado>();
  const grupos = new Map<string, FilaExtracto[]>();
  for (const f of cargos) {
    const k = `${f.monedaCuenta}|${centimos(f.total)}`;
    (grupos.get(k) ?? grupos.set(k, []).get(k)!).push(f);
  }

  for (const [clave, filas] of grupos) {
    const [moneda, cts] = clave.split("|");
    const candidatos = movimientos.filter((m) => m.importe < 0 && m.moneda === moneda && centimos(m.importe) === Number(cts));
    const pares: Array<{ fila: FilaExtracto; mov: MovimientoBanco; distancia: number }> = [];
    for (const fila of filas) {
      for (const mov of candidatos) {
        const distancia = Math.min(dias(fila.fecha, mov.fecha), fila.fechaInicio ? dias(fila.fechaInicio, mov.fecha) : Infinity);
        if (distancia <= VENTANA_DIAS_CRUCE) pares.push({ fila, mov, distancia });
      }
    }
    pares.sort((a, b) => a.distancia - b.distancia || a.fila.lineaCsv - b.fila.lineaCsv);
    const filasUsadas = new Set<FilaExtracto>();
    const movsUsados = new Set<string>();
    for (const p of pares) {
      if (filasUsadas.has(p.fila) || movsUsados.has(p.mov.id)) continue;
      filasUsadas.add(p.fila);
      movsUsados.add(p.mov.id);
      resultado.set(p.fila, { fila: p.fila, estado: estadoDeMovimiento(p.mov.estado), movimiento: p.mov });
    }
    for (const fila of filas) if (!resultado.has(fila)) resultado.set(fila, { fila, estado: "no_sincronizado" });

    // Gemelos: mismo importe, titulares distintos y estados distintos → no se sabe qué cargo es de quién. No se reclama a ciegas.
    const emparejados = filas.map((f) => resultado.get(f)!).filter((c) => c.movimiento);
    const titulares = new Set(emparejados.map((c) => normalizar(c.fila.titular)));
    const estados = new Set(emparejados.map((c) => c.estado));
    if (emparejados.length > 1 && titulares.size > 1 && estados.size > 1) {
      for (const c of emparejados) resultado.set(c.fila, { ...c, estado: "ambiguo" });
    }
  }
  return cargos.map((f) => resultado.get(f)!);
}

export interface PropuestaPendienteResumen {
  proveedor: string;
  monto: number;
  moneda: string;
  fecha: string;
}

/**
 * Un recibo que ya llegó y espera el botón de Carlos no es un soporte que falte pedir: se detecta por importe
 * (original o de cuenta) y una fecha cercana. Más cauteloso que el cruce con el banco: exige ≤ 10 días.
 */
export function coincideConPropuestaPendiente(c: CargoCruzado, propuestas: PropuestaPendienteResumen[]): boolean {
  return propuestas.some((p) => {
    const importeP = centimos(p.monto);
    const coincideImporte =
      (p.moneda.toUpperCase() === c.fila.monedaOriginal && importeP === centimos(c.fila.importeOriginal)) ||
      (p.moneda.toUpperCase() === c.fila.monedaCuenta && importeP === centimos(c.fila.total));
    return coincideImporte && (!p.fecha || dias(p.fecha, c.fila.fecha) <= 10);
  });
}

export interface GrupoTitular {
  clave: string;
  titular: string;
  cargos: CargoCruzado[];
}

export function claveTitular(titular: string): string {
  return normalizar(titular);
}

/** Un grupo por persona; los cargos sin titular conocido quedan juntos en «(sin titular)». */
export function agruparPorTitular(cargos: CargoCruzado[]): GrupoTitular[] {
  const mapa = new Map<string, GrupoTitular>();
  for (const c of cargos) {
    const titular = c.fila.titular.trim();
    const clave = titular ? claveTitular(titular) : "";
    const g = mapa.get(clave) ?? { clave, titular: titular || "(sin titular)", cargos: [] };
    g.cargos.push(c);
    mapa.set(clave, g);
  }
  return [...mapa.values()].sort((a, b) => b.cargos.length - a.cargos.length || a.titular.localeCompare(b.titular));
}

const MONEDAS = new Set(["eur", "usd", "gbp", "cop", "brl", "mxn", "chf", "cad", "aud"]);
const palabrasDeCuenta = (t: string): string[] => normalizar(t).split(" ").filter((w) => w && !MONEDAS.has(w));

/**
 * Qué cuentas de Holded corresponden a la cuenta del extracto («EUR Main» ↔ «Main»; «USD Pocket» ↔ «Pocket USD»).
 * Se compara el nombre sin el código de moneda; si no hay una coincidencia exacta se aceptan las que contengan todas las
 * palabras, y como último recurso las de la misma moneda (el cruce por importe y fecha desempata, y avisa si no basta).
 */
export function elegirCuentasHolded<T extends { name?: string; currency?: string }>(cuentaExtracto: string, cuentas: T[]): T[] {
  const buscadas = palabrasDeCuenta(cuentaExtracto);
  const moneda = normalizar(cuentaExtracto).split(" ").find((w) => MONEDAS.has(w))?.toUpperCase();
  if (buscadas.length) {
    const exactas = cuentas.filter((c) => palabrasDeCuenta(c.name ?? "").join(" ") === buscadas.join(" "));
    const porMoneda = (lista: T[]): T[] => {
      const misma = moneda ? lista.filter((c) => !c.currency || c.currency.toUpperCase() === moneda) : lista;
      return misma.length ? misma : lista;
    };
    if (exactas.length) return exactas.length > 1 ? porMoneda(exactas) : exactas;
    const contienen = cuentas.filter((c) => buscadas.every((w) => palabrasDeCuenta(c.name ?? "").includes(w)));
    if (contienen.length) return contienen.length > 1 ? porMoneda(contienen) : contienen;
  }
  return moneda ? cuentas.filter((c) => (c.currency ?? "").toUpperCase() === moneda) : cuentas;
}
