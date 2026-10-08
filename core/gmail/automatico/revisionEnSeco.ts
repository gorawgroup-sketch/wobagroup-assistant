import type { ResultadoAuto } from "./model";
import { explicarPendiente } from "./service";

/**
 * Revisión en seco tras cada despliegue (punto 4 del plan contra la recurrencia, Carlos 08-10-2026).
 *
 * Unos minutos después de arrancar con una versión nueva, el servidor repite la última pasada de correo en modo
 * simulación: sin análisis nuevos (cero coste de IA, solo análisis ya guardados), sin escribir en Holded, Gmail ni Sheets
 * y sin mensajes de progreso. Compara el resultado por correo con la revisión en seco anterior y, SOLO si algo empeoró
 * (un correo que antes se automatizaba ahora queda pendiente, un motivo sin catalogar, o la pasada falló), avisa a Carlos
 * antes de que lo descubra él. Si todo sigue igual o mejor, deja una línea en el log y nada más.
 */
export interface ResumenSeco {
  version: string;
  fecha: string;
  simulados: number;
  revisados: number;
  /** Por correo: «automatizable» o el motivo (texto para el operador) por el que queda pendiente. */
  correos: Record<string, { asunto: string; estado: string }>;
}

export const AUTOMATIZABLE = "automatizable";

export function resumirParaComparar(resultado: ResultadoAuto, version: string, ahora = new Date()): ResumenSeco {
  const correos: ResumenSeco["correos"] = {};
  for (const p of resultado.pendientes) {
    // Un correo aplazado por falta de análisis guardado no dice nada de la versión: no se compara.
    if (p.motivos.some((m) => m.startsWith("revision_pospuesta"))) continue;
    // En simulación, «se habría ejecutado» es la señal de que el correo se automatiza con esta versión.
    const automatizable = p.motivos.includes("operacion_pendiente_sin_escritura_en_simulacion");
    correos[p.mensajeId] = { asunto: p.asunto, estado: automatizable ? AUTOMATIZABLE : explicarPendiente(p.motivos, p.detalles?.[0]) };
  }
  return { version, fecha: ahora.toISOString(), simulados: resultado.simulados, revisados: resultado.revisados, correos };
}

export interface Comparacion { empeora: boolean; cambios: string[] }

/** Solo cuentan los correos presentes en las dos revisiones: los nuevos y los ya resueltos no dicen nada de la versión. */
export function compararResumenes(anterior: ResumenSeco | undefined, actual: ResumenSeco): Comparacion {
  const cambios: string[] = [];
  let empeora = false;
  for (const [id, ahora] of Object.entries(actual.correos)) {
    if (/sin explicación catalogada/i.test(ahora.estado)) { empeora = true; cambios.push(`• «${ahora.asunto}»: motivo sin catalogar → ${ahora.estado}`); continue; }
    const antes = anterior?.correos[id];
    if (!antes || antes.estado === ahora.estado) continue;
    const aPeor = antes.estado === AUTOMATIZABLE && ahora.estado !== AUTOMATIZABLE;
    if (aPeor) empeora = true;
    cambios.push(`• «${ahora.asunto}»: ${aPeor ? "antes se automatizaba y ahora queda pendiente" : "cambió el motivo"} → ${ahora.estado}`);
  }
  return { empeora, cambios };
}

export interface DependenciasRevisionEnSeco {
  version: () => string;
  hayRevisionEnCurso: () => boolean;
  ultima: () => Promise<ResumenSeco | undefined>;
  revisar: () => Promise<ResultadoAuto>;
  guardar: (resumen: ResumenSeco) => Promise<void>;
  avisar: (texto: string) => Promise<void>;
  ahora?: () => Date;
}

export type DesenlaceSeco = "omitida_revision_en_curso" | "omitida_misma_version" | "sin_cambios_a_peor" | "aviso_enviado" | "fallo";

