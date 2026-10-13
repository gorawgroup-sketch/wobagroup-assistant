import { createHash } from "node:crypto";
import type { Empresa } from "./client";

/**
 * Reposición de comprobantes rescatados (caso 2026-10-13): Holded duplica los adjuntos de una compra en cada PUT y 10 compras de Footprint
 * acabaron con entre 4 y 32.768 copias de su comprobante. Se rescató UNA copia íntegra de cada una en Drive (carpeta «RESCATE COMPROBANTES
 * HOLDED - adjuntos duplicados 2026-10-13»). Cuando una persona limpia los duplicados en Holded, esta acción vuelve a adjuntar esa única copia
 * por el MISMO camino que usa WOBi al crear un gasto (`adjuntarComprobanteHolded`: durable, idempotente y verificado por contenido).
 *
 * Alcance cerrado a propósito: solo las compras y los archivos de este manifiesto (id de Drive + huella SHA-256 exacta); nunca un archivo ni una
 * compra arbitrarios. Y solo sobre una compra SIN adjuntos: si ya tiene alguno, no se sube otro (así no puede crear un duplicado).
 */
export interface EntradaRestauracion {
  empresa: Empresa;
  purchaseId: string;
  etiqueta: string;
  driveFileId: string;
  nombreArchivo: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

export const MANIFIESTO_RESTAURACION: readonly EntradaRestauracion[] = [
  { empresa: "Footprint", purchaseId: "6aafc4da82a59b46bc0dfbae", etiqueta: "AHORRAMAS, SA (AHORRAMAS, S.A.) 7,60 EUR (2026-09-09)", driveFileId: "1W3qUVqsEm0BvwDddk72s3N9lSQRfiyvP",
    nombreArchivo: "FTG_2026-09-09_AHORRAMAS_SA_AHORRAMAS_S_A_7.60EUR_6aafc4da.jpg", mimeType: "image/jpeg", bytes: 2880746, sha256: "273ba685af6ef2fc398972e98587bd365b789c5f7a2a0f38d2874d73fa7edb68" },
  { empresa: "Footprint", purchaseId: "6aafc499d57ceb5a420afe59", etiqueta: "Kiwi.com s.r.o. 151,00 USD (2026-09-16)", driveFileId: "1yVPJbgXbFbJN_L--sj8zI4DaWmtElZMm",
    nombreArchivo: "FTG_2026-09-16_Kiwi_com_s_r_o_151.00USD_6aafc499.pdf", mimeType: "application/pdf", bytes: 19318, sha256: "50640536ae310a68d8774871b77178527dd70c76a6552ccffdac31222128daeb" },
  { empresa: "Footprint", purchaseId: "6aafc4ad14fbe8fd6a028a80", etiqueta: "ALDI 82,31 EUR (2026-08-28)", driveFileId: "1jDIp3dKtzwU1Ud3bteIEBhfY60MB0UtP",
    nombreArchivo: "FTG_2026-08-28_ALDI_82.31EUR_6aafc4ad.jpg", mimeType: "image/jpeg", bytes: 2737040, sha256: "b5d08ad9e0550fe40b1a001254b5375a41bf63cde408123c2eada2757aea0289" },
  { empresa: "Footprint", purchaseId: "6aafc4a399bd8dc13e086441", etiqueta: "Delhaize Hoogstraten 140,41 EUR (2026-08-28)", driveFileId: "1s4Z3KCTaLW0MGokcJuU3_pltciY0eG9F",
    nombreArchivo: "FTG_2026-08-28_Delhaize_Hoogstraten_140.41EUR_6aafc4a3.jpg", mimeType: "image/jpeg", bytes: 2434128, sha256: "59ad023e7bc483eb6c26b93bdd47cbe31c59a7a49d10b9e840fa0028c35f0d1f" },
  { empresa: "Footprint", purchaseId: "6aafaf4c3f5f4b80c8049149", etiqueta: "Nieuwe Veste 5,40 EUR (2026-09-16)", driveFileId: "1qOj5k--59v1MbppS2WhN9z1GhnwgXQpI",
    nombreArchivo: "FTG_2026-09-16_Nieuwe_Veste_5.40EUR_6aafaf4c.jpg", mimeType: "image/jpeg", bytes: 2193498, sha256: "8ebc03f69330ab38c870dbd9f6610f5d755d90e1af14affa7d32514d3533b259" },
  { empresa: "Footprint", purchaseId: "6aafcda1cd49b8227a05d481", etiqueta: "JUMBO SUPERMARKTEN 30,12 EUR (2026-08-29)", driveFileId: "176q0irf0-dHVTaKbrRMioDYbqNMgaJxG",
    nombreArchivo: "FTG_2026-08-29_JUMBO_SUPERMARKTEN_30.12EUR_6aafcda1.jpg", mimeType: "image/jpeg", bytes: 2668366, sha256: "35fe9e48cd998266c9602c3085e3a4d457cdfd8eaf00b4e1b32a23c9dac9d134" },
  { empresa: "Footprint", purchaseId: "6ab130082e91242b5d045230", etiqueta: "AIRBNB 233,21 USD (2026-09-20)", driveFileId: "1oWXHDsMQYSi9ssczEhJlXCaCFmJNEX2_",
    nombreArchivo: "FTG_2026-09-20_AIRBNB_233.21USD_6ab13008.pdf", mimeType: "application/pdf", bytes: 215372, sha256: "709a994d71a16b92c4ca9ea69905e724a8f18f4eb742e6641c667464095e7bba" },
  { empresa: "Footprint", purchaseId: "6ab10233d5e8cb68100f1fb6", etiqueta: "JETSMART AIRLINES S.A.S. 192,28 EUR (2026-09-16)", driveFileId: "1VjlspY0zqt66I4d0NDdzI2ZNDG3RRg6L",
    nombreArchivo: "FTG_2026-09-16_JETSMART_AIRLINES_S_A_S_192.28EUR_6ab10233.pdf", mimeType: "application/pdf", bytes: 16368, sha256: "0753d797b58c8ff3fa0814fc386e5f658534b073f4b1be4ecb27922cf2ffb2a7" },
  { empresa: "Footprint", purchaseId: "6ab26363a996172f94058b35", etiqueta: "Booking.com 62,51 EUR (2026-09-20)", driveFileId: "1hq30V3l9trWhse14Vn9RjMYSfS2j-3Pd",
    nombreArchivo: "FTG_2026-09-20_Booking_com_62.51EUR_6ab26363.pdf", mimeType: "application/pdf", bytes: 70970, sha256: "b56f2b9408b6f23e5f2dc53e3cbe4d9f6d68074014a31bede5ec962554a15895" },
  { empresa: "Footprint", purchaseId: "6abb8fe46f51af8c8804efe8", etiqueta: "Station Gomerco Mertens Meerle 55,32 USD (2026-09-28)", driveFileId: "1VZcx5-IXPHGVgmjHeAvsdYcgupcaq3sU",
    nombreArchivo: "FTG_2026-09-28_Station_Gomerco_Mertens_Meerle_55.32USD_6abb8fe4.jpg", mimeType: "image/jpeg", bytes: 303206, sha256: "9994a944ad2990110f2e8c17283d47f0b98ac105dfdf3b6d9729dad4e14b1bcd" },
];

export type MotivoRechazoRestauracion = "no_esta_en_el_manifiesto" | "ya_tiene_adjuntos" | "archivo_de_drive_distinto" | "adjuntos_ilegibles";

export type ResultadoRestauracion =
  | { estado: "restaurado"; purchaseId: string; etiqueta: string; adjuntosAntes: 0; adjuntosDespues: number; attachmentId: string; verificado: boolean }
  | { estado: "rechazado"; purchaseId: string; motivo: MotivoRechazoRestauracion; detalle: string; adjuntos?: number };

export interface DepsRestauracion {
  /** Número de entradas de adjuntos que Holded lista hoy para la compra. */
  contarAdjuntos(empresa: Empresa, purchaseId: string): Promise<number>;
  descargarDeDrive(fileId: string): Promise<{ bytes: Buffer }>;
  adjuntar(empresa: Empresa, purchaseId: string, archivo: { bytes: Buffer; nombreArchivo: string; mimeType: string }, idempotencyKey: string): Promise<{ attachmentId: string }>;
}

/**
 * `intento` entra en la clave idempotente: un reintento por un fallo de red repite el MISMO intento (no sube dos veces); una reposición
 * deliberada posterior (la persona volvió a limpiar la compra) usa otro número.
 */
export async function restaurarComprobante(
  purchaseId: string, deps: DepsRestauracion, intento = "1", manifiesto: readonly EntradaRestauracion[] = MANIFIESTO_RESTAURACION
): Promise<ResultadoRestauracion> {
  const entrada = manifiesto.find((e) => e.purchaseId === purchaseId);
  if (!entrada) return { estado: "rechazado", purchaseId, motivo: "no_esta_en_el_manifiesto", detalle: "Esa compra no está en la lista de comprobantes rescatados." };

  let antes: number;
  try {
    antes = await deps.contarAdjuntos(entrada.empresa, entrada.purchaseId);
  } catch (error) {
    // Una lectura fallida NO es «sin adjuntos»: subir con la lectura caída podría duplicar.
    return { estado: "rechazado", purchaseId, motivo: "adjuntos_ilegibles", detalle: "No se pudieron leer los adjuntos de la compra en Holded; no se sube nada." + (error instanceof Error ? ` (${error.name})` : "") };
  }
  if (antes > 0) {
    return { estado: "rechazado", purchaseId, motivo: "ya_tiene_adjuntos", adjuntos: antes,
      detalle: `La compra ya tiene ${antes} adjunto(s) en Holded. No se sube otro: primero hay que dejarla sin adjuntos.` };
  }

  const descargado = await deps.descargarDeDrive(entrada.driveFileId);
  const sha = createHash("sha256").update(descargado.bytes).digest("hex");
  if (sha !== entrada.sha256 || descargado.bytes.length !== entrada.bytes) {
    return { estado: "rechazado", purchaseId, motivo: "archivo_de_drive_distinto",
      detalle: "El archivo de Drive no coincide con el comprobante rescatado (huella o tamaño distintos); no se sube." };
  }

  const clave = `restaurar-comprobante:${entrada.purchaseId}:${entrada.sha256.slice(0, 16)}:${intento}`;
  const subido = await deps.adjuntar(entrada.empresa, entrada.purchaseId, { bytes: descargado.bytes, nombreArchivo: entrada.nombreArchivo, mimeType: entrada.mimeType }, clave);
  const despues = await deps.contarAdjuntos(entrada.empresa, entrada.purchaseId);
  return { estado: "restaurado", purchaseId, etiqueta: entrada.etiqueta, adjuntosAntes: 0, adjuntosDespues: despues, attachmentId: subido.attachmentId, verificado: despues === 1 };
}
