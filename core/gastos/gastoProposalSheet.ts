import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { textosParecidos } from "../utils/textoParecido";
import { montosCercanos } from "../utils/montos";
import { conMutex } from "../utils/asyncMutex";
import type { Empresa } from "../holded/client";
import type { PurchaseCandidato, MovimientoBancarioCandidato } from "../holded/write";
import type { LineaFactura } from "../documental/extractInvoiceData";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_gastos_pendientes";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días, igual que las demás propuestas

// Bug real de auditoría (agregar movimientosAmbiguosJSON como columna Y): el rango de columnas
// (A1:__1 en ensureTab, A2:__10000 en leerTodas, A:__ en crearPropuestaGasto) está hardcodeado por
// letra, NO se calcula de HEADERS.length — agregar una columna nueva a HEADERS sin extender los TRES
// rangos deja la columna nueva escribible pero NUNCA legible (values.get con un rango explícito
// nunca trae columnas fuera de él, así que row[n] de esa columna siempre sale undefined, sin ningún
// error). La próxima columna que se agregue DEBE extender los tres rangos a la letra siguiente.
const HEADERS = [
  "id",
  "empresa",
  "proveedor",
  "monto",
  "moneda",
  "fecha",
  "concepto",
  "rutaLocal",
  "nombreArchivoOriginal",
  "mimeType",
  "candidatosJSON",
  "chatId",
  "messageId",
  "creadoEn",
  "lineasJSON",
  "cuentaId",
  "cuentaTagsJSON",
  "deColaCorreo",
  "origenAdjuntoGmailJSON",
  "numeroDocumento",
  "montoOriginal",
  "correoOrigenJSON",
  "seleccionAccionesJSON",
  "hayMovimientoBancario",
  "movimientosAmbiguosJSON",
];

