export const MODELO_SONNET_5 = "claude-sonnet-5";
export const MODELO_SONNET_4_6 = "claude-sonnet-4-6";

export type ProcesoDocumentalIA =
  | "clasificar_correo"
  | "clasificar_documento"
  | "extraer_factura"
  | "extraer_gasto_correo"
  | "transcribir_captura";

const VARIABLE_POR_PROCESO: Record<ProcesoDocumentalIA, string> = {
  clasificar_correo: "WOBI_AI_MODEL_CLASIFICAR_CORREO",
  clasificar_documento: "WOBI_AI_MODEL_CLASIFICAR_DOCUMENTO",
  extraer_factura: "WOBI_AI_MODEL_EXTRAER_FACTURA",
  extraer_gasto_correo: "WOBI_AI_MODEL_EXTRAER_GASTO_CORREO",
  transcribir_captura: "WOBI_AI_MODEL_TRANSCRIBIR_CAPTURA",
};

const MODELOS_SEGUROS = new Set([MODELO_SONNET_5, MODELO_SONNET_4_6]);

/**
 * Enrutamiento reversible para lectura financiera/documental. Sonnet 5 es el modelo predeterminado:
 * tiene una tarifa nominal menor que 4.6 y ya está validado en el chat y la clasificación de correo
 * de producción. Se conserva 4.6 como rollback inmediato mediante variable de entorno.
 *
 * Haiku no se admite todavía en estos procesos: primero debe superar una comparación de calidad con
 * documentos reales anonimizados. Una errata tampoco puede seleccionar silenciosamente otro modelo.
 */
export function resolverModeloDocumental(
  proceso: ProcesoDocumentalIA,
  env: NodeJS.ProcessEnv = process.env
): string {
  const variable = VARIABLE_POR_PROCESO[proceso];
  const configurado = env[variable]?.trim();
  if (!configurado) return MODELO_SONNET_5;
  if (MODELOS_SEGUROS.has(configurado)) return configurado;

  console.warn(
    `[ai/model-routing] ${variable} no admite "${configurado}"; se usa ${MODELO_SONNET_5}.`
  );
  return MODELO_SONNET_5;
}
