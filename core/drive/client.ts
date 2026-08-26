import { createReadStream } from "node:fs";
import { google, drive_v3 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";

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
  name: string;
  folderPath: string;
  friendlyType: string;
  webViewLink: string;
}

interface FolderInfo {
  name: string;
  parentId?: string;
}

const MAX_ANCESTRY_HOPS = 30;

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
  const escapedQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  const q = `name contains '${escapedQuery}' and trashed = false`;

  const candidatos: drive_v3.Schema$File[] = [];
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

    candidatos.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

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
      name: f.name ?? "(sin nombre)",
      folderPath: ancestry.length > 0 ? ancestry.join(" / ") : "(raíz)",
      friendlyType: (f.mimeType && FRIENDLY_TYPES[f.mimeType]) || f.mimeType || "Desconocido",
      webViewLink: f.webViewLink ?? "",
    });
  }

  return results;
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

      const escapado = limpio.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

/**
 * Sube un archivo local a una carpeta específica de Drive. Solo debe
 * invocarse tras aprobación explícita del usuario — nunca automáticamente.
 */
export async function subirArchivoADrive(
  rutaLocal: string,
  nombreArchivo: string,
  mimeType: string | undefined,
  folderId: string
): Promise<ArchivoSubido> {
  const drive = getDriveWriteClient();

  const res = await drive.files.create({
    requestBody: { name: nombreArchivo, parents: [folderId] },
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

    const escapado = limpio.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
