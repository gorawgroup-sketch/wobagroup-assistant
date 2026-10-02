import type { Empresa } from "../client";

/**
 * Interruptores independientes de las dos automatizaciones de Holded en servidor.
 *  - apagado:    no hace nada (valor por defecto: desplegar el código no cambia el comportamiento del sistema).
 *  - simulacion: solo LEE de la API (cuentas, compras) y registra qué haría; nunca abre el navegador ni escribe.
 *  - activo:     ejecuta de verdad, SOLO sobre las empresas listadas explícitamente en *_EMPRESAS.
 */
export type ModoAutomatizacion = "apagado" | "simulacion" | "activo";
export type Automatizacion = "SYNC_BANCARIA" | "TICKETS";

const EMPRESAS: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"];

export function modoAutomatizacion(nombre: Automatizacion, env: NodeJS.ProcessEnv = process.env): ModoAutomatizacion {
  const valor = (env[`WOBI_HOLDED_${nombre}_MODO`] ?? "apagado").trim().toLowerCase();
  if (valor === "apagado" || valor === "off" || valor === "0") return "apagado";
  if (valor === "activo" || valor === "on" || valor === "1") return "activo";
  if (valor === "simulacion" || valor === "simulación") return "simulacion";
  // Ausente o desconocido: apagado. Desplegar este código no cambia nada hasta que alguien lo enciende por variable de entorno.
  return "apagado";
}

/** En modo activo el alcance es explícito: sin lista, ninguna empresa. En simulación se observan todas. */
export function empresasAutomatizacion(nombre: Automatizacion, env: NodeJS.ProcessEnv = process.env): Empresa[] {
  const modo = modoAutomatizacion(nombre, env);
  if (modo === "apagado") return [];
  if (modo === "simulacion") return [...EMPRESAS];
  const lista = (env[`WOBI_HOLDED_${nombre}_EMPRESAS`] ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return EMPRESAS.filter((e) => lista.includes(e.toLowerCase()));
}
