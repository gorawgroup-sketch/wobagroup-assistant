import { readFileSync } from "node:fs";
import { join } from "node:path";
import { google, sheets_v4 } from "googleapis";

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

const DEFAULT_CREDENTIALS_PATH = join(
  process.cwd(),
  "credentials",
  "woba-copilot-506216-26f3bc9a934e.json"
);

let sheetsClient: sheets_v4.Sheets | null = null;

/**
 * Carga las credenciales de la cuenta de servicio de Google. Prioriza
 * GOOGLE_SERVICE_ACCOUNT_JSON (el JSON completo como variable de entorno,
 * necesario en Railway porque /credentials no se sube al repo) y cae de
 * vuelta al archivo local en /credentials para desarrollo.
 */
function loadCredentials(): ServiceAccountCredentials {
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inlineJson) {
    return JSON.parse(inlineJson) as ServiceAccountCredentials;
  }

  const path = process.env.GOOGLE_SERVICE_ACCOUNT_PATH ?? DEFAULT_CREDENTIALS_PATH;
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as ServiceAccountCredentials;
}

/**
 * Devuelve un cliente autenticado de la API de Google Sheets (solo lectura),
 * reutilizado entre llamadas.
 */
export function getSheetsClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  const credentials = loadCredentials();

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}
