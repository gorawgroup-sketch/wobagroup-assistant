import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { google } from "googleapis";
import { listBankMovements, listTreasuryAccounts, type Empresa } from "../holded/client";
import { loadServiceAccountCredentials } from "../google/serviceAccount";
import { agregarFila, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import type { CargoCorreo } from "./redactarCorreoSoportes";

/**
 * Hoja de seguimiento COMPARTIDA y editable por persona (pedido de Simon Talloen, 2026-09-14 y 2026-10-09, aprobado por Carlos):
 * un Google Sheet fijo por titular —siempre el mismo archivo— donde ve el estado de cada cargo, cuándo se le pidió y puede escribir
 * comentarios. Wobi la mantiene tras cada campaña de soportes SIN tocar nunca las columnas de comentario y respuesta, y marca lo ya
 * pedido para que nadie tenga que revisar dos veces lo mismo. Sustituye al Excel que se adjuntaba cada vez (una copia nueva, sin los
 * comentarios anteriores).
 *
 * Las funciones puras (`fusionarHoja`, `aplicarEstados`, `migrarEsquema`) deciden; el resto solo lee y escribe Drive/Sheets.
 */

export const PESTANA = "Soportes";
export const ENCABEZADOS = [
  "Date", "Merchant", "Original amount", "Orig. currency", "Card charge", "Acct. currency", "Status in Holded",
  "First requested", "Last requested", "Comment (edit here)", "Wobi's answer", "Updated",
];
const [C_FECHA, , , , C_CARGO, C_MONEDA, C_ESTADO, C_PRIMERA, C_ULTIMA, , , C_ACTUALIZADO] = ENCABEZADOS.map((_, i) => i);
export const ESTADO_PENDIENTE = "Pending – receipt needed";
export const ESTADO_CONCILIADO = "Done (matched in Holded)";
export const ESTADO_PARCIAL = "Partly matched in Holded";
const TAB_HOJAS = "_hojas_soportes";
const HEADERS_HOJAS = ["empresa", "email", "titular", "spreadsheetId", "url", "creadoEn"];

const dias = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const pad = (fila: string[]): string[] => Array.from({ length: ENCABEZADOS.length }, (_, i) => String(fila[i] ?? ""));

/** ¿La fila de la hoja es este cargo? Mismo importe cargado, misma moneda de cuenta y fecha a ≤ 2 días (el banco y el extracto difieren un día). */
export function coincide(fila: string[], c: { fecha: string; cargo: number; monedaCuenta: string }): boolean {
  const importe = Number(String(fila[C_CARGO]).replace(",", "."));
  return Number.isFinite(importe) && Math.abs(importe - Math.abs(c.cargo)) < 0.011 && fila[C_MONEDA] === c.monedaCuenta && dias(String(fila[C_FECHA]), c.fecha) <= 2;
}

/**
 * La primera versión de la hoja (2026-10-09) tenía dos columnas «Requested Sep 14» / «Requested Oct 6» con «yes». Las dos pasan a
 * «First requested» / «Last requested» (fechas). Devuelve null si ya está en el esquema actual.
 */
export function migrarEsquema(valores: string[][]): string[][] | null {
  const cab = valores[0] ?? [];
  if (!/^Requested Sep/i.test(String(cab[C_PRIMERA] ?? ""))) return null;
  const filas = valores.slice(1).map((f) => {
    const f1 = String(f[C_PRIMERA] ?? "").toLowerCase() === "yes", f2 = String(f[C_ULTIMA] ?? "").toLowerCase() === "yes";
    const n = pad(f);
    n[C_PRIMERA] = f1 ? "2026-09-14" : f2 ? "2026-10-06" : "";
    n[C_ULTIMA] = f2 ? "2026-10-06" : f1 ? "2026-09-14" : "";
    return n;
  });
  return [ENCABEZADOS, ...filas];
}

export interface ResultadoFusion { filas: string[][]; nuevas: number; yaPedidas: number }

/**
 * Mete en la hoja los cargos de ESTA solicitud. Los que ya estaban conservan su comentario, su respuesta y su «primera vez pedido»; solo
 * cambian estado y «último pedido». Los nuevos se añaden al final. `yaPedidas` cuenta los que ya se habían pedido en una fecha anterior.
 */
export function fusionarHoja(existentes: string[][], cargos: CargoCorreo[], hoy: string): ResultadoFusion {
  const filas = existentes.map(pad);
  const usadas = new Set<number>();
  let nuevas = 0, yaPedidas = 0;
  for (const c of cargos) {
    const dato = { fecha: c.fecha, cargo: Math.abs(c.total), monedaCuenta: c.monedaCuenta };
    const i = filas.findIndex((f, k) => !usadas.has(k) && coincide(f, dato));
    if (i >= 0) {
      usadas.add(i);
      const f = filas[i];
      if (f[C_PRIMERA] && f[C_PRIMERA] < hoy) yaPedidas++;
      if (!f[C_PRIMERA]) f[C_PRIMERA] = hoy;
      f[C_ESTADO] = ESTADO_PENDIENTE; f[C_ULTIMA] = hoy; f[C_ACTUALIZADO] = hoy;
    } else {
      filas.push(pad([c.fecha, c.comercio, String(Math.abs(c.importeOriginal)), c.monedaOriginal, String(Math.abs(c.total)), c.monedaCuenta, ESTADO_PENDIENTE, hoy, hoy, "", "", hoy]));
      usadas.add(filas.length - 1);
      nuevas++;
    }
  }
  return { filas, nuevas, yaPedidas };
}

/** Refresca el estado de TODAS las filas con lo que dice Holded hoy (`estadoDe` devuelve undefined si no localiza el cargo: la fila no se toca). */
export function aplicarEstados(filas: string[][], estadoDe: (fecha: string, cargo: number, moneda: string) => string | undefined, hoy: string): number {
  let cambios = 0;
  for (const f of filas) {
    const e = estadoDe(String(f[C_FECHA]), Number(String(f[C_CARGO]).replace(",", ".")), String(f[C_MONEDA]));
    if (e && f[C_ESTADO] !== e) { f[C_ESTADO] = e; f[C_ACTUALIZADO] = hoy; cambios++; }
  }
  return cambios;
}

/* ───────── Holded: estado actual de cada cargo ───────── */

export async function estadosDesdeHolded(empresa: Empresa, desde: string, hasta: string): Promise<(fecha: string, cargo: number, moneda: string) => string | undefined> {
  const movs: Array<{ importe: number; fecha: string; moneda: string; estado: string }> = [];
  for (const c of (await listTreasuryAccounts(empresa)).filter((x) => !x.archived && x.type === "bank")) {
    for (const m of await listBankMovements(empresa, c.id, desde, hasta).catch((error) => {
      console.error(`[soportes] No se pudieron leer los movimientos de ${c.name} para la hoja (se deja el estado como estaba):`, error instanceof Error ? error.message : error);
      return [];
    })) {
      const raw = m as unknown as Record<string, unknown>;
      movs.push({ importe: Number(raw.amount), fecha: String(raw.date ?? raw.value_date ?? "").slice(0, 10), moneda: String(c.currency), estado: String(raw.status ?? raw.reconciliation_status ?? "") });
    }
  }
  return (fecha, cargo, moneda) => {
    const m = movs.find((x) => x.importe < 0 && Math.abs(Math.abs(x.importe) - Math.abs(cargo)) < 0.011 && x.moneda === moneda && dias(x.fecha, fecha) <= 2);
    if (!m) return undefined;
    return m.estado === "reconciled" ? ESTADO_CONCILIADO : m.estado.startsWith("partial") ? ESTADO_PARCIAL : ESTADO_PENDIENTE;
  };
}

/* ───────── Drive / Sheets ───────── */

function clienteSheets() {
  const c = loadServiceAccountCredentials();
  return google.sheets({ version: "v4", auth: new google.auth.JWT({ email: c.client_email, key: c.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
}
function clienteDrive() {
  const c = loadServiceAccountCredentials();
  return google.drive({ version: "v3", auth: new google.auth.JWT({ email: c.client_email, key: c.private_key, scopes: ["https://www.googleapis.com/auth/drive"], subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined }) });
}

export interface HojaRegistrada { id: string; url: string }

export async function buscarHoja(empresa: string, email: string): Promise<HojaRegistrada | undefined> {
  const fila = (await leerFilas(TAB_HOJAS, HEADERS_HOJAS.length, HEADERS_HOJAS)).map((f) => f.valores)
    .find((v) => v[0] === empresa && String(v[1]).trim().toLowerCase() === email.trim().toLowerCase() && v[3]);
  return fila ? { id: fila[3], url: fila[4] } : undefined;
}

async function xlsxInicial(titular: string, empresa: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(PESTANA, { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  ws.columns = ENCABEZADOS.map((h, i) => ({ header: h, width: [12, 30, 14, 9, 12, 9, 24, 12, 12, 55, 60, 11][i] }));
  const cab = ws.getRow(1);
  cab.font = { bold: true, color: { argb: "FFFFFFFF" } }; cab.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
  cab.alignment = { vertical: "middle", wrapText: true }; cab.height = 32;
  ws.autoFilter = { from: "A1", to: "L1" };
  const leeme = wb.addWorksheet("Read me");
  leeme.columns = [{ width: 110 }];
  for (const t of [
    `${empresa} – card expense support tracker for ${titular}`, "",
    "• This is ONE shared, editable sheet. We keep updating it; your comments are never deleted.",
    "• Write in the yellow column «Comment» whatever you want us to know: where you sent the receipt (date and recipient), that it is a duplicate, that it was refunded, etc.",
    "• Column «Wobi's answer» is where we reply to your comments.",
    "• «Status in Holded» is refreshed from the bank reconciliation. Pending = we still need the receipt or the match.",
    "• «First / Last requested» show when each charge was asked for, so you never have to review the same item twice.",
    "• Receipts: send them to asistente@wobagroup.com (one email per receipt is fine, subject with merchant, amount and currency).",
    "• Charges you already sent that still show as pending are normally waiting in our processing queue; tell us in the comment and we will check them first.",
  ]) leeme.addRow([t]);
  leeme.getRow(1).font = { bold: true, size: 13 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Crea la hoja (una sola vez por persona y empresa), la comparte con la cuenta de servicio y con la persona, y la registra. */
export async function asegurarHoja(empresa: string, titular: string, email: string): Promise<HojaRegistrada> {
  return conMutex(`soportes-hoja:${empresa}:${email.toLowerCase()}`, async () => {
    const existente = await buscarHoja(empresa, email);
    if (existente) return existente;
    const drive = clienteDrive();
    const creada = await drive.files.create({
      requestBody: { name: `${empresa} · Soportes pendientes · ${titular}`, mimeType: "application/vnd.google-apps.spreadsheet" },
      media: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: Readable.from(await xlsxInicial(titular, empresa)) },
      fields: "id,webViewLink", supportsAllDrives: true,
    });
    const id = creada.data.id;
    if (!id) throw new Error("Drive no devolvió el id de la hoja creada.");
    // Wobi la mantiene con la cuenta de servicio; la persona edita. Sin esto la hoja existiría pero nadie podría usarla.
    await drive.permissions.create({ fileId: id, requestBody: { type: "user", role: "writer", emailAddress: loadServiceAccountCredentials().client_email }, sendNotificationEmail: false, supportsAllDrives: true });
    await drive.permissions.create({ fileId: id, requestBody: { type: "user", role: "writer", emailAddress: email }, sendNotificationEmail: false, supportsAllDrives: true });
    const url = creada.data.webViewLink ?? `https://docs.google.com/spreadsheets/d/${id}/edit`;
    await agregarFila(TAB_HOJAS, HEADERS_HOJAS.length, HEADERS_HOJAS, [empresa, email, titular, id, url, Date.now()]);
    return { id, url };
  });
}

export interface ResultadoSincronizacion { url: string; nuevas: number; yaPedidas: number; estadosActualizados: number }

/**
 * Deja la hoja al día: migra el esquema viejo si hace falta, añade/actualiza los cargos de esta solicitud y refresca los estados desde
 * Holded. SOLO escribe las columnas de datos (A:I y L): jamás J:K, así lo que la persona escriba mientras tanto no se pisa.
 */
export async function sincronizarHoja(
  empresa: string, titular: string, email: string, cargos: CargoCorreo[],
  estadoDe: (fecha: string, cargo: number, moneda: string) => string | undefined, hoy: string = new Date().toISOString().slice(0, 10),
): Promise<ResultadoSincronizacion> {
  const hoja = await asegurarHoja(empresa, titular, email);
  return conMutex(`soportes-hoja-escritura:${hoja.id}`, async () => {
    const sheets = clienteSheets();
    const leido = (await sheets.spreadsheets.values.get({ spreadsheetId: hoja.id, range: `${PESTANA}!A1:L2000` })).data.values as string[][] | undefined ?? [];
    const migrado = migrarEsquema(leido);
    const base = (migrado ?? (leido.length ? leido : [ENCABEZADOS])).slice(1);
    const { filas, nuevas, yaPedidas } = fusionarHoja(base, cargos, hoy);
    const estadosActualizados = aplicarEstados(filas, estadoDe, hoy);
    const data: Array<{ range: string; values: string[][] }> = [{ range: `${PESTANA}!A1:L1`, values: [ENCABEZADOS] }];
    filas.forEach((f, i) => {
      const r = i + 2;
      if (i < base.length) {
        data.push({ range: `${PESTANA}!A${r}:I${r}`, values: [f.slice(0, 9)] }, { range: `${PESTANA}!L${r}`, values: [[f[C_ACTUALIZADO]]] });
      } else {
        data.push({ range: `${PESTANA}!A${r}:L${r}`, values: [f] });
      }
    });
    for (let i = 0; i < data.length; i += 200) {
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: hoja.id, requestBody: { valueInputOption: "RAW", data: data.slice(i, i + 200) } });
    }
    return { url: hoja.url, nuevas, yaPedidas, estadosActualizados };
  });
}

