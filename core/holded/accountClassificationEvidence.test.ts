import assert from "node:assert/strict";
import test from "node:test";
import {
  combinarTagsGastoAprendidos,
  construirSugerenciaDesdeCoincidencias,
  esImporteUtilComoPrecedenteContable,
  filtrarPrecedentesViajePorNaturaleza,
  inferirTagsCategoria,
  normalizarEtiquetaHolded,
  seleccionarCoincidenciasProveedor,
  type LineaConCuenta,
} from "./write";

function linea(documentId: string, account: string, lineName = "Anthropic"): LineaConCuenta {
  return {
    documentId,
    contactName: "Anthropic, PBC",
    descripcion: "Suscripción Claude",
    lineName,
    account,
    tags: ["suscripcion"],
  };
}

test("los cargos residuales no se usan como precedente contable", () => {
  assert.equal(esImporteUtilComoPrecedenteContable(0.02), false);
  assert.equal(esImporteUtilComoPrecedenteContable(-0.99), false);
  assert.equal(esImporteUtilComoPrecedenteContable(0.5, "MICRO-001"), true);
  assert.equal(esImporteUtilComoPrecedenteContable(1), true);
  assert.equal(esImporteUtilComoPrecedenteContable(18), true);
  assert.equal(esImporteUtilComoPrecedenteContable(Number.NaN), true);
});

test("elige la cuenta respaldada por más documentos independientes", () => {
  const sugerencia = construirSugerenciaDesdeCoincidencias(
    [
      linea("correcto-1", "cuenta-suscripciones"),
      linea("correcto-1", "cuenta-suscripciones", "Segunda línea del mismo documento"),
      linea("correcto-2", "cuenta-suscripciones"),
      linea("incorrecto-1", "diferencias-cambio"),
    ],
    "proveedor"
  );

  assert.equal(sugerencia?.accountId, "cuenta-suscripciones");
});

test("un empate contable se declara inconcluso en vez de depender de la paginación", () => {
  const sugerencia = construirSugerenciaDesdeCoincidencias(
    [linea("uno", "diferencias-cambio"), linea("dos", "cuenta-suscripciones")],
    "proveedor"
  );

  assert.equal(sugerencia, undefined);
});

test("un taxi no toma hoteles u otros viajes como precedente contable", () => {
  const bogotaTaxi: LineaConCuenta = {
    ...linea("taxi-bogota", "gastos-viaje", "Uber Bogotá — Alejandro Florez"),
    contactName: "Uber Colombia",
    descripcion: "Traslado Chapinero, Bogotá",
    tags: ["taxi", "transporte", "alejandroflorez"],
  };
  const hotelMadrid: LineaConCuenta = {
    ...linea("hotel-madrid", "gastos-viaje", "Hotel Madrid — Nuria Ortiz"),
    contactName: "Hotel Madrid",
    descripcion: "Alojamiento Madrid",
    tags: ["hospedaje", "nuriaortiz"],
  };
  const taxiBarcelona: LineaConCuenta = {
    ...linea("taxi-barcelona", "gastos-viaje", "Bolt Barcelona — Nuria Ortiz"),
    contactName: "Bolt",
    descripcion: "Traslado Barcelona",
    tags: ["taxi", "transporte", "nuriaortiz"],
  };

  assert.deepEqual(
    filtrarPrecedentesViajePorNaturaleza([bogotaTaxi, hotelMadrid, taxiBarcelona], ["transporte", "taxi"])
      .map((precedente) => precedente.documentId),
    ["taxi-bogota", "taxi-barcelona"]
  );
});