export interface PropuestaGasto {
  id: string;
  empresa: Empresa;
  proveedor: string;
  monto: number;
  moneda: string;
  fecha: string;
  concepto: string;
  rutaLocal: string;
  nombreArchivoOriginal: string;
  mimeType?: string;
  candidatos: PurchaseCandidato[];
  /** Desglose de IVA leído de la factura — se usa al crear el gasto en Holded. */
  lineas: LineaFactura[];
  chatId: number;
  /**
   * Id real del mensaje de Telegram con los botones — se guarda en 0 al crear la propuesta (antes de
   * mandar el mensaje) y se actualiza al id real una vez enviado. 0 es un sentinel válido: Telegram
   * nunca asigna message_id=0 a un mensaje real (ver sendTelegramMessageWithButtons), así que
   * messageId===0 significa de forma confiable "esta propuesta nunca llegó a mostrarse" — usado por
   * el chequeo de "propuesta huérfana" (procesarGastoEntrante.ts) y por el vigilante automático
   * (vigilarProcesamientoAtascado.ts) para no confundir una propuesta que existe en Sheets con una
   * que Carlos de verdad llegó a ver.
   */
  messageId: number;
  creadoEn: number;
  /** Cuenta contable inferida (ver inferirCuentaGasto) — se usa al crear el gasto en Holded, si se pudo inferir. */
  cuentaId?: string;
  cuentaTags?: string[];
  /**
   * true si este gasto vino de un adjunto de la cola de revisión de correo
   * uno a uno (ver core/gmail/colaRevisionStore.ts) — gastoCallbackHandler.ts
   * lo usa para decidir si avanzar esa cola al resolverse. Bug real
   * encontrado en auditoría: sin este marcador, resolver un gasto CUALQUIERA
   * (ej. una foto de un recibo mandada por Telegram, sin relación con
   * ningún correo) hacía avanzar/marcar-como-leído el correo activo de la
   * cola si había uno en curso — dos flujos totalmente independientes que
   * comparten el mismo chat, sin ninguna relación real entre sí.
   */
  deColaCorreo?: boolean;
  /**
   * Si rutaLocal viene de un adjunto real de Gmail, sus ids — permite volver
   * a descargarlo de la fuente durable si la copia local (tmp/uploads, no
   * sobrevive un redeploy de Railway) se pierde antes de adjuntarlo al gasto
   * en Holded. Bug real encontrado en vivo (2026-09-03): un gasto se creó
   * SIN su comprobante porque la propuesta en Sheets sobrevivió un redeploy
   * pero la copia local no. Ver core/gmail/reDescargarAdjunto.ts.
   */
  origenAdjuntoGmail?: { mensajeIdGmail: string; attachmentIdGmail: string };
  /**
   * Pedido explícito de Carlos: el número real del documento (factura/
   * recibo/ticket), tal como aparece impreso — se usa para diligenciar
   * "Número de documento" al crear el gasto en Holded. undefined si no se
   * pudo identificar con claridad (nunca un número inventado).
   */
  numeroDocumento?: string;
  /**
   * Monto real extraído de la factura al crear la propuesta, NUNCA tocado
   * por actualizarMontoPropuestaGasto — permite que buscarPropuestaGastoPendiente
   * siga detectando un reenvío del MISMO correo aunque "monto" ya se haya
   * ajustado (ej. a la mitad). Bug real de auditoría: sin este campo, un
   * reenvío del correo original de INDUBUILDING LUARCA tras ajustar el
   * monto a la mitad ya no coincidía dentro del margen de montosCercanos,
   * generando una propuesta duplicada para la misma factura. undefined
   * solo en filas viejas creadas antes de este campo.
   */
  montoOriginal?: number;
  /**
   * Datos del correo del que vino esta factura/gasto — permite ofrecer, como
   * acciones ADICIONALES a registrar el gasto, responder ese correo o
   * guardarlo como conocimiento (ver gastoCallbackHandler.ts,
   * gasto_responder/gasto_guardarconocimiento/gasto_otrasacciones). Pedido
   * explícito de Carlos, tras un caso real (INDUBUILDING LUARCA): "no solo
   * registrar el gasto... deberíamos poder responder el mail o dejar como
   * conocimiento o programar un recordatorio... puede ser 1 sola cosa o
   * pueden ser varias". undefined si el gasto no vino de un correo (ej. una
   * foto mandada por Telegram).
   */
  correoOrigen?: { de: string; asunto: string; threadId: string; messageIdHeader: string; mensajeIdGmail?: string };
  /**
   * Acciones actualmente marcadas (☑️) en el teclado de selección — ver
   * gastoTeclado.ts. Pedido explícito de Carlos: "activar una o varias y
   * luego aprobar" — tocar un check solo cambia este campo (no ejecuta
   * nada); solo "▶️ Aprobar selección" (gasto_aprobar en
   * gastoCallbackHandler.ts) lee esto y ejecuta todo lo marcado junto.
   * Estado puramente de UI, no de negocio — vacío/undefined = nada
   * marcado todavía.
   */
  seleccionAcciones?: string[];
  /**
   * true si al mandar la propuesta se encontró un movimiento bancario real
   * sin conciliar que coincide — decide si el teclado de selección
   * (gastoTeclado.ts) ofrece "Crear y conciliar" además de "Crear". Se
   * guarda acá (en vez de recalcularlo) porque el teclado se REPINTA en
   * cada toque de un check (ver gasto_toggle, gastoCallbackHandler.ts) y
   * repetir la búsqueda de movimiento bancario en cada toque sería trabajo
   * repetido para un dato que no cambia mientras la propuesta esté viva.
   */
  hayMovimientoBancario?: boolean;
  /**
   * Pedido explícito de Carlos, tras un caso real: cuando hay VARIOS movimientos bancarios parecidos
   * (ninguno exacto y único), antes solo se podía elegir cuál respondiendo en texto libre — pero eso
   * no se puede combinar con los checks del teclado ("no tengo la posibilidad de darte las dos
   * respuestas al mismo tiempo"). Se guardan acá los candidatos para que gastoTeclado.ts pueda ofrecer
   * un check "Conciliar con #N" por cada uno, y así elegir empresa + conciliar en la MISMA aprobación.
   */
  movimientosAmbiguos?: MovimientoBancarioCandidato[];
}

let writeClient: sheets_v4.Sheets | null = null;
let tabGridId: number | null = null;

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

