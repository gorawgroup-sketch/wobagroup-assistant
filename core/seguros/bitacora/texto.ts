/**
 * La bitácora en texto para el chat (la herramienta `ver_actividad` del especialista). El front la dibuja desde el contrato de Cerebro;
 * esto es lo mismo, contado en líneas, para cuando alguien pregunta «¿qué hiciste hoy?» por Telegram.
 */
import type { EntradaBitacora, ResultadoTarea } from "./tipos";
import { ETIQUETAS_TAREA, vistaProgramacion, type VistaTareaProgramada } from "./vistas";

/** «08/10 17:35», en hora de Madrid. */
export function fechaHoraMadrid(iso: string): string {
  const instante = new Date(iso);
  if (!Number.isFinite(instante.getTime())) return iso;
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(instante)
      .map((p) => [p.type, p.value.padStart(2, "0")])
  );
  return `${partes.day}/${partes.month} ${partes.hour}:${partes.minute}`;
}

const RESULTADO: Record<ResultadoTarea, string> = { sin_novedades: "sin novedades", con_novedades: "con novedades", con_advertencias: "con advertencias", error: "ERROR" };
const ESTADO: Record<VistaTareaProgramada["estado"], string> = {
  al_dia: "al día", retrasada: "RETRASADA (su última cita no dejó constancia)", sin_registro: "aún sin constancia (la bitácora es nueva)", sin_lectura: "no se pudo leer la bitácora", bajo_demanda: "cuando se le pregunta",
};
const MAX_TEXTO_AVISO = 3500;

export function textoActividad(entradas: EntradaBitacora[], opciones: { ahora: Date; tarea?: string; incluirTextos?: boolean; limite: number }): string {
  const elegidas = entradas
    .filter((e) => !opciones.tarea || e.tarea === opciones.tarea)
    .sort((a, b) => Date.parse(b.cuando) - Date.parse(a.cuando))
    .slice(0, opciones.limite);

  const lineas = elegidas.map((e) => {
    const base = `- ${fechaHoraMadrid(e.cuando)} · ${ETIQUETAS_TAREA[e.tarea]}${e.origen === "programada" ? "" : ` (${e.origen})`} · ${RESULTADO[e.resultado]} — ${e.resumen}`;
    const extras: string[] = [];
    for (const a of e.detalle.avisos ?? []) {
      const estado = !a.entregado ? " (NO llegó)" : a.entregadoEn ? ` (entregado ${fechaHoraMadrid(a.entregadoEn)})` : "";
      const texto = opciones.incluirTextos ? `\n${a.texto.slice(0, MAX_TEXTO_AVISO)}${a.truncado || a.texto.length > MAX_TEXTO_AVISO ? "\n[texto recortado]" : ""}` : "";
      extras.push(`  ↳ aviso por Telegram${estado}: «${a.titulo}»${texto}`);
    }
    for (const ev of e.detalle.eventos ?? []) extras.push(`  ↳ evento de calendario ${ev.accion}: ${ev.titulo} (${fechaHoraMadrid(ev.inicio)})`);
    for (const nota of e.detalle.notas ?? []) extras.push(`  ↳ ${nota}`);
    return [base, ...extras].join("\n");
  });

  const programacion = vistaProgramacion(entradas, opciones.ahora).map(
    (t) => `- ${t.nombre}: ${t.cuando}${t.proxima ? ` · próxima: ${fechaHoraMadrid(t.proxima)}` : ""} · ${ESTADO[t.estado]}`
  );

  return [
    `Actividad de Wobi Seguros (hora de Madrid), la más reciente primero${opciones.tarea ? `, solo «${ETIQUETAS_TAREA[opciones.tarea as keyof typeof ETIQUETAS_TAREA] ?? opciones.tarea}»` : ""}:`,
    lineas.length ? lineas.join("\n") : "(Aún no hay constancia en la bitácora: se empezó a llevar el 08-10-2026 y se llena con cada pasada.)",
    "",
    "Cuándo trabaja cada tarea:",
    ...programacion,
  ].join("\n");
}
