import { createHash } from "node:crypto";

export type EstadoEnvioCorreo = "preparado" | "enviando" | "verificado" | "incierto";

export interface ResultadoEnvioCorreo {
  id: string;
  threadId: string;
}

export interface RegistroEnvioCorreo {
  clave: string;
  proceso: string;
  estado: EstadoEnvioCorreo;
  messageIdRfc: string;
  gmailMessageId?: string;
  gmailThreadId?: string;
  creadoEn: number;
  actualizadoEn: number;
  verificadoEn?: number;
}

export interface RepositorioEnviosCorreo {
  reservar(registro: RegistroEnvioCorreo): Promise<{ registro: RegistroEnvioCorreo; nuevo: boolean }>;
  obtener(clave: string): Promise<RegistroEnvioCorreo | undefined>;
  marcarEnviando(clave: string): Promise<RegistroEnvioCorreo | undefined>;
  marcarPreparado(clave: string): Promise<void>;
  marcarVerificado(clave: string, resultado: ResultadoEnvioCorreo): Promise<void>;
  marcarIncierto(clave: string): Promise<void>;
  listarPendientes(): Promise<RegistroEnvioCorreo[]>;
}

export interface TransporteCorreoDurable {
  buscar(messageIdRfc: string): Promise<ResultadoEnvioCorreo | undefined>;
  enviar(messageIdRfc: string): Promise<ResultadoEnvioCorreo>;
}

export class EnvioCorreoInciertoError extends Error {
  constructor() {
    super(
      "Gmail no confirmó si el correo salió. Wobi bloqueó cualquier reenvío automático para evitar duplicarlo y lo dejó pendiente de verificación."
    );
    this.name = "EnvioCorreoInciertoError";
  }
}

