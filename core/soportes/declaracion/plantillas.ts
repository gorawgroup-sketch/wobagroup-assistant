import type { Empresa } from "../../holded/client";

/**
 * Plantillas «GASTOS SIN SOPORTE» por empresa (docx en la raíz del Drive de cada una; creadas el 12-10-2026 con su imagen
 * institucional). Se pueden sustituir por variable de entorno sin tocar código. Footprint tiene plantilla genérica desde el 12-10-2026
 * (derivada del documento de Simon).
 */
const PLANTILLAS_POR_DEFECTO: Partial<Record<Empresa, string>> = {
  EWORKS: "1gJJuxrrggus_4_tuRhEGysclOPxIw_Eg",
  WOBA: "1JAKTEQLpUNUeujdi5FaU_fF4uh4gcBeV",
  // Derivada el 12-10-2026 del documento de Simon (misma imagen institucional), con marcadores y una fila vacía.
  Footprint: "1eSkaJDSP9cvCWvUCwfZn89SVchP_1x03",
};

export const FIRMA_EMPRESA: Partial<Record<Empresa, string>> = {
  EWORKS: "COMPAÑIA DE PROYECTOS EWORKS, SL",
  WOBA: "BUSINESS ATELIER EUROPA, SL",
  Footprint: "BUSINESS FOOTPRINT EU, SL",
};

/** Carpeta de destino (ruta dentro de la raíz de la empresa) donde se guardan las declaraciones generadas y las firmadas. */
export const RUTA_CARPETA_DECLARACIONES = ["DOCUMENTOS GENERALES", "GASTOS SIN SOPORTE"];

export function plantillaDeclaracionDe(empresa: Empresa, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const clave = `WOBI_DECLARACION_PLANTILLA_${empresa.toUpperCase()}`;
  return env[clave]?.trim() || PLANTILLAS_POR_DEFECTO[empresa];
}
