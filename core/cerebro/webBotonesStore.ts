import { agregarFila, actualizarFila, eliminarFila, leerFilas } from "../google/sheetsKeyValueStore";
import type { InlineKeyboardButton } from "../telegram/types";
import { conMutex } from "../utils/asyncMutex";

/**
 * Espejo durable de los teclados inline que Wobi muestra en Telegram.
 *
 * El front no inventa acciones: conserva exactamente el texto y callback_data
 * que Telegram recibió. Persistirlos permite que sigan disponibles después de
 * un redeploy de Railway y que una decisión de segundo nivel (por ejemplo
 * "▶️ Sí, siguiente") aparezca también en el chat web.
 */
export interface BotonesActivosMensaje {
  chatId: number;
  messageId: number;
  texto: string;
  botones: InlineKeyboardButton[][];
  actualizadoEn: number;
}

export interface RepositorioBotonesWeb {
  listar(): Promise<BotonesActivosMensaje[]>;
  guardar(mensaje: BotonesActivosMensaje): Promise<void>;
  eliminar(chatId: number, messageId: number): Promise<void>;
}

const TAB_NAME = "_cerebro_botones_web";
const HEADERS = ["clave", "chatId", "messageId", "texto", "botonesJSON", "actualizadoEn"];
const NUM_COLS = HEADERS.length;
const MUTEX_PERSISTENCIA = "webBotonesStore:sheet";

function clave(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function botonesValidos(value: unknown): value is InlineKeyboardButton[][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (fila) =>
        Array.isArray(fila) &&
        fila.length > 0 &&
        fila.every(
          (boton) =>
            boton !== null &&
            typeof boton === "object" &&
            typeof (boton as InlineKeyboardButton).text === "string" &&
            typeof (boton as InlineKeyboardButton).callback_data === "string" &&
            (boton as InlineKeyboardButton).callback_data.length > 0
        )
    )
  );
}

function desdeFila(valores: string[]): BotonesActivosMensaje | undefined {
  const chatId = Number(valores[1]);
  const messageId = Number(valores[2]);
  const actualizadoEn = Number(valores[5]);
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId) || messageId <= 0 || !actualizadoEn) {
    return undefined;
  }

  try {
    const botones: unknown = JSON.parse(valores[4] || "[]");
    if (!botonesValidos(botones)) return undefined;
    return { chatId, messageId, texto: valores[3] || "", botones, actualizadoEn };
  } catch {
    return undefined;
  }
}

function aFila(mensaje: BotonesActivosMensaje): (string | number)[] {
  return [
    clave(mensaje.chatId, mensaje.messageId),
    mensaje.chatId,
    mensaje.messageId,
    mensaje.texto,
    JSON.stringify(mensaje.botones),
    mensaje.actualizadoEn,
  ];
}

const repositorioSheets: RepositorioBotonesWeb = {
  async listar() {
    const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
    return filas.flatMap(({ valores }) => {
      const mensaje = desdeFila(valores);
      return mensaje ? [mensaje] : [];
    });
  },

  async guardar(mensaje) {
    await conMutex(MUTEX_PERSISTENCIA, async () => {
      const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
      const existente = filas.find(({ valores }) => valores[0] === clave(mensaje.chatId, mensaje.messageId));
      if (existente) {
        await actualizarFila(TAB_NAME, existente.rowIndex, NUM_COLS, aFila(mensaje));
      } else {
        await agregarFila(TAB_NAME, NUM_COLS, HEADERS, aFila(mensaje));
      }
    });
  },

  async eliminar(chatId, messageId) {
    await conMutex(MUTEX_PERSISTENCIA, async () => {
      const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
      const existente = filas.find(({ valores }) => valores[0] === clave(chatId, messageId));
      if (existente) await eliminarFila(TAB_NAME, existente.rowIndex, HEADERS);
    });
  },
};

/**
 * Cache corto para no consultar Sheets en cada render. No hay TTL funcional
 * ni máximo de botones: una decisión permanece mientras siga activa en
 * Telegram y se elimina cuando el mismo flujo retira su teclado.
 */
export class AlmacenBotonesWeb {
  private readonly activos = new Map<string, BotonesActivosMensaje>();
  private cacheCargadaEn = 0;

  constructor(
    private readonly repositorio: RepositorioBotonesWeb,
    private readonly ahora: () => number = Date.now,
    private readonly cacheTtlMs = 3_000
  ) {}

  private async cargarSiHaceFalta(forzar = false): Promise<void> {
    if (!forzar && this.cacheCargadaEn > 0 && this.ahora() - this.cacheCargadaEn < this.cacheTtlMs) return;
    const guardados = await this.repositorio.listar();
    this.activos.clear();
    for (const mensaje of guardados) this.activos.set(clave(mensaje.chatId, mensaje.messageId), mensaje);
    this.cacheCargadaEn = this.ahora();
  }

  async registrar(
    chatId: number,
    messageId: number,
    texto: string,
    botones: InlineKeyboardButton[][]
  ): Promise<void> {
    if (!botonesValidos(botones)) return;
    const mensaje = { chatId, messageId, texto, botones, actualizadoEn: this.ahora() };
    this.activos.set(clave(chatId, messageId), mensaje);
    await this.repositorio.guardar(mensaje);
  }

