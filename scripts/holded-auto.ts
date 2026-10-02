import "dotenv/config";
import { cerrarPoolAuto, poolAuto } from "../core/gmail/automatico/postgres";
import { empresasAutomatizacion, modoAutomatizacion } from "../core/holded/automatizacion/modo";
import { inventarioCandidatos } from "../core/holded/automatizacion/tickets";
import type { Empresa } from "../core/holded/client";

/**
 * Consulta de las automatizaciones de Holded (solo lectura).
 *   status                         modos, alcance y conteo de trabajos por tipo/estado + últimos incidentes
 *   inventario <empresa> <desde> <hasta>   candidatos a ticket entre dos fechas YYYY-MM-DD (no convierte nada)
 */
async function main(): Promise<void> {
  const [accion, empresa, desde, hasta] = process.argv.slice(2);
  if (accion === "status") {
    const [conteo, incidentes] = await Promise.all([
      poolAuto().query("SELECT kind,state,count(*)::int AS n FROM wobi_holded_jobs GROUP BY kind,state ORDER BY kind,state"),
      poolAuto().query("SELECT key,state,data->>'ultimoError' AS error,updated_at FROM wobi_holded_jobs WHERE state IN ('fallido','requiere_intervencion','no_confirmado') ORDER BY updated_at DESC LIMIT 20"),
    ]);
    console.log(JSON.stringify({
      sincronizacionBancaria: { modo: modoAutomatizacion("SYNC_BANCARIA"), empresas: empresasAutomatizacion("SYNC_BANCARIA") },
      tickets: { modo: modoAutomatizacion("TICKETS"), empresas: empresasAutomatizacion("TICKETS") },
      trabajos: conteo.rows, incidentes: incidentes.rows,
    }, null, 2));
  } else if (accion === "inventario" && empresa && desde && hasta) {
    const lista = await inventarioCandidatos(empresa as Empresa, desde, hasta);
    console.log(JSON.stringify({ total: lista.length, probables: lista.filter((c) => c.nivel === "probable") }, null, 2));
  } else throw new Error("Uso: holded-auto.ts status | inventario <WOBA|EWORKS|Footprint> <desde> <hasta>");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "Error"); process.exitCode = 1; }).finally(cerrarPoolAuto);
