import "dotenv/config";
import "../core/google/globalOptions";
import { prepararColaPostgres } from "../core/gmail/colaStorage";
import { configuracionAuto } from "../core/gmail/automatico/model";
import { poolAuto, SCHEMA_AUTO } from "../core/gmail/automatico/postgres";

async function start(): Promise<void> {
  const config = configuracionAuto();
  if (process.env.WOBI_MAIL_DATABASE_URL) {
    await poolAuto().query(SCHEMA_AUTO);
    await prepararColaPostgres();
    console.log("[startup] Registro durable y cola de correo preparados.");
  } else if (config.modo !== "off") {
    throw new Error("WOBI_MAIL_DATABASE_URL es obligatoria antes de activar la revisión automática.");
  }
  await import("../src/server");
}

start().catch((error) => {
  console.error("[startup] No se pudo iniciar el servicio:", error instanceof Error ? error.message : "Error de arranque");
  process.exit(1);
});
