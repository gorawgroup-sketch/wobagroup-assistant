import { createReadStream } from "node:fs";
import { google, drive_v3 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { conMutex } from "../utils/asyncMutex";
import {
  ejecutarSubidaDriveDurable,
  identidadSubidaDrive,
  reconciliarSubidasDrivePendientes,
  SubidaDriveInciertaError,
  type ResultadoSubidaDrive,
} from "./durableUpload";
import { durableUploadStore } from "./durableUploadStore";

/** Escapa un valor para usarlo dentro de una consulta de Drive (name = '...' / name contains '...') — compartido por todas las búsquedas de este archivo, antes 4 copias independientes de la misma línea. */
function escaparParaConsultaDrive(nombre: string): string {
  return nombre.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

let driveClient: drive_v3.Drive | null = null;

/**
 * Devuelve un cliente autenticado de la API de Google Drive (solo lectura),
 * reutilizado entre llamadas. Usa la misma cuenta de servicio que Sheets.
 */
function getDriveClient(): drive_v3.Drive {
  if (driveClient) return driveClient;

  const credentials = loadServiceAccountCredentials();

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

/** Chequeo mínimo de conexión (about.get, sin listar archivos) para el panel de conexiones. */
export async function verificarConexionDrive(): Promise<{ ok: boolean; detalle?: string }> {
  try {
    await getDriveClient().about.get({ fields: "user" });
    return { ok: true };
  } catch (error) {
    return { ok: false, detalle: error instanceof Error ? error.message : String(error) };
  }
}

let driveWriteClient: drive_v3.Drive | null = null;

/**
 * Cliente de Drive con permiso de escritura (scope completo), distinto del
 * de solo lectura usado por la búsqueda. Se usa exclusivamente para subir
 * archivos ya aprobados por el usuario.
 *
 * Las cuentas de servicio no tienen cuota de almacenamiento propia, así que
 * no pueden crear archivos en carpetas de un Drive personal (solo en
 * Unidades Compartidas). Por eso este cliente "impersona" a un usuario real
 * (GOOGLE_IMPERSONATE_EMAIL) vía delegación de dominio — configurada en el
 * Admin Console de Google Workspace, con el client_id de esta cuenta de
 * servicio y el scope drive autorizados.
 */
function getDriveWriteClient(): drive_v3.Drive {
  if (driveWriteClient) return driveWriteClient;

  const credentials = loadServiceAccountCredentials();
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL;

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"],
    subject: impersonate || undefined,
  });

  driveWriteClient = google.drive({ version: "v3", auth });
  return driveWriteClient;
}

const FRIENDLY_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/pdf": "PDF",
  "image/jpeg": "Imagen JPEG",
  "image/png": "Imagen PNG",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word (.docx)",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel (.xlsx)",
  "application/vnd.google-apps.folder": "Carpeta",
};

export interface DriveSearchResult {
  id: string;
  name: string;
  folderPath: string;
  friendlyType: string;
  webViewLink: string;
  mimeType?: string;
}

interface FolderInfo {
  name: string;
  parentId?: string;
}

const MAX_ANCESTRY_HOPS = 30;

// Bug real encontrado en vivo (2026-09-01): "name contains '<consulta>'" en
// la API de Drive exige la frase COMPLETA como substring contiguo del
// nombre — una consulta de varias palabras ("control de acceso") no
// encontraba "guia rapida control accesos.pdf" (sin "de" en el medio, y
// "acceso"/"accesos" en singular/plural), aunque el archivo real existía y
// era justo lo que se buscaba. Verificado en vivo: la palabra suelta
// "acceso" SÍ lo encontraba. Ahora se descompone la consulta en palabras
// significativas (3+ letras, sin palabras vacías como "de"/"la"/"el") y se
// consulta cada una POR SEPARADO, uniendo los resultados (sin duplicar por
// id) — así una consulta de varias palabras encuentra el archivo aunque
// solo una de esas palabras aparezca literalmente en el nombre real.
const PALABRAS_VACIAS = new Set(["de", "la", "el", "los", "las", "un", "una", "y", "en", "para", "del", "al", "con"]);

