/**
 * Peticiones de un correo: qué pide cada persona, sobre qué adjunto, y qué acción se propone para cada una. Las produce el
 * mismo clasificador del correo (sin llamada de IA extra) y se muestran como una lista numerada en la propuesta, en vez de
 * un único párrafo y una sola acción.
 */
export interface Peticion {
  /** Quién la hace (nombre o dirección), tal como lo dice el correo. */
  quien: string;
  /** Qué pide, en concreto. */
  que: string;
  /** Acción propuesta para esta petición (nunca «ya hecho»). */
  accion: string;
  /** Nombre del adjunto al que se refiere, si lo hay. */
  sobreAdjunto?: string;
  /** Plazo o fecha límite que menciona, si lo hay. */
  fechaLimite?: string;
}

export const MAX_PETICIONES = 8;

const texto = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Valida lo que devuelve el modelo: descarta elementos sin «qué» o sin «acción» y limita la cantidad. */
export function normalizarPeticiones(entrada: unknown): Peticion[] {
  if (!Array.isArray(entrada)) return [];
  const salida: Peticion[] = [];
  for (const x of entrada) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const que = texto(o.que, 400), accion = texto(o.accion, 500);
    if (!que || !accion) continue;
    salida.push({
      quien: texto(o.quien, 120) || "(no se indica)", que, accion,
      sobreAdjunto: texto(o.sobre_adjunto ?? o.sobreAdjunto, 160) || undefined,
      fechaLimite: texto(o.fecha_limite ?? o.fechaLimite, 80) || undefined,
    });
    if (salida.length >= MAX_PETICIONES) break;
  }
  return salida;
}

/** Lista numerada para el mensaje de Telegram. Con una sola petición no añade nada que el resumen no diga ya. */
export function listaDePeticiones(peticiones: Peticion[]): string {
  if (peticiones.length < 2) return "";
  return ["Peticiones detectadas:", ...peticiones.map((p, i) =>
    `${i + 1}. ${p.quien} pide: ${p.que}${p.sobreAdjunto ? ` (sobre «${p.sobreAdjunto}»)` : ""}${p.fechaLimite ? ` — plazo: ${p.fechaLimite}` : ""}\n   ✅ Acción propuesta: ${p.accion}`)].join("\n");
}

/** Acción sugerida global a partir de las peticiones (varias → una sola frase que las enumera). */
export function accionGlobal(peticiones: Peticion[], accionDelModelo: string): string {
  if (peticiones.length < 2) return accionDelModelo;
  return `Atender las ${peticiones.length} peticiones: ${peticiones.map((p, i) => `${i + 1}) ${p.accion}`).join("; ")}.`;
}
