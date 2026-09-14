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

interface EjecucionChatEnCurso {
  textoHash: string;
  iniciada: Promise<ResultadoSolicitudChat>;
  tarea: Promise<ResultadoSolicitudChat>;
}

const ejecucionesEnCurso = new Map<string, EjecucionChatEnCurso>();
const MAX_PROCESANDO_MS = 10 * 60 * 1000;

export function solicitudesChatEnCurso(): number { return ejecucionesEnCurso.size; }

export function solicitudChatExpirada(solicitud: SolicitudChatGuardada, ahora = Date.now()): boolean {
  return solicitud.estado === "procesando" && ahora - solicitud.actualizadoEn > MAX_PROCESANDO_MS;
}

function crearEjecucionChat(
  entrada: { requestId: string; chatId: number; texto: string },
  repositorio: RepositorioSolicitudesChat,
  responder: () => Promise<string>
): EjecucionChatEnCurso {
  const clave = `${entrada.chatId}:${entrada.requestId}`;
  const textoHash = hashTextoChat(entrada.texto);
  let confirmarInicio!: (resultado: ResultadoSolicitudChat) => void;
  let rechazarInicio!: (error: unknown) => void;
  const iniciada = new Promise<ResultadoSolicitudChat>((resolve, reject) => {
    confirmarInicio = resolve;
    rechazarInicio = reject;
  });

  const tarea = (async (): Promise<ResultadoSolicitudChat> => {
    try {
      const existente = await repositorio.obtener(entrada.chatId, entrada.requestId);
      if (existente) {
        if (existente.textoHash !== textoHash) {
          throw new ConflictoIdempotencia("El mismo messageId ya fue usado con un texto diferente.");
        }
        if (existente.estado === "completado") {
          const resultado = { estado: "completado", respuesta: existente.respuesta ?? "", duplicada: true } as const;
          confirmarInicio(resultado);
          return resultado;
        }
        if (existente.estado === "fallido") {
          const resultado = { estado: "fallido", duplicada: true } as const;
          confirmarInicio(resultado);
          return resultado;
        }

        if (solicitudChatExpirada(existente)) {
          await repositorio.fallar(entrada.chatId, entrada.requestId);
          const resultado = { estado: "fallido", duplicada: true } as const;
          confirmarInicio(resultado);
          return resultado;
        }
        const resultado = { estado: "procesando", duplicada: true } as const;
        confirmarInicio(resultado);
        return resultado;
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

      // La confirmación al navegador ocurre solo DESPUÉS de que la reserva
      // durable existe. Desde aquí la conexión HTTP puede cerrarse sin que
      // el mensaje se pierda o vuelva a ejecutar sus herramientas.
      confirmarInicio({ estado: "procesando", duplicada: false });

      try {
        const respuesta = await responder();
        await repositorio.completar(entrada.chatId, entrada.requestId, respuesta);
        return { estado: "completado", respuesta, duplicada: false };
      } catch (error) {
        await repositorio.fallar(entrada.chatId, entrada.requestId).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      rechazarInicio(error);
      throw error;
    }
  })();

  const ejecucion = { textoHash, iniciada, tarea };
  ejecucionesEnCurso.set(clave, ejecucion);
  // El modo compatible `procesarSolicitudChat` espera `tarea` directamente;
  // en ese caso nadie consume `iniciada` si la preparación falla.
  void iniciada.catch(() => undefined);
  // `iniciarSolicitudChat` devuelve antes de que termine el modelo. Este
  // catch evita una promesa rechazada sin observador; el estado `fallido`
  // permanece durable y el navegador lo recoge por polling.
  void tarea.catch(() => undefined).finally(() => {
    if (ejecucionesEnCurso.get(clave) === ejecucion) ejecucionesEnCurso.delete(clave);
  });
  return ejecucion;
}

function obtenerOCrearEjecucionChat(
  entrada: { requestId: string; chatId: number; texto: string },
  repositorio: RepositorioSolicitudesChat,
  responder: () => Promise<string>
): EjecucionChatEnCurso {
  const clave = `${entrada.chatId}:${entrada.requestId}`;
  const textoHash = hashTextoChat(entrada.texto);
  const enCurso = ejecucionesEnCurso.get(clave);
  if (enCurso) {
    if (enCurso.textoHash !== textoHash) {
      throw new ConflictoIdempotencia("El mismo messageId ya fue usado con un texto diferente.");
    }
    return enCurso;
  }
  return crearEjecucionChat(entrada, repositorio, responder);
}

/**
 * Reserva el mensaje de forma durable y devuelve el control inmediatamente.
 * La respuesta continúa en segundo plano y se consulta por requestId.
 */
export function iniciarSolicitudChat(
  entrada: { requestId: string; chatId: number; texto: string },
  repositorio: RepositorioSolicitudesChat,
  responder: () => Promise<string>
): Promise<ResultadoSolicitudChat> {
  return obtenerOCrearEjecucionChat(entrada, repositorio, responder).iniciada;
}

export async function procesarSolicitudChat(
  entrada: { requestId: string; chatId: number; texto: string },
  repositorio: RepositorioSolicitudesChat,
  responder: () => Promise<string>
): Promise<ResultadoSolicitudChat> {
  return obtenerOCrearEjecucionChat(entrada, repositorio, responder).tarea;
}