test("la referencia visible de viaje prefiere misma persona o ubicación y nunca inventa una", () => {
  const sugerencia = construirSugerenciaDesdeCoincidencias(
    [
      {
        ...linea("bogota", "gastos-viaje", "Uber Bogotá — Alejandro Florez"),
        contactName: "Uber Colombia",
        descripcion: "Traslado Chapinero, Bogotá",
        tags: ["taxi", "transporte", "alejandroflorez"],
      },
      {
        ...linea("barcelona", "gastos-viaje", "Bolt Barcelona — Nuria Ortiz"),
        contactName: "Bolt",
        descripcion: "Traslado Barcelona",
        tags: ["taxi", "transporte", "nuriaortiz"],
      },
    ],
    "viaje",
    2,
    {
      proveedor: "Bolt",
      concepto: "Taxi en Barcelona para reuniones",
      personaAsociada: "Nuria Ortiz",
      exigirContexto: true,
    }
  );

  assert.equal(sugerencia?.accountId, "gastos-viaje");
  assert.equal(sugerencia?.ejemplo, "Bolt Barcelona — Nuria Ortiz");
  assert.deepEqual(sugerencia?.contextoEjemplo, ["persona", "ubicacion"]);
  assert.equal(sugerencia?.evidencias, 2);

  const sinContexto = construirSugerenciaDesdeCoincidencias(
    [
      { ...linea("bogota-1", "gastos-viaje", "Uber Bogotá — Alejandro Florez"), descripcion: "Chapinero Bogotá" },
      { ...linea("bogota-2", "gastos-viaje", "Uber Bogotá — Alejandro Florez"), descripcion: "Chapinero Bogotá" },
    ],
    "viaje",
    2,
    { proveedor: "Bolt", concepto: "Taxi Barcelona", personaAsociada: "Nuria Ortiz", exigirContexto: true }
  );
  assert.equal(sinContexto?.ejemplo, "");
  assert.deepEqual(sinContexto?.contextoEjemplo, undefined);
});

test("reconoce una compra de créditos de Anthropic como suscripción", () => {
  assert.deepEqual(
    inferirTagsCategoria("Compra de créditos (one-time credit purchase) — septiembre 2026", "Anthropic, PBC"),
    ["suscripcion"]
  );
});

test("reconoce la terminología real de los billetes aéreos", () => {
  assert.deepEqual(
    inferirTagsCategoria("Tiquete aéreo Norwegian DY1719 Madrid a Oslo", "Norwegian Air Shuttle AOC AS"),
    ["transporte", "avion"]
  );
  assert.deepEqual(
    inferirTagsCategoria("Airline ticket Bogotá Medellín", "Kiwi.com s.r.o."),
    ["transporte", "avion"]
  );
});