function getClient(): sheets_v4.Sheets {
  if (writeClient) return writeClient;

  const credentials = loadServiceAccountCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  writeClient = google.sheets({ version: "v4", auth });
  return writeClient;
}

async function ensureTab(): Promise<number> {
  if (tabGridId !== null) return tabGridId;

  const sheetId = assertSheetId();
  const sheets = getClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB_NAME);

  if (existing?.properties?.sheetId != null) {
    tabGridId = existing.properties.sheetId;
    return tabGridId;
  }

  const addResp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME, hidden: true } } }] },
  });

  const newSheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId == null) {
    throw new Error("No se pudo crear la pestaña de gastos pendientes.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A1:Y1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  tabGridId = newSheetId;
  return tabGridId;
}

function rowToPropuesta(row: unknown[]): PropuestaGasto | null {
  if (!row[0]) return null;

  let candidatos: PurchaseCandidato[] = [];
  try {
    candidatos = row[10] ? JSON.parse(String(row[10])) : [];
  } catch {
    candidatos = [];
  }

  let lineas: LineaFactura[] = [];
  try {
    lineas = row[14] ? JSON.parse(String(row[14])) : [];
  } catch {
    lineas = [];
  }

  let cuentaTags: string[] | undefined;
  try {
    cuentaTags = row[16] ? JSON.parse(String(row[16])) : undefined;
  } catch {
    cuentaTags = undefined;
  }

  let origenAdjuntoGmail: PropuestaGasto["origenAdjuntoGmail"];
  try {
    origenAdjuntoGmail = row[18] ? JSON.parse(String(row[18])) : undefined;
  } catch {
    origenAdjuntoGmail = undefined;
  }

  let correoOrigen: PropuestaGasto["correoOrigen"];
  try {
    correoOrigen = row[21] ? JSON.parse(String(row[21])) : undefined;
  } catch {
    correoOrigen = undefined;
  }

  let seleccionAcciones: string[] | undefined;
  try {
    seleccionAcciones = row[22] ? JSON.parse(String(row[22])) : undefined;
  } catch {
    seleccionAcciones = undefined;
  }

  let movimientosAmbiguos: MovimientoBancarioCandidato[] | undefined;
  try {
    movimientosAmbiguos = row[24] ? JSON.parse(String(row[24])) : undefined;
  } catch {
    movimientosAmbiguos = undefined;
  }

  return {
    id: String(row[0]),
    empresa: row[1] as Empresa,
    proveedor: row[2] ? String(row[2]) : "",
    monto: Number(row[3]) || 0,
    moneda: row[4] ? String(row[4]) : "EUR",
    fecha: row[5] ? String(row[5]) : "",
    concepto: row[6] ? String(row[6]) : "",
    rutaLocal: row[7] ? String(row[7]) : "",
    nombreArchivoOriginal: row[8] ? String(row[8]) : "",
    mimeType: row[9] ? String(row[9]) : undefined,
    candidatos,
    lineas,
    chatId: Number(row[11]) || 0,
    messageId: Number(row[12]) || 0,
    creadoEn: Number(row[13]) || 0,
    cuentaId: row[15] ? String(row[15]) : undefined,
    cuentaTags,
    deColaCorreo: row[17] === true || row[17] === "true",
    origenAdjuntoGmail,
    numeroDocumento: row[19] ? String(row[19]) : undefined,
    montoOriginal: row[20] !== undefined && row[20] !== "" ? Number(row[20]) : undefined,
    correoOrigen,
    seleccionAcciones,
    // Hallazgo real de auditoría (2026-09-07): row[23]==="" NUNCA distinguía "nunca se calculó
    // todavía" (undefined) de "se calculó y dio false" — ambos se escribían/leían como la misma
    // cadena vacía. reenviarPropuestaGasto.ts necesita esa distinción exacta para saber si vale la
    // pena repetir la búsqueda de movimiento bancario en vivo (solo cuando de verdad nunca se
    // completó) — sin ella, ese chequeo (=== undefined) nunca era true para ninguna propuesta leída
    // de Sheets, así que la búsqueda en vivo nunca se disparaba.
    hayMovimientoBancario: row[23] === "" || row[23] == null ? undefined : row[23] === true || row[23] === "true",
    movimientosAmbiguos,
  };
}

function propuestaToRow(p: PropuestaGasto): (string | number)[] {
  return [
    p.id,
    p.empresa,
    p.proveedor,
    p.monto,
    p.moneda,
    p.fecha,
    p.concepto,
    p.rutaLocal,
    p.nombreArchivoOriginal,
    p.mimeType ?? "",
    JSON.stringify(p.candidatos),
    p.chatId,
    p.messageId,
    p.creadoEn,
    JSON.stringify(p.lineas),
    p.cuentaId ?? "",
    JSON.stringify(p.cuentaTags ?? []),
    p.deColaCorreo === true ? "true" : "",
    p.origenAdjuntoGmail ? JSON.stringify(p.origenAdjuntoGmail) : "",
    p.numeroDocumento ?? "",
    p.montoOriginal ?? "",
    p.correoOrigen ? JSON.stringify(p.correoOrigen) : "",
    p.seleccionAcciones && p.seleccionAcciones.length > 0 ? JSON.stringify(p.seleccionAcciones) : "",
    p.hayMovimientoBancario === undefined ? "" : p.hayMovimientoBancario ? "true" : "false",
    p.movimientosAmbiguos && p.movimientosAmbiguos.length > 0 ? JSON.stringify(p.movimientosAmbiguos) : "",
  ];
}

interface FilaConIndice {
  rowIndex: number;
  propuesta: PropuestaGasto;
}

async function leerTodas(): Promise<FilaConIndice[]> {
  await ensureTab();
  const sheetId = assertSheetId();
  const sheets = getClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A2:Y10000`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = resp.data.values ?? [];
  const result: FilaConIndice[] = [];
  rows.forEach((row, i) => {
    const propuesta = rowToPropuesta(row);
    if (propuesta) result.push({ rowIndex: i + 2, propuesta });
  });
  return result;
}

async function eliminarFila(rowIndex1Based: number): Promise<void> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  const gridId = await ensureTab();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId: gridId, dimension: "ROWS", startIndex: rowIndex1Based - 1, endIndex: rowIndex1Based },
          },
        },
      ],
    },
  });
}

async function purgarVencidas(): Promise<void> {
  const todas = await leerTodas();
  const ahora = Date.now();
  const vencidas = todas.filter(({ propuesta }) => ahora - propuesta.creadoEn > TTL_MS);

  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const { rowIndex } of vencidas) {
    await eliminarFila(rowIndex);
  }
}

/**
 * Bug real de gravedad alta encontrado en vivo (2026-09-08, caso MARNAPA SA DE CV/GDL Pastriva,
 * 4.96€): `values.append` con un rango de columnas (`A:Y`) le pide a Sheets que ADIVINE en qué fila Y
 * EN QUÉ COLUMNA empieza "la tabla" — y esa heurística puede fallar en silencio. Verificado en vivo:
 * 5 propuestas reales seguidas se escribieron completas SIN error, pero todas terminaron con sus
 * datos empezando en la columna U en vez de la A (el resto de la fila, A:T, quedó vacío) — probablemente
 * porque la fila de encabezados (row 1) solo tiene datos hasta la columna N (quedó desactualizada
 * cuando se agregaron más campos a HEADERS después, sin nunca reescribirla), y esa forma irregular
 * confundió la detección de "tabla" de append. El efecto real: leerTodas() lee row[0] esperando "id",
 * lo encuentra vacío (porque el id real está en la columna U), y descarta la fila como si no
 * existiera — la propuesta se manda a Telegram con botones reales, pero CUALQUIER búsqueda posterior
 * por id (incluyendo el propio botón "Crear" que Carlos toca) no encuentra nada: "Esta propuesta ya
 * no está disponible." Cada reintento repetía el mismo problema, generando una propuesta nueva
 * igualmente invisible cada vez — "leíste y me enviaste 2 mails al mismo tiempo y uno ha quedado
 * inactivo" es exactamente este bug visto desde el chat.
 *
 * La corrección de fondo: nunca dejar que Sheets adivine la fila/columna de un `append` — se calcula
 * la fila libre real a mano (ver siguienteFilaLibre) y se escribe con `values.update` sobre un rango
 * EXPLÍCITO (`A{fila}:Y{fila}`), que Sheets no puede reinterpretar ni desplazar.
 */
async function siguienteFilaLibre(): Promise<number> {
  const sheetId = assertSheetId();
  const sheets = getClient();
  // Rango ancho (A:Y, no solo A:A) a propósito: una fila ya rota por este mismo bug puede tener la
  // columna A vacía pero datos reales más a la derecha — hay que contarla igual para no escribir
  // encima de ella. values.get recorta las filas vacías al final, así que rows.length ya es "la
  // última fila con algo, en cualquier columna del rango".
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:Y`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = resp.data.values ?? [];
  return rows.length + 1;
}

const MAX_INTENTOS_ESCRITURA = 3;

/**
 * Calcular la fila libre y escribir ahí son dos llamadas separadas (values.get + values.update) —
 * sin ninguna transacción real de Sheets de por medio. El retry-con-verificación de abajo detecta una
 * colisión entre dos ESCRITURAS casi simultáneas, pero NUNCA una colisión con un BORRADO concurrente
 * (hallazgo real de auditoría xhigh, mismo día): si consumirPropuestaGasto elimina una fila (desplaza
 * todo lo de abajo hacia arriba) justo entre que esta función calculó "fila libre" y de verdad
 * escribe ahí, la escritura puede terminar pisando en silencio una fila COMPLETAMENTE AJENA que el
 * borrado desplazó hasta esa posición — destruyendo una propuesta real sin relación con esta llamada.
 * Nada de esto es hipotético: consumirPropuestaGasto se dispara en cada tap de un botón de Telegram,
 * mientras el cron de correo o el vigilante de atascados pueden estar creando una propuesta nueva al
 * mismo tiempo (exactamente el patrón real de esta misma noche). conMutex serializa TODA operación
 * que calcula/mueve filas de esta hoja en el propio proceso — nunca dos corren a la vez — cerrando
 * ambos huecos de raíz en vez de perseguir cada colisión una por una.
 */
export async function crearPropuestaGasto(datos: Omit<PropuestaGasto, "id" | "creadoEn">): Promise<PropuestaGasto> {
  return conMutex(TAB_NAME, async () => {
    await purgarVencidas();

    const sheetId = assertSheetId();
    const sheets = getClient();
    await ensureTab();

    // montoOriginal siempre se fija al monto real de creación, ignorando
    // cualquier valor que venga en datos — solo actualizarMontoPropuestaGasto
    // puede cambiar "monto" después, y nunca toca este campo.
    const propuesta: PropuestaGasto = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now(), montoOriginal: datos.monto };

    for (let intento = 0; intento < MAX_INTENTOS_ESCRITURA; intento++) {
      const fila = await siguienteFilaLibre();
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${fila}:Y${fila}`,
        valueInputOption: "RAW",
        requestBody: { values: [propuestaToRow(propuesta)] },
      });

      const verificacion = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${TAB_NAME}!A${fila}`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      if (verificacion.data.values?.[0]?.[0] === propuesta.id) return propuesta;

      console.error(
        `[gastoProposalSheet] Colisión al escribir la propuesta ${propuesta.id} en la fila ${fila} (otro proceso escribió ahí primero) — reintento ${intento + 1}/${MAX_INTENTOS_ESCRITURA}.`
      );
    }

    throw new Error(`No se pudo guardar la propuesta ${propuesta.id} tras ${MAX_INTENTOS_ESCRITURA} intentos por colisiones repetidas.`);
  });
}

