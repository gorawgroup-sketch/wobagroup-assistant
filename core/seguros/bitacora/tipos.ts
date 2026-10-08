/**
 * Bitácora de Wobi Seguros: la constancia de QUÉ hizo y CUÁNDO. Cada ejecución de sus tareas (aunque no encuentre nada),
 * cada aviso que mandó por Telegram, cada evento que puso o retiró del calendario y cada cambio que Carlos aprobó o canceló.
 * Existe para que Carlos lo vea en Cerebro sin depender de su memoria ni de rebuscar en el chat.
 */
export type TareaSeguros = "vigilante" | "avisos" | "pagos" | "semanal" | "agente";
export const TAREAS_SEGUROS: readonly TareaSeguros[] = ["vigilante", "avisos", "pagos", "semanal", "agente"];

/** programada = la lanzó el planificador; manual = alguien lo pidió desde el chat; agente = una decisión sobre una propuesta del especialista. */
export type OrigenEjecucion = "programada" | "manual" | "agente";
export const ORIGENES: readonly OrigenEjecucion[] = ["programada", "manual", "agente"];

/** sin_novedades = corrió y no había nada que contar (también es información: se ve que corrió). */
export type ResultadoTarea = "sin_novedades" | "con_novedades" | "con_advertencias" | "error";
export const RESULTADOS: readonly ResultadoTarea[] = ["sin_novedades", "con_novedades", "con_advertencias", "error"];

export interface AvisoRegistrado {
  canal: "telegram";
  titulo: string;
  texto: string;
  /** false = Telegram no lo aceptó: no llegó (queda pendiente de reenvío o se repite). */
  entregado: boolean;
}

export interface EventoRegistrado {
  accion: "creado" | "retirado";
  titulo: string;
  /** Inicio del evento (ISO UTC). */
  inicio: string;
}

export interface DetalleBitacora {
  avisos?: AvisoRegistrado[];
  eventos?: EventoRegistrado[];
  cifras?: Record<string, number>;
  notas?: string[];
}

/** Lo que construye cada tarea; el registrador le pone el id y el instante. */
export interface EntradaNueva {
  tarea: TareaSeguros;
  origen: OrigenEjecucion;
  resultado: ResultadoTarea;
  resumen: string;
  detalle: DetalleBitacora;
}

export interface EntradaBitacora extends EntradaNueva {
  id: string;
  /** Instante en que terminó (ISO UTC). */
  cuando: string;
}

export interface EntradaBitacoraConFila extends EntradaBitacora {
  rowIndex: number;
}

/** Cuando la pestaña pasa de MAX_ENTRADAS se podan las más antiguas hasta dejar ENTRADAS_TRAS_PODAR (≈ 2 meses de actividad normal). */
export const MAX_ENTRADAS_BITACORA = 400;
export const ENTRADAS_TRAS_PODAR = 300;
export const MAX_TEXTO_AVISO = 1500;
export const MAX_RESUMEN = 400;
export const MAX_NOTA = 240;
export const MAX_NOTAS = 10;
export const MAX_AVISOS = 6;
export const MAX_EVENTOS = 20;
