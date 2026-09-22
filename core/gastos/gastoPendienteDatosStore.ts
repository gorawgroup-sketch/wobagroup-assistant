import { randomUUID } from "node:crypto";
import { agregarFila, leerFilas, eliminarFila as eliminarFilaKV } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import type { DatosFactura } from "../documental/extractInvoiceData";

/**
 * Bug real encontrado en vivo: procesarGastoEntrante tiene dos ramas que NO
 * mandan una propuesta con botones (empresa sin identificar, o moneda
 * extranjera sin monto equivalente) — solo hacen una pregunta en texto
 * plano y retornan. Pero devolvía `void` igual que la rama que SÍ manda la
 * propuesta, así que procesarDocumentoLocal/capturarCorreo.ts no podían
 * distinguir "ya te mandé la propuesta con botón" de "te hice una
 * pregunta" — Wobi le dijo a Carlos "ya te la mandé por Telegram" dos veces
 * seguidas para una factura de Panamá (MERA AEROPUERTO DE PANAMA SA, 17.95
 * USD) cuando en realidad solo había preguntado la moneda equivalente, sin
 * ningún botón. Además, la pregunta en sí no se persistía en ningún lado
 * (a diferencia de contactoResolucionStore.ts / classificationStore.ts),
 * así que la respuesta de Carlos en texto libre no podía retomar el
 * proceso — cada intento releía el documento desde cero y volvía a
 * preguntar lo mismo. Este store, junto con reintentarGastoPendiente.ts,
 * cierra ambos huecos: guarda todo lo necesario para retomar sin releer el
 * documento, y buildSystemPromptDinamico avisa cuando hay una pregunta de
 * este tipo sin responder.
 */
export interface GastoPendienteDatos {
  id: string;
  chatId: number;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  datos: DatosFactura;
  motivo: "empresa" | "proveedor" | "moneda" | "verificacion_duplicado";
  creadoEn: number;
  /**
   * true si el gasto que originó esta pregunta viene de la cola de revisión
   * de correo uno a uno — ver PropuestaGasto.deColaCorreo. Bug real
   * encontrado al construir el camino de gasto-desde-cuerpo-de-correo: este
   * store era el único de la familia de gasto que todavía no lo tenía, así
   * que una factura (por adjunto o por cuerpo) con empresa/moneda poco clara
   * dejaba la cola esperando una respuesta que nunca la iba a destrabar.
   */
  deColaCorreo?: boolean;
  /**
   * Bug real encontrado en auditoría: sin este campo, una factura por correo
   * con empresa/moneda poco clara (ej. Panamá, MERA AEROPUERTO DE PANAMA SA)
   * perdía el correoOrigen al pasar por este store — reintentarGastoPendiente.ts
   * volvía a llamar procesarGastoEntrante SIN él, así que la propuesta final
   * (ya con el dato correcto) se mandaba sin los botones "Responder correo"/
   * "Guardar como conocimiento"/"Otras acciones", justo para el tipo de
   * factura ambigua que motivó el pedido original de Carlos. Ver
   * PropuestaGasto.correoOrigen (gastoProposalSheet.ts).
   */
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string; mensajeIdGmail?: string };
  /**
   * Hallazgo real de auditoría (mismo patrón que correoOrigen arriba, caso real Holded Technologies
   * septiembre/Footprint): sin este campo, un adjunto REAL de Gmail (no un cuerpo-como-comprobante)
   * perdía su origen al pasar por este store — reintentarGastoPendiente.ts volvía a llamar
   * procesarGastoEntrante SIN él, así que si la copia local (tmp/uploads) se perdía en un redeploy de
   * Railway mientras la pregunta seguía pendiente, adjuntarYLimpiar (gastoCallbackHandler.ts) nunca
   * podía recuperar el PDF real desde Gmail — caía directo a regenerar un comprobante SUSTITUTO desde
   * el cuerpo del correo (pensado solo para cuando nunca hubo un adjunto real), adjuntando un
   * documento que no es la factura real. Ver PropuestaGasto.origenAdjuntoGmail (gastoProposalSheet.ts).
   */
  origenAdjuntoGmail?: { mensajeIdGmail: string; attachmentIdGmail: string; partId?: string };
}

