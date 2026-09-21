import test from "node:test";
import assert from "node:assert/strict";
import type { DatosFactura } from "../documental/extractInvoiceData";
import { reconstruirGastoDesdeAsuntoPago, resolverProveedorRealDesdeMovimiento } from "./reprocesarResolucionProveedor";

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
  const proveedor = await resolverProveedorRealDesdeMovimiento(
    datos,
    "Footprint",
    async (_empresa, c) => {
      criterios = c;
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

test("reconstruye importes objetivos de un comprobante de pago aunque el PDF no nombre al comercio", () => {
  const reconstruido = reconstruirGastoDesdeAsuntoPago(
    "Fwd: 192.28EUR | 690.267COP - Vuelos viaje a Bogotá Alejandro Flórez",
    "---------- Forwarded message ---------\nFrom: Alejandro Florez <alejandro@footprint.global>\n",
    "Thu, Sep 17, 2026 at 3:26 AM",
    { ...datos, esFacturaOGasto: false, monto: 0, moneda: "", montoEquivalente: undefined, monedaEquivalente: undefined }
  );

  assert.equal(reconstruido?.monto, 690267);
  assert.equal(reconstruido?.moneda, "COP");
  assert.equal(reconstruido?.montoEquivalente, 192.28);
  assert.equal(reconstruido?.monedaEquivalente, "EUR");
  assert.equal(reconstruido?.personaAsociada, "Alejandro Florez");
  assert.equal(reconstruido?.contextoDeViaje, true);
  assert.equal(reconstruido?.fecha, "2026-09-17");
  assert.match(reconstruido?.concepto ?? "", /Vuelos viaje a Bogotá/);
});
