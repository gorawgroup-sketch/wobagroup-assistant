import { google, drive_v3 } from "googleapis";
import { loadServiceAccountCredentials } from "./serviceAccount";
import { fetchDetalleRegistros, type DetalleRegistro } from "./cashflowSheet";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;

/**
 * Los comentarios de Google Sheets (clic derecho > Comentar, o Ctrl+Alt+M —
 * distintos de las "notas" clásicas, clic derecho > Insertar nota) NO se
 * leen por la API de Sheets: viven en la API de Drive (comments.list sobre
 * el archivo). Verificado en vivo: probamos primero `note` en
 * spreadsheets.get (siempre vacío) antes de encontrar que Carlos y su
 * equipo usan comentarios reales de Sheets en la columna VALOR de Pagos
 * Proyectos e Ingresos para dejar contexto de pago (fecha esperada,
 * condición, a quién avisar) — esto lee esos comentarios reales.
 */
function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

let driveReadClient: drive_v3.Drive | null = null;

function getDriveReadClient(): drive_v3.Drive {
  if (driveReadClient) return driveReadClient;

  const credentials = loadServiceAccountCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  driveReadClient = google.drive({ version: "v3", auth });
  return driveReadClient;
}

export interface AnotacionCashflow {
  id: string;
  /** Valor de la celda al momento del comentario (ej. "€345.38") — se usa para ubicar la fila real. */
  valorCelda: string;
  contenido: string;
  autor: string;
  creado: string;
  modificado: string;
  resuelto: boolean;
  respuestas: Array<{ autor: string; contenido: string }>;
  /**
   * Fila de DATOS que corresponde a esta anotación, si se pudo ubicar
   * (matcheando valorCelda contra fetchDetalleRegistros). undefined si el
   * valor ya no aparece en ningún registro actual — probablemente la fila
   * cambió o se borró desde que se dejó el comentario (comentario
   * "huérfano"), hay que avisarlo así en vez de fingir que se ubicó.
   */
  registro?: DetalleRegistro;
}

/**
 * Lee todos los comentarios (Drive API) del Sheet de cashflow y los cruza
 * con fetchDetalleRegistros (hoja DATOS) para ubicar cada uno en su
 * categoría/cliente/proyecto/semana/empresa real, usando el valor de la
 * celda como llave de coincidencia (no hay otra forma pública de resolver
 * el "anchor" opaco que devuelve la API de comentarios a una celda A1).
 * Por defecto solo devuelve los NO resueltos (resolved=false) — los
 * resueltos ya no necesitan seguimiento.
 */
export async function obtenerAnotacionesCashflow(soloSinResolver = true): Promise<AnotacionCashflow[]> {
  const sheetId = assertSheetId();
  const drive = getDriveReadClient();

  const comentarios: drive_v3.Schema$Comment[] = [];
  let pageToken: string | undefined;
  do {
    const resp = await drive.comments.list({
      fileId: sheetId,
      fields:
        "nextPageToken,comments(id,content,quotedFileContent,author,resolved,createdTime,modifiedTime,replies(content,author))",
      pageSize: 100,
      pageToken,
    });
    comentarios.push(...(resp.data.comments ?? []));
    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);

  const registros = await fetchDetalleRegistros();
  const porValor = new Map<string, DetalleRegistro>();
  for (const r of registros) {
    const key = r.valor.trim();
    if (key && !porValor.has(key)) porValor.set(key, r);
  }

  return comentarios
    .filter((c) => !soloSinResolver || !c.resolved)
    .map((c) => {
      const valorCelda = (c.quotedFileContent?.value ?? "").trim();
      return {
        id: c.id ?? "",
        valorCelda,
        contenido: c.content ?? "",
        autor: c.author?.displayName ?? "(desconocido)",
        creado: c.createdTime ?? "",
        modificado: c.modifiedTime ?? "",
        resuelto: c.resolved ?? false,
        respuestas: (c.replies ?? [])
          .filter((r) => r.content)
          .map((r) => ({ autor: r.author?.displayName ?? "(desconocido)", contenido: r.content ?? "" })),
        registro: porValor.get(valorCelda),
      };
    });
}