const TAB_NAME = "_gastos_pendientes_datos";
// 24h — pedido explícito de Carlos (mismo criterio en todos los
// "pendiente_*", ver pendienteCapturaEmpresaStore.ts), igual que contactoResolucionStore.ts.
const TTL_MS = 24 * 60 * 60 * 1000;
// Hallazgo real de auditoría (2026-09-15): a diferencia de otros stores de este mismo tipo
// (durableBankReconciliationStore, webBotonesStore), este nunca tuvo protección contra
// lectura-modificación-escritura concurrente — dos llamadas casi simultáneas (ej. el vigilante de
// correos atascados reintentando un correo dos veces en pocos minutos) podían leer la misma
// instantánea de filas, y la eliminación de una pisar el índice de fila que la otra ya tenía
// capturado, dejando filas en blanco (huérfanas) en la hoja y perdiendo el registro real. Todas las
// operaciones que leen y luego escriben ahora se serializan con la misma clave.
const CLAVE_MUTEX = `gastos-pendientes-datos:${TAB_NAME}`;

const HEADERS = [
  "id",
  "chatId",
  "rutaLocal",
  "nombreArchivoOriginal",
  "mimeType",
  "datosJSON",
  "motivo",
  "creadoEn",
  "deColaCorreo",
  "correoOrigenJSON",
  "origenAdjuntoGmailJSON",
];

function rowToPendiente(row: unknown[]): GastoPendienteDatos | null {
  if (!row[0]) return null;

  let datos: DatosFactura;
  try {
    datos = row[5] ? JSON.parse(String(row[5])) : null;
  } catch {
    return null; // fila corrupta — mejor ignorarla que tumbar el resto
  }
  if (!datos) return null;

  const motivo =
    row[6] === "empresa" || row[6] === "proveedor" || row[6] === "moneda" || row[6] === "verificacion_duplicado"
      ? row[6]
      : "moneda";

  let correoOrigen: GastoPendienteDatos["correoOrigen"];
  try {
    correoOrigen = row[9] ? JSON.parse(String(row[9])) : undefined;
  } catch {
    correoOrigen = undefined;
  }

  let origenAdjuntoGmail: GastoPendienteDatos["origenAdjuntoGmail"];
  try {
    origenAdjuntoGmail = row[10] ? JSON.parse(String(row[10])) : undefined;
  } catch {
    origenAdjuntoGmail = undefined;
  }

  return {
    id: String(row[0]),
    chatId: Number(row[1]) || 0,
    rutaLocal: row[2] ? String(row[2]) : "",
    nombreArchivoOriginal: row[3] ? String(row[3]) : "",
    mimeType: row[4] ? String(row[4]) : undefined,
    datos,
    motivo,
    creadoEn: Number(row[7]) || 0,
    deColaCorreo: row[8] === true || row[8] === "true",
    correoOrigen,
    origenAdjuntoGmail,
  };
}

function pendienteToRow(p: GastoPendienteDatos): (string | number)[] {
  return [
    p.id,
    p.chatId,
    p.rutaLocal,
    p.nombreArchivoOriginal,
    p.mimeType ?? "",
    JSON.stringify(p.datos),
    p.motivo,
    p.creadoEn,
    p.deColaCorreo === true ? "true" : "",
    p.correoOrigen ? JSON.stringify(p.correoOrigen) : "",
    p.origenAdjuntoGmail ? JSON.stringify(p.origenAdjuntoGmail) : "",
  ];
}

interface FilaConIndice {
  rowIndex: number;
  pendiente: GastoPendienteDatos;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  const rows = await leerFilas(TAB_NAME, HEADERS.length, HEADERS);
  return rows.flatMap(({ rowIndex, valores }) => {
    const pendiente = rowToPendiente(valores);
    return pendiente ? [{ rowIndex, pendiente }] : [];
  });
}

async function eliminarFila(rowIndex: number): Promise<void> {
  await eliminarFilaKV(TAB_NAME, rowIndex, HEADERS);
}

