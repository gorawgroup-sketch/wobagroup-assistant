import { readFileSync } from "node:fs";
import { join } from "node:path";

export type TipoRecurrencia = "mensual" | "anual";
export type Aproximado = "inicio" | "mediados" | "finales" | "durante el mes";

export interface EntradaCalendarioFiscal {
  concepto: string;
  tipo: TipoRecurrencia;
  /** Solo para tipo "mensual": día del mes (1-31) o "ultimo_dia_mes". */
  dia_referencia?: number | "ultimo_dia_mes";
  /** Solo para tipo "anual": mes (1-12). */
  mes?: number;
  /** Solo para tipo "anual": posición aproximada dentro del mes. */
  aproximado?: Aproximado;
  empresa: string;
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

export interface AlertaProxima {
  concepto: string;
  empresa: string;
  fecha: Date;
  diasParaVencer: number;
}

/**
 * Devuelve las entradas cuya próxima fecha cae dentro de los próximos
 * `diasVentana` días (incluyendo hoy), ordenadas por cercanía.
 */
export function calcularProximasAlertas(diasVentana = 3, hoy: Date = new Date()): AlertaProxima[] {
  const entradas = loadCalendarioFiscal();
  const hoyNorm = normalizarFecha(hoy);

  const alertas: AlertaProxima[] = entradas.map((entrada) => {
    const fecha = calcularProximaFecha(entrada, hoy);
    const diasParaVencer = Math.round((fecha.getTime() - hoyNorm.getTime()) / 86_400_000);
    return { concepto: entrada.concepto, empresa: entrada.empresa, fecha, diasParaVencer };
  });

  return alertas
    .filter((a) => a.diasParaVencer >= 0 && a.diasParaVencer <= diasVentana)
    .sort((a, b) => a.diasParaVencer - b.diasParaVencer);
}
