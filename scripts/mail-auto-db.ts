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
    const r = await poolAuto().query("SELECT state,count(*)::int AS operaciones FROM wobi_mail_operations WHERE mailbox=$1 GROUP BY state ORDER BY state", [config.buzon]);
    console.log(JSON.stringify({ modo: config.modo, empresas: config.empresas, operaciones: r.rows }, null, 2));
  } else throw new Error("Uso: mail-auto-db.ts setup|status");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Error de configuración"); process.exitCode = 1; })
  .finally(cerrarPoolAuto);
