import { createHash } from "node:crypto";
import { actualizarFila, agregarFilaAtomica, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";

const TAB_NAME = "_instrucciones_correo_aprendidas";
const HEADERS = [
  "clave",
  "remitente",
  "alcance",
  "patronAsunto",
  "instruccion",
  "activa",
  "vecesConfirmada",
  "creadaEn",
  "actualizadaEn",
  "mensajeIdOrigen",
];
const NUM_COLS = HEADERS.length;
const MUTEX = `instrucciones-correo-aprendidas:${TAB_NAME}`;
const TTL_CACHE_MS = 2 * 60_000;
const MAX_INSTRUCCION_CHARS = 1_200;

export type AlcanceInstruccionCorreo = "remitente" | "remitente_asunto";

export interface InstruccionCorreoAprendida {
  rowIndex: number;
  clave: string;
  remitente: string;
  alcance: AlcanceInstruccionCorreo;
  patronAsunto: string;
  instruccion: string;
  activa: boolean;
  vecesConfirmada: number;
  creadaEn: string;
  actualizadaEn: string;
  mensajeIdOrigen: string;
}

interface CacheReglas {
  cargadaEn: number;
  filas: InstruccionCorreoAprendida[];
}

let cache: CacheReglas | undefined;

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extraerEmailRemitente(de: string): string {
  const entreAngulos = de.match(/<([^<>\s]+@[^<>\s]+)>/i)?.[1];
  const suelto = de.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  return (entreAngulos || suelto || de).trim().toLowerCase();
}

const PALABRAS_VACIAS = new Set([
  "re", "fw", "fwd", "de", "del", "la", "las", "el", "los", "un", "una", "para", "por", "con", "and", "the",
]);

export function patronDeAsunto(asunto: string): string {
  const limpio = normalizar(asunto.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, ""));
  const tokens = limpio
    .split(" ")
    .map((token) => token.replace(/[\d_]+/g, ""))
    .filter((token) => token.length >= 3 && !PALABRAS_VACIAS.has(token));
  return [...new Set(tokens)].slice(0, 10).join(" ");
}

const MARCAS_REUTILIZABLES = [
  /\bsiempre\b/i,
  /\bcada vez\b/i,
  /\bde ahora en adelante\b/i,
  /\ben adelante\b/i,
  /\bpara (?:los )?(?:futuros?|proximos?)\b/i,
  /\bcuando lleguen?\b/i,
  /\bestos? (?:tipos? de )?correos?\b/i,
  /\baprende (?:esta|esto|que)\b/i,
  /\bguarda (?:esta|esto) como regla\b/i,
  /\brecuerda que\b/i,
];

/** Solo una instrucción explícitamente futura se convierte en regla; las órdenes puntuales no. */
export function esInstruccionReutilizable(instruccion: string): boolean {
  const texto = instruccion.trim();
  return texto.length >= 8 && texto.length <= MAX_INSTRUCCION_CHARS && MARCAS_REUTILIZABLES.some((patron) => patron.test(texto));
}

function alcanceDe(instruccion: string): AlcanceInstruccionCorreo {
  return /\b(?:todos?|cualquier|cada) (?:los? )?correos? (?:de|del) (?:este )?(?:remitente|contacto)\b/i.test(instruccion) ||
    /\bsiempre que (?:este )?(?:remitente|contacto)\b/i.test(instruccion)
    ? "remitente"
    : "remitente_asunto";
}

export function instruccionSustituyeAnteriores(instruccion: string): boolean {
  return /\b(?:ya no|en vez de|sustituye|reemplaza|corrige (?:la|esta) regla|cambia (?:la|esta) instruccion)\b/i.test(instruccion);
}

function claveDe(remitente: string, alcance: AlcanceInstruccionCorreo, patronAsunto: string, instruccion: string): string {
  return createHash("sha256")
    .update([remitente, alcance, patronAsunto, normalizar(instruccion)].join("|"))
    .digest("hex");
}

function filaAObjeto(rowIndex: number, valores: string[]): InstruccionCorreoAprendida | undefined {
  const alcance = valores[2] as AlcanceInstruccionCorreo;
  if (!valores[0] || !valores[1] || !valores[4] || (alcance !== "remitente" && alcance !== "remitente_asunto")) {
    return undefined;
  }
  return {
    rowIndex,
    clave: valores[0],
    remitente: valores[1],
    alcance,
    patronAsunto: valores[3] || "",
    instruccion: valores[4],
    activa: valores[5] !== "false",
    vecesConfirmada: Math.max(1, Number(valores[6]) || 1),
    creadaEn: valores[7] || "",
    actualizadaEn: valores[8] || "",
    mensajeIdOrigen: valores[9] || "",
  };
}