export function palabrasSignificativas(query: string): string[] {
  const palabras = query
    .toLowerCase()
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 3 && !PALABRAS_VACIAS.has(p));
  return palabras.length > 0 ? palabras : [query.trim()].filter(Boolean);
}

/**
 * Busca archivos Y carpetas por nombre en TODO lo que la cuenta de servicio
 * puede ver (búsqueda global, indexada por nombre — rápida sin importar el
 * tamaño del árbol), y luego, solo para los que coinciden por nombre,
 * verifica si están dentro del árbol de la carpeta raíz solicitada subiendo
 * por la cadena de padres. Esto evita enumerar árboles de carpetas enteros
 * (que pueden ser muy grandes y lentos) cuando solo hace falta filtrar unos
 * pocos resultados. Solo lectura — no descarga ni lee contenido de archivos.
 */
export async function searchDriveFiles(rootFolderId: string, query: string): Promise<DriveSearchResult[]> {
  const drive = getDriveClient();

  const candidatosPorId = new Map<string, drive_v3.Schema$File>();

  for (const palabra of palabrasSignificativas(query)) {
    const escapedQuery = escaparParaConsultaDrive(palabra);
    const q = `name contains '${escapedQuery}' and trashed = false`;

    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q,
        fields: "nextPageToken, files(id, name, mimeType, webViewLink, parents)",
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
      });

      for (const f of res.data.files ?? []) {
        if (f.id) candidatosPorId.set(f.id, f);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  const candidatos = Array.from(candidatosPorId.values());

  const folderCache = new Map<string, FolderInfo | null>();

  async function getFolderInfo(folderId: string): Promise<FolderInfo | null> {
    if (folderCache.has(folderId)) return folderCache.get(folderId) ?? null;

    try {
      const res = await drive.files.get({
        fileId: folderId,
        fields: "name, parents",
        supportsAllDrives: true,
      });
      const info: FolderInfo = { name: res.data.name ?? "(sin nombre)", parentId: res.data.parents?.[0] };
      folderCache.set(folderId, info);
      return info;
    } catch {
      folderCache.set(folderId, null);
      return null;
    }
  }

  /**
   * Sube por la cadena de padres desde `startFolderId` hasta encontrar
   * `rootFolderId` (devuelve la ruta de carpetas intermedias) o hasta
   * quedarse sin padres / superar el límite de saltos (no está en el árbol).
   */
  async function resolveAncestry(startFolderId: string | undefined): Promise<string[] | null> {
    if (!startFolderId) return null;
    if (startFolderId === rootFolderId) return [];

    const path: string[] = [];
    let current: string | undefined = startFolderId;
    let hops = 0;

    while (current && hops < MAX_ANCESTRY_HOPS) {
      hops++;
      if (current === rootFolderId) return path.reverse();

      const info = await getFolderInfo(current);
      if (!info) return null;

      path.push(info.name);
      current = info.parentId;
    }

    return null;
  }

  const results: DriveSearchResult[] = [];

  for (const f of candidatos) {
    const parentId = f.parents?.[0];
    const ancestry = await resolveAncestry(parentId);
    if (ancestry === null) continue; // no está dentro del árbol de esta empresa

    results.push({
      id: f.id ?? "",
      name: f.name ?? "(sin nombre)",
      folderPath: ancestry.length > 0 ? ancestry.join(" / ") : "(raíz)",
      friendlyType: (f.mimeType && FRIENDLY_TYPES[f.mimeType]) || f.mimeType || "Desconocido",
      webViewLink: f.webViewLink ?? "",
      mimeType: f.mimeType ?? undefined,
    });
  }

  return results;
}

export interface ArchivoDriveDescargado {
  bytes: Buffer;
  mimeType: string;
  name: string;
}

const MIMES_LEGIBLES_DRIVE = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

