import { createHash } from "node:crypto";

export type EstadoSubidaDrive = "preparada" | "subiendo" | "verificada" | "incierta";

export interface ResultadoSubidaDrive {
  fileId: string;
  webViewLink: string;
}

export interface RegistroSubidaDrive {
  clave: string;
  proceso: string;
  estado: EstadoSubidaDrive;
  marcador: string;
  folderId: string;
  driveFileId?: string;
  webViewLink?: string;
  creadoEn: number;
  actualizadoEn: number;
  verificadoEn?: number;
}

export interface RepositorioSubidasDrive {
  reservar(registro: RegistroSubidaDrive): Promise<{ registro: RegistroSubidaDrive; nuevo: boolean }>;
  obtener(clave: string): Promise<RegistroSubidaDrive | undefined>;
  marcarSubiendo(clave: string): Promise<RegistroSubidaDrive | undefined>;
  marcarPreparada(clave: string): Promise<void>;
  marcarVerificada(clave: string, resultado: ResultadoSubidaDrive): Promise<void>;
  marcarIncierta(clave: string): Promise<void>;
  listarPendientes(): Promise<RegistroSubidaDrive[]>;
}

export interface TransporteSubidaDrive {
  buscar(marcador: string, folderId: string): Promise<ResultadoSubidaDrive | undefined>;
  subir(marcador: string): Promise<ResultadoSubidaDrive>;
}

export class SubidaDriveInciertaError extends Error {
  constructor() {
    super(
      "Drive no confirmó si el archivo quedó subido. Wobi bloqueó otra subida automática para evitar duplicarlo y lo dejó pendiente de verificación."
    );
    this.name = "SubidaDriveInciertaError";
  }
}