  async actualizar(
    chatId: number,
    messageId: number,
    botones: InlineKeyboardButton[][],
    textoSiFalta?: string
  ): Promise<void> {
    if (botones.length === 0) {
      this.activos.delete(clave(chatId, messageId));
      await this.repositorio.eliminar(chatId, messageId);
      return;
    }
    if (!botonesValidos(botones)) return;

    await this.cargarSiHaceFalta();
    const existente = this.activos.get(clave(chatId, messageId));
    if (!existente) {
      // Hallazgo real de auditoría (caso real Carlos: corrección de moneda de una propuesta de gasto
      // cuyo registro de botones se había perdido — ej. quedó creada antes de que este store se
      // volviera durable) — sin este respaldo, la actualización se descartaba en silencio para
      // siempre: Telegram y Holded quedaban al día, pero el chat web nunca volvía a mostrar esos
      // botones, sin ningún error visible. Si el llamador tiene a mano un texto razonable (no siempre
      // lo tiene — editTelegramMessageReplyMarkup existe justo para editar SOLO botones, sin texto),
      // se usa para recrear el registro en vez de perder la actualización.
      if (!textoSiFalta) return;
      const nuevo: BotonesActivosMensaje = { chatId, messageId, texto: textoSiFalta, botones, actualizadoEn: this.ahora() };
      this.activos.set(clave(chatId, messageId), nuevo);
      await this.repositorio.guardar(nuevo);
      return;
    }
    const actualizado = { ...existente, botones, actualizadoEn: this.ahora() };
    this.activos.set(clave(chatId, messageId), actualizado);
    await this.repositorio.guardar(actualizado);
  }

  async actualizarTexto(chatId: number, messageId: number, texto: string): Promise<void> {
    await this.cargarSiHaceFalta();
    const existente = this.activos.get(clave(chatId, messageId));
    if (!existente || existente.texto === texto) return;
    const actualizado = { ...existente, texto, actualizadoEn: this.ahora() };
    this.activos.set(clave(chatId, messageId), actualizado);
    await this.repositorio.guardar(actualizado);
  }

  async obtenerActivos(chatId: number): Promise<BotonesActivosMensaje[]> {
    await this.cargarSiHaceFalta();
    return this.obtenerActivosMemoria(chatId);
  }

  async obtenerMensaje(chatId: number, messageId: number): Promise<BotonesActivosMensaje | undefined> {
    await this.cargarSiHaceFalta();
    return this.obtenerMensajeMemoria(chatId, messageId);
  }

  obtenerActivosMemoria(chatId: number): BotonesActivosMensaje[] {
    return Array.from(this.activos.values())
      .filter((mensaje) => mensaje.chatId === chatId)
      .sort((a, b) => a.actualizadoEn - b.actualizadoEn);
  }

  obtenerMensajeMemoria(chatId: number, messageId: number): BotonesActivosMensaje | undefined {
    return this.activos.get(clave(chatId, messageId));
  }
}

const almacen = new AlmacenBotonesWeb(repositorioSheets);

function registrarFallo(operacion: string, error: unknown): void {
  console.error(`[webBotonesStore] No se pudo ${operacion} el espejo durable:`, error instanceof Error ? error.message : error);
}

/** Se llama después de enviar un mensaje nuevo con botones a Telegram. */
export async function registrarBotonesActivos(
  chatId: number,
  messageId: number,
  texto: string,
  botones: InlineKeyboardButton[][]
): Promise<void> {
  try {
    await almacen.registrar(chatId, messageId, texto, botones);
  } catch (error) {
    registrarFallo("guardar", error);
  }
}

/**
 * Actualiza o retira el teclado sin cambiar el texto guardado. `textoSiFalta` es un respaldo
 * opcional: si el registro de este mensaje ya no existe (ver AlmacenBotonesWeb.actualizar), se usa
 * para recrearlo en vez de descartar la actualización en silencio.
 */
export async function actualizarBotonesActivos(
  chatId: number,
  messageId: number,
  botones: InlineKeyboardButton[][],
  textoSiFalta?: string
): Promise<void> {
  try {
    await almacen.actualizar(chatId, messageId, botones, textoSiFalta);
  } catch (error) {
    registrarFallo("actualizar", error);
  }
}

/** Mantiene el texto del front sincronizado cuando Telegram edita el mensaje sin cambiar su teclado. */
export async function actualizarTextoBotonesActivos(chatId: number, messageId: number, texto: string): Promise<void> {
  try {
    await almacen.actualizarTexto(chatId, messageId, texto);
  } catch (error) {
    registrarFallo("actualizar el texto de", error);
  }
}

/** Todos los mensajes con botones activos para un chat, del más viejo al más nuevo. */
export async function obtenerBotonesActivos(chatId: number): Promise<BotonesActivosMensaje[]> {
  try {
    return await almacen.obtenerActivos(chatId);
  } catch (error) {
    registrarFallo("leer", error);
    return almacen.obtenerActivosMemoria(chatId);
  }
}

/** Un mensaje puntual; también valida que un clic del front siga siendo una acción vigente. */
export async function obtenerBotonesDeMensaje(
  chatId: number,
  messageId: number
): Promise<BotonesActivosMensaje | undefined> {
  try {
    return await almacen.obtenerMensaje(chatId, messageId);
  } catch (error) {
    registrarFallo("leer", error);
    return almacen.obtenerMensajeMemoria(chatId, messageId);
  }
}