/**
 * Descarga el contenido real (bytes) de un archivo de Drive por su id —
 * scope drive.readonly ya alcanza para esto (no hace falta escritura).
 * Pedido explícito de Carlos tras un caso real: un documento ya archivado
 * en Drive ("guía rápida de control de accesos") no se podía CONSULTAR
 * directamente — solo se sabía que existía (buscar_documento_drive), sin
 * poder leer su contenido para responder con la información real. Solo
 * soporta los mismos tipos que Claude vision puede leer (PDF/imagen, ver
 * MIMES_LEGIBLES_DRIVE) — un Google Doc/Sheet nativo necesitaría exportarse
 * primero, no soportado todavía (nunca se ha dado un caso real).
 */
export async function descargarArchivoDrive(fileId: string): Promise<ArchivoDriveDescargado> {
  const drive = getDriveClient();

  const meta = await drive.files.get({
    fileId,
    fields: "name, mimeType",
    supportsAllDrives: true,
  });
  const mimeType = meta.data.mimeType ?? "";
  const name = meta.data.name ?? "(sin nombre)";

  if (!MIMES_LEGIBLES_DRIVE.includes(mimeType)) {
    throw new Error(
      `El archivo "${name}" es de tipo ${mimeType || "desconocido"} — solo se puede leer el contenido de PDF o imágenes por ahora.`
    );
  }

  const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
  const bytes = Buffer.from(res.data as ArrayBuffer);

  return { bytes, mimeType, name };
}

const MAX_ANCESTRY_HOPS_UPLOAD = 30;

export async function estaDentroDelArbol(drive: drive_v3.Drive, folderId: string, rootFolderId: string): Promise<boolean> {
  let current: string | undefined = folderId;
  let hops = 0;

  while (current && hops < MAX_ANCESTRY_HOPS_UPLOAD) {
    if (current === rootFolderId) return true;
    hops++;

    try {
      const fileId: string = current;
      const res = await drive.files.get({ fileId, fields: "parents", supportsAllDrives: true });
      current = res.data.parents?.[0];
    } catch {
      return false;
    }
  }

  return false;
}

export interface CarpetaResuelta {
  folderId: string;
  encontrada: boolean;
  rutaEncontrada?: string;
}

/**
 * Busca, dentro del árbol de `rootFolderId`, una subcarpeta cuyo nombre
 * coincida con alguno de `nombresCandidatos` (en orden de preferencia — el
 * primero que encuentre y esté dentro del árbol gana). Prueba coincidencia
 * exacta primero y, si no hay, coincidencia parcial (por si el nombre real
 * trae variaciones como emojis, ej. "SEGUROS📜"). Si no encuentra ninguna,
 * devuelve el propio `rootFolderId` como destino (fallback seguro: nunca
 * sube "a ciegas" a una carpeta no verificada).
 */
export async function resolverCarpetaDestino(
  rootFolderId: string,
  nombresCandidatos: string[]
): Promise<CarpetaResuelta> {
  const drive = getDriveClient();

  for (const modo of ["exacta", "parcial"] as const) {
    for (const nombre of nombresCandidatos) {
      const limpio = nombre.trim();
      if (!limpio) continue;

      const escapado = escaparParaConsultaDrive(limpio);
      const condicionNombre = modo === "exacta" ? `name = '${escapado}'` : `name contains '${escapado}'`;
      const q = `mimeType = 'application/vnd.google-apps.folder' and ${condicionNombre} and trashed = false`;

      const res = await drive.files.list({
        q,
        fields: "files(id, name)",
        pageSize: 20,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
      });

      for (const folder of res.data.files ?? []) {
        if (!folder.id) continue;
        if (await estaDentroDelArbol(drive, folder.id, rootFolderId)) {
          return { folderId: folder.id, encontrada: true, rutaEncontrada: folder.name ?? limpio };
        }
      }
    }
  }

  return { folderId: rootFolderId, encontrada: false };
}

