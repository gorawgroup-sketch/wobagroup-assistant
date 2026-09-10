import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { conMutex } from "../utils/asyncMutex";
import { enteroAcotado } from "../utils/asyncTimeout";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import {
  actualizarFila,
  agregarFila,
  eliminarFilas,
  leerFila,
  leerFilas,
} from "../google/sheetsKeyValueStore";
import type {
  EntregaTelegramDurable,
  EstadoEntregaTelegram,
  RepositorioEntregasTelegram,
} from "./durableDelivery";

const TAB_NAME = "_telegram_entregas_durables";
const HEADERS = [
  "clave", "updateId", "intentoId", "estado", "tipo", "chatId", "payload", "creadoEn", "actualizadoEn", "notificadoEn",
];
const NUM_COLS = HEADERS.length;
const CLAVE_MUTEX = `telegram-entregas:${TAB_NAME}`;
const RETENCION_MS = enteroAcotado(process.env.WOBI_TELEGRAM_LEDGER_RETENTION_DAYS, 30, 7, 180) * 24 * 60 * 60 * 1000;
const PURGA_CADA_MS = 6 * 60 * 60 * 1000;
const PREFIJO_CIFRADO = "v1";
let clavePayload: Buffer | null = null;

interface EntregaConFila extends EntregaTelegramDurable { rowIndex: number; }

const ESTADOS = new Set<EstadoEntregaTelegram>(["reservada", "iniciada", "completada", "incierta"]);
const PRIORIDAD_ESTADO: Record<EstadoEntregaTelegram, number> = {
  reservada: 1,
  iniciada: 2,
  incierta: 3,
  completada: 4,
};

function obtenerClavePayload(): Buffer {
  if (!clavePayload) {
    const { private_key } = loadServiceAccountCredentials();
    clavePayload = createHash("sha256").update("wobi-telegram-ledger-v1\0").update(private_key).digest();
  }
  return clavePayload;
}

export function cifrarPayloadDurable(payload: string, clave: Buffer = obtenerClavePayload()): string {
  if (!payload) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", clave, iv);
  const contenido = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return [PREFIJO_CIFRADO, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), contenido.toString("base64url")].join(":");
}

