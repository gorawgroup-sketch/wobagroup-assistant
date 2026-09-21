import test from "node:test";
import assert from "node:assert/strict";
import type { DatosFactura } from "../documental/extractInvoiceData";
import { resolverProveedorRealDesdeMovimiento } from "./reprocesarResolucionProveedor";

const datos: DatosFactura = {
  esFacturaOGasto: true,
  proveedor: "Aerolínea no identificada en el documento",
  monto: 690267,
  moneda: "COP",
  montoEquivalente: 192.28,
  monedaEquivalente: "EUR",
  fecha: "2026-09-16",
  concepto: "Vuelos viaje a Bogotá",
  reciboSimplificado: true,
  lineas: [{ concepto: "Vuelos", base: 690267, tipoIvaPct: 0 }],
  empresaProbable: "Footprint",
  confianza: "alta",
  razon: "Comprobante bancario",
};

test("recupera el proveedor desde un único movimiento bancario exacto", async () => {
  let criterios: unknown;
  let tolerancia: number | undefined;
  const proveedor = await resolverProveedorRealDesdeMovimiento(
    datos,
    "Footprint",
    async (_empresa, c, t) => {
      criterios = c;
      tolerancia = t;
      return [{
        accountId: "cuenta",
        movementId: "movimiento",
        descripcion: "Jetsmart Airlines Sas",
        monto: -192.28,
        moneda: "EUR",
        fecha: "2026-09-17",
      }];
    }
  );

  assert.equal(proveedor, "Jetsmart Airlines Sas");
  assert.deepEqual(criterios, { monto: 192.28, moneda: "EUR", fecha: "2026-09-16" });
  assert.equal(tolerancia, 3.8456);
});

test("no inventa proveedor cuando el movimiento exacto no es único", async () => {
  await assert.rejects(
    resolverProveedorRealDesdeMovimiento(datos, "Footprint", async () => [
      { accountId: "a", movementId: "1", descripcion: "Jetsmart", monto: -192.28, moneda: "EUR", fecha: "2026-09-17" },
      { accountId: "b", movementId: "2", descripcion: "Avianca", monto: -192.28, moneda: "EUR", fecha: "2026-09-17" },
    ]),
    /hay 2 movimientos\/proveedores posibles/
  );
});