function objetoAFila(regla: Omit<InstruccionCorreoAprendida, "rowIndex">): (string | number)[] {
  return [
    regla.clave,
    regla.remitente,
    regla.alcance,
    regla.patronAsunto,
    regla.instruccion,
    regla.activa ? "true" : "false",
    regla.vecesConfirmada,
    regla.creadaEn,
    regla.actualizadaEn,
    regla.mensajeIdOrigen,
  ];
}

async function leerTodas(forzar = false): Promise<InstruccionCorreoAprendida[]> {
  if (!forzar && cache && Date.now() - cache.cargadaEn < TTL_CACHE_MS) return cache.filas;
  const filas = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS))
    .map((fila) => filaAObjeto(fila.rowIndex, fila.valores))
    .filter((fila): fila is InstruccionCorreoAprendida => Boolean(fila));
  cache = { cargadaEn: Date.now(), filas };
  return filas;
}

function mismoAlcance(
  regla: Pick<InstruccionCorreoAprendida, "remitente" | "alcance" | "patronAsunto">,
  remitente: string,
  alcance: AlcanceInstruccionCorreo,
  patronAsunto: string
): boolean {
  return regla.remitente === remitente && regla.alcance === alcance &&
    (alcance === "remitente" || regla.patronAsunto === patronAsunto);
}

export async function registrarInstruccionCorreoAprendida(datos: {
  de: string;
  asunto: string;
  instruccion: string;
  mensajeIdOrigen?: string;
}): Promise<{ guardada: boolean; reemplazo: boolean }> {
  if (!esInstruccionReutilizable(datos.instruccion)) return { guardada: false, reemplazo: false };

  const remitente = extraerEmailRemitente(datos.de);
  const alcance = alcanceDe(datos.instruccion);
  const patronAsunto = alcance === "remitente" ? "" : patronDeAsunto(datos.asunto);
  if (!remitente || (alcance === "remitente_asunto" && !patronAsunto)) return { guardada: false, reemplazo: false };

  const clave = claveDe(remitente, alcance, patronAsunto, datos.instruccion);
  const reemplazo = instruccionSustituyeAnteriores(datos.instruccion);
  await conMutex(MUTEX, async () => {
    const filas = await leerTodas(true);
    const ahora = new Date().toISOString();
    const exacta = filas.find((fila) => fila.clave === clave);

    if (reemplazo) {
      for (const anterior of filas.filter((fila) => fila.activa && fila.clave !== clave && mismoAlcance(fila, remitente, alcance, patronAsunto))) {
        await actualizarFila(TAB_NAME, anterior.rowIndex, NUM_COLS, objetoAFila({ ...anterior, activa: false, actualizadaEn: ahora }));
      }
    }

    const siguiente: Omit<InstruccionCorreoAprendida, "rowIndex"> = {
      clave,
      remitente,
      alcance,
      patronAsunto,
      instruccion: datos.instruccion.trim(),
      activa: true,
      vecesConfirmada: (exacta?.vecesConfirmada ?? 0) + 1,
      creadaEn: exacta?.creadaEn || ahora,
      actualizadaEn: ahora,
      mensajeIdOrigen: datos.mensajeIdOrigen || exacta?.mensajeIdOrigen || "",
    };

    if (exacta) await actualizarFila(TAB_NAME, exacta.rowIndex, NUM_COLS, objetoAFila(siguiente));
    else await agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(siguiente));
    cache = undefined;
  });
  return { guardada: true, reemplazo };
}

function asuntoCoincide(patron: string, asunto: string): boolean {
  const a = new Set(patron.split(" ").filter(Boolean));
  const b = new Set(patronDeAsunto(asunto).split(" ").filter(Boolean));
  if (a.size === 0) return false;
  let comunes = 0;
  for (const token of a) if (b.has(token)) comunes++;
  return comunes >= Math.min(2, a.size) && comunes / a.size >= 0.5;
}

export function seleccionarInstruccionesAplicables(
  de: string,
  asunto: string,
  reglas: InstruccionCorreoAprendida[]
): InstruccionCorreoAprendida[] {
  const remitente = extraerEmailRemitente(de);
  return reglas
    .filter((regla) => regla.activa && regla.remitente === remitente)
    .filter((regla) => regla.alcance === "remitente" || asuntoCoincide(regla.patronAsunto, asunto))
    .sort((a, b) => b.vecesConfirmada - a.vecesConfirmada || b.actualizadaEn.localeCompare(a.actualizadaEn))
    .slice(0, 5);
}

export async function obtenerInstruccionesAplicablesCorreo(de: string, asunto: string): Promise<InstruccionCorreoAprendida[]> {
  return seleccionarInstruccionesAplicables(de, asunto, await leerTodas());
}

export async function obtenerTodasLasInstruccionesCorreoAprendidas(): Promise<InstruccionCorreoAprendida[]> {
  return leerTodas();
}
