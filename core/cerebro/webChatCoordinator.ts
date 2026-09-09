import { createHash } from "node:crypto";

export type EstadoSolicitudChat = "procesando" | "completado" | "fallido";

export interface SolicitudChatGuardada {
  requestId: string;
  chatId: number;
  textoHash: string;
  estado: EstadoSolicitudChat;
  respuesta?: string;
  creadoEn: number;
  actualizadoEn: number;
}

export interface RepositorioSolicitudesChat {
  obtener(chatId: number, requestId: string): Promise<SolicitudChatGuardada | undefined>;
  reservar(solicitud: SolicitudChatGuardada): Promise<void>;
  completar(chatId: number, requestId: string, respuesta: string): Promise<void>;
  fallar(chatId: number, requestId: string): Promise<void>;
}

export interface ResultadoSolicitudChat {
  estado: EstadoSolicitudChat;
  respuesta?: string;
  duplicada: boolean;
}

export class ConflictoIdempotencia extends Error {}

export function hashTextoChat(texto: string): string {
  return createHash("sha256").update(texto).digest("hex");
}

const ejecucionesEnCurso = new Map<string, { textoHash: string; tarea: Promise<ResultadoSolicitudChat> }>();
const MAX_PROCESANDO_MS = 10 * 60 * 1000;

export function solicitudesChatEnCurso(): number { return ejecucionesEnCurso.size; }

export async function procesarSolicitudChat(
  entrada: { requestId: string; chatId: number; texto: string },
  repositorio: RepositorioSolicitudesChat,
  responder: () => Promise<string>
): Promise<ResultadoSolicitudChat> {
  const clave = `${entrada.chatId}:${entrada.requestId}`;
  const textoHash = hashTextoChat(entrada.texto);
  const enCurso = ejecucionesEnCurso.get(clave);
  if (enCurso) {
    if (enCurso.textoHash !== textoHash) {
      throw new ConflictoIdempotencia("El mismo messageId ya fue usado con un texto diferente.");
    }
    return enCurso.tarea;
  }

  const tarea = (async (): Promise<ResultadoSolicitudChat> => {
    const existente = await repositorio.obtener(entrada.chatId, entrada.requestId);
    if (existente) {
      if (existente.textoHash !== textoHash) {
        throw new ConflictoIdempotencia("El mismo messageId ya fue usado con un texto diferente.");
      }
      if (existente.estado === "completado") {
        return { estado: "completado", respuesta: existente.respuesta ?? "", duplicada: true };
      }
      if (existente.estado === "fallido") return { estado: "fallido", duplicada: true };

      if (Date.now() - existente.actualizadoEn > MAX_PROCESANDO_MS) {
        await repositorio.fallar(entrada.chatId, entrada.requestId);
        return { estado: "fallido", duplicada: true };
      }
      return { estado: "procesando", duplicada: true };
    }

    const ahora = Date.now();
    await repositorio.reservar({
      requestId: entrada.requestId,
      chatId: entrada.chatId,
      textoHash,
      estado: "procesando",
      creadoEn: ahora,
      actualizadoEn: ahora,
    });

    try {
      const respuesta = await responder();
      await repositorio.completar(entrada.chatId, entrada.requestId, respuesta);
      return { estado: "completado", respuesta, duplicada: false };
    } catch (error) {
      await repositorio.fallar(entrada.chatId, entrada.requestId).catch(() => undefined);
      throw error;
    }
  })();

  ejecucionesEnCurso.set(clave, { textoHash, tarea });
  try {
    return await tarea;
  } finally {
    ejecucionesEnCurso.delete(clave);
  }
}
