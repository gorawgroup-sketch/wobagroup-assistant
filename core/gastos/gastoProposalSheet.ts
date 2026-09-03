import { randomUUID } from "node:crypto";
import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { textosParecidos } from "../utils/textoParecido";
import { montosCercanos } from "../utils/montos";
import type { Empresa } from "../holded/client";
import type { PurchaseCandidato } from "../holded/write";
import type { LineaFactura } from "../documental/extractInvoiceData";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;
const TAB_NAME = "_gastos_pendientes";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días, igual que las demás propuestas

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
    range: `${TAB_NAME}!A1:U1`,
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
    range: `${TAB_NAME}!A2:U10000`,
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

export async function crearPropuestaGasto(datos: Omit<PropuestaGasto, "id" | "creadoEn">): Promise<PropuestaGasto> {
  await purgarVencidas();

  const sheetId = assertSheetId();
  const sheets = getClient();
  await ensureTab();

  // montoOriginal siempre se fija al monto real de creación, ignorando
  // cualquier valor que venga en datos — solo actualizarMontoPropuestaGasto
  // puede cambiar "monto" después, y nunca toca este campo.
  const propuesta: PropuestaGasto = { ...datos, id: randomUUID().slice(0, 8), creadoEn: Date.now(), montoOriginal: datos.monto };

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_NAME}!A:U`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [propuestaToRow(propuesta)] },
  });

  return propuesta;
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

export async function obtenerPropuestaGasto(id: string): Promise<PropuestaGasto | undefined> {
  const todas = await leerTodas();
  return todas.find(({ propuesta }) => propuesta.id === id)?.propuesta;
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
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
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

/** Devuelve la propuesta y ELIMINA su fila de inmediato (aprobada o descartada). */
export async function consumirPropuestaGasto(id: string): Promise<PropuestaGasto | undefined> {
  const todas = await leerTodas();
  const match = todas.find(({ propuesta }) => propuesta.id === id);
  if (!match) return undefined;

  await eliminarFila(match.rowIndex);
  return match.propuesta;
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