/**
 * Caso real reportado por Carlos: al pedir "✏️ Elegir otra carpeta" en un documento, el sistema solo
 * podía encontrar una carpeta YA EXISTENTE o, si no, archivar en la raíz sin decir que la carpeta que
 * pidió no existe ni ofrecer crearla — "debes... mostrarme la alternativa para crear una carpeta
 * nueva, pedirme nombre, crearla y archivarlo ahí". A diferencia de resolverCarpetaDestino (búsqueda
 * global entre nombres candidatos, nunca crea, cae a la raíz si no encuentra), esto DESCIENDE la ruta
 * dada, nivel por nivel, y CREA cada segmento que no exista todavía — solo se usa cuando el usuario
 * pidió explícitamente crear la carpeta, nunca automáticamente.
 *
 * Hallazgo real de auditoría: la primera versión buscaba solo por nombre EXACTO en cada nivel — a
 * diferencia de resolverCarpetaDestino, que ya prueba una segunda pasada con "contains" precisamente
 * porque nombres reales de carpetas en este Drive traen variaciones (ej. "SEGUROS📜" en vez de
 * "Seguros"). Sin esa segunda pasada, pedir crear "Seguros" habría creado una carpeta DUPLICADA junto
 * a la real — y esta cuenta de servicio no puede borrar ni mandar a la papelera nada que crea (sin
 * permiso en este Drive compartido), así que un duplicado así queda para siempre. Ahora prueba exacta
 * y luego parcial en cada nivel, igual que resolverCarpetaDestino, ANTES de crear. La búsqueda usa
 * getDriveClient() (misma identidad de solo-lectura que listar_carpetas_drive) para que "¿ya existe?"
 * responda lo mismo sin importar qué tool la pregunte — solo la creación en sí usa el cliente de
 * escritura.
 */
export async function resolverOCrearCarpeta(
  rootFolderId: string,
  ruta: string[]
): Promise<{ folderId: string; encontrada: boolean; creada: boolean; rutaEncontrada: string }> {
  const lector = getDriveClient();
  let parentId = rootFolderId;
  let huboCreacion = false;
  const segmentosFinales: string[] = [];

  for (const segmentoRaw of ruta) {
    const nombre = segmentoRaw.trim();
    if (!nombre) continue;

    const escapado = escaparParaConsultaDrive(nombre);
    let existenteId: string | undefined;
    let nombreReal = nombre;

    for (const modo of ["exacta", "parcial"] as const) {
      const condicionNombre = modo === "exacta" ? `name = '${escapado}'` : `name contains '${escapado}'`;
      const q = `mimeType = 'application/vnd.google-apps.folder' and ${condicionNombre} and '${parentId}' in parents and trashed = false`;
      const res = await lector.files.list({
        q,
        fields: "files(id, name)",
        pageSize: 5,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
      });
      const match = res.data.files?.[0];
      if (match?.id) {
        existenteId = match.id;
        nombreReal = match.name ?? nombre;
        break;
      }
    }

    if (existenteId) {
      parentId = existenteId;
      segmentosFinales.push(nombreReal);
      continue;
    }

    const escritor = getDriveWriteClient();
    const creada = await escritor.files.create({
      requestBody: { name: nombre, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
      fields: "id",
      supportsAllDrives: true,
    });
    if (!creada.data.id) {
      throw new Error(`No se pudo crear la carpeta "${nombre}" en Drive.`);
    }
    parentId = creada.data.id;
    segmentosFinales.push(nombre);
    huboCreacion = true;
  }

  return { folderId: parentId, encontrada: true, creada: huboCreacion, rutaEncontrada: segmentosFinales.join(" / ") };
}

export interface ArchivoReciente {
  name: string;
  createdTime: string;
  webViewLink: string;
}

const MAX_ANCESTRY_HOPS_RECIENTES = 30;
const CONCURRENCIA_ANCESTRIA = 8;

/**
 * Resuelve, subiendo por la cadena de padres desde `startFolderId`, cuál (si
 * alguna) de las `rootFolderIds` es un ancestro — con caché de carpetas
 * compartida entre llamadas (`folderCache`), para no repetir la misma
 * llamada a la API cuando muchos archivos comparten carpetas padre.
 */
async function resolverRaizAncestro(
  drive: drive_v3.Drive,
  startFolderId: string,
  rootFolderIds: string[],
  folderCache: Map<string, FolderInfo | null>
): Promise<string | undefined> {
  let current: string | undefined = startFolderId;
  let hops = 0;

  while (current && hops < MAX_ANCESTRY_HOPS_RECIENTES) {
    const match = rootFolderIds.find((r) => r === current);
    if (match) return match;
    hops++;

    if (!folderCache.has(current)) {
      try {
        const res = await drive.files.get({ fileId: current, fields: "name, parents", supportsAllDrives: true });
        folderCache.set(current, { name: res.data.name ?? "", parentId: res.data.parents?.[0] });
      } catch {
        folderCache.set(current, null);
      }
    }

    const info = folderCache.get(current);
    if (!info) return undefined;
    current = info.parentId;
  }

  return undefined;
}

async function ejecutarConConcurrenciaAcotada<T, R>(items: T[], concurrencia: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const resultados: R[] = new Array(items.length);
  let indice = 0;

  async function trabajador(): Promise<void> {
    while (indice < items.length) {
      const i = indice++;
      resultados[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrencia, items.length) }, trabajador));
  return resultados;
}

