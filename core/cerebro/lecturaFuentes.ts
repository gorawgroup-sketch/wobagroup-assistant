import { AsyncLocalStorage } from "node:async_hooks";
import { conCancelacionSheets } from "../google/limitadorSheets";

export interface EstadoFuente {
  fuente: string;
  ok: boolean;
  verificadoEn: string;
  ultimoExitoEn: string | null;
  conservado: boolean;
  /** Categoría diagnóstica segura: no incluye URL, credenciales ni contenido de la fuente. */
  causa?: "timeout" | "cuota" | "transporte" | "otro";
  duracionMs?: number;
}

function clasificarFallo(error: unknown): NonNullable<EstadoFuente["causa"]> {
  const e = error as { status?: number; code?: string; response?: { status?: number }; message?: string } | null;
  if (e?.message === "Tiempo de lectura agotado") return "timeout";
  if (e?.status === 429 || e?.response?.status === 429) return "cuota";
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(e?.code ?? "")) return "transporte";
  return "otro";
}

/** Cada snapshot conserva la fecha real de las fuentes que no se pudieron releer. */
export class LecturaFuentes {
  private contexto = new AsyncLocalStorage<EstadoFuente[]>();
  private anteriores = new Map<string, { dato: unknown; en: string }>();
  constructor(private timeoutMs = 45_000) {}

  async ejecutar<T>(fn: () => Promise<T>): Promise<{ datos: T; fuentes: EstadoFuente[] }> {
    const fuentes: EstadoFuente[] = [];
    const datos = await this.contexto.run(fuentes, fn);
    return { datos, fuentes };
  }

  async leer<T>(fuente: string, fn: () => Promise<T>, fallback: T, timeoutMs = this.timeoutMs): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelacion = new AbortController();
    let expiro = false;
    const estados = this.contexto.getStore();
    const inicio = Date.now();
    try {
      const dato = await Promise.race([
        Promise.resolve().then(() => conCancelacionSheets(cancelacion.signal, fn)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          expiro = true;
          cancelacion.abort(new Error("Tiempo de lectura agotado"));
          reject(new Error("Tiempo de lectura agotado"));
        }, timeoutMs); }),
      ]);
      const en = new Date().toISOString();
      this.anteriores.set(fuente, { dato, en });
      estados?.push({ fuente, ok: true, verificadoEn: en, ultimoExitoEn: en, conservado: false, duracionMs: Date.now() - inicio });
      return dato;
    } catch (error) {
      const anterior = this.anteriores.get(fuente);
      const causa = expiro ? "timeout" : clasificarFallo(error);
      const duracionMs = Date.now() - inicio;
      estados?.push({ fuente, ok: false, verificadoEn: new Date().toISOString(), ultimoExitoEn: anterior?.en ?? null, conservado: Boolean(anterior), causa, duracionMs });
      console.warn(`[cerebro] No se pudo actualizar ${fuente} (${causa}, ${duracionMs} ms); ${anterior ? "se conserva la última lectura" : "sin datos verificados"}.`);
      return anterior ? anterior.dato as T : fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
