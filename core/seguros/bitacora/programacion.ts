/**
 * Cuándo trabaja cada tarea de Wobi Seguros. Es la fuente de lo que Cerebro enseña como «cada cuánto vigila»; el planificador
 * (core/jobs/scheduler.ts) tiene sus propias cadenas cron, y programacion.test.ts comprueba que ambas dicen lo mismo, para que lo que
 * se le dice a Carlos nunca se desvíe de lo que de verdad corre.
 */
import { instanteMadrid } from "../pagos/eventoCalendario";
import type { EntradaBitacora, TareaSeguros } from "./tipos";

export interface TareaProgramada {
  id: TareaSeguros;
  nombre: string;
  /** Nombre con el que el planificador la registra (ejecutarSinSolapamiento). Sin él, no la lanza el planificador. */
  job?: string;
  /** Cadena cron EXACTA del planificador (hora de Madrid). */
  cron?: string;
  dias: "diario" | "lunes" | "bajo_demanda";
  /** HH:MM, hora de Madrid. */
  horas: string[];
  conIA: boolean;
  queHace: string;
  cuandoAvisa: string;
}

export const PROGRAMACION_SEGUROS: readonly TareaProgramada[] = [
  {
    id: "vigilante", nombre: "Vigilante: banco, correo y registro", job: "revisarSegurosVigilante", cron: "35 8,17 * * *", dias: "diario", horas: ["08:35", "17:35"], conIA: false,
    queHace: "Mira los movimientos del banco en Holded y el correo de aseguradoras y corredurías, y mantiene al día el registro: confirma cobros, detecta recibos devueltos y cargos que no encajan.",
    cuandoAvisa: "Solo cuando hay una novedad.",
  },
  {
    id: "avisos", nombre: "Avisos del registro", job: "revisarAlertasSeguros", cron: "50 8 * * *", dias: "diario", horas: ["08:50"], conIA: false,
    queHace: "Revisa el registro de pólizas: vencimientos a 30 días o menos y pagos pendientes o devueltos por el banco.",
    cuandoAvisa: "Una sola vez por cada caso nuevo.",
  },
  {
    id: "pagos", nombre: "Calendario de pagos", job: "revisarPagosSeguros", cron: "55 8 * * *", dias: "diario", horas: ["08:55"], conIA: false,
    queHace: "Pone en el calendario el evento de cada pago (3 días antes, a las 9:00) y, cuando un pago está a 1-3 días, comprueba el saldo de su cuenta de cargo en Holded.",
    cuandoAvisa: "Cuando un pago está a 1-3 días; el día antes repite solo si la caja no alcanza o no se pudo comprobar.",
  },
  {
    id: "semanal", nombre: "Resumen semanal", job: "informeSemanalSeguros", cron: "10 9 * * 1", dias: "lunes", horas: ["09:10"], conIA: false,
    queHace: "Resume los pagos sin confirmar, lo que espera a Carlos y los vencimientos y pagos de los próximos 60 días.",
    cuandoAvisa: "Los lunes, si hay algo que contar.",
  },
  {
    id: "agente", nombre: "Especialista (cuando le preguntas)", dias: "bajo_demanda", horas: [], conIA: true,
    queHace: "Responde preguntas sobre pólizas, documentos y banco, lee documentos de Drive y propone cambios al registro y a su memoria con botón ✅/❌.",
    cuandoAvisa: "Solo cuando le hablas.",
  },
];

export const tareaProgramada = (id: TareaSeguros): TareaProgramada => {
  const tarea = PROGRAMACION_SEGUROS.find((t) => t.id === id);
  if (!tarea) throw new Error(`Tarea de Seguros desconocida: ${id}`);
  return tarea;
};

export function textoCuando(t: TareaProgramada): string {
  if (t.dias === "bajo_demanda") return "Cuando le preguntas";
  const horas = t.horas.length > 1 ? `${t.horas.slice(0, -1).join(", ")} y ${t.horas[t.horas.length - 1]}` : t.horas[0];
  return t.dias === "lunes" ? `Los lunes a las ${horas} (hora de Madrid)` : `Todos los días a las ${horas} (hora de Madrid)`;
}

// --- cuándo toca (hora de Madrid, con su cambio de horario) ---------------------------------------------------------

const MS_DIA = 86_400_000;
const fechaMadrid = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const diaSemanaMadrid = (ms: number): string => new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", weekday: "short" }).format(new Date(ms));

/** Los instantes (ms) en que le toca correr entre `desde` y `hasta`, ambos incluidos, de menor a mayor. */
export function ocurrenciasEntre(t: TareaProgramada, desdeMs: number, hastaMs: number): number[] {
  if (t.dias === "bajo_demanda") return [];
  const instantes = new Set<number>();
  for (let ms = desdeMs - 2 * MS_DIA; ms <= hastaMs + 2 * MS_DIA; ms += MS_DIA) {
    const fecha = fechaMadrid(ms);
    if (t.dias === "lunes" && diaSemanaMadrid(Date.parse(instanteMadrid(fecha, "12:00"))) !== "Mon") continue;
    for (const hora of t.horas) {
      const instante = Date.parse(instanteMadrid(fecha, hora));
      if (instante >= desdeMs && instante <= hastaMs) instantes.add(instante);
    }
  }
  return [...instantes].sort((a, b) => a - b);
}

export function ultimaOcurrencia(t: TareaProgramada, ahoraMs: number): number | null {
  const lista = ocurrenciasEntre(t, ahoraMs - 8 * MS_DIA, ahoraMs);
  return lista.length ? lista[lista.length - 1] : null;
}

export function proximaOcurrencia(t: TareaProgramada, ahoraMs: number): number | null {
  const lista = ocurrenciasEntre(t, ahoraMs + 1, ahoraMs + 8 * MS_DIA);
  return lista.length ? lista[0] : null;
}

/**
 * al_dia = corrió en su última cita (o todavía está dentro del margen); retrasada = su última cita pasó y no dejó constancia (no corrió,
 * se omitió porque la anterior seguía en curso o el servidor se reinició justo entonces); sin_registro = aún no hay ninguna constancia de
 * una ejecución programada (p. ej. recién estrenada la bitácora); sin_lectura = no se pudo leer la bitácora.
 */
export type EstadoTarea = "al_dia" | "retrasada" | "sin_registro" | "sin_lectura" | "bajo_demanda";
/** Una tarea puede tardar unos minutos en terminar (la constancia se escribe al final): hasta entonces no se da por retrasada. */
export const GRACIA_MS = 30 * 60_000;

export function estadoDeTarea(t: TareaProgramada, entradas: Array<Pick<EntradaBitacora, "tarea" | "origen" | "cuando">> | null, ahoraMs: number): EstadoTarea {
  if (t.dias === "bajo_demanda") return "bajo_demanda";
  if (entradas == null) return "sin_lectura";
  const programadas = entradas.filter((e) => e.tarea === t.id && e.origen === "programada");
  if (programadas.length === 0) return "sin_registro";
  const ultima = ultimaOcurrencia(t, ahoraMs);
  if (ultima == null || ahoraMs - ultima < GRACIA_MS) return "al_dia";
  return programadas.some((e) => Date.parse(e.cuando) >= ultima) ? "al_dia" : "retrasada";
}