export async function actualizarMessageIdGasto(id: string, messageId: number): Promise<void> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!M${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[messageId]] },
  });
}

/** Busca una fila por id de propuesta — helper compartido, evita repetir leerTodas()+find() en cada actualización (hallazgo real de auditoría). */
async function buscarFilaPropuesta(id: string): Promise<FilaConIndice | undefined> {
  const todas = await leerTodas();
  return todas.find(({ propuesta }) => propuesta.id === id);
}

export async function obtenerPropuestaGasto(id: string): Promise<PropuestaGasto | undefined> {
  return (await buscarFilaPropuesta(id))?.propuesta;
}

/** Todas las propuestas de gasto vigentes de un chat — para vigilarProcesamientoAtascado.ts, que necesita saber si ALGO ya se generó para un correo activo antes de considerarlo atascado. */
export async function obtenerPropuestasGastoPorChat(chatId: number): Promise<PropuestaGasto[]> {
  const todas = await leerTodas();
  return todas.filter(({ propuesta }) => propuesta.chatId === chatId).map(({ propuesta }) => propuesta);
}

/**
 * Pedido explícito de Carlos, tras un caso real: una cuota de comunidad se
 * paga a medias con otra parte, así que el gasto a registrar en Holded es
 * la MITAD del importe real de la factura — y no había ninguna forma de
 * ajustar el monto antes de crear el gasto (solo empresa/concepto, ver
 * continuarConCorreccionGasto). Actualiza monto y líneas de una propuesta
 * TODAVÍA pendiente (sin consumirla) — el llamador debe recalcular las
 * líneas manteniendo los mismos % de IVA/retención, solo escalando la base.
 */