async function purgarVencidas(): Promise<void> {
  const todas = await leerTodas();
  const ahora = Date.now();
  // Las preguntas originadas por la cola son estado durable del correo:
  // mientras sigan pendientes, ese mensaje debe permanecer UNREAD. Solo las
  // preguntas sueltas/manuales pueden vencer por antigüedad.
  const vencidas = todas.filter(({ pendiente }) =>
    pendiente.deColaCorreo !== true && ahora - pendiente.creadoEn > TTL_MS
  );

  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

export async function guardarGastoPendienteDatos(
  datos: Omit<GastoPendienteDatos, "id" | "creadoEn">
): Promise<GastoPendienteDatos> {
  return conMutex(CLAVE_MUTEX, async () => {
    await purgarVencidas();

    const pendiente: GastoPendienteDatos = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now() };

    await agregarFila(TAB_NAME, HEADERS.length, HEADERS, pendienteToRow(pendiente));

    return pendiente;
  });
}

/**
 * Busca por chatId — para cuando el usuario responde en texto libre a la
 * pregunta pendiente en vez de reenviar el documento. Si hay varias del
 * mismo chat, consume la más reciente.
 */
export async function consumirGastoPendienteDatosPorChat(chatId: number): Promise<GastoPendienteDatos | undefined> {
  return conMutex(CLAVE_MUTEX, async () => {
    const todas = await leerTodas();
    const delChat = todas.filter(({ pendiente }) => pendiente.chatId === chatId);
    if (delChat.length === 0) return undefined;

    const masReciente = delChat.reduce((a, b) => (a.pendiente.creadoEn >= b.pendiente.creadoEn ? a : b));
    await eliminarFila(masReciente.rowIndex);
    return masReciente.pendiente;
  });
}

/**
 * Reclama una pendiente concreta por id y chat. Los botones siempre usan
 * esta variante en vez de "la mas reciente": mientras un correo esta
 * abierto pueden existir varias decisiones y un doble toque o un mensaje
 * atrasado nunca debe consumir la factura equivocada.
 */
export async function consumirGastoPendienteDatosPorId(
  chatId: number,
  id: string
): Promise<GastoPendienteDatos | undefined> {
  return conMutex(CLAVE_MUTEX, async () => {
    const todas = await leerTodas();
    const encontrada = todas.find(({ pendiente }) => pendiente.chatId === chatId && pendiente.id === id);
    if (!encontrada) return undefined;

    await eliminarFila(encontrada.rowIndex);
    return encontrada.pendiente;
  });
}

/** Restaura exactamente la misma decision despues de un fallo transitorio. */
export async function restaurarGastoPendienteDatos(pendiente: GastoPendienteDatos): Promise<void> {
  await conMutex(CLAVE_MUTEX, async () => {
    const todas = await leerTodas();
    if (todas.some(({ pendiente: actual }) => actual.id === pendiente.id)) return;

    await agregarFila(TAB_NAME, HEADERS.length, HEADERS, pendienteToRow(pendiente));
  });
}

/** Solo lectura (no consume) — para que buildSystemPromptDinamico avise de la pregunta pendiente. */
export async function obtenerGastoPendienteDatosPorChat(chatId: number): Promise<GastoPendienteDatos | undefined> {
  const todas = await leerTodas();
  const delChat = todas.filter(({ pendiente }) => pendiente.chatId === chatId);
  if (delChat.length === 0) return undefined;

  return delChat.reduce((a, b) => (a.pendiente.creadoEn >= b.pendiente.creadoEn ? a : b)).pendiente;
}

/** Todas las pendientes de un chat (no solo la más reciente) — ver el comentario equivalente en classificationStore.ts, mismo motivo: vigilarProcesamientoAtascado.ts. */
export async function obtenerGastosPendienteDatosPorChat(chatId: number): Promise<GastoPendienteDatos[]> {
  const todas = await leerTodas();
  return todas.filter(({ pendiente }) => pendiente.chatId === chatId).map(({ pendiente }) => pendiente);
}
