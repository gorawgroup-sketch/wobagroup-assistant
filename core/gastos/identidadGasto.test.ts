import assert from "node:assert/strict";
import test from "node:test";
import {
  claveIdempotenciaGasto,
  coincidenciaIdentidadGasto,
  esNumeroDocumentoIdentificable,
} from "./identidadGasto";

test("reconoce el mismo comprobante por huella aunque venga de otro correo", () => {
  assert.equal(
    coincidenciaIdentidadGasto(
      { huellaContenido: "ABC123", proveedor: "Otro texto" },
      { huellaContenido: "abc123", proveedor: "Uber B.V." }
    ),
    "mismo_archivo"
  );
});

test("reconoce el mismo número legal con proveedor equivalente", () => {
  assert.equal(
    coincidenciaIdentidadGasto(
      { numeroDocumento: "HCJCHBFC-03-2026-0001761", proveedor: "Uber B.V. (en nombre de Maria Fe Gil Garcia)", monto: 22.96, moneda: "EUR", fecha: "2026-09-08" },
      { numeroDocumento: "  hcjchbfc-03-2026-0001761 ", proveedor: "UBER B.V. en nombre de Maria Fe Gil Garcia", monto: 22.96, moneda: "eur", fecha: "2026-09-08" }
    ),
    "mismo_numero_y_proveedor"
  );
});

test("no bloquea por placeholders ni por números iguales de proveedores distintos", () => {
  assert.equal(esNumeroDocumentoIdentificable("00000"), false);
  assert.equal(
    coincidenciaIdentidadGasto(
      { numeroDocumento: "001", proveedor: "Restaurante Uno" },
      { numeroDocumento: "001", proveedor: "Taxi Dos" }
    ),
    undefined
  );
});

test("no bloquea dos gastos legítimos si cambia fecha, importe o moneda", () => {
  const registrado = { numeroDocumento: "001", proveedor: "Proveedor Legal", monto: 20, moneda: "EUR", fecha: "2026-09-08" };
  assert.equal(coincidenciaIdentidadGasto({ ...registrado, monto: 21 }, registrado), undefined);
  assert.equal(coincidenciaIdentidadGasto({ ...registrado, moneda: "USD" }, registrado), undefined);
  assert.equal(coincidenciaIdentidadGasto({ ...registrado, fecha: "2027-09-08" }, registrado), undefined);
});

test("la clave durable es estable entre propuestas del mismo documento", () => {
  const base = {
    empresa: "Footprint",
    contactId: "contacto-uber",
    numeroDocumento: "HCJCHBFC-03-2026-0001761",
    fecha: "2026-09-08",
  };
  assert.equal(
    claveIdempotenciaGasto({ ...base, propuestaId: "propuesta-a" }),
    claveIdempotenciaGasto({ ...base, propuestaId: "propuesta-b" })
  );
});

test("sin identidad documental mantiene idempotencia por propuesta", () => {
  const base = { empresa: "Footprint", contactId: "contacto", numeroDocumento: "00000" };
  assert.notEqual(
    claveIdempotenciaGasto({ ...base, propuestaId: "a" }),
    claveIdempotenciaGasto({ ...base, propuestaId: "b" })
  );
});
