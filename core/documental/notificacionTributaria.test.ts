import assert from "node:assert/strict";
import test from "node:test";
import { detectarNotificacionTributaria, pistaCarpetaNotificacionTributaria } from "./notificacionTributaria";

test("caso #7: la sanción tributaria de la AEAT (Art. 191 LGT) y la providencia de apremio son notificaciones, nunca gasto", () => {
  const sancion = detectarNotificacionTributaria({ proveedor: "Agencia Tributaria (AEAT)", concepto: "Sanción tributaria Art. 191 LGT, IS 2024", numero: "A2860025..." });
  assert.equal(sancion?.organismo, "AEAT"); assert.equal(sancion?.tipo, "sanción");
  const apremio = detectarNotificacionTributaria({ proveedor: "Agencia Tributaria", concepto: "Providencia de apremio IS 2024" });
  assert.equal(apremio?.tipo, "providencia de apremio");
  assert.match(pistaCarpetaNotificacionTributaria(sancion!, "137,62 EUR"), /NO un gasto ni una factura/);
});

test("el organismo como «proveedor» basta aunque el concepto sea genérico; un proveedor normal con la palabra requerimiento no", () => {
  assert.equal(detectarNotificacionTributaria({ proveedor: "Dependencia Regional de Recaudación Madrid", concepto: "Pago" })?.organismo, "AEAT");
  assert.equal(detectarNotificacionTributaria({ proveedor: "Tesorería General de la Seguridad Social", concepto: "Cuotas" })?.organismo, "TGSS");
  assert.equal(detectarNotificacionTributaria({ proveedor: "Ikea", concepto: "Requerimiento de material de oficina" }), undefined);
  assert.equal(detectarNotificacionTributaria({ proveedor: "Anthropic, PBC", concepto: "Créditos API" }), undefined);
});

test("una gestoría que menciona a Hacienda en el concepto sí es un gasto (no es el organismo ni un acto administrativo)", () => {
  assert.equal(detectarNotificacionTributaria({ proveedor: "Gestoría Pérez SL", concepto: "Honorarios presentación modelos Hacienda" }), undefined);
});