export async function ejecutarRevisionEnSeco(deps: DependenciasRevisionEnSeco): Promise<DesenlaceSeco> {
  const version = deps.version();
  if (deps.hayRevisionEnCurso()) { console.log("[revision-en-seco] Hay una revisión real en marcha; se omite."); return "omitida_revision_en_curso"; }
  // Si no se puede leer la revisión anterior no se inventa «ninguna»: la pasada se da por fallida y se avisa.
  let anterior: ResumenSeco | undefined;
  let resultado: ResultadoAuto;
  try {
    anterior = await deps.ultima();
    if (anterior?.version === version) { console.log(`[revision-en-seco] La versión ${version} ya tiene revisión en seco; se omite (reinicio sin despliegue).`); return "omitida_misma_version"; }
    resultado = await deps.revisar();
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    console.error("[revision-en-seco] La pasada en seco falló:", detalle);
    await deps.avisar(`🧪 Revisión en seco tras el despliegue ${version}: la pasada falló antes de terminar (${detalle.slice(0, 160)}). No se escribió nada; conviene mirarlo antes de la siguiente revisión real.`).catch(() => {});
    return "fallo";
  }
  const actual = resumirParaComparar(resultado, version, deps.ahora?.() ?? new Date());
  const comparacion = compararResumenes(anterior, actual);
  await deps.guardar(actual).catch((error) => console.warn("[revision-en-seco] No se pudo guardar el resumen:", error instanceof Error ? error.message : error));
  console.log("[revision-en-seco]", JSON.stringify({ version, anterior: anterior?.version, revisados: actual.revisados, simulados: actual.simulados,
    comparados: Object.keys(actual.correos).length, cambios: comparacion.cambios.length, empeora: comparacion.empeora }));
  if (!comparacion.empeora) return "sin_cambios_a_peor";
  await deps.avisar(
    `🧪 Revisión en seco tras el despliegue ${version} (sin escribir nada, sin coste de IA): algo empeoró respecto a la versión ${anterior?.version ?? "anterior"}.\n` +
    comparacion.cambios.slice(0, 8).join("\n") + (comparacion.cambios.length > 8 ? `\n… y ${comparacion.cambios.length - 8} más.` : "") +
    "\n\nNo hace falta que hagas nada todavía: lo reviso antes de la siguiente revisión real."
  ).catch((error) => console.error("[revision-en-seco] No se pudo avisar:", error));
  return "aviso_enviado";
}

/**
 * Enganche de arranque (src/server.ts): espera unos minutos tras el despliegue (para no sumar ráfagas a las cuotas de
 * arranque) y ejecuta la revisión en seco con las dependencias reales. Se apaga con WOBI_MAIL_DRY_RUN=off.
 */
export function programarRevisionEnSecoTrasDespliegue(env: NodeJS.ProcessEnv = process.env): void {
  if (env.WOBI_MAIL_DRY_RUN === "off") { console.log("[revision-en-seco] Apagada por WOBI_MAIL_DRY_RUN=off."); return; }
  if (!env.WOBI_MAIL_DATABASE_URL || !env.WOBI_MAIL_AUTO_MODE || env.WOBI_MAIL_AUTO_MODE === "off") {
    console.log("[revision-en-seco] Sin coordinación durable o revisión automática apagada; no se programa.");
    return;
  }
  const retrasoMs = Math.max(60_000, Math.min(30 * 60_000, Number(env.WOBI_MAIL_DRY_RUN_DELAY_MS) || 5 * 60_000));
  const version = (env.RAILWAY_GIT_COMMIT_SHA ?? "desconocida").slice(0, 7);
  console.log(`[revision-en-seco] Programada para dentro de ${Math.round(retrasoMs / 60_000)} min (versión ${version}).`);
  const temporizador = setTimeout(() => {
    void (async () => {
      const [{ revisarGastosAutomaticos }, { PostgresAutoStore }, { configuracionAuto }, { hayRevisionEnCurso }, { sendTelegramMessage }] = await Promise.all([
        import("./runtime"), import("./postgres"), import("./model"), import("../../jobs/revisarCorreoNuevo"), import("../../telegram/client"),
      ]);
      const chatId = Number(env.CASHFLOW_ALERTS_CHAT_ID);
      const buzon = configuracionAuto().buzon;
      const store = new PostgresAutoStore();
      await ejecutarRevisionEnSeco({
        version: () => version,
        hayRevisionEnCurso,
        ultima: async () => (await store.ultimaRevisionEnSeco(buzon)) as ResumenSeco | undefined,
        revisar: () => revisarGastosAutomaticos(chatId, { enSeco: true }),
        guardar: (resumen) => store.auditar({ buzon, tipo: "revision_en_seco", datos: resumen }),
        avisar: async (texto) => { if (Number.isFinite(chatId)) await sendTelegramMessage(chatId, texto); },
      });
    })().catch((error) => console.error("[revision-en-seco] Error inesperado:", error));
  }, retrasoMs);
  temporizador.unref();
}
