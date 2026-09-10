import { AsyncLocalStorage } from "node:async_hooks";
import { enteroAcotado, TiempoMaximoExcedidoError } from "../utils/asyncTimeout";

export interface AccesoHerramienta {
  identidad: string;
  modo: "lectura" | "escritura";
  recursos: readonly string[];
}

export function configuracionConcurrencia(env: NodeJS.ProcessEnv = process.env) {
  return {
    paralelo: (env.WOBI_PARALLEL_READS_ENABLED ?? "true").trim().toLowerCase() === "true",
    global: enteroAcotado(env.WOBI_READ_CONCURRENCY_GLOBAL, 4, 1, 8),
    porIdentidad: enteroAcotado(env.WOBI_READ_CONCURRENCY_PER_CHAT, 2, 1, 4),
    cashflow: enteroAcotado(env.WOBI_READ_CONCURRENCY_CASHFLOW, 1, 1, 2),
    maxPendientes: enteroAcotado(env.WOBI_TOOL_QUEUE_MAX_PENDING, 32, 8, 128),
    esperaMs: enteroAcotado(env.WOBI_TOOL_QUEUE_TIMEOUT_MS, 30_000, 1_000, 120_000),
  };
}

interface Reserva extends AccesoHerramienta {
  viva: boolean;
  hijos: Set<Promise<unknown>>;
}
interface Pendiente {
  acceso: AccesoHerramienta;
  iniciar(): void;
  cancelar(error: unknown): void;
}

function solapan(a: readonly string[], b: readonly string[]): boolean {
  return a.includes("*") || b.includes("*") || a.some((r) => b.includes(r));
}
function conflicto(a: AccesoHerramienta, b: AccesoHerramienta): boolean {
  return (a.modo === "escritura" || b.modo === "escritura") && solapan(a.recursos, b.recursos);
}

/** Bloqueos locales al proceso. La reserva dura hasta terminar el trabajo REAL, no su timeout visible. */
export class PlanificadorHerramientas {
  private readonly activas = new Set<Reserva>();
  private readonly pendientes: Pendiente[] = [];
  private readonly contexto = new AsyncLocalStorage<Reserva>();

  constructor(private readonly config = configuracionConcurrencia()) {}

  get estado() { return { activas: this.activas.size, pendientes: this.pendientes.length }; }

  ejecutar<T>(acceso: AccesoHerramienta, tarea: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const padre = this.contexto.getStore();
    // Los flujos de correo pueden llamar herramientas anidadas: reutilizar la reserva exclusiva.
    if (padre?.viva) {
      const cubre = padre.recursos.includes("*") || acceso.recursos.every((r) => padre.recursos.includes(r));
      if (!cubre || (padre.modo === "lectura" && acceso.modo !== "lectura")) {
        return Promise.reject(new Error("La herramienta anidada excede la reserva de recursos."));
      }
      const hijo = Promise.resolve().then(tarea);
      padre.hijos.add(hijo);
      void hijo.then(() => padre.hijos.delete(hijo), () => padre.hijos.delete(hijo));
      return hijo;
    }
    if (this.pendientes.length >= this.config.maxPendientes) {
      return Promise.reject(new TiempoMaximoExcedidoError("cola_herramientas_saturada", 0));
    }
    return new Promise<T>((resolve, reject) => {
      const limpiar = () => { clearTimeout(timer); signal?.removeEventListener("abort", abortar); };
      const pendiente: Pendiente = {
        acceso,
        cancelar: (error) => {
          const idx = this.pendientes.indexOf(pendiente);
          if (idx < 0) return; // Nunca interrumpir trabajo ya iniciado.
          this.pendientes.splice(idx, 1);
          limpiar();
          reject(error);
          this.drenar();
        },
        iniciar: () => {
          limpiar();
          const reserva: Reserva = { ...acceso, viva: true, hijos: new Set() };
          this.activas.add(reserva);
          const trabajo = this.contexto.run(reserva, async () => {
            try { return await tarea(); }
            finally {
              while (reserva.hijos.size) await Promise.allSettled([...reserva.hijos]);
              reserva.viva = false;
              this.activas.delete(reserva);
              this.drenar();
            }
          });
          void trabajo.then(resolve, reject);
        },
      };
      const abortar = () => pendiente.cancelar(signal!.reason);
      const timer = setTimeout(() => pendiente.cancelar(
        new TiempoMaximoExcedidoError("cola_herramientas", this.config.esperaMs)
      ), this.config.esperaMs);
      signal?.addEventListener("abort", abortar, { once: true });
      this.pendientes.push(pendiente);
      this.drenar();
    });
  }

  private drenar(): void {
    for (let i = 0; i < this.pendientes.length;) {
      const pendiente = this.pendientes[i];
      const acceso = pendiente.acceso;
      const lecturas = [...this.activas].filter((r) => r.modo === "lectura");
      const sinCupo = acceso.modo === "lectura" && (
        lecturas.length >= this.config.global ||
        lecturas.filter((r) => r.identidad === acceso.identidad).length >= this.config.porIdentidad ||
        (acceso.recursos.includes("cashflow") &&
          lecturas.filter((r) => r.recursos.includes("cashflow")).length >= this.config.cashflow)
      );
      // Una escritura esperando impide que lecturas posteriores la adelanten indefinidamente.
      const bloqueada = [...this.activas].some((r) => conflicto(r, acceso)) ||
        this.pendientes.slice(0, i).some((p) => conflicto(p.acceso, acceso));
      if (sinCupo || bloqueada) { i++; continue; }
      this.pendientes.splice(i, 1);
      pendiente.iniciar();
    }
  }
}

export const planificadorHerramientas = new PlanificadorHerramientas();

export function obtenerEstadoPlanificadorHerramientas() { return planificadorHerramientas.estado; }
