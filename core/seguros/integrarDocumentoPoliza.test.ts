import assert from "node:assert/strict";
import test from "node:test";
import { buscarPolizaDelDocumento, idDocumentoPoliza, integrarDocumentoPoliza, normalizarNumeroPoliza, numeroDePolizaEnNombre } from "./integrarDocumentoPoliza";
import { interpretarReportePoliza, type DatosDocumentoPoliza } from "./extraerDatosPoliza";
import type { DocumentoPoliza } from "./documentosPolizaStore";
import { esDocumentoParaWobiSeguros } from "../documental/archiveFile";

// Filas reales del registro de pólizas de WOBA (2026-10-01), tal como están escritas.
const registro = [
  { id: "woba_rc_markel", empresa: "WOBA", tipoCobertura: "Responsabilidad civil general", numeroPoliza: "023S00453RCG", estado: "vigente" as const },
  { id: "woba_showroom_allianz", empresa: "WOBA", tipoCobertura: "Todo riesgo showroom", numeroPoliza: "054239034", estado: "vencida" as const },
  { id: "woba_showroom_complemento_2026_2027", empresa: "WOBA", tipoCobertura: "Todo riesgo showroom — complemento", numeroPoliza: "054239034 (Suplemento nº 2 / 54239034.2) — Pyme 2038", estado: "vigente" as const },
  { id: "woba_accidentes_empleados", empresa: "WOBA", tipoCobertura: "Accidentes de empleados", numeroPoliza: "", estado: "no_contratada" as const },
  { id: "woba_rc_suplemento_3_3", empresa: "WOBA", tipoCobertura: "RC — suplemento", numeroPoliza: "023S00453RCG (Suplemento 3.3)", estado: "vigente" as const },
  { id: "woba_showroom_2026_2027", empresa: "WOBA", tipoCobertura: "Todo riesgo showroom — renovación", numeroPoliza: "054239034 (S4239034 en el listado oficial de Acodrid)", estado: "vigente" as const },
];

test("el número de póliza se compara sin ceros a la izquierda ni separadores", () => {
  assert.equal(normalizarNumeroPoliza("054239034"), normalizarNumeroPoliza("54239034"));
  assert.equal(normalizarNumeroPoliza("023-S00453 RCG"), "23S00453RCG");
});

test("un suplemento se enlaza con la fila de ESE suplemento (caso real: 054239034.2 de Allianz)", () => {
  assert.equal(buscarPolizaDelDocumento(registro, "54239034", "2")?.id, "woba_showroom_complemento_2026_2027");
  assert.equal(buscarPolizaDelDocumento(registro, "023S00453RCG", "3.3")?.id, "woba_rc_suplemento_3_3");
});

test("sin suplemento (o con uno que el registro no tiene) se enlaza con la póliza vigente, no con sus suplementos", () => {
  assert.equal(buscarPolizaDelDocumento(registro, "023S00453RCG", "")?.id, "woba_rc_markel");
  assert.equal(buscarPolizaDelDocumento(registro, "054239034", "")?.id, "woba_showroom_2026_2027");
  assert.equal(buscarPolizaDelDocumento(registro, "054239034", "7")?.id, "woba_showroom_2026_2027");
  // El suplemento «3» no es el «3.3».
  assert.equal(buscarPolizaDelDocumento(registro, "023S00453RCG", "3")?.id, "woba_rc_markel");
});

test("un número que no está en el registro, o demasiado corto, no se enlaza con nada", () => {
  assert.equal(buscarPolizaDelDocumento(registro, "999S00001XYZ", ""), undefined);
  assert.equal(buscarPolizaDelDocumento(registro, "", ""), undefined);
});

const datos = (extra: Partial<DatosDocumentoPoliza> = {}): DatosDocumentoPoliza => ({
  esDocumentoPoliza: true, tipoDocumento: "suplemento", numeroPoliza: "054239034", suplemento: "2",
  aseguradora: "Allianz", correduria: "Acodrid", tomador: "Business Atelier Europa SL", empresa: "WOBA",
  tipoCobertura: "Multirriesgo showroom", capitalAsegurado: "", franquicia: "", prima: "289,14", moneda: "EUR",
  vigenciaInicio: "2026-09-10", vigenciaFin: "2027-08-31", fechaDocumento: "2026-09-19", resumen: "Amplía la actividad asegurada.",
  ...extra,
});

