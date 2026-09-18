import { AsyncLocalStorage } from "node:async_hooks";

export interface EstadoFuente {
  fuente: string;
  ok: boolean;
  verificadoEn: string;
  ultimoExitoEn: string | null;
  conservado: boolean;
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

  async leer<T>(fuente: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const estados = this.contexto.getStore();
    try {
      const dato = await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Tiempo de lectura agotado")), this.timeoutMs); }),
      ]);
      const en = new Date().toISOString();
      this.anteriores.set(fuente, { dato, en });
      estados?.push({ fuente, ok: true, verificadoEn: en, ultimoExitoEn: en, conservado: false });
      return dato;
    } catch {
      const anterior = this.anteriores.get(fuente);
      estados?.push({ fuente, ok: false, verificadoEn: new Date().toISOString(), ultimoExitoEn: anterior?.en ?? null, conservado: Boolean(anterior) });
      console.warn(`[cerebro] No se pudo actualizar ${fuente}; ${anterior ? "se conserva la última lectura" : "sin datos verificados"}.`);
      return anterior ? anterior.dato as T : fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
