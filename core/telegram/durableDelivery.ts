import { createHash, randomUUID } from "node:crypto";
import type { TelegramUpdate } from "./types";
import { enteroAcotado } from "../utils/asyncTimeout";

export type EstadoEntregaTelegram = "reservada" | "iniciada" | "completada" | "incierta";
export type TipoEntregaTelegram = "mensaje" | "callback" | "callback_sensible" | "otro";

export interface EntregaTelegramDurable {
  clave: string;
  updateId: number;
  intentoId: string;
  estado: EstadoEntregaTelegram;
  tipo: TipoEntregaTelegram;
  chatId?: number;
  payload: string;
  creadoEn: number;
  actualizadoEn: number;
  notificadoEn?: number;
}

export interface RepositorioEntregasTelegram {
  reservar(entrega: EntregaTelegramDurable): Promise<{ entrega: EntregaTelegramDurable; nueva: boolean }>;
  obtener(clave: string): Promise<EntregaTelegramDurable | undefined>;
  marcarIniciada(clave: string): Promise<EntregaTelegramDurable | undefined>;
  marcarCompletada(clave: string): Promise<void>;
  marcarIncierta(clave: string): Promise<EntregaTelegramDurable | undefined>;
  marcarNotificada(clave: string): Promise<void>;
  listarRecuperables(): Promise<EntregaTelegramDurable[]>;
}

function hashClave(valor: string): string {
  return createHash("sha256").update(valor).digest("hex");
}

/**
 * Los callbacks sensibles se identifican por usuario + mensaje + acción, no
 * por callback_query.id: dos pulsaciones del mismo botón conservan una sola
 * operación durable. Los toggles/pre-pasos no usan esta clave para no impedir
 * cambios intencionales de selección.
 */
