import type { Empresa } from "../client";

/**
 * Detección de transferencias internas y conversiones de moneda entre cuentas de la MISMA empresa.
 *
 * Lógica determinista y pura (sin IA, sin red): recibe las cuentas y los movimientos ya leídos de Holded y devuelve
 * propuestas. No concilia ni escribe nada; la ejecución es otra pieza y exige autorización.
 *
 * Importe, fecha y tasa NO bastan. En la auditoría del 03-10-2026 hubo falsos candidatos reales: el mismo día y por
 * el mismo importe, WOBA tenía una transferencia propia de 1.900 € y un préstamo de eWorks de 1.900 €; un cobro de
 * «Business Atelier Agency» de 6.000 € junto a una transferencia propia de 6.000 €. Por eso cada pata debe demostrar
 * por su descripción que el movimiento es de la propia empresa, y un movimiento con más de un candidato se bloquea.
 */

export interface CuentaTransferencia {
  id: string;
  nombre: string;
  /** bank | card | gateway… Solo las cuentas bancarias pueden ser origen o destino. */
  tipo: string;
  moneda: string;
  archivada: boolean;
  /** Banco o proveedor que sirve la cuenta («Revolut Business ES», «Wise ES»…). */
  proveedor?: string;
  /** Última sincronización bancaria (ISO). Sin sincronización reciente la cuenta no participa. */
  sincronizadaEn?: string;
  cuentaContable?: string;
}

export interface MovimientoTransferencia {
  id: string;
  cuentaId: string;
  /** YYYY-MM-DD */
  fecha: string;
  /** Con signo, en la moneda de la cuenta. */
  importe: number;
  moneda: string;
  /** Valoración contable en EUR que da Holded cuando la cuenta no es en EUR (con signo). */
  equivalenteEur?: number;
  descripcion: string;
  estado: string;
  conciliado: number;
}

export type TipoOperacion = "transferencia" | "conversion";
export type Confianza = "automatica" | "revision" | "bloqueada";

export interface PropuestaTransferencia {
  /** Clave idempotente por pareja ORDENADA de movimientos (origen → destino). */
  clave: string;
  empresa: Empresa;
  tipo: TipoOperacion;
  fecha: string;
  origen: { cuenta: CuentaTransferencia; movimiento: MovimientoTransferencia };
  destino: { cuenta: CuentaTransferencia; movimiento: MovimientoTransferencia };
  /** Solo conversiones: unidades de moneda destino por unidad de moneda origen. */
  tasaImplicita?: number;
  tasaHistorica?: number;
  /** Diferencia, en %, entre la valoración en EUR de las dos patas (conversiones). */
  diferenciaPct?: number;
  /** Valor en EUR que entra menos el que sale: negativa = coste o pérdida de cambio; positiva = ganancia. */
  diferenciaEur?: number;
  confianza: Confianza;
  motivos: string[];
}

export interface CuentaExcluida { cuenta: CuentaTransferencia; motivo: string }

export interface ResultadoDeteccion {
  propuestas: PropuestaTransferencia[];
  cuentasExcluidas: CuentaExcluida[];
}

export const VERSION_REGLA = "transferencias-v1";
/** Una cuenta sin sincronizar en este plazo puede no tener todavía la otra pata: no participa. */
export const DIAS_MAX_SIN_SINCRONIZAR = 3;
export const DIAS_HABILES_MAX_TRANSFERENCIA = 2;
export const DIFERENCIA_AUTOMATICA_PCT = 1;
export const DIFERENCIA_REVISION_PCT = 3;

const CENTIMO = 0.005;

export const normalizarTexto = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Cómo aparece cada empresa en las descripciones bancarias (núcleo de su razón social). «business atelier» a secas NO
 * vale para WOBA: «Business Atelier Agency» y «Business Atelier» (EE. UU.) son otras sociedades que le pagan.
 */
export const NOMBRES_PROPIOS: Record<Empresa, string[]> = {
  WOBA: ["business atelier europa"],
  EWORKS: ["compania de proyectos eworks"],
  Footprint: ["business footprint eu"],
};

const MONEDAS = ["eur", "usd", "gbp", "cop"];

/** Descripción sin la coletilla de comisión («(fee: Usd)») ni espacios sobrantes: las dos patas de un cambio la comparten. */
export function descripcionBase(descripcion: string): string {
  return normalizarTexto(descripcion.replace(/\(fee:[^)]*\)/gi, " "));
}

/** «Exchanged To Eur Main», «Converted Usd To Eur»: devuelve la moneda de destino que declara el banco. */
export function monedaDestinoDeConversion(descripcion: string): string | undefined {
  const d = descripcionBase(descripcion);
  const m = /\b(?:exchanged|converted)\b.*?\bto (eur|usd|gbp|cop)\b/.exec(d);
  return m ? m[1].toUpperCase() : undefined;
}

/** La descripción demuestra que la otra parte es la propia empresa. */
export function esMovimientoPropio(empresa: Empresa, descripcion: string): boolean {
  const d = normalizarTexto(descripcion);
  if (NOMBRES_PROPIOS[empresa].some((n) => d.includes(n))) return true;
  return /\btransferencia propia\b|\btraspaso entre cuentas\b|\btraspaso propio\b/.test(d);
}

