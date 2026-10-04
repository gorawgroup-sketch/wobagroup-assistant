import assert from "node:assert/strict";
import test from "node:test";
import { aliasARepuntar, aprenderProveedorCorregido, normalizarNombreProveedor } from "./cambioProveedorCompra";

const fila = (nombreDetectado: string, contactId: string, moneda = "USD", empresa = "Footprint") => ({ nombreDetectado, empresa, contactId, moneda });

test("normaliza como el almacén de alias: sin tildes, mayúsculas, puntos ni comas", () => {
  assert.equal(normalizarNombreProveedor("Management Group Investors, LLC"), "management group investors llc");
  assert.equal(normalizarNombreProveedor("  MANAGEMENT   Group Investors LLC."), "management group investors llc");
});

test("re-apunta solo los alias del contacto VIEJO con el nombre leído o el nuevo, de la misma empresa", () => {
  const filas = [
    fila("Management Group Investors, LLC", "viejo"),            // el equivocado → sí
    fila("management group investors llc", "viejo", ""),         // sin moneda → sí
    fila("Management Group Investors, LLC", "otro"),             // apunta a otro contacto → no
    fila("Madrid Hotel 101", "viejo"),                           // otro texto → no
    fila("Management Group Investors, LLC", "viejo", "USD", "WOBA"), // otra empresa → no
  ];
  const r = aliasARepuntar(filas, { empresa: "Footprint", contactoViejoId: "viejo", nombresLeidos: ["Management Group Investors, LLC", "Management Group Investors LLC"] });
  assert.deepEqual(r.map((x) => x.moneda), ["USD", ""]);
});

test("aprendizaje: corrige los alias equivocados y, si no había ninguno, enseña el correcto", async () => {
  const registrados: unknown[][] = [];
  const registrar = async (...a: unknown[]) => { registrados.push(a); };
  const datos = { empresa: "Footprint" as const, contactoViejoId: "viejo", nombreLeido: "Management Group Investors, LLC", nombreNuevo: "Management Group Investors LLC", contactoNuevoId: "nuevo", contactoNuevoNombre: "Management Group Investors LLC", moneda: "USD" };
  const conAlias = await aprenderProveedorCorregido(datos, { listar: async () => [{ rowIndex: 2, vecesConfirmado: 1, contactName: "x", ...fila("Management Group Investors, LLC", "viejo") }], registrar: registrar as never });
  assert.deepEqual(conAlias, { repuntados: 1, creado: false });
  assert.deepEqual(registrados[0], ["Footprint", "Management Group Investors, LLC", "nuevo", "Management Group Investors LLC", "USD"]);
  registrados.length = 0;
  const sinAlias = await aprenderProveedorCorregido(datos, { listar: async () => [], registrar: registrar as never });
  assert.deepEqual(sinAlias, { repuntados: 0, creado: true });
  assert.deepEqual(registrados[0], ["Footprint", "Management Group Investors, LLC", "nuevo", "Management Group Investors LLC", "USD"]);
});