export function identidadSubidaDrive(
  idempotencyKey: string,
  folderId: string,
  ahora = Date.now()
): RegistroSubidaDrive {
  const identidad = idempotencyKey.trim();
  const carpeta = folderId.trim();
  if (!identidad || identidad.length > 300) {
    throw new Error("La clave idempotente de Drive es obligatoria y debe tener como máximo 300 caracteres.");
  }
  if (!carpeta || carpeta.length > 300) {
    throw new Error("La carpeta de destino de Drive es obligatoria y debe tener como máximo 300 caracteres.");
  }
  const clave = createHash("sha256")
    .update(`wobi-drive-v1\0${identidad}\0${carpeta}`)
    .digest("hex");
  return {
    clave,
    proceso: "archivo_aprobado",
    estado: "preparada",
    marcador: clave,
    folderId: carpeta,
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
}

function resultadoGuardado(registro: RegistroSubidaDrive): ResultadoSubidaDrive {
  return {
    fileId: registro.driveFileId ?? "",
    webViewLink:
      registro.webViewLink ??
      (registro.driveFileId ? `https://drive.google.com/file/d/${registro.driveFileId}/view` : ""),
  };
}

function codigoHttp(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const valor = e.response?.status ?? e.status ?? e.code;
  const numero = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(numero) ? numero : undefined;
}

/** Reconoce el fallo local incluso si la librería HTTP lo envuelve como causa. */
export function esArchivoLocalInexistente(error: unknown, profundidad = 0): boolean {
  if (!error || typeof error !== "object" || profundidad > 3) return false;
  const e = error as { code?: unknown; cause?: unknown };
  return e.code === "ENOENT" || esArchivoLocalInexistente(e.cause, profundidad + 1);
}

/** ENOENT ocurre antes de transmitir; los 4xx listados son rechazos inequívocos. */
export function esRechazoDefinitivoSinSubida(error: unknown): boolean {
  if (esArchivoLocalInexistente(error)) return true;
  const codigo = codigoHttp(error);
  return codigo !== undefined && codigo >= 400 && codigo < 500 && ![408, 409, 425, 429].includes(codigo);
}

async function verificarExistencia(
  registro: RegistroSubidaDrive,
  repositorio: RepositorioSubidasDrive,
  transporte: TransporteSubidaDrive
): Promise<ResultadoSubidaDrive | undefined> {
  const encontrado = await transporte.buscar(registro.marcador, registro.folderId);
  if (encontrado) await repositorio.marcarVerificada(registro.clave, encontrado);
  return encontrado;
}

/**
 * Frontera conservadora para Drive:
 * - preparada puede subir;
 * - subiendo/incierta solo consulta el marcador privado en Drive;
 * - verificada devuelve el archivo ya registrado;
 * - solo un rechazo inequívoco permite repetir con la misma identidad.
 */
export async function ejecutarSubidaDriveDurable(
  idempotencyKey: string,
  folderId: string,
  proceso: string,
  repositorio: RepositorioSubidasDrive,
  transporte: TransporteSubidaDrive,
  ahora = Date.now()
): Promise<{ resultado: ResultadoSubidaDrive; reutilizado: boolean }> {
  const inicial = { ...identidadSubidaDrive(idempotencyKey, folderId, ahora), proceso };
  const { registro } = await repositorio.reservar(inicial);

  if (registro.estado === "verificada") {
    return { resultado: resultadoGuardado(registro), reutilizado: true };
  }

  if (registro.estado === "subiendo" || registro.estado === "incierta") {
    const encontrado = await verificarExistencia(registro, repositorio, transporte);
    if (encontrado) return { resultado: encontrado, reutilizado: true };
    if (registro.estado === "subiendo") await repositorio.marcarIncierta(registro.clave);
    throw new SubidaDriveInciertaError();
  }

  const subiendo = await repositorio.marcarSubiendo(registro.clave);
  if (!subiendo) {
    const actual = await repositorio.obtener(registro.clave);
    if (actual?.estado === "verificada") return { resultado: resultadoGuardado(actual), reutilizado: true };
    throw new SubidaDriveInciertaError();
  }

  let resultado: ResultadoSubidaDrive;
  try {
    resultado = await transporte.subir(subiendo.marcador);
  } catch (error) {
    if (esRechazoDefinitivoSinSubida(error)) {
      await repositorio.marcarPreparada(subiendo.clave);
      throw error;
    }
    try {
      const encontrado = await verificarExistencia(subiendo, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // La consulta también falló: la salida segura sigue siendo incierta.
    }
    await repositorio.marcarIncierta(subiendo.clave);
    throw new SubidaDriveInciertaError();
  }

  try {
    await repositorio.marcarVerificada(subiendo.clave, resultado);
  } catch {
    // Drive ya aceptó el archivo: a partir de aquí solo se consulta el
    // marcador privado; nunca se repite files.create.
    try {
      const encontrado = await verificarExistencia(subiendo, repositorio, transporte);
      if (encontrado) return { resultado: encontrado, reutilizado: true };
    } catch {
      // Conserva la salida segura de abajo.
    }
    await repositorio.marcarIncierta(subiendo.clave).catch(() => undefined);
    throw new SubidaDriveInciertaError();
  }

  return { resultado, reutilizado: false };
}

/** Reconciliación de solo lectura; jamás invoca files.create. */
export async function reconciliarSubidasDrivePendientes(
  repositorio: RepositorioSubidasDrive,
  buscar: TransporteSubidaDrive["buscar"]
): Promise<{ revisadas: number; verificadas: number; inciertas: number; errores: number }> {
  const pendientes = await repositorio.listarPendientes();
  let verificadas = 0;
  let inciertas = 0;
  let errores = 0;
  for (const registro of pendientes) {
    try {
      const encontrado = await buscar(registro.marcador, registro.folderId);
      if (encontrado) {
        await repositorio.marcarVerificada(registro.clave, encontrado);
        verificadas++;
      } else {
        if (registro.estado === "subiendo") await repositorio.marcarIncierta(registro.clave);
        inciertas++;
      }
    } catch {
      errores++;
    }
  }
  return { revisadas: pendientes.length, verificadas, inciertas, errores };
}