test("el flujo compartido conserva los aprendizajes de tags del proceso uno a uno", () => {
  assert.deepEqual(
    combinarTagsGastoAprendidos("Tiquete aéreo", "Kiwi.com", "Nuria Ortiz", ["alojamiento", "kelly"]),
    ["Nuria Ortiz", "transporte", "avion"]
  );
  assert.deepEqual(
    combinarTagsGastoAprendidos("Hotel", "Scandic", undefined, ["alojamiento", "jorge"]),
    ["jorge", "hospedaje"]
  );
  assert.deepEqual(
    combinarTagsGastoAprendidos(
      "Compra supermercado Ahorramas",
      "AHORRAMAS",
      "Simon Talloen",
      ["alimentacion", "hospedaje", "simon", "simontalloen"]
    ),
    ["Simon Talloen", "alimentacion"]
  );
  assert.deepEqual(
    combinarTagsGastoAprendidos(
      "Compra supermercado Ahorramas",
      "AHORRAMAS",
      undefined,
      ["alimentacion", "hospedaje", "simon", "simontalloen"]
    ),
    ["simontalloen", "alimentacion"]
  );
  assert.deepEqual(
    combinarTagsGastoAprendidos("Consumo Nieuwe Veste", "Nieuwe Veste", undefined, ["alimentacion", "simontalloen"]),
    ["simontalloen", "alimentacion"]
  );
  assert.deepEqual(
    combinarTagsGastoAprendidos("Consumo", "Proveedor", undefined, ["alimentacion", "hospedaje", "simontalloen"]),
    ["simontalloen"]
  );
  assert.deepEqual(
    combinarTagsGastoAprendidos(
      "Compra supermercado ALDI",
      "ALDI",
      undefined,
      ["alimentacion", "latam", "simontalloen"]
    ),
    ["simontalloen", "alimentacion"]
  );
  assert.deepEqual(
    combinarTagsGastoAprendidos("Material de oficina", "Proveedor", undefined, ["oficina", "latam", "alejandra"]),
    ["alejandra"]
  );
  assert.deepEqual(
    combinarTagsGastoAprendidos(
      "Café/postre — Nieuwe Veste, Breda — Simon Talloen — pagado con Visa",
      "Nieuwe Veste",
      undefined,
      ["alimentacion"]
    ),
    ["simontalloen", "alimentacion"]
  );
  assert.deepEqual(
    combinarTagsGastoAprendidos(
      "Compra supermercado Ahorramas",
      "AHORRAMAS",
      undefined,
      ["hospedaje", "simontalloen"],
      "Viaje de Simon Talloen · alojamiento en Madrid"
    ),
    ["simontalloen", "alimentacion"]
  );
  assert.deepEqual(
    combinarTagsGastoAprendidos(
      "Consumo Nieuwe Veste",
      "Nieuwe Veste",
      undefined,
      ["alimentacion"],
      "Ticket de Simon Talloen durante el viaje"
    ),
    ["simontalloen", "alimentacion"]
  );
});

test("normaliza los tags como los hashtags visibles de Holded", () => {
  assert.equal(normalizarEtiquetaHolded("Núria Ortiz"), "nuriaortiz");
  assert.equal(normalizarEtiquetaHolded("wobi-ticket-pendiente"), "wobiticketpendiente");
});

test("una razón social exacta nunca se mezcla con otra sociedad de nombre parecido", () => {
  const lineas: LineaConCuenta[] = [
    { ...linea("llc-1", "profesionales"), contactName: "BUSINESS ATELIER LLC", lineName: "Consulting Service" },
    { ...linea("llc-2", "profesionales"), contactName: "BUSINESS ATELIER LLC", lineName: "Sent Money" },
    { ...linea("llc-error", "woba-services"), contactName: "BUSINESS ATELIER LLC", lineName: "Consulting Service" },
    ...Array.from({ length: 12 }, (_, indice) => ({
      ...linea(`europa-${indice}`, "woba-services"),
      contactName: "Business Atelier Europa SL (WOBA GROUP)",
      lineName: "Servicios contables y financieros",
    })),
  ];

  const seleccion = seleccionarCoincidenciasProveedor("BUSINESS ATELIER LLC (KMINO)", lineas);
  const sugerencia = construirSugerenciaDesdeCoincidencias(seleccion.coincidencias, "proveedor");
  assert.equal(seleccion.identidadExacta, true);
  assert.equal(seleccion.coincidencias.length, 3);
  assert.equal(sugerencia?.accountId, "profesionales");
});

test("un empate de la entidad exacta queda inconcluso y no usa empresas parecidas", () => {
  const lineas: LineaConCuenta[] = [
    { ...linea("llc-1", "profesionales"), contactName: "BUSINESS ATELIER LLC" },
    { ...linea("llc-2", "woba-services"), contactName: "BUSINESS ATELIER LLC" },
    ...Array.from({ length: 8 }, (_, indice) => ({
      ...linea(`europa-${indice}`, "woba-services"),
      contactName: "Business Atelier Europa SL (WOBA GROUP)",
    })),
  ];

  const seleccion = seleccionarCoincidenciasProveedor("BUSINESS ATELIER LLC", lineas);
  assert.equal(seleccion.identidadExacta, true);
  assert.equal(construirSugerenciaDesdeCoincidencias(seleccion.coincidencias, "proveedor"), undefined);
});
