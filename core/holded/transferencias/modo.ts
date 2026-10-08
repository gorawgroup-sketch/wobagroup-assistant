import type { Empresa } from "../client";

/**
 * Interruptor de la conciliación de transferencias internas. Desplegar el código no cambia nada: por defecto apagado.
 *  - apagado:      ni detecta ni propone.
 *  - observacion:  detecta y propone; «Conciliar transferencia» no ejecuta nada.
 *  - activo:       ejecuta las parejas autorizadas por escrito en WOBI_TRANSFERENCIAS_CASOS y, si
 *                  WOBI_TRANSFERENCIAS_ALCANCE=eur, cualquier transferencia EUR↔EUR inequívoca (validado por Carlos el
 *                  05-10-2026 con la prueba WOBA de 350 €). Cada una sigue necesitando su pulsación en Telegram, y el
 *                  ejecutor rechaza por su cuenta conversiones, otras monedas y parejas ambiguas.
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

/**
 * WOBI_TRANSFERENCIAS_ALCANCE, separado por comas: lo que ya no necesita autorización escrita pareja a pareja.
 *  - eur:           transferencias EUR↔EUR (validado por Carlos el 05-10-2026, WOBA 350 €).
 *  - conversiones:  conversiones con una pata en euros en las que la entrada no vale más que la salida
 *                   (validado por Carlos el 05-10-2026, eWorks −433,96 EUR → +500 USD). Con diferencia a favor NO se ejecuta
 *                   (08-10-2026): ninguna transferencia entre cuentas propias toca cuentas de comisiones o diferencias.
 */
function alcance(env: NodeJS.ProcessEnv): Set<string> {
  return new Set((env.WOBI_TRANSFERENCIAS_ALCANCE ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
}

export function alcanceEurAbierto(env: NodeJS.ProcessEnv = process.env): boolean { return alcance(env).has("eur"); }
export function alcanceConversionesAbierto(env: NodeJS.ProcessEnv = process.env): boolean { return alcance(env).has("conversiones"); }

/** Cada tipo de operación tiene su propio alcance; una pareja en WOBI_TRANSFERENCIAS_CASOS vale siempre. */
export function ejecucionAutorizada(clave: string, env: NodeJS.ProcessEnv = process.env, tipo: "transferencia" | "conversion" = "transferencia"): boolean {
  if (modoTransferencias(env) !== "activo" || !CLAVE.test(clave)) return false;
  const abierto = tipo === "conversion" ? alcanceConversionesAbierto(env) : alcanceEurAbierto(env);
  return abierto || casosAutorizados(env).has(clave);
}

export const EMPRESAS_TRANSFERENCIAS: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"];
