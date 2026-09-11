import assert from "node:assert/strict";
import test from "node:test";
import { esReferenciaCorreoConcreta } from "./referenciaCorreo";

test("rechaza referencias vagas que deben ir por la cola de no leídos", () => {
  for (const texto of [
    "el correo",
    "el primer correo",
    "el último mail",
    "revisa los correos de hoy",
    "reprocesa la factura anterior",
    "el correo del proveedor",
  ]) {
    assert.equal(esReferenciaCorreoConcreta(texto), false, texto);
  }
});

test("acepta remitente, asunto o detalle distintivo para buscar también en leídos", () => {
  for (const texto of ["Hippopotamus", "subject:C1-083249", "from:proveedor@empresa.com", "factura 1313 Business Atelier"]) {
    assert.equal(esReferenciaCorreoConcreta(texto), true, texto);
  }
});
