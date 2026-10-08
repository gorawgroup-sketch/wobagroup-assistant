import { createHash } from "node:crypto";
import { extraerDatosPoliza, type DatosDocumentoPoliza } from "./extraerDatosPoliza";
import { listarDocumentosPoliza, registrarDocumentoPoliza, type DocumentoPoliza } from "./documentosPolizaStore";
import { listarPolizas } from "./polizaRegistroSheet";
import type { Poliza } from "./types";

/**
 * «Dile a Wobi Seguros que lo lea»: cuando un documento de póliza queda archivado en Drive, se lee de verdad
 * (extraerDatosPoliza), se enlaza con su póliza del registro por el número y se guarda en `_documentos_polizas`, de
 * donde lo recupera `consultar_polizas_seguro`. No modifica el registro de pólizas (Carlos lo edita a mano y cambiar
 * prima, vigencia o estado es una decisión suya): solo añade conocimiento.
 */

/** Solo dígitos y letras, sin ceros a la izquierda: «054239034» y «54239034» son la misma póliza. */
export function normalizarNumeroPoliza(numero: string): string {
  return numero.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+/, "");
}

/**
 * Póliza del registro a la que pertenece un documento. El registro guarda textos como
 * «054239034 (Suplemento nº 2 / 54239034.2) — Pyme 2038», así que se compara el primer número de cada fila. Entre
 * varias filas de la misma póliza (la póliza y sus suplementos) gana la que menciona el suplemento del documento y,
 * si no, la que está vigente.
 */
export function buscarPolizaDelDocumento<T extends Pick<Poliza, "id" | "numeroPoliza" | "estado">>(
  polizas: T[],
  numeroPoliza: string,
  suplemento: string
): T | undefined {
  const objetivo = normalizarNumeroPoliza(numeroPoliza);
  if (objetivo.length < 5) return undefined;
  const candidatas = polizas.filter((p) => {
    const principal = normalizarNumeroPoliza((p.numeroPoliza.match(/[A-Za-z0-9]+/) ?? [""])[0]);
    return principal === objetivo;
  });
  if (candidatas.length <= 1) return candidatas[0];
  const sup = suplemento.trim();
  const esFilaDeSuplemento = (p: T) => /suplemento/i.test(p.numeroPoliza);
  if (sup) {
    // Números que la fila menciona tras el de la póliza: «(Suplemento nº 2 / 54239034.2)» → 2 y 54239034.2.
    const mencionaSuplemento = (p: T) =>
      (p.numeroPoliza.replace(/^[A-Za-z0-9]+/, "").match(/\d+(?:\.\d+)*/g) ?? [])        // «54239034.2» es «póliza.suplemento»; «3.3» es otro suplemento, no el «3».
        .some((n) => n === sup || (n.endsWith(`.${sup}`) && n.slice(0, -sup.length - 1).length >= 5));
    const delSuplemento = candidatas.find((p) => esFilaDeSuplemento(p) && mencionaSuplemento(p));
    if (delSuplemento) return delSuplemento;
  }
  const principales = candidatas.filter((p) => !esFilaDeSuplemento(p));
  return principales.find((p) => p.estado === "vigente") ?? principales[0] ?? candidatas[0];
}

/**
 * Las condiciones generales son del PRODUCTO, no de la póliza: no traen impreso el número de póliza, pero el nombre del archivo casi siempre
 * lo lleva («… 023S00453RCG Condiciones Generales RC.pdf»). Busca en el nombre el número principal de alguna póliza del registro y lo devuelve
 * tal como está en el registro; vacío si ninguno aparece o si aparecen varios distintos (ambiguo: mejor sin enlazar que mal enlazado).
 * Caso real (08-10-2026): 5 documentos leídos de Drive quedaron sin póliza y el panel, que filtra por póliza, no los enseñaba.
 */
export function numeroDePolizaEnNombre<T extends Pick<Poliza, "numeroPoliza">>(nombreArchivo: string, polizas: T[]): string {
  const nombre = normalizarNumeroPoliza(nombreArchivo);
  const encontrados = new Map<string, string>();
  for (const p of polizas) {
    const bruto = (p.numeroPoliza.match(/[A-Za-z0-9]+/) ?? [""])[0];
    const principal = normalizarNumeroPoliza(bruto);
    // Un número demasiado corto aparecería por casualidad en cualquier nombre.
    if (principal.length >= 7 && nombre.includes(principal)) encontrados.set(principal, bruto);
  }
  return encontrados.size === 1 ? [...encontrados.values()][0] : "";
}