/**
 * Lista archivos (no carpetas) creados después de `sinceISODate`, agrupados
 * por cuál de `rootFolderIds` los contiene (clave del record de vuelta) —
 * en UNA sola búsqueda global y UNA sola resolución de ancestría por
 * archivo (compartida entre las N carpetas raíz, con caché de carpetas),
 * en vez de repetir la búsqueda y la ancestría una vez por empresa. La API
 * de Drive no soporta un filtro nativo de "descendiente recursivo de X",
 * así que sigue siendo "buscar global + verificar ancestría" (como
 * searchDriveFiles), pero resuelto de la forma más barata posible. Solo
 * lectura.
 */
export async function listarArchivosRecientesPorRaiz(
  rootFolderIds: string[],
  sinceISODate: string
): Promise<Record<string, ArchivoReciente[]>> {
  const drive = getDriveClient();
  const q = `createdTime > '${sinceISODate}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;

  const candidatos: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q,
      fields: "nextPageToken, files(id, name, createdTime, webViewLink, parents)",
      pageSize: 100,
      pageToken,
      orderBy: "createdTime desc",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });

    candidatos.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const folderCache = new Map<string, FolderInfo | null>();
  const porRaiz: Record<string, ArchivoReciente[]> = Object.fromEntries(rootFolderIds.map((r) => [r, []]));

  const asignaciones = await ejecutarConConcurrenciaAcotada(candidatos, CONCURRENCIA_ANCESTRIA, async (f) => {
    const parentId = f.parents?.[0];
    if (!parentId) return undefined;
    return resolverRaizAncestro(drive, parentId, rootFolderIds, folderCache);
  });

  candidatos.forEach((f, i) => {
    const raiz = asignaciones[i];
    if (!raiz) return;
    porRaiz[raiz].push({
      name: f.name ?? "(sin nombre)",
      createdTime: f.createdTime ?? "",
      webViewLink: f.webViewLink ?? "",
    });
  });

  return porRaiz;
}

export interface ArchivoSubido {
  fileId: string;
  webViewLink: string;
}

const APP_PROPERTY_EFECTO = "wobi_effect";
const metricasSubidasDurables = {
  activas: 0,
  subidas: 0,
  reutilizadas: 0,
  verificadasRecuperadas: 0,
  incertidumbresDetectadas: 0,
  errores: 0,
  inciertasUltimaRevision: 0,
};
let timerReconciliacionSubidas: ReturnType<typeof setTimeout> | null = null;

export function configuracionSubidasDriveDurables(env: NodeJS.ProcessEnv = process.env) {
  return {
    // Solo false explícito restaura temporalmente el camino anterior.
    habilitado: (env.WOBI_DRIVE_DURABLE_ENABLED ?? "true").trim().toLowerCase() !== "false",
  };
}

export function obtenerEstadoSubidasDriveDurables() {
  return { habilitado: configuracionSubidasDriveDurables().habilitado, ...metricasSubidasDurables };
}

async function buscarArchivoPorMarcador(
  marcador: string,
  folderId: string
): Promise<ResultadoSubidaDrive | undefined> {
  const drive = getDriveWriteClient();
  const q =
    `appProperties has { key='${APP_PROPERTY_EFECTO}' and value='${marcador}' } ` +
    `and '${escaparParaConsultaDrive(folderId)}' in parents and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: "incompleteSearch, files(id, webViewLink)",
    pageSize: 2,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
  });
  if (res.data.incompleteSearch) {
    throw new Error("Drive devolvió una búsqueda incompleta para el marcador durable.");
  }
  const encontrado = res.data.files?.[0];
  if (!encontrado?.id) return undefined;
  return {
    fileId: encontrado.id,
    webViewLink: encontrado.webViewLink ?? `https://drive.google.com/file/d/${encontrado.id}/view`,
  };
}