function entorno(reporte: DatosDocumentoPoliza, existentes: DocumentoPoliza[] = []) {
  const guardados: DocumentoPoliza[] = [];
  return {
    guardados,
    deps: {
      extraer: async () => reporte,
      polizas: async () => registro as never,
      documentos: async () => [...existentes, ...guardados],
      registrar: async (d: DocumentoPoliza) => { guardados.push(d); },
      ahora: () => new Date("2026-10-01T12:00:00Z"),
    },
  };
}
const entrada = { rutaLocal: "/tmp/x.pdf", mimeType: "application/pdf", nombreArchivo: "054239034.2 (SUPLEMENTO).pdf", enlaceDrive: "https://drive/x", origen: "Correo de Acodrid." };

test("un documento de póliza archivado queda en el conocimiento de Wobi Seguros, enlazado a su póliza", async () => {
  const e = entorno(datos());
  const r = await integrarDocumentoPoliza(entrada, e.deps);
  assert.equal(r.estado, "integrado");
  assert.equal(e.guardados.length, 1);
  assert.equal(e.guardados[0].polizaId, "woba_showroom_complemento_2026_2027");
  assert.equal(e.guardados[0].empresa, "WOBA");
  assert.equal(e.guardados[0].enlaceDrive, "https://drive/x");
  assert.match(e.guardados[0].resumen, /Tomador: Business Atelier Europa SL.*Amplía la actividad asegurada/);
  assert.match(r.mensaje, /Wobi Seguros lo leyó y lo integró.*póliza 054239034 \(suplemento 2\)/);
});

test("integrar dos veces el mismo documento no lo duplica", async () => {
  const e = entorno(datos());
  await integrarDocumentoPoliza(entrada, e.deps);
  const r = await integrarDocumentoPoliza(entrada, e.deps);
  assert.equal(r.estado, "ya_integrado");
  assert.equal(e.guardados.length, 1);
  assert.equal(idDocumentoPoliza(datos(), "a.pdf"), idDocumentoPoliza(datos({ numeroPoliza: "54239034" }), "otro nombre.pdf"));
});

test("si al leerlo no es una póliza, no se guarda nada", async () => {
  const e = entorno(datos({ esDocumentoPoliza: false }));
  const r = await integrarDocumentoPoliza(entrada, e.deps);
  assert.equal(r.estado, "no_es_poliza");
  assert.equal(e.guardados.length, 0);
});

test("una póliza que no está en el registro se guarda como documento suelto y se dice", async () => {
  const e = entorno(datos({ numeroPoliza: "777X00001", suplemento: "", empresa: "Footprint" }));
  const r = await integrarDocumentoPoliza(entrada, e.deps);
  assert.equal(e.guardados[0].polizaId, "");
  assert.equal(e.guardados[0].empresa, "Footprint");
  assert.match(r.mensaje, /no está en el registro de pólizas/);
});

test("lo que reporta el lector se interpreta sin inventar: campos ausentes quedan vacíos y la empresa desconocida no se adivina", () => {
  const r = interpretarReportePoliza({ es_documento_poliza: true, numero_poliza: " 023S00453RCG ", empresa: "Otra SL", moneda: "eur", resumen: "x" });
  assert.equal(r.esDocumentoPoliza, true);
  assert.equal(r.numeroPoliza, "023S00453RCG");
  assert.equal(r.empresa, "desconocida");
  assert.equal(r.moneda, "EUR");
  assert.equal(r.prima, "");
});

test("Wobi Seguros lee lo que va a la carpeta de seguros o lo que el lector marcó como póliza", () => {
  const clasificacion = (carpetaSugerida: string, esDocumentoPoliza?: boolean) => ({ clasificacion: { carpetaSugerida, esDocumentoPoliza } as never });
  assert.equal(esDocumentoParaWobiSeguros(clasificacion("SEGUROS📜 / EUROPA / SEGURO WOBA 2026")), true);
  assert.equal(esDocumentoParaWobiSeguros(clasificacion("EUROPA"), "SEGURO / POLIZA"), true);
  assert.equal(esDocumentoParaWobiSeguros(clasificacion("Contratos", true)), true);
  assert.equal(esDocumentoParaWobiSeguros(clasificacion("Facturas 2026")), false);
  assert.equal(esDocumentoParaWobiSeguros(clasificacion("RECURSOS HUMANOS / Seguridad Social")), false);
  assert.equal(esDocumentoParaWobiSeguros(clasificacion("Seguros Sociales 2026")), false);
});