/** Movimiento interno del mismo banco entre sus propias cuentas: «To Eur Main» en las dos patas. */
function esTraspasoInternoDelBanco(descripcion: string): boolean {
  return new RegExp(`^to (${MONEDAS.join("|")}) \\S`).test(descripcionBase(descripcion));
}

function diasHabilesEntre(a: string, b: string): number {
  const [desde, hasta] = a <= b ? [a, b] : [b, a];
  const fin = Date.parse(`${hasta}T00:00:00Z`);
  let dias = 0;
  for (let t = Date.parse(`${desde}T00:00:00Z`) + 86_400_000; t <= fin; t += 86_400_000) {
    const dia = new Date(t).getUTCDay();
    if (dia !== 0 && dia !== 6) dias++;
  }
  return dias;
}

const diasNaturalesEntre = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** Valor en EUR de una pata: su importe si la cuenta es en EUR; si no, la valoración contable de Holded. */
function valorEur(m: MovimientoTransferencia): number | undefined {
  if (m.moneda === "EUR") return Math.abs(m.importe);
  return m.equivalenteEur !== undefined && Number.isFinite(m.equivalenteEur) && m.equivalenteEur !== 0 ? Math.abs(m.equivalenteEur) : undefined;
}

export function clasificarCuentas(cuentas: CuentaTransferencia[], hoy: string): { validas: CuentaTransferencia[]; excluidas: CuentaExcluida[] } {
  const validas: CuentaTransferencia[] = [];
  const excluidas: CuentaExcluida[] = [];
  for (const cuenta of cuentas) {
    const motivo =
      cuenta.archivada ? "archivada"
      : cuenta.tipo !== "bank" ? `tipo «${cuenta.tipo}»: no es una cuenta bancaria de origen o destino`
      : !cuenta.sincronizadaEn ? "sin fecha de sincronización bancaria"
      : diasNaturalesEntre(cuenta.sincronizadaEn.slice(0, 10), hoy) > DIAS_MAX_SIN_SINCRONIZAR ? `sin sincronizar desde el ${cuenta.sincronizadaEn.slice(0, 10)}`
      : undefined;
    if (motivo) excluidas.push({ cuenta, motivo }); else validas.push(cuenta);
  }
  return { validas, excluidas };
}

export const clavePareja = (empresa: Empresa, origenId: string, destinoId: string) => `${empresa}:${origenId}>${destinoId}`;

export interface OpcionesDeteccion {
  /** YYYY-MM-DD del día de la ejecución (para medir la frescura de la sincronización). */
  hoy: string;
  /** Tasa de mercado del día: unidades de `destino` por unidad de `origen`. undefined si no hay fuente fiable. */
  tasaHistorica?: (fecha: string, origen: string, destino: string) => number | undefined;
}

