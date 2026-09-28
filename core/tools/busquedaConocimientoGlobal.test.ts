import assert from "node:assert/strict";
import test from "node:test";
import {
  ordenarResultadosDriveGlobal,
  puntuarResultadoDriveGlobal,
  seleccionarResultadosDriveGlobal,
} from "./busquedaConocimientoGlobal";
import type { DriveSearchResultGlobal } from "../drive/client";

const base: Omit<DriveSearchResultGlobal, "id" | "name"> = {
  empresa: "WOBA",
  folderPath: "ALEJANDRA WOBA",
  friendlyType: "Google Doc",
  webViewLink: "https://docs.google.com/example",
  mimeType: "application/vnd.google-apps.document",
};

test("prioriza el documento de responsabilidades para facturación y destinatarios", () => {
  const responsabilidades = { ...base, id: "1", name: "RESUMEN RESPONSABILIDADES" };
  const facturas = { ...base, id: "2", name: "FACTURAS PENDIENTES" };
  const consulta = "a quién enviamos las facturas de Elsamex";
  assert.ok(
    puntuarResultadoDriveGlobal(responsabilidades, consulta) > puntuarResultadoDriveGlobal(facturas, consulta)
  );
  assert.equal(ordenarResultadosDriveGlobal([facturas, responsabilidades], consulta)[0].id, "1");
  assert.deepEqual(
    seleccionarResultadosDriveGlobal([facturas, responsabilidades], consulta).map((r) => r.id),
    ["1"]
  );
});

test("los Google Docs nativos reciben prioridad de lectura determinista", () => {
  const googleDoc = { ...base, id: "1", name: "Elsamex" };
  const imagen = { ...base, id: "2", name: "Elsamex", mimeType: "image/png", friendlyType: "Imagen PNG" };
  assert.ok(puntuarResultadoDriveGlobal(googleDoc, "Elsamex") > puntuarResultadoDriveGlobal(imagen, "Elsamex"));
});