test("el clasificador puede pedir el contenido de una carpeta profunda por su ruta", async () => {
  const { rutaDeCarpetaPadre } = await import("../documental/classifyFile");
  assert.deepEqual(rutaDeCarpetaPadre("SEGUROS📜 / EUROPA"), ["SEGUROS📜", "EUROPA"]);
  assert.deepEqual(rutaDeCarpetaPadre("EUROPA"), ["EUROPA"]);
  assert.deepEqual(rutaDeCarpetaPadre(undefined), []);
});

test("el número de póliza también se reconoce en el nombre del archivo (condiciones generales sin número impreso)", () => {
  assert.equal(numeroDePolizaEnNombre("BUSINESS ATELIER EUROPA, S.L.  023S00453RCG Condiciones Generales RC.pdf", registro), "023S00453RCG");
  assert.equal(numeroDePolizaEnNombre("CERTIF. POL.54239034.PDF", registro), "054239034", "devuelve el número tal como está en el registro (con su cero)");
  assert.equal(numeroDePolizaEnNombre("POLIZA 054239034 - Devolver firmado.PDF", registro), "054239034");
  assert.equal(numeroDePolizaEnNombre("Signed_ADXP_230727_88822458000000_KITPOLI_000252 .pdf", registro), "", "sin ninguno de los números del registro: no se adivina");
  assert.equal(numeroDePolizaEnNombre("023S00453RCG y 054239034 juntas.pdf", registro), "", "dos pólizas distintas en el nombre: ambiguo, mejor sin enlazar");
  assert.equal(numeroDePolizaEnNombre("Condiciones.pdf", [{ numeroPoliza: "1234" }]), "", "un número demasiado corto aparecería por casualidad");
  assert.equal(numeroDePolizaEnNombre("Condiciones.pdf", [{ numeroPoliza: "" }]), "");
});

test("unas condiciones generales sin número impreso se enlazan por el número del nombre del archivo, y su id sigue siendo el del nombre", async () => {
  const sinNumero = datos({ tipoDocumento: "condiciones generales", numeroPoliza: "", suplemento: "", fechaDocumento: "", vigenciaInicio: "", vigenciaFin: "", prima: "", moneda: "" });
  const e = entorno(sinNumero);
  const nombre = "BUSINESS ATELIER EUROPA, S.L.  023S00453RCG Condiciones Generales RC.pdf";
  const r = await integrarDocumentoPoliza({ ...entrada, nombreArchivo: nombre }, e.deps);
  assert.equal(r.estado, "integrado");
  assert.equal(r.documento?.polizaId, "woba_rc_markel");
  assert.equal(r.documento?.empresa, "WOBA");
  assert.equal(r.documento?.numeroPoliza, "023S00453RCG");
  assert.match(r.mensaje, /póliza 023S00453RCG/);
  assert.match(r.mensaje, /por el número del nombre del archivo/);
  assert.equal(r.documento?.id, idDocumentoPoliza(sinNumero, nombre), "el id no cambia: dos versiones con distinto nombre no se confunden");

  // Otra versión de las condiciones generales (otro archivo) también se integra: no se toman por el mismo documento.
  const otra = await integrarDocumentoPoliza({ ...entrada, nombreArchivo: "023S00453RCG Condiciones Generales RC (2025).pdf" }, e.deps);
  assert.equal(otra.estado, "integrado");
  assert.equal(e.guardados.length, 2);
});

test("el número impreso manda sobre el del nombre del archivo, y sin ninguno el documento queda suelto", async () => {
  const impreso = entorno(datos({ numeroPoliza: "054239034", suplemento: "" }));
  const r1 = await integrarDocumentoPoliza({ ...entrada, nombreArchivo: "023S00453RCG - nombre engañoso.pdf" }, impreso.deps);
  assert.equal(r1.documento?.polizaId, "woba_showroom_2026_2027");
  assert.doesNotMatch(r1.mensaje, /nombre del archivo/);

  const suelto = entorno(datos({ numeroPoliza: "", suplemento: "", tipoDocumento: "condiciones generales" }));
  const r2 = await integrarDocumentoPoliza({ ...entrada, nombreArchivo: "Condiciones Generales.pdf" }, suelto.deps);
  assert.equal(r2.documento?.polizaId, "");
  assert.match(r2.mensaje, /no trae número de póliza: queda como documento suelto/);
});
