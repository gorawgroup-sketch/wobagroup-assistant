import { createHash } from "node:crypto";

export type EstadoSolicitudChat = "procesando" | "aplicado" | "completado" | "incierto" | "fallido";

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
  marcarIncierto(chatId: number, requestId: string): Promise<void>;
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
const solicitudesVivas = new Map<string, SolicitudChatGuardada>();
const MAX_PROCESANDO_MS = 10 * 60 * 1000;
const RETENCION_ESTADO_VIVO_MS = 48 * 60 * 60 * 1000;

export type AlCambiarEstadoSolicitudChat = (solicitud: SolicitudChatGuardada) => void;

function claveSolicitud(chatId: number, requestId: string): string {
  return `${chatId}:${requestId}`;
}

function guardarEstadoVivo(
  solicitud: SolicitudChatGuardada,
  alCambiarEstado?: AlCambiarEstadoSolicitudChat
): void {
  solicitudesVivas.set(claveSolicitud(solicitud.chatId, solicitud.requestId), solicitud);
  try {
    alCambiarEstado?.(solicitud);
  } catch (error) {
    // El canal visual es una optimización. Una desconexión SSE o un
    // observador defectuoso nunca puede cambiar el resultado contable.
    console.error("[webChatCoordinator] Error publicando estado en vivo:", error instanceof Error ? error.name : "Error");
  }

  // Sin temporizadores que mantengan Railway despierto. La purga se hace al
  // publicar y solo recorre el mapa cuando realmente creció.
  if (solicitudesVivas.size > 2_000) {
    const limite = Date.now() - RETENCION_ESTADO_VIVO_MS;
    for (const [clave, guardada] of solicitudesVivas) {
      if (guardada.actualizadoEn < limite) solicitudesVivas.delete(clave);
    }
  }
}

/** Estado caliente para el front; evita leer Sheets durante cada sondeo. */
export function obtenerSolicitudChatViva(chatId: number, requestId: string): SolicitudChatGuardada | undefined {
  const solicitud = solicitudesVivas.get(claveSolicitud(chatId, requestId));
  return solicitud ? { ...solicitud } : undefined;
}

export function solicitudesChatEnCurso(): number { return ejecucionesEnCurso.size; }

export function solicitudChatExpirada(solicitud: SolicitudChatGuardada, ahora = Date.now()): boolean {
  return (solicitud.estado === "procesando" || solicitud.estado === "aplicado") &&
    ahora - solicitud.actualizadoEn > MAX_PROCESANDO_MS;
}

