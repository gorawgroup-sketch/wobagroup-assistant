/**
 * Observación de transferencias internas y conversiones entre cuentas de la misma empresa.
 * SOLO LECTURA: cualquier petición a Holded que no sea GET aborta el script antes de salir de la máquina.
 *
 *   npx tsx scripts/holded-transferencias.ts [dias]      (por defecto, los últimos 40 días)
 */
import "dotenv/config";
import { detectarTransferenciasDeEmpresa } from "../core/holded/transferencias/lectura";
import { informeObservacion } from "../core/holded/transferencias/informe";

const fetchOriginal = globalThis.fetch;
let lecturas = 0;
globalThis.fetch = (async (entrada: Parameters<typeof fetch>[0], opciones?: Parameters<typeof fetch>[1]) => {
  const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
  const metodo = (opciones?.method ?? (typeof entrada === "object" && "method" in entrada ? entrada.method : "GET")).toUpperCase();
  if (url.includes("holded.com")) {
    if (metodo !== "GET") throw new Error(`Escritura bloqueada en modo observación: ${metodo} ${url.split("?")[0]}`);
    lecturas++;
  }
  return fetchOriginal(entrada, opciones);
}) as typeof fetch;

async function main() {
  const dias = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 40;
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);
  const resultados = [];
  for (const empresa of ["WOBA", "EWORKS", "Footprint"] as const) resultados.push(await detectarTransferenciasDeEmpresa(empresa, desde, hoy, hoy));
  console.log(informeObservacion(resultados));
  console.log(`\nPeriodo ${desde} a ${hoy}. Peticiones a Holded: ${lecturas} lecturas (GET), 0 escrituras.`);
}
main().then(() => process.exit(0)).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
