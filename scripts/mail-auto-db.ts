import "dotenv/config";
import { SCHEMA_AUTO, poolAuto, cerrarPoolAuto } from "../core/gmail/automatico/postgres";
import { configuracionAuto } from "../core/gmail/automatico/model";

async function main(): Promise<void> {
  const accion = process.argv[2];
  if (accion === "setup") {
    await poolAuto().query(SCHEMA_AUTO);
    console.log("Registro de correo preparado. No se cambió el modo ni se ejecutó ninguna operación en Gmail/Holded.");
  } else if (accion === "status") {
    const config = configuracionAuto();
    const [operaciones, eventos, ultima, analisis] = await Promise.all([
      poolAuto().query("SELECT state,count(*)::int AS operaciones FROM wobi_mail_operations WHERE mailbox=$1 GROUP BY state ORDER BY state", [config.buzon]),
      poolAuto().query("SELECT kind,count(*)::int AS eventos FROM wobi_mail_events WHERE mailbox=$1 GROUP BY kind ORDER BY kind", [config.buzon]),
      poolAuto().query("SELECT data,created_at FROM wobi_mail_events WHERE mailbox=$1 AND kind='revision_terminada' ORDER BY id DESC LIMIT 1", [config.buzon]),
      poolAuto().query("SELECT count(*)::int AS total FROM wobi_mail_analyses WHERE mailbox=$1", [config.buzon]),
    ]);
    const resultado = ultima.rows[0]?.data as Record<string, unknown> | undefined;
    console.log(JSON.stringify({ modo: config.modo, empresas: config.empresas, analisisGuardados: analisis.rows[0]?.total ?? 0,
      operaciones: operaciones.rows,
      eventos: eventos.rows, ultimaRevision: resultado ? { fecha: ultima.rows[0].created_at,
        modo: resultado.modo, revisados: resultado.revisados, completados: resultado.completados,
        simulados: resultado.simulados, pendientes: Array.isArray(resultado.pendientes) ? resultado.pendientes.length : undefined,
        gastos: Array.isArray(resultado.gastos) ? resultado.gastos.length : undefined } : null }, null, 2));
  } else throw new Error("Uso: mail-auto-db.ts setup|status");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Error de configuración"); process.exitCode = 1; })
  .finally(cerrarPoolAuto);
