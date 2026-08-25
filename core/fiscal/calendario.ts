import { readFileSync } from "node:fs";
import { join } from "node:path";

export type TipoRecurrencia = "mensual" | "anual";
export type Aproximado = "inicio" | "mediados" | "finales" | "durante el mes";

export interface EntradaCalendarioFiscal {
  /** Slug corto y estable, solo en entradas que pueden proponerse para Holded+cashflow (ver empresaCashflow). */
  id?: string;
  concepto: string;
  tipo: TipoRecurrencia;
  /** Solo para tipo "mensual": día del mes (1-31) o "ultimo_dia_mes". */
  dia_referencia?: number | "ultimo_dia_mes";
  /** Solo para tipo "anual": mes (1-12). */
  mes?: number;
  /** Solo para tipo "anual": posición aproximada dentro del mes. */
  aproximado?: Aproximado;
  empresa: string;
  /**
   * Si está presente, la entrada es candidata a proponerse como pago
   * recurrente para registrar en Holded + cashflow (botón en la alerta). El
   * valor es la empresa tal como la reconoce el cashflow (WOBA o EWORKS) —
   * "BAE" y "WOBA" son la misma entidad, así que las entradas "BAE" mapean a
   * "WOBA" aquí. Entradas sin este campo se quedan como aviso informativo
   * únicamente (monto desconocido o aplica a varias empresas a la vez).
   */
  empresaCashflow?: "WOBA" | "EWORKS";
  /** Nombre del proveedor/contacto en Holded, si se conoce de antemano. */
  proveedor?: string;
}

const CALENDARIO_PATH = join(process.cwd(), "docs", "calendario_fiscal.json");

let cache: EntradaCalendarioFiscal[] | null = null;

/**
 * Carga /docs/calendario_fiscal.json (misma convención de ruta que
 * core/knowledge/loader.ts para docs/responsabilidades.md).
 */
export function loadCalendarioFiscal(): EntradaCalendarioFiscal[] {
  if (cache) return cache;

  const raw = readFileSync(CALENDARIO_PATH, "utf-8");
  cache = JSON.parse(raw) as EntradaCalendarioFiscal[];
  return cache;
}

// "aproximado" no es una fecha real del documento, solo una posición dentro
// del mes — se mapea a un día representativo únicamente para poder calcular
// cuándo avisar. Revisar que estos días tengan sentido antes de confiar en
// el cron sin supervisión.
const DIA_APROXIMADO: Record<Aproximado, number> = {
  inicio: 5,
  mediados: 15,
  finales: 25,
  "durante el mes": 15,
};

function ultimoDiaDelMes(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

function normalizarFecha(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Calcula la próxima fecha en que vence una entrada del calendario, a partir
 * de `hoy`. Si la fecha de este mes/año ya pasó, salta al siguiente ciclo.
 */
export function calcularProximaFecha(entrada: EntradaCalendarioFiscal, hoy: Date = new Date()): Date {
  const hoyNorm = normalizarFecha(hoy);

  if (entrada.tipo === "mensual") {
    const diaEsteMes =
      entrada.dia_referencia === "ultimo_dia_mes"
        ? ultimoDiaDelMes(hoyNorm.getFullYear(), hoyNorm.getMonth())
        : (entrada.dia_referencia as number);

    let candidato = new Date(hoyNorm.getFullYear(), hoyNorm.getMonth(), diaEsteMes);

    if (candidato < hoyNorm) {
      const siguienteMesIndex = hoyNorm.getMonth() + 1; // Date normaliza el desborde a enero del año siguiente
      const diaSiguienteMes =
        entrada.dia_referencia === "ultimo_dia_mes"
          ? ultimoDiaDelMes(hoyNorm.getFullYear(), siguienteMesIndex)
          : diaEsteMes;
      candidato = new Date(hoyNorm.getFullYear(), siguienteMesIndex, diaSiguienteMes);
    }

    return candidato;
  }

  // tipo === "anual"
  const mesIndex0 = (entrada.mes ?? 1) - 1;
  const dia = entrada.aproximado ? DIA_APROXIMADO[entrada.aproximado] : 15;

  let candidato = new Date(hoyNorm.getFullYear(), mesIndex0, dia);
  if (candidato < hoyNorm) {
    candidato = new Date(hoyNorm.getFullYear() + 1, mesIndex0, dia);
  }

  return candidato;
}

/** Busca una entrada del calendario por su `id` (solo las que lo tienen). */
export function obtenerEntradaPorId(id: string): EntradaCalendarioFiscal | undefined {
  return loadCalendarioFiscal().find((e) => e.id === id);
}

export interface AlertaProxima {
  concepto: string;
  empresa: string;
  fecha: Date;
  diasParaVencer: number;
  /** Presente solo si la entrada es candidata a proponerse para Holded + cashflow. */
  id?: string;
  empresaCashflow?: "WOBA" | "EWORKS";
  proveedor?: string;
}

// Ventana de aviso por defecto: las entradas "anual" tienen fecha aproximada
// (no un día confirmado), así que se avisan con más margen que las
// "mensual", cuyo día es exacto y conocido.
const VENTANA_MENSUAL_DIAS = 3;
const VENTANA_ANUAL_DIAS = 7;

/**
 * Devuelve las entradas cuya próxima fecha cae dentro de su ventana de aviso,
 * ordenadas por cercanía. Sin `diasOverride`, usa 3 días para "mensual" (día
 * exacto) y 7 días para "anual" (fecha aproximada). Con `diasOverride`, esa
 * misma ventana se aplica a todas por igual (para consultas puntuales tipo
 * "qué vence en los próximos 60 días").
 */
export function calcularProximasAlertas(hoy: Date = new Date(), diasOverride?: number): AlertaProxima[] {
  const entradas = loadCalendarioFiscal();
  const hoyNorm = normalizarFecha(hoy);

  const alertas = entradas.map((entrada) => {
    const fecha = calcularProximaFecha(entrada, hoy);
    const diasParaVencer = Math.round((fecha.getTime() - hoyNorm.getTime()) / 86_400_000);
    const ventana = diasOverride ?? (entrada.tipo === "mensual" ? VENTANA_MENSUAL_DIAS : VENTANA_ANUAL_DIAS);
    return {
      concepto: entrada.concepto,
      empresa: entrada.empresa,
      fecha,
      diasParaVencer,
      ventana,
      id: entrada.id,
      empresaCashflow: entrada.empresaCashflow,
      proveedor: entrada.proveedor,
    };
  });

  return alertas
    .filter((a) => a.diasParaVencer >= 0 && a.diasParaVencer <= a.ventana)
    .sort((a, b) => a.diasParaVencer - b.diasParaVencer);
}
