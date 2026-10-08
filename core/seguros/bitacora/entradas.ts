/**
 * Cómo se cuenta cada tarea en la bitácora. Funciones puras: de lo que la tarea acaba de hacer a la línea de la bitácora, sin tocar
 * Sheets ni Telegram (se prueban sin dependencias). El registrador (registrar.ts) les pone el id y el instante.
 */
import type { CambioPendiente, ResultadoAplicar } from "../agente/cambiosPendientes";
import type { ResultadoCalendarioPagos } from "../pagos/calendarioPagos";
import type { Informe } from "../vigilante/informe";
import type { ResultadoVigilante } from "../vigilante/vigilante";
import { MAX_NOTA, type AvisoRegistrado, type EntradaNueva, type OrigenEjecucion, type TareaSeguros } from "./tipos";

const n = (cantidad: number, singular: string, plural: string): string => `${cantidad} ${cantidad === 1 ? singular : plural}`;
const fechaLarga = (fecha: string): string => fecha.split("-").reverse().join("/");
const mensajeDe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, MAX_NOTA);

/** `entregadoEn`: el instante en que Telegram aceptó ESE mensaje (solo tiene sentido si `entregado` es true). */
const avisoDe = (informe: Informe | null, entregado: boolean | null, entregadoEn?: string): AvisoRegistrado[] | undefined =>
  informe && entregado !== null
    ? [{ canal: "telegram", titulo: informe.titulo, texto: informe.cuerpo, entregado, ...(entregado && entregadoEn ? { entregadoEn } : {}) }]
    : undefined;

/** `entregado`: true = Telegram lo aceptó, false = falló, null = no había nada que enviar. */
export function entradaVigilante(a: {
  resultado: ResultadoVigilante;
  informe: Informe | null;
  entregado: boolean | null;
  /** Cuándo aceptó Telegram el informe de esta revisión. */
  entregadoEn?: string;
  /** Un informe anterior que no había llegado y que esta pasada ha reenviado (se anota como un aviso más, con su propia hora). */
  reenvio?: { informe: Informe; entregadoEn?: string };
  reenviado?: boolean;
  origen?: OrigenEjecucion;
}): EntradaNueva {
  const nuevo = a.resultado.contenido;
  const ahora = a.resultado.situacion;
  const partes: string[] = [];
  if (nuevo.confirmados.length) partes.push(n(nuevo.confirmados.length, "pago confirmado", "pagos confirmados"));
  if (nuevo.enTransito.length) partes.push(n(nuevo.enTransito.length, "cargo nuevo en tránsito", "cargos nuevos en tránsito"));
  if (nuevo.devoluciones.length) partes.push(n(nuevo.devoluciones.length, "devolución", "devoluciones"));
  if (nuevo.cargos.length) partes.push(n(nuevo.cargos.length, "cargo que no encaja", "cargos que no encajan"));
  if (nuevo.correos.length) partes.push(n(nuevo.correos.length, "correo nuevo de aseguradoras", "correos nuevos de aseguradoras"));
  const advertencias = [...nuevo.advertencias, ...nuevo.fallosPersistentes];
  // Los mensajes de esta pasada en el orden en que salieron: primero el informe pendiente que se reenvía (si lo hay) y luego el de esta revisión.
  const avisos = [...(a.reenvio ? avisoDe(a.reenvio.informe, true, a.reenvio.entregadoEn) ?? [] : []), ...(avisoDe(a.informe, a.entregado, a.entregadoEn) ?? [])];

  let resumen = partes.length ? `Novedades: ${partes.join(", ")}` : "Banco, correo y registro revisados: sin novedades";
  if (a.entregado === true) resumen += " · aviso enviado por Telegram";
  if (a.entregado === false) resumen += " · el aviso no llegó a Telegram y queda pendiente de reenvío";
  if (a.reenviado || a.reenvio) resumen += " · reenviado un aviso anterior que no había llegado";
  if (ahora.enTransito.length) resumen += ` · ${n(ahora.enTransito.length, "cargo sigue", "cargos siguen")} en tránsito sin confirmar`;
  if (advertencias.length) resumen += ` · revisión incompleta (${n(advertencias.length, "advertencia", "advertencias")})`;

  return {
    tarea: "vigilante", origen: a.origen ?? "programada",
    resultado: advertencias.length || a.entregado === false ? "con_advertencias" : partes.length ? "con_novedades" : "sin_novedades",
    resumen,
    detalle: {
      avisos: avisos.length ? avisos : undefined,
      cifras: {
        confirmados: nuevo.confirmados.length, enTransitoNuevos: nuevo.enTransito.length, devoluciones: nuevo.devoluciones.length, cargosNuevos: nuevo.cargos.length,
        correosNuevos: nuevo.correos.length, enTransitoAhora: ahora.enTransito.length, cargosARevisarAhora: ahora.cargos.length,
      },
      notas: advertencias,
    },
  };
}