function crearEjecucionChat(
  entrada: { requestId: string; chatId: number; texto: string },
  repositorio: RepositorioSolicitudesChat,
  responder: () => Promise<string>,
  alCambiarEstado?: AlCambiarEstadoSolicitudChat
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
          guardarEstadoVivo(existente, alCambiarEstado);
          const resultado = { estado: "completado", respuesta: existente.respuesta ?? "", duplicada: true } as const;
          confirmarInicio(resultado);
          return resultado;
        }
        if (existente.estado === "incierto") {
          guardarEstadoVivo(existente, alCambiarEstado);
          const resultado = { estado: "incierto", duplicada: true } as const;
          confirmarInicio(resultado);
          return resultado;
        }
        if (existente.estado === "fallido") {
          guardarEstadoVivo(existente, alCambiarEstado);
          const resultado = { estado: "fallido", duplicada: true } as const;
          confirmarInicio(resultado);
          return resultado;
        }

        if (solicitudChatExpirada(existente)) {
          await repositorio.marcarIncierto(entrada.chatId, entrada.requestId);
          const incierta = { ...existente, estado: "incierto", actualizadoEn: Date.now() } as const;
          guardarEstadoVivo(incierta, alCambiarEstado);
          const resultado = { estado: "incierto", duplicada: true } as const;
          confirmarInicio(resultado);
          return resultado;
        }
        guardarEstadoVivo(existente, alCambiarEstado);
        const resultado = { estado: "procesando", duplicada: true } as const;
        confirmarInicio(resultado);
        return resultado;
      }

      const ahora = Date.now();
      const reservada: SolicitudChatGuardada = {
        requestId: entrada.requestId,
        chatId: entrada.chatId,
        textoHash,
        estado: "procesando",
        creadoEn: ahora,
        actualizadoEn: ahora,
      };
      await repositorio.reservar(reservada);
      guardarEstadoVivo(reservada, alCambiarEstado);

      // La confirmación al navegador ocurre solo DESPUÉS de que la reserva
      // durable existe. Desde aquí la conexión HTTP puede cerrarse sin que
      // el mensaje se pierda o vuelva a ejecutar sus herramientas.
      confirmarInicio({ estado: "procesando", duplicada: false });

      try {
        const respuesta = await responder();
        guardarEstadoVivo(
          { ...reservada, estado: "aplicado", respuesta, actualizadoEn: Date.now() },
          alCambiarEstado
        );
        try {
          await repositorio.completar(entrada.chatId, entrada.requestId, respuesta);
          guardarEstadoVivo(
            { ...reservada, estado: "completado", respuesta, actualizadoEn: Date.now() },
            alCambiarEstado
          );
          return { estado: "completado", respuesta, duplicada: false };
        } catch {
          await repositorio.marcarIncierto(entrada.chatId, entrada.requestId).catch(() => undefined);
          guardarEstadoVivo(
            { ...reservada, estado: "incierto", actualizadoEn: Date.now() },
            alCambiarEstado
          );
          return { estado: "incierto", duplicada: false };
        }
      } catch (error) {
        // Una excepción después de iniciar el handler no demuestra que una
        // escritura externa no haya ocurrido. Fallar cerrado: resultado
        // incierto, nunca reintento automático.
        await repositorio.marcarIncierto(entrada.chatId, entrada.requestId).catch(() => undefined);
        guardarEstadoVivo(
          { ...reservada, estado: "incierto", actualizadoEn: Date.now() },
          alCambiarEstado
        );
        return { estado: "incierto", duplicada: false };
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
  // catch evita una promesa rechazada sin observador; el estado durable
  // (completado o incierto) lo recoge el navegador al reconectar.
  void tarea.catch(() => undefined).finally(() => {
    if (ejecucionesEnCurso.get(clave) === ejecucion) ejecucionesEnCurso.delete(clave);
  });
  return ejecucion;
}

function obtenerOCrearEjecucionChat(
  entrada: { requestId: string; chatId: number; texto: string },
  repositorio: RepositorioSolicitudesChat,
  responder: () => Promise<string>,
  alCambiarEstado?: AlCambiarEstadoSolicitudChat
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
  return crearEjecucionChat(entrada, repositorio, responder, alCambiarEstado);
}

/**
 * Reserva el mensaje de forma durable y devuelve el control inmediatamente.
 * La respuesta continúa en segundo plano y se consulta por requestId.
 */
export function iniciarSolicitudChat(
  entrada: { requestId: string; chatId: number; texto: string },
  repositorio: RepositorioSolicitudesChat,
  responder: () => Promise<string>,
  alCambiarEstado?: AlCambiarEstadoSolicitudChat
): Promise<ResultadoSolicitudChat> {
  return obtenerOCrearEjecucionChat(entrada, repositorio, responder, alCambiarEstado).iniciada;
}

export async function procesarSolicitudChat(
  entrada: { requestId: string; chatId: number; texto: string },
  repositorio: RepositorioSolicitudesChat,
  responder: () => Promise<string>,
  alCambiarEstado?: AlCambiarEstadoSolicitudChat
): Promise<ResultadoSolicitudChat> {
  return obtenerOCrearEjecucionChat(entrada, repositorio, responder, alCambiarEstado).tarea;
}