export function descifrarPayloadDurable(payload: string, clave: Buffer = obtenerClavePayload()): string {
  if (!payload || !payload.startsWith(`${PREFIJO_CIFRADO}:`)) return payload;
  try {
    const [, iv, tag, contenido] = payload.split(":");
    if (!iv || !tag || !contenido) return "";
    const decipher = createDecipheriv("aes-256-gcm", clave, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(contenido, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Nunca revelar el ciphertext ni detalles criptográficos. El coordinador
    // convertirá una reserva indescifrable en resultado incierto sin ejecutarla.
    return "";
  }
}

function desdeFila(rowIndex: number, valores: string[]): EntregaConFila | undefined {
  const estado = valores[3] as EstadoEntregaTelegram;
  const updateId = Number(valores[1]);
  if (!valores[0] || !Number.isFinite(updateId) || !ESTADOS.has(estado)) return undefined;
  const chatId = Number(valores[5]);
  const notificadoEn = Number(valores[9]);
  return {
    rowIndex,
    clave: valores[0],
    updateId,
    intentoId: valores[2],
    estado,
    tipo: valores[4] as EntregaTelegramDurable["tipo"],
    chatId: Number.isFinite(chatId) && chatId !== 0 ? chatId : undefined,
    payload: descifrarPayloadDurable(valores[6] ?? ""),
    creadoEn: Number(valores[7]) || 0,
    actualizadoEn: Number(valores[8]) || 0,
    notificadoEn: Number.isFinite(notificadoEn) && notificadoEn > 0 ? notificadoEn : undefined,
  };
}

function aFila(entrega: EntregaTelegramDurable): (string | number)[] {
  return [
    entrega.clave,
    entrega.updateId,
    entrega.intentoId,
    entrega.estado,
    entrega.tipo,
    entrega.chatId ?? "",
    cifrarPayloadDurable(entrega.payload),
    entrega.creadoEn,
    entrega.actualizadoEn,
    entrega.notificadoEn ?? "",
  ];
}

function elegirCanonica(a: EntregaConFila, b: EntregaConFila): EntregaConFila {
  const diferencia = PRIORIDAD_ESTADO[a.estado] - PRIORIDAD_ESTADO[b.estado];
  if (diferencia !== 0) return diferencia > 0 ? a : b;
  if (a.actualizadoEn !== b.actualizadoEn) return a.actualizadoEn > b.actualizadoEn ? a : b;
  return a.rowIndex < b.rowIndex ? a : b;
}

class StoreEntregasTelegram implements RepositorioEntregasTelegram {
  private registros = new Map<string, EntregaConFila>();
  private inicializado = false;
  private ultimaPurgaEn = 0;

  async reservar(entrega: EntregaTelegramDurable) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const existente = this.registros.get(entrega.clave);
      if (existente) return { entrega: this.publica(existente), nueva: false };

      const rowIndex = await agregarFila(TAB_NAME, NUM_COLS, HEADERS, aFila(entrega));
      const guardada = { ...entrega, rowIndex };
      this.registros.set(entrega.clave, guardada);
      return { entrega: this.publica(guardada), nueva: true };
    });
  }

  async obtener(clave: string) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const entrega = await this.refrescar(clave);
      return entrega ? this.publica(entrega) : undefined;
    });
  }

  marcarIniciada(clave: string) {
    // La fila durable se limpia ya, pero el llamador recibe el payload en
    // memoria para ejecutar esta única vez.
    return this.cambiarEstado(clave, ["reservada"], "iniciada", true, true);
  }

  async marcarCompletada(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["iniciada"], "completada", true);
  }

  marcarIncierta(clave: string) {
    return this.cambiarEstado(clave, ["reservada", "iniciada"], "incierta", true);
  }

  async marcarNotificada(clave: string): Promise<void> {
    await conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || actual.estado !== "incierta" || actual.notificadoEn) return;
      const siguiente = { ...actual, notificadoEn: Date.now(), actualizadoEn: Date.now() };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
    });
  }

  async listarRecuperables(): Promise<EntregaTelegramDurable[]> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      return [...this.registros.values()]
        .filter((e) => e.estado === "reservada" || e.estado === "iniciada" || (e.estado === "incierta" && !e.notificadoEn))
        .map((e) => this.publica(e));
    });
  }

  private async cambiarEstado(
    clave: string,
    permitidos: EstadoEntregaTelegram[],
    estado: EstadoEntregaTelegram,
    limpiarPayload: boolean,
    devolverPayloadAnterior = false
  ): Promise<EntregaTelegramDurable | undefined> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || !permitidos.includes(actual.estado)) return undefined;
      const siguiente: EntregaConFila = {
        ...actual,
        estado,
        payload: limpiarPayload ? "" : actual.payload,
        actualizadoEn: Date.now(),
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
      return this.publica(devolverPayloadAnterior ? { ...siguiente, payload: actual.payload } : siguiente);
    });
  }

  private async inicializarYPurgar(): Promise<void> {
    if (!this.inicializado) {
      await this.recargarYPurgar(true);
      this.inicializado = true;
      return;
    }
    if (Date.now() - this.ultimaPurgaEn >= PURGA_CADA_MS) await this.recargarYPurgar(false);
  }

  private async refrescar(clave: string): Promise<EntregaConFila | undefined> {
    const conocida = this.registros.get(clave);
    if (!conocida) return undefined;
    const fila = await leerFila(TAB_NAME, conocida.rowIndex, NUM_COLS, HEADERS);
    const actual = fila ? desdeFila(fila.rowIndex, fila.valores) : undefined;
    if (actual?.clave === clave) {
      this.registros.set(clave, actual);
      return actual;
    }
    // Otro proceso pudo purgar filas y desplazar índices: reconstruir antes
    // de decidir que una entrega desapareció.
    await this.recargarYPurgar(true);
    return this.registros.get(clave);
  }

  private async recargarYPurgar(forzar: boolean): Promise<void> {
    if (!forzar && Date.now() - this.ultimaPurgaEn < PURGA_CADA_MS) return;
    const filas = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS))
      .map((f) => desdeFila(f.rowIndex, f.valores))
      .filter((f): f is EntregaConFila => Boolean(f));
    const canonicas = new Map<string, EntregaConFila>();
    for (const fila of filas) {
      const actual = canonicas.get(fila.clave);
      canonicas.set(fila.clave, actual ? elegirCanonica(actual, fila) : fila);
    }
    const ahora = Date.now();
    const eliminar = filas.filter((fila) => {
      if (canonicas.get(fila.clave)?.rowIndex !== fila.rowIndex) return true;
      const terminal = fila.estado === "completada" || (fila.estado === "incierta" && Boolean(fila.notificadoEn));
      return terminal && ahora - fila.actualizadoEn > RETENCION_MS;
    });
    if (eliminar.length) {
      await eliminarFilas(TAB_NAME, eliminar.map((e) => e.rowIndex), HEADERS);
      const restantes = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS))
        .map((f) => desdeFila(f.rowIndex, f.valores))
        .filter((f): f is EntregaConFila => Boolean(f));
      this.registros = new Map(restantes.map((e) => [e.clave, e]));
    } else {
      this.registros = canonicas;
    }
    this.ultimaPurgaEn = ahora;
  }

  private publica(entrega: EntregaConFila): EntregaTelegramDurable {
    const { rowIndex: _rowIndex, ...publica } = entrega;
    return { ...publica };
  }
}

export const durableDeliveryStore = new StoreEntregasTelegram();