export interface CierreAvisos {
  activas: { pagos: number; renovaciones: number };
  nuevas: { pagos: number; renovaciones: number };
  envio: { titulo: string; cuerpo: string; entregado: boolean; entregadoEn?: string } | null;
}

export function entradaAvisos(c: CierreAvisos): EntradaNueva {
  const cifras = { pagosActivos: c.activas.pagos, renovacionesActivas: c.activas.renovaciones, pagosNuevos: c.nuevas.pagos, renovacionesNuevas: c.nuevas.renovaciones };
  const avisos = c.envio ? avisoDe({ titulo: c.envio.titulo, cuerpo: c.envio.cuerpo }, c.envio.entregado, c.envio.entregadoEn) : undefined;
  if (c.envio && !c.envio.entregado) {
    return { tarea: "avisos", origen: "programada", resultado: "error", resumen: "No se pudo entregar el aviso a Telegram; se reintenta mañana.", detalle: { avisos, cifras } };
  }
  if (c.envio) {
    const partes = [
      c.nuevas.pagos ? n(c.nuevas.pagos, "pago pendiente o devuelto", "pagos pendientes o devueltos") : "",
      c.nuevas.renovaciones ? n(c.nuevas.renovaciones, "póliza a 30 días o menos de vencer", "pólizas a 30 días o menos de vencer") : "",
    ].filter(Boolean);
    return { tarea: "avisos", origen: "programada", resultado: "con_novedades", resumen: `Aviso enviado por Telegram: ${partes.join(" y ")}.`, detalle: { avisos, cifras } };
  }
  const activos = c.activas.pagos + c.activas.renovaciones;
  return {
    tarea: "avisos", origen: "programada", resultado: "sin_novedades",
    resumen: activos === 0
      ? "Registro revisado: ninguna póliza vence en 30 días ni hay pagos pendientes."
      : `Registro revisado: ${n(activos, "caso activo", "casos activos")}, todos ya avisados antes.`,
    detalle: { cifras },
  };
}

export function entradaPagos(a: { r: ResultadoCalendarioPagos; informe: Informe | null; entregado: boolean | null; entregadoEn?: string }): EntradaNueva {
  const { r } = a;
  const creados = r.eventos.filter((e) => e.accion === "creado").length;
  const retirados = r.eventos.length - creados;
  const partes = [n(r.previstos, "pago previsto", "pagos previstos")];
  if (creados || retirados) partes.push(`eventos de calendario: ${creados} creado(s), ${retirados} retirado(s)`);
  if (r.proximo) partes.push(`próximo pago: ${fechaLarga(r.proximo.fecha)} (${r.proximo.empresa}, ${r.proximo.concepto})`);
  partes.push(
    a.entregado === true ? `aviso enviado de ${n(r.avisos.length, "pago", "pagos")}` : a.entregado === false ? "el aviso no llegó a Telegram (se repite mañana)" : "ningún pago a 1-3 días"
  );
  const hayNovedad = r.eventos.length > 0 || a.entregado === true;
  return {
    tarea: "pagos", origen: "programada",
    resultado: r.advertencias.length || a.entregado === false ? "con_advertencias" : hayNovedad ? "con_novedades" : "sin_novedades",
    resumen: `Calendario revisado: ${partes.join(" · ")}`,
    detalle: {
      avisos: avisoDe(a.informe, a.entregado, a.entregadoEn),
      eventos: r.eventos,
      cifras: { previstos: r.previstos, eventosCreados: creados, eventosRetirados: retirados, pagosAvisados: r.avisos.length },
      notas: r.advertencias,
    },
  };
}