export function identidadEnvioCorreo(idempotencyKey: string, ahora = Date.now()): RegistroEnvioCorreo {
  const normalizada = idempotencyKey.trim();
  if (!normalizada || normalizada.length > 300) {
    throw new Error("La clave idempotente del correo es obligatoria y debe tener como máximo 300 caracteres.");
  }
  const clave = createHash("sha256").update(`wobi-correo-v1\0${normalizada}`).digest("hex");
  return {
    clave,
    proceso: "correo",
    estado: "preparado",
    messageIdRfc: `<wobi-${clave.slice(0, 40)}@idempotency.wobagroup.com>`,
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
}

function resultadoGuardado(registro: RegistroEnvioCorreo): ResultadoEnvioCorreo {
  return { id: registro.gmailMessageId ?? "", threadId: registro.gmailThreadId ?? "" };
}

function codigoHttp(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const valor = e.response?.status ?? e.status ?? e.code;
  const numero = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(numero) ? numero : undefined;
}

/** Solo rechazos 4xx inequívocos vuelven a preparado. Timeouts, 408/409/425/429 y 5xx son ambiguos. */
export function esRechazoDefinitivoSinEnvio(error: unknown): boolean {
  const codigo = codigoHttp(error);
  return codigo !== undefined && codigo >= 400 && codigo < 500 && ![408, 409, 425, 429].includes(codigo);
}

async function verificarExistencia(
  registro: RegistroEnvioCorreo,
  repositorio: RepositorioEnviosCorreo,
  transporte: TransporteCorreoDurable
): Promise<ResultadoEnvioCorreo | undefined> {
  const encontrado = await transporte.buscar(registro.messageIdRfc);
  if (encontrado) await repositorio.marcarVerificado(registro.clave, encontrado);
  return encontrado;
}

/** Consulta previa para evitar redactar/regenerar trabajo si el efecto ya existe o quedó incierto. */
export async function consultarEnvioCorreoDurable(
  idempotencyKey: string,
  repositorio: RepositorioEnviosCorreo,
  buscar: TransporteCorreoDurable["buscar"]
): Promise<ResultadoEnvioCorreo | undefined> {
  const identidad = identidadEnvioCorreo(idempotencyKey);
  const registro = await repositorio.obtener(identidad.clave);
  if (!registro || registro.estado === "preparado") return undefined;
  if (registro.estado === "verificado") return resultadoGuardado(registro);
  const encontrado = await buscar(registro.messageIdRfc);
  if (encontrado) {
    await repositorio.marcarVerificado(registro.clave, encontrado);
    return encontrado;
  }
  if (registro.estado === "enviando") await repositorio.marcarIncierto(registro.clave);
  throw new EnvioCorreoInciertoError();
}

/**
 * Frontera exactly-once conservadora para Gmail:
 * - preparado puede enviar;
 * - enviando/incierto solo puede consultar Gmail, nunca reenviar;
 * - verificado devuelve el resultado durable;
 * - un rechazo 4xx inequívoco permite un intento posterior con la misma clave.
 */
export async function ejecutarEnvioCorreoDurable(
  idempotencyKey: string,
  proceso: string,
  repositorio: RepositorioEnviosCorreo,
  transporte: TransporteCorreoDurable,
  ahora = Date.now()
): Promise<{ resultado: ResultadoEnvioCorreo; reutilizado: boolean }> {
  const inicial = { ...identidadEnvioCorreo(idempotencyKey, ahora), proceso };
  const { registro } = await repositorio.reservar(inicial);

  if (registro.estado === "verificado") {
    return { resultado: resultadoGuardado(registro), reutilizado: true };
  }

  if (registro.estado === "enviando" || registro.estado === "incierto") {
    const encontrado = await verificarExistencia(registro, repositorio, transporte);
    if (encontrado) return { resultado: encontrado, reutilizado: true };
    if (registro.estado === "enviando") await repositorio.marcarIncierto(registro.clave);
    throw new EnvioCorreoInciertoError();
  }

  const enviando = await repositorio.marcarEnviando(registro.clave);
  if (!enviando) {
    const actual = await repositorio.obtener(registro.clave);
    if (actual?.estado === "verificado") return { resultado: resultadoGuardado(actual), reutilizado: true };
    throw new EnvioCorreoInciertoError();
  }

  let resultado: ResultadoEnvioCorreo;
  try {
    resultado = await transporte.enviar(enviando.messageIdRfc);
  } catch (error) {
    if (esRechazoDefinitivoSinEnvio(error)) {
      await repositorio.marcarPreparado(enviando.clave);
      throw error;
    }
    try {
      const encontrado = await verificarExistencia(enviando, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // La consulta también falló: el resultado sigue siendo incierto.
    }
    await repositorio.marcarIncierto(enviando.clave);
    throw new EnvioCorreoInciertoError();
  }

  try {
    await repositorio.marcarVerificado(enviando.clave, resultado);
  } catch {
    // El envío ya fue aceptado. Si falla el checkpoint final, solo una
    // consulta puede confirmar; nunca se vuelve a llamar a send.
    try {
      const encontrado = await verificarExistencia(enviando, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // Conserva la salida segura de abajo.
    }
    await repositorio.marcarIncierto(enviando.clave).catch(() => undefined);
    throw new EnvioCorreoInciertoError();
  }

  return { resultado, reutilizado: false };
}

export async function reconciliarEnviosCorreoPendientes(
  repositorio: RepositorioEnviosCorreo,
  buscar: TransporteCorreoDurable["buscar"]
): Promise<{ revisados: number; verificados: number; inciertos: number; errores: number }> {
  const pendientes = await repositorio.listarPendientes();
  let verificados = 0;
  let inciertos = 0;
  let errores = 0;
  for (const registro of pendientes) {
    try {
      const encontrado = await buscar(registro.messageIdRfc);
      if (encontrado) {
        await repositorio.marcarVerificado(registro.clave, encontrado);
        verificados++;
      } else {
        if (registro.estado === "enviando") await repositorio.marcarIncierto(registro.clave);
        inciertos++;
      }
    } catch {
      errores++;
    }
  }
  return { revisados: pendientes.length, verificados, inciertos, errores };
}
