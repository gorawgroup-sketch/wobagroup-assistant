import test from "node:test";
import assert from "node:assert/strict";
import {
  ImpuestoSujetoPasivoNoDisponibleError,
  mapearImpuestoPrincipalATaxKey,
  mapearInversionSujetoPasivoATaxKey,
  mapearPorcentajeATaxKey,
  type TaxCatalogEntry,
} from "./write";

const CATALOGO_REAL_MINIMO: TaxCatalogEntry[] = [
  { key: "p_iva_21", name: "IVA 21%", amount: 21, type: "percentage", visible: true },
  { key: "p_iva_0", name: "IVA 0%", amount: 0, type: "percentage", visible: true },
  { key: "p_iva_exento", name: "Exento", amount: 0, type: "percentage", visible: true },
  { key: "p_iva_nosujeto", name: "No sujeto", amount: 0, type: "percentage", visible: true },
  {
    key: "p_iva_invsuj",
    name: "Inv. Suj. Pasivo",
    amount: null,
    type: "group",
    visible: true,
    items: ["p_iva_invsuj_1", "p_iva_invsuj_2"],
  },
  { key: "p_iva_invsuj_2", name: "Inv. Suj. Pasivo (-)", amount: 21, type: "percentage", visible: false },
  {
    key: "p_iva_bi_invsuj_0",
    name: "Adq. bienes de inversión ISP 0%",
    amount: 0,
    type: "percentage",
    visible: true,
  },
];

test("sujeto pasivo usa el grupo visible real, no IVA 0 ni un componente interno", () => {
  assert.equal(mapearInversionSujetoPasivoATaxKey(CATALOGO_REAL_MINIMO), "p_iva_invsuj");
  assert.equal(
    mapearImpuestoPrincipalATaxKey(CATALOGO_REAL_MINIMO, {
      tipoIvaPct: 0,
      tratamientoFiscal: "inversion_sujeto_pasivo",
    }),
    "p_iva_invsuj"
  );
});

test("una propuesta antigua a IVA 0 se migra de forma segura a sujeto pasivo", () => {
  assert.equal(
    mapearImpuestoPrincipalATaxKey(CATALOGO_REAL_MINIMO, { tipoIvaPct: 0 }),
    "p_iva_invsuj"
  );
});

test("el IVA español real conserva su código porcentual", () => {
  assert.equal(
    mapearImpuestoPrincipalATaxKey(CATALOGO_REAL_MINIMO, {
      tipoIvaPct: 21,
      tratamientoFiscal: "iva",
    }),
    "p_iva_21"
  );
  assert.equal(mapearPorcentajeATaxKey(CATALOGO_REAL_MINIMO, 21), "p_iva_21");
});

test("la búsqueda semántica solo acepta un grupo visible inequívoco", () => {
  const catalogoRenombrado = CATALOGO_REAL_MINIMO.map((t) =>
    t.key === "p_iva_invsuj"
      ? { ...t, key: "clave_configurada_por_holded", name: "Inversión sujeto pasivo" }
      : t
  );
  assert.equal(
    mapearInversionSujetoPasivoATaxKey(catalogoRenombrado),
    "clave_configurada_por_holded"
  );
});

test("si Holded no ofrece sujeto pasivo, bloquea antes de elegir un impuesto 0 arbitrario", () => {
  const sinSujetoPasivo = CATALOGO_REAL_MINIMO.filter(
    (t) => t.key !== "p_iva_invsuj" && t.key !== "p_iva_invsuj_2"
  );
  assert.throws(
    () => mapearImpuestoPrincipalATaxKey(sinSujetoPasivo, { tipoIvaPct: 0 }),
    ImpuestoSujetoPasivoNoDisponibleError
  );
});