export function crearEntregaTelegram(
  update: TelegramUpdate,
  callbackSensible: boolean,
  ahora = Date.now()
): EntregaTelegramDurable {
  const callback = update.callback_query;
  const chatId = callback?.message?.chat.id ?? update.message?.chat.id ?? callback?.from.id;
  const identidad = callback && callbackSensible
    ? `accion:${callback.from.id}:${callback.message?.chat.id ?? "sin-chat"}:${callback.message?.message_id ?? "sin-mensaje"}:${callback.data ?? ""}`
    : `update:${update.update_id}`;
  const tipo: TipoEntregaTelegram = callback
    ? (callbackSensible ? "callback_sensible" : "callback")
    : update.message ? "mensaje" : "otro";

  return {
    clave: hashClave(identidad),
    updateId: update.update_id,
    intentoId: randomUUID(),
    estado: "reservada",
    tipo,
    chatId,
    payload: JSON.stringify(update),
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
}

interface OpcionesCoordinador {
  ahora?: () => number;
  demoraReservaMs?: number;
  demoraIncertidumbreMs?: number;
}

export function configuracionEntregasDurables(env: NodeJS.ProcessEnv = process.env) {
  return {
    // Solo "false" explícito activa el fallback; una errata conserva la ruta segura.
    habilitado: (env.WOBI_TELEGRAM_DURABLE_ENABLED ?? "true").trim().toLowerCase() !== "false",
    demoraReservaMs: enteroAcotado(env.WOBI_TELEGRAM_RESERVATION_GRACE_MS, 5_000, 1_000, 30_000),
    demoraIncertidumbreMs: enteroAcotado(env.WOBI_TELEGRAM_UNCERTAIN_AFTER_MS, 120_000, 30_000, 600_000),
  };
}

/**
 * Coordina persistencia y ejecución, pero deja el ACK HTTP al servidor: así
 * este puede responder 200 justo después de reservar y antes de procesar.
 */
export class CoordinadorEntregasTelegram {
  private readonly activas = new Set<string>();
  private readonly revisiones = new Map<string, ReturnType<typeof setTimeout>>();
  private recuperadas = 0;
  private inciertas = 0;
  private duplicadas = 0;
  private errores = 0;
  private readonly ahora: () => number;
  private readonly demoraReservaMs: number;
  private readonly demoraIncertidumbreMs: number;

  constructor(
    private readonly repositorio: RepositorioEntregasTelegram,
    private readonly procesar: (update: TelegramUpdate) => Promise<void>,
    private readonly avisarIncertidumbre: (entrega: EntregaTelegramDurable) => Promise<void>,
    opciones: OpcionesCoordinador = {}
  ) {
    const config = configuracionEntregasDurables();
    this.ahora = opciones.ahora ?? Date.now;
    this.demoraReservaMs = opciones.demoraReservaMs ?? config.demoraReservaMs;
    this.demoraIncertidumbreMs = opciones.demoraIncertidumbreMs ?? config.demoraIncertidumbreMs;
  }

  get estado() {
    return {
      activas: this.activas.size,
      revisionesPendientes: this.revisiones.size,
      recuperadas: this.recuperadas,
      inciertas: this.inciertas,
      duplicadas: this.duplicadas,
      errores: this.errores,
    };
  }

  async reservar(update: TelegramUpdate, callbackSensible: boolean) {
    try {
      const resultado = await this.repositorio.reservar(crearEntregaTelegram(update, callbackSensible, this.ahora()));
      if (!resultado.nueva) this.duplicadas++;
      return resultado;
    } catch (error) {
      this.errores++;
      throw error;
    }
  }

  /** Se llama después del ACK. Una entrega nueva puede comenzar ya; una encontrada respeta su lease. */
  async atender(entrega: EntregaTelegramDurable, nueva: boolean): Promise<void> {
    if (entrega.estado === "completada" || (entrega.estado === "incierta" && entrega.notificadoEn)) return;
    if (entrega.estado === "reservada") {
      const espera = nueva ? 0 : Math.max(0, this.demoraReservaMs - (this.ahora() - entrega.actualizadoEn));
      if (espera > 0) return this.programar(entrega.clave, espera);
      return this.ejecutar(entrega.clave, !nueva);
    }
    if (entrega.estado === "iniciada") {
      const espera = Math.max(0, this.demoraIncertidumbreMs - (this.ahora() - entrega.actualizadoEn));
      if (espera > 0) return this.programar(entrega.clave, espera);
      return this.declararIncierta(entrega.clave);
    }
    return this.declararIncierta(entrega.clave);
  }

  async recuperar(): Promise<void> {
    try {
      const pendientes = await this.repositorio.listarRecuperables();
      // Un reinicio no debe convertir varias reservas antiguas en una ráfaga.
      for (const entrega of pendientes) await this.atender(entrega, false);
    } catch (error) {
      this.errores++;
      throw error;
    }
  }

  cerrar(): void {
    for (const timer of this.revisiones.values()) clearTimeout(timer);
    this.revisiones.clear();
  }

  private async ejecutar(clave: string, recuperada: boolean): Promise<void> {
    if (this.activas.has(clave)) return;
    let iniciada: EntregaTelegramDurable | undefined;
    try {
      iniciada = await this.repositorio.marcarIniciada(clave);
    } catch (error) {
      // La escritura del checkpoint pudo llegar a Sheets aunque su respuesta
      // se perdiera. Releer luego decide entre recuperar o declarar incierto.
      this.errores++;
      this.programar(clave, this.demoraReservaMs);
      throw error;
    }
    if (!iniciada) return;

    let update: TelegramUpdate;
    try {
      update = JSON.parse(iniciada.payload) as TelegramUpdate;
    } catch {
      await this.declararIncierta(clave);
      return;
    }

    this.activas.add(clave);
    if (recuperada) this.recuperadas++;
    try {
      await this.procesar(update);
      await this.repositorio.marcarCompletada(clave);
    } catch (error) {
      await this.declararIncierta(clave);
      throw error;
    } finally {
      this.activas.delete(clave);
    }
  }

  private async declararIncierta(clave: string): Promise<void> {
    try {
      const actual = await this.repositorio.obtener(clave);
      if (!actual || actual.estado === "completada" || actual.notificadoEn) return;
      const entrega = actual.estado === "incierta" ? actual : await this.repositorio.marcarIncierta(clave);
      if (!entrega || entrega.notificadoEn) return;
      this.inciertas++;
      await this.avisarIncertidumbre(entrega);
      await this.repositorio.marcarNotificada(clave);
    } catch (error) {
      this.errores++;
      this.programar(clave, 30_000);
      throw error;
    }
  }

  private programar(clave: string, demoraMs: number): void {
    if (this.revisiones.has(clave)) return;
    const timer = setTimeout(() => {
      this.revisiones.delete(clave);
      void this.revisar(clave).catch(() => undefined);
    }, demoraMs);
    timer.unref();
    this.revisiones.set(clave, timer);
  }

  private async revisar(clave: string): Promise<void> {
    const actual = await this.repositorio.obtener(clave);
    if (actual) await this.atender(actual, false);
  }
}
