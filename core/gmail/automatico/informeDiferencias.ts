import type { ResultadoAuto } from "./model";
import { AUTOMATIZABLE, resumirParaComparar, type ResumenSeco } from "./revisionEnSeco";

/**
 * Informe por diferencias (punto 5 del plan contra la recurrencia, Carlos 08-10-2026): cada revisión dice qué cambió desde
 * la anterior (nuevos pendientes, resueltos, cambios de motivo, cuántos siguen igual) antes de la lista completa, para ver
 * de un vistazo si el sistema avanza o retrocede. El resumen por correo de cada pasada real se guarda en wobi_mail_events
 * (`revision_resumen`); la pasada siguiente lo compara. Lógica pura aquí; el enganche está en runtime.ts.
 */
export const EVENTO_RESUMEN_REVISION = "revision_resumen";

export interface DiferenciasRevision {
  desde?: string;
  nuevos: Array<{ asunto: string; estado: string }>;
  resueltos: Array<{ asunto: string }>;
  cambiados: Array<{ asunto: string; antes: string; ahora: string }>;
  iguales: number;
}

export function calcularDiferencias(anterior: ResumenSeco | undefined, actual: ResumenSeco): DiferenciasRevision {
  const dif: DiferenciasRevision = { desde: anterior?.fecha, nuevos: [], resueltos: [], cambiados: [], iguales: 0 };
  for (const [id, ahora] of Object.entries(actual.correos)) {
    if (ahora.estado === AUTOMATIZABLE) continue; // lo automatizado ya sale en «Gastos creados»
    const antes = anterior?.correos[id];
    if (!antes || antes.estado === AUTOMATIZABLE) dif.nuevos.push({ asunto: ahora.asunto, estado: ahora.estado });
    else if (antes.estado !== ahora.estado) dif.cambiados.push({ asunto: ahora.asunto, antes: antes.estado, ahora: ahora.estado });
    else dif.iguales++;
  }
  for (const [id, antes] of Object.entries((anterior?.correos ?? {}) as ResumenSeco["correos"])) {
    if (antes.estado !== AUTOMATIZABLE && !(id in actual.correos)) dif.resueltos.push({ asunto: antes.asunto });
  }
  return dif;
}

const MAX_LINEAS = 6;
const acotar = (texto: string) => (texto.length > 110 ? `${texto.slice(0, 107)}…` : texto);
const fechaCorta = (iso?: string) => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

/** Sección del informe. Sin revisión anterior guardada, lo dice y no inventa diferencias. */
export function lineasDiferencias(dif: DiferenciasRevision | undefined): string[] {
  if (!dif) return [];
  if (dif.desde === undefined) return ["", "🔁 Primera revisión con registro de cambios: la siguiente dirá qué cambió respecto a esta."];
  const lineas = ["", `🔁 Desde la última revisión (${fechaCorta(dif.desde) ?? "anterior"})`];
  const lista = <T,>(items: T[], f: (t: T) => string) => [
    ...items.slice(0, MAX_LINEAS).map(f),
    ...(items.length > MAX_LINEAS ? [`  … y ${items.length - MAX_LINEAS} más.`] : []),
  ];
  if (!dif.nuevos.length && !dif.resueltos.length && !dif.cambiados.length) {
    lineas.push(`Sin cambios: ${dif.iguales} pendiente(s) siguen igual que antes.`);
    return lineas;
  }
  if (dif.resueltos.length) lineas.push(`✅ Resueltos desde entonces: ${dif.resueltos.length}.`, ...lista(dif.resueltos, (r) => `  • «${acotar(r.asunto)}»`));
  if (dif.nuevos.length) lineas.push(`🆕 Pendientes nuevos: ${dif.nuevos.length}.`, ...lista(dif.nuevos, (n) => `  • «${acotar(n.asunto)}»: ${acotar(n.estado)}`));
  if (dif.cambiados.length) lineas.push(`✏️ Cambiaron de motivo: ${dif.cambiados.length}.`, ...lista(dif.cambiados, (c) => `  • «${acotar(c.asunto)}»: ${acotar(c.ahora)}`));
  lineas.push(`➡️ Siguen igual: ${dif.iguales}.`);
  return lineas;
}

export interface AlmacenResumenes {
  ultimo: () => Promise<ResumenSeco | undefined>;
  guardar: (resumen: ResumenSeco) => Promise<void>;
}

/** Calcula las diferencias contra la pasada real anterior y guarda la actual. Nunca interrumpe la revisión: ante un fallo, se avisa en el log y el informe sale sin la sección. */
export async function diferenciasDeEstaRevision(resultado: ResultadoAuto, version: string, almacen: AlmacenResumenes, ahora = new Date()): Promise<DiferenciasRevision | undefined> {
  const actual = resumirParaComparar(resultado, version, ahora);
  try {
    const anterior = await almacen.ultimo();
    const dif = calcularDiferencias(anterior, actual);
    await almacen.guardar(actual);
    return dif;
  } catch (error) {
    console.warn("[correo-auto] No se pudo calcular el informe por diferencias (la revisión sigue igual):", error instanceof Error ? error.message : error);
    return undefined;
  }
}