export async function actualizarMontoPropuestaGasto(id: string, nuevoMonto: number, nuevasLineas: LineaFactura[]): Promise<boolean> {
  const match = await buscarFilaPropuesta(id);
  if (!match) return false;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!D${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[nuevoMonto]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!O${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[JSON.stringify(nuevasLineas)]] },
  });
  return true;
}

/**
 * Pedido explícito de Carlos, tras un caso real: un correo reportó un gasto de Uber Eats como
 * "$12.71" pero el cargo real había sido en euros — la MONEDA que reportaron estaba mal, no el
 * número. Actualiza moneda (y monto/líneas si también cambian, mismo criterio que
 * actualizarMontoPropuestaGasto) de una propuesta TODAVÍA pendiente — ver interpretarCorreccionGasto
 * en core/claude/client.ts para cómo se detecta esto a partir de una respuesta en texto libre.
 */
export async function actualizarMonedaPropuestaGasto(id: string, nuevaMoneda: string, nuevoMonto: number, nuevasLineas: LineaFactura[]): Promise<boolean> {
  const match = await buscarFilaPropuesta(id);
  if (!match) return false;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!D${match.rowIndex}:E${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[nuevoMonto, nuevaMoneda]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!O${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[JSON.stringify(nuevasLineas)]] },
  });
  return true;
}

