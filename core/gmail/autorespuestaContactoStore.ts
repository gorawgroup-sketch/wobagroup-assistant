import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import { extraerDireccionCorreo } from "./client";

/**
 * Lista de contactos aprobados para conversación automática por correo (ver
 * revisarConversacionesAutomaticas.ts) — pedido explícito de Carlos: poder
 * sostener una conversación fluida con destinatarios específicos, donde
 * Wobi lee, redacta y ENVÍA la respuesta sin esperar un botón, algo que
 * ningún otro flujo de correo hace. La aprobación es POR CONTACTO y de una
 * sola vez (al agregarlo acá) — "Carlos me dirá con cuáles", nunca se
 * agrega nadie sola. Sheets, no memoria — mismo motivo que el resto de los
 * stores del proyecto (Railway es efímero, un redeploy no debe borrar la
 * lista de contactos aprobados).
 */
export interface ContactoAutorespuesta {
  email: string;
  nombre: string;
  agregadoEn: number;
}

const TAB_NAME = "_contactos_autorespuesta";
const HEADERS = ["email", "nombre", "agregadoEn"];
const NUM_COLS = HEADERS.length;

function filaAObjeto(valores: string[]): ContactoAutorespuesta {
  return {
    email: valores[0]?.toLowerCase() ?? "",
    nombre: valores[1] || "",
    agregadoEn: Number(valores[2]) || 0,
  };
}

async function leerTodos(): Promise<{ rowIndex: number; contacto: ContactoAutorespuesta }[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return filas.map((f) => ({ rowIndex: f.rowIndex, contacto: filaAObjeto(f.valores) }));
}

export async function listarContactosAutorespuesta(): Promise<ContactoAutorespuesta[]> {
  const todos = await leerTodos();
  return todos.map((f) => f.contacto);
}

/**
 * true si `de` (un header "From" crudo, tipo `Nombre <correo@dominio.com>`, o ya una dirección
 * pura) es de un contacto de la lista aprobada — SIEMPRE por igualdad exacta de la dirección real
 * extraída (ver extraerDireccionCorreo), nunca por subcadena del texto completo del remitente:
 * hallazgo real de auditoría, cualquiera puede poner el email que sea dentro de su propio nombre
 * visible y colarse si esto comparara por subcadena.
 */
export async function esContactoAutorespuesta(de: string): Promise<boolean> {
  const todos = await listarContactosAutorespuesta();
  const direccion = extraerDireccionCorreo(de);
  return todos.some((c) => c.email === direccion);
}

/** No duplica si el email ya estaba — actualiza el nombre si vino distinto. */
export async function agregarContactoAutorespuesta(email: string, nombre: string): Promise<void> {
  const emailNorm = email.toLowerCase().trim();
  const todos = await leerTodos();
  const existente = todos.find((f) => f.contacto.email === emailNorm);
  if (existente) return;

  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, [emailNorm, nombre, Date.now()]);
}

/** true si de verdad había un contacto con ese email y se quitó. */
export async function quitarContactoAutorespuesta(email: string): Promise<boolean> {
  const emailNorm = email.toLowerCase().trim();
  const todos = await leerTodos();
  const fila = todos.find((f) => f.contacto.email === emailNorm);
  if (!fila) return false;

  await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  return true;
}
