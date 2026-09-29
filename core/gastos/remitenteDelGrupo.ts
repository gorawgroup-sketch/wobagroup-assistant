/**
 * ¿El correo lo envió alguien del propio grupo?
 *
 * Caso real (2026-09-28, D1 SAS): el ticket de un compañero de viaje llegó por correo desde su cuenta
 * corporativa, pero el comprobante no llevaba su nombre y el extractor no identificó a la persona. Sin
 * persona, la señal de viaje de inferirCuentaGasto (persona + recibo simplificado) no se activó y la
 * cuenta la decidió una coincidencia de palabras. Que un ticket lo envíe un empleado desde su buzón
 * corporativo es un hecho comprobable sin IA: basta para tratarlo como gasto del equipo.
 *
 * Se mira SOLO la dirección real (entre <>), nunca el nombre visible, que es texto libre y falsificable
 * (mismo criterio que core/gmail/client.ts). Los dominios se leen del entorno en el momento de uso.
 */
// Solo dominios verificados en correos reales; los demás se añaden con WOBI_DOMINIOS_GRUPO.
const DOMINIOS_POR_DEFECTO = "wobagroup.com,footprint.global";

export function dominiosDelGrupo(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.WOBI_DOMINIOS_GRUPO?.trim() || DOMINIOS_POR_DEFECTO)
    .split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
}

export function esRemitenteDelGrupo(de: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!de) return false;
  const entreAngulos = de.match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1];
  const direccion = (entreAngulos ?? (/^[^\s<>"]+@[^\s<>"]+$/.test(de.trim()) ? de.trim() : "")).toLowerCase();
  const dominio = direccion.split("@")[1];
  if (!dominio) return false;
  return dominiosDelGrupo(env).some((d) => dominio === d);
}