/**
 * Marca/desmarca acciones en el teclado de selección (ver gastoTeclado.ts)
 * — puramente estado de UI, no dispara nada por sí sola. No consume la
 * propuesta (mismo criterio que actualizarMontoPropuestaGasto).
 */
export async function actualizarSeleccionAccionesGasto(id: string, acciones: string[]): Promise<boolean> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return false;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!W${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[acciones.length > 0 ? JSON.stringify(acciones) : ""]] },
  });
  return true;
}

/**
 * El resultado de la búsqueda de movimiento bancario ocurre DESPUÉS de
 * crearPropuestaGasto (solo aplica en la rama sin candidatos de Holded, ver
 * procesarGastoEntrante.ts) — se guarda con esta escritura de un solo campo
 * en vez de reordenar esa función, para no arriesgar el resto de su lógica.
 */
export async function actualizarFlagMovimientoBancarioGasto(id: string, hayMovimiento: boolean): Promise<boolean> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return false;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!X${match.rowIndex}`,
    valueInputOption: "RAW",
    // "false" explícito, nunca "" — "" significa "todavía no se calculó" (ver rowToPropuesta), y esta
    // función siempre recibe un boolean real (la búsqueda de movimiento ya se hizo, con o sin match).
    requestBody: { values: [[hayMovimiento ? "true" : "false"]] },
  });
  return true;
}

/**
 * Guarda los movimientos bancarios ambiguos (varios parecidos, ninguno único) para que
 * gastoTeclado.ts pueda ofrecer un check "Conciliar con #N" por cada uno — ver
 * PropuestaGasto.movimientosAmbiguos.
 */
export async function actualizarMovimientosAmbiguosPropuestaGasto(id: string, movimientos: MovimientoBancarioCandidato[]): Promise<boolean> {
  const match = await buscarFilaPropuesta(id);
  if (!match) return false;

  const sheetId = assertSheetId();
  const sheets = getClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!Y${match.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[JSON.stringify(movimientos)]] },
  });
  return true;
}

/**
 * Pedido explícito de Carlos: "Corregir clasificación" pasa a ser un
 * ajuste de campos NO consumidor — antes creaba el gasto de inmediato con
 * la corrección (ver el comentario histórico en continuarConCorreccionGasto,
 * gastoCallbackHandler.ts), lo que impedía combinarla con otras acciones
 * (ej. corregir Y ajustar el monto Y DESPUÉS crear, todo en una sola
 * aprobación). Mismo patrón que actualizarMontoPropuestaGasto: actualiza en
 * el lugar, deja la propuesta viva para que "Crear gasto" (más tarde, en la
 * misma aprobación o después) la relea ya corregida.
 */
export async function actualizarClasificacionPropuestaGasto(id: string, empresa: Empresa, concepto: string): Promise<boolean> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return false;

  const sheetId = assertSheetId();
  const sheets = getClient();
  const actual = match.propuesta;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!B${match.rowIndex}:G${match.rowIndex}`,
    valueInputOption: "RAW",
    // B..G en orden: empresa, proveedor, monto, moneda, fecha, concepto —
    // Sheets reemplaza el rango COMPLETO que se le pasa (no solo las celdas
    // que cambian), así que se relee la fila actual para no pisar
    // proveedor/monto/moneda/fecha con un update parcial.
    requestBody: { values: [[empresa, actual.proveedor, actual.monto, actual.moneda, actual.fecha, concepto]] },
  });
  return true;
}

