import { agregarFila, leerFilas, type FilaCruda } from "../google/sheetsKeyValueStore";

/**
 * Documentos de pólizas que Wobi Seguros ya leyó: condiciones particulares, suplementos, certificados… Cada fila es
 * un documento archivado en Drive con lo que dice (resumen y datos clave), enlazado a su póliza del registro
 * (`polizaRegistroSheet.ts`) por `polizaId` cuando se reconoce el número.
 *
 * Nace de un pedido de Carlos (2026-10-01, correo de Acodrid con las condiciones de la RC y el suplemento del
 * showroom): «reconócelos, guárdalos en el drive y dile a Wobi Seguros que los lea para que lo tenga en su
 * conocimiento». Sin esto el documento quedaba en Drive pero ninguna conversación sabía que existía ni qué decía.
 */
const TAB_NAME = "_documentos_polizas";
const HEADERS = [
  "id",
  "polizaId",
  "empresa",
  "numeroPoliza",
  "aseguradora",
  "tipoDocumento",
  "nombreArchivo",
  "fechaDocumento",
  "vigenciaInicio",
  "vigenciaFin",
  "prima",
  "capitalAsegurado",
  "resumen",
  "enlaceDrive",
  "origen",
  "registradoEn",
];
const NUM_COLS = HEADERS.length;

export interface DocumentoPoliza {
  id: string;
  /** Id de la póliza en el registro; vacío si el número no corresponde a ninguna póliza registrada. */
  polizaId: string;
  empresa: string;
  numeroPoliza: string;
  aseguradora: string;
  tipoDocumento: string;
  nombreArchivo: string;
  fechaDocumento: string;
  vigenciaInicio: string;
  vigenciaFin: string;
  prima: string;
  capitalAsegurado: string;
  resumen: string;
  enlaceDrive: string;
  origen: string;
  registradoEn: string;
}

function filaADocumento(fila: FilaCruda): DocumentoPoliza {
  const v = fila.valores;
  return {
    id: v[0] ?? "", polizaId: v[1] ?? "", empresa: v[2] ?? "", numeroPoliza: v[3] ?? "", aseguradora: v[4] ?? "",
    tipoDocumento: v[5] ?? "", nombreArchivo: v[6] ?? "", fechaDocumento: v[7] ?? "", vigenciaInicio: v[8] ?? "",
    vigenciaFin: v[9] ?? "", prima: v[10] ?? "", capitalAsegurado: v[11] ?? "", resumen: v[12] ?? "",
    enlaceDrive: v[13] ?? "", origen: v[14] ?? "", registradoEn: v[15] ?? "",
  };
}

export async function listarDocumentosPoliza(): Promise<DocumentoPoliza[]> {
  return (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).map(filaADocumento);
}

export async function registrarDocumentoPoliza(d: DocumentoPoliza): Promise<void> {
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, [
    d.id, d.polizaId, d.empresa, d.numeroPoliza, d.aseguradora, d.tipoDocumento, d.nombreArchivo, d.fechaDocumento,
    d.vigenciaInicio, d.vigenciaFin, d.prima, d.capitalAsegurado, d.resumen, d.enlaceDrive, d.origen, d.registradoEn,
  ]);
}