export function entradaSemanal(a: { informe: Informe | null; entregado: boolean | null; entregadoEn?: string }): EntradaNueva {
  if (!a.informe) return { tarea: "semanal", origen: "programada", resultado: "sin_novedades", resumen: "Resumen semanal: nada que contar esta semana.", detalle: {} };
  if (a.entregado === false) return { tarea: "semanal", origen: "programada", resultado: "error", resumen: "No se pudo enviar el resumen semanal a Telegram.", detalle: { avisos: avisoDe(a.informe, false) } };
  return { tarea: "semanal", origen: "programada", resultado: "con_novedades", resumen: "Resumen semanal enviado por Telegram.", detalle: { avisos: avisoDe(a.informe, true, a.entregadoEn) } };
}

/** Una línea que dice QUÉ se decidió en una propuesta del especialista (sin volver a pedir la póliza ni la memoria). */
export function describirCambio(cambio: Pick<CambioPendiente, "accion" | "datos">): string {
  let datos: Record<string, unknown> = {};
  try { datos = JSON.parse(cambio.datos) as Record<string, unknown>; } catch (error) { console.error("[bitacora] Propuesta con datos ilegibles (se describe sin ellos):", mensajeDe(error)); }
  if (cambio.accion === "actualizar_poliza") {
    const campos = datos.cambios && typeof datos.cambios === "object" ? Object.keys(datos.cambios as object) : [];
    return `cambio en la póliza ${String(datos.polizaId ?? "?")}${campos.length ? ` (${campos.join(", ")})` : ""}`;
  }
  if (cambio.accion === "recordar") return `recordar (${String(datos.tipo ?? "dato")}): «${String(datos.texto ?? "").replace(/\s+/g, " ").slice(0, 140)}»`;
  return `retirar de la memoria el recuerdo ${String(datos.id ?? "?")}`;
}

export function entradaCambio(a: { cambio: Pick<CambioPendiente, "accion" | "datos">; decision: "aplicar" | "cancelar"; por: string; resultado?: ResultadoAplicar; error?: unknown }): EntradaNueva {
  const que = describirCambio(a.cambio);
  if (a.decision === "cancelar") return { tarea: "agente", origen: "agente", resultado: "sin_novedades", resumen: `${a.por} canceló la propuesta: ${que}. No se cambió nada.`, detalle: {} };
  if (a.error !== undefined) return { tarea: "agente", origen: "agente", resultado: "error", resumen: `${a.por} aprobó la propuesta (${que}) pero no se pudo confirmar el cambio.`, detalle: { notas: [mensajeDe(a.error)] } };
  if (a.resultado && !a.resultado.ok) return { tarea: "agente", origen: "agente", resultado: "con_advertencias", resumen: `${a.por} aprobó la propuesta (${que}) pero no se aplicó.`, detalle: { notas: [a.resultado.mensaje.slice(0, MAX_NOTA)] } };
  return { tarea: "agente", origen: "agente", resultado: "con_novedades", resumen: `${a.por} aprobó y se aplicó: ${que}.`, detalle: a.resultado?.mensaje ? { notas: [a.resultado.mensaje.slice(0, MAX_NOTA)] } : {} };
}

export function entradaError(tarea: TareaSeguros, origen: OrigenEjecucion, error: unknown, contexto = ""): EntradaNueva {
  return { tarea, origen, resultado: "error", resumen: `${contexto || "La tarea falló"}: ${mensajeDe(error)}`.slice(0, 400), detalle: {} };
}
