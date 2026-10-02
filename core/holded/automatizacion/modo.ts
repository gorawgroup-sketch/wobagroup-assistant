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

/**
 * Lista de gastos aprobados por escrito: «Empresa:idHolded,Empresa:idHolded». Estricta: una entrada mal escrita se descarta
 * (nunca se interpreta «a lo que se parezca») y los duplicados se ignoran.
 */
export function parsearCasosAprobados(valor: string | undefined): Array<{ empresa: Empresa; id: string }> {
  const vistos = new Set<string>();
  const salida: Array<{ empresa: Empresa; id: string }> = [];
  for (const parte of (valor ?? "").split(",")) {
    const [nombre, id] = parte.trim().split(":").map((x) => x.trim());
    const empresa = EMPRESAS.find((e) => e.toLowerCase() === (nombre ?? "").toLowerCase());
    if (!empresa || !id || !/^[0-9a-f]{24}$/i.test(id) || vistos.has(`${empresa}:${id}`)) continue;
    vistos.add(`${empresa}:${id}`);
    salida.push({ empresa, id });
  }
  return salida;
}
