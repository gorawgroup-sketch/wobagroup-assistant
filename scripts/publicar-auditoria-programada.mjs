import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const archivo = process.argv[2];
if (!archivo) {
  console.error("Uso: node scripts/publicar-auditoria-programada.mjs <resultado.json>");
  process.exit(2);
}

const secret = process.env.ADMIN_SECRET;
if (!secret) {
  console.error("Falta ADMIN_SECRET en el entorno.");
  process.exit(2);
}

const ruta = resolve(archivo);
const crudo = await readFile(ruta, "utf8");
if (Buffer.byteLength(crudo, "utf8") > 64 * 1024) {
  console.error("El resultado supera el máximo de 64 KiB.");
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(crudo);
} catch {
  console.error("El archivo no contiene JSON válido.");
  process.exit(2);
}

const base = (process.env.WOBI_PUBLIC_BASE_URL || "https://copilot.wobagroup.com").replace(/\/$/, "");
const respuesta = await fetch(`${base}/webhook/auditoria-programada`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

if (!respuesta.ok) {
  const detalle = (await respuesta.text()).slice(0, 1_000);
  console.error(`No se pudo publicar la auditoría (${respuesta.status}): ${detalle}`);
  process.exit(1);
}

const resultado = await respuesta.json();
console.log(JSON.stringify({ ok: true, ejecucionId: resultado?.registro?.ejecucionId, estado: resultado?.registro?.estado }));