/** Mismo documento (misma póliza, suplemento, tipo y fecha) → mismo id: integrar dos veces no duplica. */
export function idDocumentoPoliza(datos: Pick<DatosDocumentoPoliza, "numeroPoliza" | "suplemento" | "tipoDocumento" | "fechaDocumento">, nombreArchivo: string): string {
  const base = datos.numeroPoliza
    ? [normalizarNumeroPoliza(datos.numeroPoliza), datos.suplemento.trim(), datos.tipoDocumento.trim().toLowerCase(), datos.fechaDocumento.trim()]
    : [nombreArchivo.trim().toLowerCase()];
  return createHash("sha256").update(base.join("\0")).digest("hex").slice(0, 16);
}

export interface EntradaDocumentoPoliza {
  rutaLocal: string;
  mimeType?: string;
  nombreArchivo: string;
  enlaceDrive: string;
  /** De dónde llegó (correo, chat…), para dejar rastro. */
  origen: string;
}

export interface ResultadoIntegracionPoliza {
  estado: "integrado" | "ya_integrado" | "no_es_poliza";
  /** Frase para el operador: qué póliza es y qué quedó registrado. */
  mensaje: string;
  documento?: DocumentoPoliza;
}

const deps = {
  extraer: extraerDatosPoliza,
  polizas: listarPolizas,
  documentos: listarDocumentosPoliza,
  registrar: registrarDocumentoPoliza,
  ahora: () => new Date(),
};

export async function integrarDocumentoPoliza(
  entrada: EntradaDocumentoPoliza,
  d: typeof deps = deps
): Promise<ResultadoIntegracionPoliza> {
  const datos = await d.extraer(entrada.rutaLocal, entrada.mimeType, `Archivo: ${entrada.nombreArchivo}. ${entrada.origen}`);
  if (!datos.esDocumentoPoliza) {
    return { estado: "no_es_poliza", mensaje: "" };
  }

  const id = idDocumentoPoliza(datos, entrada.nombreArchivo);
  const [existentes, polizas] = await Promise.all([d.documentos(), d.polizas()]);
  // Número impreso en el documento; si no trae (condiciones generales), el que lleva el nombre del archivo.
  const numeroDelNombre = datos.numeroPoliza ? "" : numeroDePolizaEnNombre(entrada.nombreArchivo, polizas);
  const numero = datos.numeroPoliza || numeroDelNombre;
  const poliza = buscarPolizaDelDocumento(polizas, numero, datos.suplemento);
  const titulo = [
    datos.tipoDocumento || "documento de póliza",
    numero ? `póliza ${numero}${datos.suplemento ? ` (suplemento ${datos.suplemento})` : ""}` : "",
    datos.aseguradora,
  ].filter(Boolean).join(" — ");
  const enlace = poliza
    ? `enlazado a «${poliza.tipoCobertura}» de ${poliza.empresa} en el registro${numeroDelNombre ? " (por el número del nombre del archivo)" : ""}`
    : numero
      ? `la póliza ${numero} no está en el registro de pólizas: queda como documento suelto hasta que la des de alta`
      : "no trae número de póliza: queda como documento suelto";

  const previo = existentes.find((doc) => doc.id === id);
  if (previo) {
    return { estado: "ya_integrado", mensaje: `🛡️ Wobi Seguros ya tenía este documento (${titulo}).`, documento: previo };
  }

  const documento: DocumentoPoliza = {
    id,
    polizaId: poliza?.id ?? "",
    empresa: poliza?.empresa ?? (datos.empresa === "desconocida" ? "" : datos.empresa),
    numeroPoliza: numero + (datos.suplemento ? ` (suplemento ${datos.suplemento})` : ""),
    aseguradora: datos.aseguradora,
    tipoDocumento: datos.tipoDocumento,
    nombreArchivo: entrada.nombreArchivo,
    fechaDocumento: datos.fechaDocumento,
    vigenciaInicio: datos.vigenciaInicio,
    vigenciaFin: datos.vigenciaFin,
    prima: datos.prima ? `${datos.prima}${datos.moneda ? ` ${datos.moneda}` : ""}` : "",
    capitalAsegurado: datos.capitalAsegurado,
    resumen: [
      datos.tomador ? `Tomador: ${datos.tomador}.` : "",
      datos.tipoCobertura ? `Cobertura: ${datos.tipoCobertura}.` : "",
      datos.franquicia ? `Franquicia: ${datos.franquicia}.` : "",
      datos.resumen,
    ].filter(Boolean).join(" ").slice(0, 4000),
    enlaceDrive: entrada.enlaceDrive,
    origen: entrada.origen.slice(0, 300),
    registradoEn: d.ahora().toISOString(),
  };
  await d.registrar(documento);
  return {
    estado: "integrado",
    mensaje: `🛡️ Wobi Seguros lo leyó y lo integró a su conocimiento: ${titulo}; ${enlace}.`,
    documento,
  };
}
