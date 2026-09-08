export type ProveedorAutorrevision = "api" | "claude_max_shadow" | "claude_max";

/**
 * Selecciona quién hace la autorrevisión nocturna.
 *
 * - api: comportamiento histórico en Railway.
 * - claude_max_shadow: Railway sigue revisando por API mientras GitHub Actions
 *   ejecuta Claude Code Max en paralelo para validar resultados.
 * - claude_max: la revisión API de Railway queda en espera y Claude Code Max
 *   pasa a ser el responsable. La ruta API no se elimina y se recupera
 *   cambiando una sola variable.
 *
 * Un valor inválido conserva la ruta API: una errata nunca debe dejar al
 * sistema sin autorrevisión silenciosamente. El gasto continúa protegido por
 * WOBI_AI_API_MODE, su allowlist y sus límites.
 */
export function obtenerProveedorAutorrevision(
  env: NodeJS.ProcessEnv = process.env
): ProveedorAutorrevision {
  const raw = (env.WOBI_AUTOREVISION_PROVIDER ?? "api").trim().toLowerCase();
  if (raw === "claude_max" || raw === "claude_max_shadow") return raw;
  return "api";
}

export function debeEjecutarAutorrevisionApi(proveedor: ProveedorAutorrevision): boolean {
  return proveedor !== "claude_max";
}

/** Misma rotación diaria que usa el workflow para poder comparar los mismos archivos en sombra. */
export function seleccionarRutasAutorrevisionSombra(
  rutas: string[],
  fecha: Date = new Date(),
  maximo = 3
): string[] {
  if (rutas.length === 0 || !Number.isInteger(maximo) || maximo <= 0) return [];
  const unicas = [...new Set(rutas)].sort();
  const cantidad = Math.min(maximo, unicas.length);
  const diaUtc = Math.floor(
    Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()) / 86_400_000
  );
  const inicio = (diaUtc * cantidad) % unicas.length;
  return Array.from({ length: cantidad }, (_, indice) => unicas[(inicio + indice) % unicas.length]);
}
