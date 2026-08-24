import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

const DEFAULT_CREDENTIALS_PATH = join(
  process.cwd(),
  "credentials",
  "woba-copilot-506216-26f3bc9a934e.json"
);

/**
 * Carga las credenciales de la cuenta de servicio de Google, compartida entre
 * todos los clientes de Google (Sheets, Drive...). Prioriza
 * GOOGLE_SERVICE_ACCOUNT_JSON (el JSON completo como variable de entorno,
 * necesario en Railway porque /credentials no se sube al repo) y cae de
 * vuelta al archivo local en /credentials para desarrollo.
 */
export function loadServiceAccountCredentials(): ServiceAccountCredentials {
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inlineJson) {
    return JSON.parse(inlineJson) as ServiceAccountCredentials;
  }

  const path = process.env.GOOGLE_SERVICE_ACCOUNT_PATH ?? DEFAULT_CREDENTIALS_PATH;
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as ServiceAccountCredentials;
}
