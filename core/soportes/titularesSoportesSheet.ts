import { actualizarFila, agregarFilaAtomica, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import { buscarPersonas, listarPersonas } from "../directorio/directorioPersonasSheet";
import { claveTitular } from "./cruceExtracto";

/**
 * A quién se le escribe por cada titular de tarjeta. El nombre del extracto («Carlos Alberto Gonzalez Guerrero») es la
 * clave; el email lo da Carlos UNA vez («el correo de Yessenia es …») y queda guardado para todas las semanas siguientes.
 * Mientras no haya uno confirmado, se propone el del directorio de personas SOLO si es inequívoco, y el resumen lo marca
 * como «del directorio» para que Carlos lo vea antes de aprobar. Nunca se inventa un email.
 */
const TAB_NAME = "_titulares_soportes";
const HEADERS = ["clave", "nombre", "email", "actualizadoEn"];
const NUM_COLS = HEADERS.length;
const MUTEX = `soportes-titulares:${TAB_NAME}`;

interface Registro { rowIndex: number; clave: string; nombre: string; email: string; actualizadoEn: number }

async function cargar(): Promise<Map<string, Registro>> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return new Map(filas.map((f) => [f.valores[0], { rowIndex: f.rowIndex, clave: f.valores[0], nombre: f.valores[1], email: f.valores[2], actualizadoEn: Number(f.valores[3]) || 0 }]));
}

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function emailValido(email: string): boolean {
  return EMAIL.test(email.trim());
}

/** Guarda (o corrige) el email de un titular. Devuelve false si el email no tiene forma de dirección. */
export async function registrarEmailTitular(nombre: string, email: string): Promise<boolean> {
  const limpio = email.trim().toLowerCase();
  const clave = claveTitular(nombre);
  if (!clave || !emailValido(limpio)) return false;
  await conMutex(MUTEX, async () => {
    const actual = (await cargar()).get(clave);
    const fila = [clave, nombre.trim(), limpio, Date.now()];
    if (actual) await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, fila);
    else await agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, fila);
  });
  return true;
}

export interface EmailResuelto { email: string; fuente: "confirmado" | "directorio" }

const tokens = (t: string): string[] => claveTitular(t).split(" ").filter(Boolean);

/**
 * Coincidencia con el directorio: todas las palabras de la ficha (mínimo dos) están en el nombre del extracto, o a la
 * inversa. «Carlos Gonzalez» encaja con «Carlos Alberto Gonzalez Guerrero»; un nombre de pila suelto, no.
 */
export function coincideNombre(titular: string, fichaDirectorio: string): boolean {
  const a = tokens(titular), b = tokens(fichaDirectorio);
  if (a.length < 2 || b.length < 2) return false;
  return b.every((x) => a.includes(x)) || a.every((x) => b.includes(x));
}

export async function resolverEmailTitular(nombre: string): Promise<EmailResuelto | undefined> {
  const clave = claveTitular(nombre);
  if (!clave) return undefined;
  const guardado = (await cargar()).get(clave);
  if (guardado?.email && emailValido(guardado.email)) return { email: guardado.email, fuente: "confirmado" };

  const fichas = (await listarPersonas()).filter((p) => p.email && emailValido(p.email) && coincideNombre(nombre, p.nombre));
  const emails = [...new Set(fichas.map((p) => p.email.trim().toLowerCase()))];
  return emails.length === 1 ? { email: emails[0], fuente: "directorio" } : undefined;
}

/** Para sugerir al usuario qué direcciones conoce el directorio cuando no hay una inequívoca. */
export async function sugerirEmailsDelDirectorio(nombre: string): Promise<string[]> {
  const primero = tokens(nombre)[0];
  if (!primero) return [];
  const fichas = await buscarPersonas(primero);
  return [...new Set(fichas.filter((p) => p.email).map((p) => `${p.nombre || "(sin nombre)"} <${p.email}>`))].slice(0, 4);
}