async function subirArchivoADriveDirecto(
  rutaLocal: string,
  nombreArchivo: string,
  mimeType: string | undefined,
  folderId: string,
  marcador?: string
): Promise<ArchivoSubido> {
  const drive = getDriveWriteClient();

  const res = await drive.files.create({
    requestBody: {
      name: nombreArchivo,
      parents: [folderId],
      appProperties: marcador ? { [APP_PROPERTY_EFECTO]: marcador } : undefined,
    },
    media: { mimeType: mimeType || "application/octet-stream", body: createReadStream(rutaLocal) },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });

  if (!res.data.id) {
    throw new Error("Drive no devolvió un id para el archivo subido.");
  }

  return {
    fileId: res.data.id,
    webViewLink: res.data.webViewLink ?? `https://drive.google.com/file/d/${res.data.id}/view`,
  };
}

/** Reconciliación de arranque: únicamente busca marcadores privados; nunca vuelve a subir. */
export async function reconciliarSubidasDriveAlArrancar() {
  if (!configuracionSubidasDriveDurables().habilitado) {
    return { revisadas: 0, verificadas: 0, inciertas: 0, errores: 0 };
  }
  const resumen = await reconciliarSubidasDrivePendientes(durableUploadStore, buscarArchivoPorMarcador);
  metricasSubidasDurables.verificadasRecuperadas += resumen.verificadas;
  metricasSubidasDurables.incertidumbresDetectadas += resumen.inciertas;
  metricasSubidasDurables.errores += resumen.errores;
  metricasSubidasDurables.inciertasUltimaRevision = resumen.inciertas;
  if (resumen.inciertas > 0 || resumen.errores > 0) programarReconciliacionSubidasDrive(30_000, 3);
  return resumen;
}

/** Reintentos acotados de solo lectura después de una respuesta ambigua. */
function programarReconciliacionSubidasDrive(demoraMs: number, intentosRestantes: number): void {
  if (timerReconciliacionSubidas || intentosRestantes <= 0) return;
  timerReconciliacionSubidas = setTimeout(() => {
    timerReconciliacionSubidas = null;
    void reconciliarSubidasDrivePendientes(durableUploadStore, buscarArchivoPorMarcador)
      .then((resumen) => {
        metricasSubidasDurables.verificadasRecuperadas += resumen.verificadas;
        metricasSubidasDurables.incertidumbresDetectadas += resumen.inciertas;
        metricasSubidasDurables.errores += resumen.errores;
        metricasSubidasDurables.inciertasUltimaRevision = resumen.inciertas;
        if (resumen.inciertas > 0 || resumen.errores > 0) {
          programarReconciliacionSubidasDrive(60_000, intentosRestantes - 1);
        }
      })
      .catch(() => {
        metricasSubidasDurables.errores++;
        programarReconciliacionSubidasDrive(60_000, intentosRestantes - 1);
      });
  }, demoraMs);
  timerReconciliacionSubidas.unref();
}