/** Devuelve la propuesta y ELIMINA su fila de inmediato (aprobada o descartada). */
/** Bajo el mismo conMutex que crearPropuestaGasto (ver su comentario) — borra una fila real
 * (deleteDimension, desplaza todo lo de abajo), así que nunca puede correr a la vez que una
 * escritura esté calculando/usando "la próxima fila libre" de esta misma hoja. */
export async function consumirPropuestaGasto(id: string): Promise<PropuestaGasto | undefined> {
  return conMutex(TAB_NAME, async () => {
    const todas = await leerTodas();
    const match = todas.find(({ propuesta }) => propuesta.id === id);
    if (!match) return undefined;

    await eliminarFila(match.rowIndex);
    return match.propuesta;
  });
}

/**
 * Busca, entre las propuestas de gasto TODAVÍA sin resolver (no consumidas
 * — nadie tocó "Crear"/"Cancelar" todavía), una que ya sea del mismo
 * proveedor y monto — para evitar mandar una SEGUNDA propuesta de "Crear
 * gasto" cuando la primera sigue viva. Bug real encontrado en vivo
 * (2026-09-03): un correo se volvió a marcar como no leído (pedido
 * explícito de Carlos: eso SIEMPRE debe re-analizarse) y el sistema mandó
 * una propuesta nueva sin darse cuenta de que la de un día antes seguía
 * sin resolver — dos botones "Crear" vivos para la MISMA factura (LUARCA
 * JULIO 2026, 3.448,28€), con el riesgo real de duplicar el gasto en
 * Holded si se tocan los dos. El chequeo de duplicados existente
 * (buscarGastoSimilar, en core/holded/write.ts) solo mira lo que YA está
 * creado en Holded — nunca las propuestas que siguen pendientes de
 * aprobación, que es exactamente el hueco que esto cierra. Mismo criterio
 * de similitud (textosParecidos + montosCercanos) que el resto del
 * sistema usa para detectar duplicados.
 */
export async function buscarPropuestaGastoPendiente(
  empresa: Empresa,
  proveedor: string,
  monto: number
): Promise<PropuestaGasto | undefined> {
  const todas = await leerTodas();
  const match = todas.find(
    ({ propuesta }) =>
      propuesta.empresa === empresa &&
      textosParecidos(proveedor, propuesta.proveedor) &&
      montosCercanos(monto, propuesta.montoOriginal ?? propuesta.monto, 0.05)
  );
  return match?.propuesta;
}
