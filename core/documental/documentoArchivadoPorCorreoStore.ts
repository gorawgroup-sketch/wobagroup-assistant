import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";

const TAB_NAME = "_documentos_archivados_por_correo";
const HEADERS = ["mensajeIdGmail", "attachmentId", "creadoEn"];
const NUM_COLS = HEADERS.length;
// Mismo TTL que gastoPorCorreoStore.ts (90 días) — mismo criterio: no es una pregunta esperando
// respuesta, es un registro permanente de "este adjunto YA se revisó y se archivó como documento
// genérico", y necesita seguir siendo consultable mucho después de procesado.
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Hallazgo real (caso real Carlos, 2026-09-10 — correo con 8 adjuntos, "TE HE PEDIDO QUE REVISES UN
 * MAIL Y ME DESCARGUES UNA FACTURA QUE HACIA FALTA... PERO VOLVISTE A DESCARGARLAS TODAS"): cuando
 * Carlos pidió revisar de nuevo un correo puntual (revisar_correo_puntual → procesarCorreoPuntual →
 * procesarCorreoLocalizado, el MISMO loop de adjuntos que usa la revisión automática por cron), el
 * único chequeo de "ya procesado" que existía (buscarGastoDesdeCorreo, gastoPorCorreoStore.ts) solo
 * cubre adjuntos que YA se convirtieron en un gasto real — un adjunto que se clasificó como
 * "documento genérico" (archivado en Drive, nunca se convirtió en gasto) no quedaba registrado en
 * ningún lado, así que CADA reproceso del mismo correo lo volvía a descargar y clasificar desde cero,
 * sin importar cuántas veces ya se hubiera revisado. Este store cierra ese hueco específico —
 * complementario a gastoPorCorreoStore.ts, nunca lo reemplaza (uno cubre "ya es un gasto", el otro
 * "ya se revisó y no era un gasto, se archivó tal cual").
 */
export interface DocumentoArchivadoPorCorreo {
  mensajeIdGmail: string;
  attachmentId: string;
  creadoEn: number;
}

export async function registrarDocumentoArchivadoDesdeCorreo(datos: {
  mensajeIdGmail: string;
  attachmentId: string;
}): Promise<void> {
  if (!datos.mensajeIdGmail || !datos.attachmentId) return;
  await purgarVencidos().catch((error) =>
    console.error("[documentoArchivadoPorCorreoStore] Error purgando registros vencidos (no crítico):", error)
  );
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, [datos.mensajeIdGmail, datos.attachmentId, Date.now()]);
}

async function purgarVencidos(): Promise<void> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  const vencidas = filas.filter((f) => {
    const creadoEn = Number(f.valores[2]) || 0;
    return ahora - creadoEn > TTL_MS;
  });
  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const fila of vencidas) {
    await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  }
}

/** true si este adjunto exacto (mensajeIdGmail+attachmentId) ya se revisó y archivó antes, y sigue dentro de la ventana. */
export async function yaSeArchivoDesdeCorreo(mensajeIdGmail: string, attachmentId: string): Promise<boolean> {
  if (!mensajeIdGmail || !attachmentId) return false;
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  return filas.some((f) => {
    const [id, attId, creadoEnRaw] = f.valores;
    if (id !== mensajeIdGmail || attId !== attachmentId) return false;
    const creadoEn = Number(creadoEnRaw) || 0;
    return ahora - creadoEn <= TTL_MS;
  });
}
