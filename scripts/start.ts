import "dotenv/config";
import { configuracionAuto } from "../core/gmail/automatico/model";
import { poolAuto, SCHEMA_AUTO } from "../core/gmail/automatico/postgres";

async function start(): Promise<void> {
  const config = configuracionAuto();
  if (process.env.WOBI_MAIL_DATABASE_URL) {
    await poolAuto().query(SCHEMA_AUTO);
    console.log("[startup] Registro durable de correo preparado.");
  } else if (config.modo !== "off") {
    throw new Error("WOBI_MAIL_DATABASE_URL es obligatoria antes de activar la revisión automática.");
  }
  await import("../src/server");
}

start().catch((error) => {
  console.error("[startup] No se pudo iniciar el servicio:", error instanceof Error ? error.message : "Error de arranque");
  process.exit(1);
});
