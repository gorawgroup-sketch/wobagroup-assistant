import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

async function fuente(ruta: string): Promise<string> {
  return readFile(join(process.cwd(), ruta), "utf8");
}

test("ningún store con ownership de cola expira la decisión que mantiene el correo UNREAD", async () => {
  const [
    clasificacion,
    desambiguacion,
    contacto,
    conciliacion,
    conciliacionAmbigua,
    accionCorreo,
    orientacionCorreo,
    captura,
    propuestaGasto,
    gastoPendienteDatos,
  ] = await Promise.all([
    fuente("core/documental/classificationStore.ts"),
    fuente("core/documental/disambiguationStore.ts"),
    fuente("core/gastos/contactoResolucionStore.ts"),
    fuente("core/gastos/conciliacionPendienteStore.ts"),
    fuente("core/gastos/conciliacionAmbiguaPendienteStore.ts"),
    fuente("core/gmail/emailActionStore.ts"),
    fuente("core/gmail/emailOrientationStore.ts"),
    fuente("core/knowledge/pendienteCapturaEmpresaStore.ts"),
    fuente("core/gastos/gastoProposalSheet.ts"),
    fuente("core/gastos/gastoPendienteDatosStore.ts"),
  ]);

  assert.match(clasificacion, /!propuesta\.correoOrigen\?\.deColaCorreo && ahora - propuesta\.creadoEn > TTL_MS/);
  assert.match(desambiguacion, /!p\.correoOrigen\?\.deColaCorreo && Date\.now\(\) - p\.creadoEn > TTL_MS/);
  assert.match(contacto, /!resolucion\.propuesta\.deColaCorreo && ahora - resolucion\.creadoEn > TTL_MS/);
  assert.match(conciliacion, /!pendiente\.deColaCorreo && ahora - pendiente\.creadoEn > TTL_MS/);
  assert.match(conciliacionAmbigua, /f\.pendiente\.deColaCorreo \|\| ahora - f\.pendiente\.creadoEn <= TTL_MS/);
  assert.match(accionCorreo, /f\.propuesta\.deColaCorreo \|\| ahora - f\.propuesta\.creadoEn <= TTL_MS/);
  assert.match(orientacionCorreo, /f\.pendiente\.deColaCorreo \|\| ahora - f\.pendiente\.creadoEn <= TTL_MS/);
  assert.match(captura, /f\.pendiente\.deColaCorreo \|\|[\s\S]*f\.pendiente\.estado !== "pendiente"/);
  assert.match(propuestaGasto, /propuesta\.deColaCorreo !== true && ahora - propuesta\.creadoEn > TTL_MS/);
  assert.match(gastoPendienteDatos, /pendiente\.deColaCorreo !== true && ahora - pendiente\.creadoEn > TTL_MS/);
});
