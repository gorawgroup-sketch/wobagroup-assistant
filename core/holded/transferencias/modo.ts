import type { Empresa } from "../client";

/**
 * Interruptor de la conciliación de transferencias internas. Desplegar el código no cambia nada: por defecto apagado.
 *  - apagado:      ni detecta ni propone.
 *  - observacion:  detecta y propone; «Conciliar transferencia» no ejecuta nada.
 *  - activo:       ejecuta SOLO las parejas autorizadas por escrito en WOBI_TRANSFERENCIAS_CASOS.
 */
export type ModoTransferencias = "apagado" | "observacion" | "activo";

export function modoTransferencias(env: NodeJS.ProcessEnv = process.env): ModoTransferencias {
  const valor = (env.WOBI_TRANSFERENCIAS_MODO ?? "").trim().toLowerCase();
  if (valor === "activo") return "activo";
  if (valor === "observacion" || valor === "observación") return "observacion";
  return "apagado";
}

const CLAVE = /^(WOBA|EWORKS|Footprint):[0-9a-f]{24}>[0-9a-f]{24}$/;

/** Parejas autorizadas: «Empresa:movimientoOrigen>movimientoDestino», separadas por coma. Una entrada mal escrita se descarta. */
export function casosAutorizados(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.WOBI_TRANSFERENCIAS_CASOS ?? "").split(",").map((c) => c.trim()).filter((c) => CLAVE.test(c)));
}

export function ejecucionAutorizada(clave: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return modoTransferencias(env) === "activo" && casosAutorizados(env).has(clave);
}

export const EMPRESAS_TRANSFERENCIAS: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"];