/**
 * Sube un archivo local a una carpeta específica de Drive. Solo debe
 * invocarse tras aprobación explícita del usuario — nunca automáticamente.
 * La clave estable identifica la aprobación, no el nombre ni los bytes: así
 * un retry técnico reutiliza el archivo, pero dos aprobaciones deliberadas
 * del mismo documento siguen siendo dos acciones distintas.
 */
export async function subirArchivoADrive(
  rutaLocal: string,
  nombreArchivo: string,
  mimeType: string | undefined,
  folderId: string,
  idempotencyKey: string,
  proceso: string = "archivo_aprobado"
): Promise<ArchivoSubido> {
  if (!configuracionSubidasDriveDurables().habilitado) {
    return subirArchivoADriveDirecto(rutaLocal, nombreArchivo, mimeType, folderId);
  }

  const identidad = identidadSubidaDrive(idempotencyKey, folderId);
  return conMutex(`drive-upload:${identidad.clave}`, async () => {
    metricasSubidasDurables.activas++;
    try {
      const subida = await ejecutarSubidaDriveDurable(
        idempotencyKey,
        folderId,
        proceso,
        durableUploadStore,
        {
          buscar: buscarArchivoPorMarcador,
          subir: (marcador) => subirArchivoADriveDirecto(rutaLocal, nombreArchivo, mimeType, folderId, marcador),
        }
      );
      if (subida.reutilizado) metricasSubidasDurables.reutilizadas++;
      else metricasSubidasDurables.subidas++;
      return subida.resultado;
    } catch (error) {
      if (error instanceof SubidaDriveInciertaError) {
        metricasSubidasDurables.incertidumbresDetectadas++;
        metricasSubidasDurables.inciertasUltimaRevision++;
        programarReconciliacionSubidasDrive(30_000, 3);
      } else metricasSubidasDurables.errores++;
      throw error;
    } finally {
      metricasSubidasDurables.activas--;
    }
  });
}

/**
 * Lista los nombres de las subcarpetas DIRECTAS de `rootFolderId`, o de una
 * subcarpeta suya llamada `nombreCarpetaPadre` (coincidencia parcial) si se
 * especifica. Pensado para que el clasificador de documentos vea nombres
 * reales de carpetas en vez de adivinar (ej. "SEGUROS📜" en vez de "Seguros").
 */
export async function listarSubcarpetas(rootFolderId: string, nombreCarpetaPadre?: string): Promise<string[]> {
  return listarCarpetasEnRuta(rootFolderId, nombreCarpetaPadre?.trim() ? [nombreCarpetaPadre] : []);
}

/**
 * Lista los nombres de las subcarpetas al final de una ruta de nombres de
 * carpetas (coincidencia parcial en cada segmento), descendiendo desde
 * `rootFolderId`. Con `ruta` vacía, lista las carpetas de primer nivel.
 * Si algún segmento de la ruta no se encuentra, devuelve un array vacío
 * (nunca inventa una carpeta que no verificó que existe).
 */
export async function listarCarpetasEnRuta(rootFolderId: string, ruta: string[]): Promise<string[]> {
  const drive = getDriveClient();
  let parentId = rootFolderId;

  for (const segmento of ruta) {
    const limpio = segmento.trim();
    if (!limpio) continue;

    const escapado = escaparParaConsultaDrive(limpio);
    const q =
      `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' ` +
      `and name contains '${escapado}' and trashed = false`;

    const res = await drive.files.list({
      q,
      fields: "files(id, name)",
      pageSize: 5,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const match = res.data.files?.[0];
    if (!match?.id) {
      return [];
    }
    parentId = match.id;
  }

  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(name)",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return (res.data.files ?? []).map((f) => f.name ?? "").filter(Boolean);
}
