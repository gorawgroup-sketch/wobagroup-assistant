import { actualizarFila, agregarFila, eliminarFilas, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";

/**
 * Estado durable de un correo a una audiencia mientras un superadministrador decide (y registro de lo enviado): una fila de cabecera con el
 * texto y una por destinatario. Vive en Sheets, así que sobrevive a un despliegue entre que se muestra el resumen y se pulsa «Enviar».
 */
const TAB_CABECERA = "_comunicaciones_masivas";
const HEADERS_CABECERA = ["id", "chatId", "messageId", "descripcion", "asunto", "cuerpo", "creadoEn"];
const TAB_DESTINATARIOS = "_comunicaciones_destinatarios";
const HEADERS_DESTINATARIOS = ["comunicacion", "indice", "nombre", "email", "empresas", "estado", "creadoEn", "detalle"];
const TTL_DESTINATARIOS_MS = 60 * 24 * 60 * 60 * 1000;
export const MAX_CARACTERES_CUERPO = 20_000;
export const mutexComunicacion = (id: string): string => `comunicacion-masiva:${id}`;

export type EstadoDestinatario = "pendiente" | "enviando" | "enviado" | "fallido" | "omitido";

export interface Cabecera { id: string; chatId: number; messageId: number; descripcion: string; asunto: string; cuerpo: string; creadoEn: number }
export interface DestinatarioGuardado { rowIndex: number; comunicacion: string; indice: number; nombre: string; email: string; empresas: string[]; estado: EstadoDestinatario; creadoEn: number; detalle?: string }
export interface Comunicacion { cabecera: Cabecera & { rowIndex: number }; destinatarios: DestinatarioGuardado[] }

const filaCabecera = (c: Cabecera): (string | number)[] => [c.id, c.chatId, c.messageId, c.descripcion, c.asunto, c.cuerpo, c.creadoEn];
const filaDestinatario = (d: Omit<DestinatarioGuardado, "rowIndex">): (string | number)[] => [d.comunicacion, d.indice, d.nombre, d.email, JSON.stringify(d.empresas), d.estado, d.creadoEn, d.detalle ?? ""];

function leerDestinatario(rowIndex: number, v: string[]): DestinatarioGuardado | undefined {
  let empresas: unknown;
  try { empresas = JSON.parse(v[4] || "[]"); } catch { return undefined; }
  if (!Array.isArray(empresas)) return undefined;
  return { rowIndex, comunicacion: v[0], indice: Number(v[1]), nombre: v[2], email: v[3], empresas: empresas.map(String), estado: v[5] as EstadoDestinatario, creadoEn: Number(v[6]) || 0, ...(v[7] ? { detalle: v[7] } : {}) };
}

export async function leerComunicacion(id: string): Promise<Comunicacion | undefined> {
  const cab = (await leerFilas(TAB_CABECERA, HEADERS_CABECERA.length, HEADERS_CABECERA)).find((f) => f.valores[0] === id);
  if (!cab) return undefined;
  const v = cab.valores;
  const destinatarios = (await leerFilas(TAB_DESTINATARIOS, HEADERS_DESTINATARIOS.length, HEADERS_DESTINATARIOS))
    .filter((f) => f.valores[0] === id).map((f) => leerDestinatario(f.rowIndex, f.valores)).filter((d): d is DestinatarioGuardado => !!d)
    .sort((a, b) => a.indice - b.indice);
  return { cabecera: { rowIndex: cab.rowIndex, id: v[0], chatId: Number(v[1]), messageId: Number(v[2]), descripcion: v[3], asunto: v[4], cuerpo: v[5], creadoEn: Number(v[6]) || 0 }, destinatarios };
}

export async function crearComunicacion(c: Cabecera, destinatarios: Array<Omit<DestinatarioGuardado, "rowIndex" | "comunicacion" | "creadoEn">>): Promise<void> {
  if (c.cuerpo.length > MAX_CARACTERES_CUERPO) throw new Error("El cuerpo del correo es demasiado largo para guardarlo.");
  await conMutex(mutexComunicacion(c.id), async () => {
    await agregarFila(TAB_CABECERA, HEADERS_CABECERA.length, HEADERS_CABECERA, filaCabecera(c));
    for (const d of destinatarios) await agregarFila(TAB_DESTINATARIOS, HEADERS_DESTINATARIOS.length, HEADERS_DESTINATARIOS, filaDestinatario({ ...d, comunicacion: c.id, creadoEn: c.creadoEn }));
  });
  void purgarDestinatariosCaducados();
}

/** El llamador debe sostener `mutexComunicacion`. */
export async function actualizarDestinatario(d: DestinatarioGuardado, estado: EstadoDestinatario): Promise<DestinatarioGuardado> {
  const siguiente = { ...d, estado };
  const { rowIndex: _ignorado, ...resto } = siguiente;
  await actualizarFila(TAB_DESTINATARIOS, d.rowIndex, HEADERS_DESTINATARIOS.length, filaDestinatario(resto));
  return siguiente;
}

export async function fijarMensaje(id: string, messageId: number): Promise<void> {
  await conMutex(mutexComunicacion(id), async () => {
    const c = await leerComunicacion(id);
    if (c) await actualizarFila(TAB_CABECERA, c.cabecera.rowIndex, HEADERS_CABECERA.length, filaCabecera({ ...c.cabecera, messageId }));
  });
}

/** Emails a los que ya se envió un correo con ESE asunto en los últimos días (para avisar de un posible reenvío). */
export async function enviosPrevios(asunto: string, emails: readonly string[], ahora = Date.now(), dias = 30): Promise<string[]> {
  const desde = ahora - dias * 86_400_000;
  const ids = new Set((await leerFilas(TAB_CABECERA, HEADERS_CABECERA.length, HEADERS_CABECERA)).filter((f) => f.valores[4] === asunto && (Number(f.valores[6]) || 0) >= desde).map((f) => f.valores[0]));
  if (ids.size === 0) return [];
  const buscados = new Set(emails.map((e) => e.toLowerCase()));
  const enviados = (await leerFilas(TAB_DESTINATARIOS, HEADERS_DESTINATARIOS.length, HEADERS_DESTINATARIOS))
    .filter((f) => ids.has(f.valores[0]) && f.valores[5] === "enviado" && buscados.has(String(f.valores[3]).toLowerCase())).map((f) => String(f.valores[3]).toLowerCase());
  return [...new Set(enviados)];
}

async function purgarDestinatariosCaducados(): Promise<void> {
  try {
    const filas = await leerFilas(TAB_DESTINATARIOS, HEADERS_DESTINATARIOS.length, HEADERS_DESTINATARIOS);
    const vencidas = filas.filter((f) => Date.now() - (Number(f.valores[6]) || 0) > TTL_DESTINATARIOS_MS).map((f) => f.rowIndex);
    if (vencidas.length) await eliminarFilas(TAB_DESTINATARIOS, vencidas, HEADERS_DESTINATARIOS);
  } catch (error) {
    console.error("[comunicaciones] No se pudieron purgar destinatarios caducados (no crítico):", error instanceof Error ? error.message : error);
  }
}

/** Comunicaciones creadas en los últimos días, con los destinatarios a los que SÍ se envió (para el seguimiento de respuestas). */
export async function listarComunicacionesRecientes(dias = 14, ahora = Date.now()): Promise<Comunicacion[]> {
  const desde = ahora - dias * 86_400_000;
  const cabeceras = (await leerFilas(TAB_CABECERA, HEADERS_CABECERA.length, HEADERS_CABECERA)).filter((f) => (Number(f.valores[6]) || 0) >= desde);
  if (cabeceras.length === 0) return [];
  const todos = (await leerFilas(TAB_DESTINATARIOS, HEADERS_DESTINATARIOS.length, HEADERS_DESTINATARIOS)).map((f) => leerDestinatario(f.rowIndex, f.valores)).filter((d): d is DestinatarioGuardado => !!d);
  return cabeceras.map((f) => {
    const v = f.valores;
    return { cabecera: { rowIndex: f.rowIndex, id: v[0], chatId: Number(v[1]), messageId: Number(v[2]), descripcion: v[3], asunto: v[4], cuerpo: v[5], creadoEn: Number(v[6]) || 0 },
      destinatarios: todos.filter((d) => d.comunicacion === v[0] && d.estado === "enviado").sort((a, b) => a.indice - b.indice) };
  }).filter((c) => c.destinatarios.length > 0);
}
