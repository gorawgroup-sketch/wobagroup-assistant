import "dotenv/config";
import "../core/google/globalOptions";
import { prepararColaPostgres } from "../core/gmail/colaStorage";
import { configuracionAuto } from "../core/gmail/automatico/model";
import { poolAuto, SCHEMA_AUTO } from "../core/gmail/automatico/postgres";

const esperar = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Durante el solapamiento de un despliegue, el contenedor viejo puede estar usando estas tablas
 * (una revisión de correo en curso hasta que drena). Un lock_timeout (55P03) aquí no es un fallo
 * del servicio: es «el anterior aún no soltó»; se reintenta en vez de morir y dejar que Railway
 * reinicie a ciegas (caso real 2026-09-28: «canceling statement due to lock timeout» al arrancar).
 */
async function conReintentoPorLock<T>(nombre: string, tarea: () => Promise<T>): Promise<T> {
  const limite = Date.now() + 5 * 60_000;
  for (let intento = 1; ; intento++) {
    try {
      return await tarea();
    } catch (error) {
      const codigo = (error as { code?: unknown })?.code;
      if (codigo !== "55P03" || Date.now() >= limite) throw error;
      console.warn(`[startup] ${nombre}: la base sigue ocupada por el despliegue anterior (intento ${intento}); reintento en 10 s.`);
      await esperar(10_000);
    }
  }
}

async function start(): Promise<void> {
  const config = configuracionAuto();
  if (process.env.WOBI_MAIL_DATABASE_URL) {
    await conReintentoPorLock("esquema durable", () => poolAuto().query(SCHEMA_AUTO));
    await conReintentoPorLock("cola de correo", () => prepararColaPostgres());
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