function evaluarPareja(
  empresa: Empresa,
  origen: { cuenta: CuentaTransferencia; movimiento: MovimientoTransferencia },
  destino: { cuenta: CuentaTransferencia; movimiento: MovimientoTransferencia },
  opciones: OpcionesDeteccion
): PropuestaTransferencia | undefined {
  const o = origen.movimiento, d = destino.movimiento;
  const base = { clave: clavePareja(empresa, o.id, d.id), empresa, fecha: o.fecha <= d.fecha ? o.fecha : d.fecha, origen, destino };

  if (o.moneda === d.moneda) {
    if (Math.abs(Math.abs(o.importe) - d.importe) > CENTIMO) return undefined;
    if (diasHabilesEntre(o.fecha, d.fecha) > DIAS_HABILES_MAX_TRANSFERENCIA) return undefined;
    const interno = esTraspasoInternoDelBanco(o.descripcion) && descripcionBase(o.descripcion) === descripcionBase(d.descripcion) &&
      Boolean(origen.cuenta.proveedor) && origen.cuenta.proveedor === destino.cuenta.proveedor;
    const propias = esMovimientoPropio(empresa, o.descripcion) && esMovimientoPropio(empresa, d.descripcion);
    if (!interno && !propias) return undefined;
    return {
      ...base, tipo: "transferencia", confianza: "automatica",
      motivos: [
        `Mismo importe (${Math.abs(o.importe).toFixed(2)} ${o.moneda}) en dos cuentas de ${empresa}`,
        o.fecha === d.fecha ? "misma fecha" : `fechas a ${diasHabilesEntre(o.fecha, d.fecha)} día(s) hábil(es)`,
        interno ? "traspaso interno del mismo banco, con la misma descripción en las dos patas" : "las dos descripciones nombran a la propia empresa",
      ],
    };
  }

  // Conversión: el banco la declara igual en las dos patas («Exchanged To Eur Main»).
  const monedaDeclarada = monedaDestinoDeConversion(o.descripcion);
  if (!monedaDeclarada || monedaDeclarada !== monedaDestinoDeConversion(d.descripcion) || monedaDeclarada !== d.moneda) return undefined;
  if (descripcionBase(o.descripcion) !== descripcionBase(d.descripcion)) return undefined;
  if (diasNaturalesEntre(o.fecha, d.fecha) > 1) return undefined;

  const eurSale = valorEur(o), eurEntra = valorEur(d);
  const tasaImplicita = d.importe / Math.abs(o.importe);
  const tasaHistorica = opciones.tasaHistorica?.(base.fecha, o.moneda, d.moneda);
  const motivos = [`El banco declara el cambio en las dos patas: «${o.descripcion.trim()}»`];
  let confianza: Confianza = "automatica";
  const degradar = (a: Confianza) => { if (a === "bloqueada" || (a === "revision" && confianza === "automatica")) confianza = a; };

  let diferenciaPct: number | undefined, diferenciaEur: number | undefined;
  if (eurSale === undefined || eurEntra === undefined) {
    degradar("revision");
    motivos.push("Holded no da la valoración en EUR de alguna pata: no se puede comprobar el cambio");
  } else {
    diferenciaEur = Math.round((eurEntra - eurSale) * 100) / 100;
    diferenciaPct = Math.abs(eurEntra - eurSale) / Math.max(eurEntra, eurSale) * 100;
    motivos.push(`Valor en EUR: salen ${eurSale.toFixed(2)}, entran ${eurEntra.toFixed(2)} (diferencia ${diferenciaPct.toFixed(2)} %)`);
    if (diferenciaPct > DIFERENCIA_REVISION_PCT) degradar("bloqueada");
    else if (diferenciaPct > DIFERENCIA_AUTOMATICA_PCT) degradar("revision");
  }
  if (tasaHistorica !== undefined && tasaHistorica > 0) {
    const desvio = Math.abs(tasaImplicita - tasaHistorica) / tasaHistorica * 100;
    motivos.push(`Tasa aplicada ${tasaImplicita.toFixed(4)} frente a la del día ${tasaHistorica.toFixed(4)} (${desvio.toFixed(2)} %)`);
    if (desvio > DIFERENCIA_REVISION_PCT) degradar("bloqueada");
    else if (desvio > DIFERENCIA_AUTOMATICA_PCT) degradar("revision");
  } else {
    motivos.push("Sin tasa histórica fiable para ese día: el cambio se apoya en la valoración en EUR de Holded");
    if (o.fecha !== d.fecha) degradar("revision");
  }
  if (!origen.cuenta.proveedor || origen.cuenta.proveedor !== destino.cuenta.proveedor) {
    degradar("revision");
    motivos.push("Las dos cuentas no son del mismo banco");
  }
  return { ...base, tipo: "conversion", tasaImplicita, tasaHistorica, diferenciaPct, diferenciaEur, confianza, motivos };
}

/**
 * Detecta las operaciones internas de UNA empresa. Nunca se le pasan movimientos de otra: aunque sean del mismo grupo,
 * son sociedades distintas y un pago entre ellas no es una transferencia propia.
 */
export function detectarTransferencias(
  empresa: Empresa,
  cuentas: CuentaTransferencia[],
  movimientos: MovimientoTransferencia[],
  opciones: OpcionesDeteccion
): ResultadoDeteccion {
  const { validas, excluidas } = clasificarCuentas(cuentas, opciones.hoy);
  const cuentaPorId = new Map(validas.map((c) => [c.id, c]));
  // Solo movimientos intactos: pendientes y sin nada conciliado.
  const libres = movimientos.filter((m) => cuentaPorId.has(m.cuentaId) && m.estado === "pending" && Math.abs(m.conciliado) < CENTIMO && m.importe !== 0);
  const salidas = libres.filter((m) => m.importe < 0), entradas = libres.filter((m) => m.importe > 0);

  const candidatas: PropuestaTransferencia[] = [];
  for (const o of salidas) {
    for (const d of entradas) {
      if (o.cuentaId === d.cuentaId) continue;
      const p = evaluarPareja(empresa, { cuenta: cuentaPorId.get(o.cuentaId)!, movimiento: o }, { cuenta: cuentaPorId.get(d.cuentaId)!, movimiento: d }, opciones);
      if (p) candidatas.push(p);
    }
  }

  // Asignación global: ningún movimiento puede usarse dos veces. Si un movimiento tiene más de una pareja posible,
  // todas las parejas en las que participa quedan bloqueadas para revisión humana.
  const usos = new Map<string, number>();
  for (const p of candidatas) for (const id of [p.origen.movimiento.id, p.destino.movimiento.id]) usos.set(id, (usos.get(id) ?? 0) + 1);
  const propuestas = candidatas.map((p) => {
    const repetidos = [p.origen.movimiento.id, p.destino.movimiento.id].filter((id) => (usos.get(id) ?? 0) > 1);
    return repetidos.length === 0 ? p : {
      ...p, confianza: "bloqueada" as const,
      motivos: [...p.motivos, "Ambiguo: alguno de estos movimientos también encaja con otro; hay que elegir a mano"],
    };
  }).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.clave.localeCompare(b.clave));

  return { propuestas, cuentasExcluidas: excluidas };
}
