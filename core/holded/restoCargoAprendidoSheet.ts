import { actualizarFila, agregarFilaAtomica, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import type { Empresa } from "./client";

/**
 * Aprendizaje del RESTO de un cargo como gasto bancario (Carlos, 2026-10-16): cuando un cargo es mayor que su gasto por una comisión de transferencia,
 * la costumbre de la casa es registrar la diferencia como un gasto del banco (proveedor Revolut, borrador, sin adjunto, con la descripción del propio
 * cargo) y conciliarlo con el resto del cargo, de modo que el cargo quede conciliado al 100 %. Cada vez que Wobi aplica ese tratamiento y Holded lo
 * confirma, guarda aquí QUÉ plantilla se usó para esa persona y moneda; la próxima vez la propone sola (sigue necesitando el botón del superadmin).
 * Mismo principio que los demás almacenes de aprendizaje (conciliacionAprendidaSheet, ajusteCambioAprendidoSheet…): solo se alimenta de lo que Holded
 * confirmó, nunca de una propuesta.
 */
const TAB_NAME = "_resto_cargo_gasto_bancario_aprendido";
const HEADERS = ["clave", "empresa", "proveedor", "moneda", "plantillaCompraId", "contactId", "proveedorBanco", "cuentaId", "tagsJson", "veces", "actualizadoEn"];
const NUM_COLS = HEADERS.length;
const MUTEX = `resto-cargo-aprendido:${TAB_NAME}`;

export interface RestoCargoAprendido {
  rowIndex: number;
  clave: string;
  empresa: Empresa;
  proveedor: string;
  moneda: string;
  plantillaCompraId: string;
  contactId: string;
  proveedorBanco: string;
  cuentaId?: string;
  tags: string[];
  veces: number;
  actualizadoEn: string;
}

const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];
const normalizar = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const claveResto = (empresa: Empresa, proveedor: string, moneda: string): string => `${empresa}|${normalizar(proveedor)}|${moneda.trim().toUpperCase()}`;

export function restoDesdeFila(rowIndex: number, v: string[]): RestoCargoAprendido | undefined {
  if (!v[0] || !EMPRESAS.includes(v[1] as Empresa) || !v[4] || !v[5]) return undefined;
  let tags: string[] = [];
  try { const t = JSON.parse(v[8] || "[]"); if (Array.isArray(t)) tags = t.filter((x): x is string => typeof x === "string"); } catch { /* etiquetas ilegibles: se ignoran */ }
  return { rowIndex, clave: v[0], empresa: v[1] as Empresa, proveedor: v[2], moneda: (v[3] || "EUR").toUpperCase(), plantillaCompraId: v[4], contactId: v[5], proveedorBanco: v[6] || "", cuentaId: v[7] || undefined, tags, veces: Math.max(1, Number(v[9]) || 1), actualizadoEn: v[10] || "" };
}

async function leerTodos(): Promise<RestoCargoAprendido[]> {
  return (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).map((f) => restoDesdeFila(f.rowIndex, f.valores)).filter((x): x is RestoCargoAprendido => Boolean(x));
}

/** Tratamiento a proponer: el de ESA persona y moneda; si no hay, el más usado de la empresa en esa moneda (la plantilla del banco suele ser la misma). */
export function elegirRestoAprendido(registros: RestoCargoAprendido[], empresa: Empresa, proveedor: string, moneda: string): RestoCargoAprendido | undefined {
  const m = moneda.trim().toUpperCase();
  const propio = registros.find((r) => r.clave === claveResto(empresa, proveedor, m));
  if (propio) return propio;
  return registros.filter((r) => r.empresa === empresa && r.moneda === m).sort((a, b) => b.veces - a.veces || b.actualizadoEn.localeCompare(a.actualizadoEn))[0];
}

export async function buscarRestoAprendido(empresa: Empresa, proveedor: string, moneda: string): Promise<RestoCargoAprendido | undefined> {
  return elegirRestoAprendido(await leerTodos(), empresa, proveedor, moneda);
}

export async function registrarRestoComoGastoBancario(datos: { empresa: Empresa; proveedor: string; moneda: string; plantillaCompraId: string; contactId: string; proveedorBanco: string; cuentaId?: string; tags: string[] }): Promise<void> {
  if (!datos.proveedor.trim() || !datos.plantillaCompraId || !datos.contactId) return;
  const clave = claveResto(datos.empresa, datos.proveedor, datos.moneda);
  await conMutex(MUTEX, async () => {
    const actual = (await leerTodos()).find((r) => r.clave === clave);
    const fila = [clave, datos.empresa, datos.proveedor.trim(), datos.moneda.trim().toUpperCase(), datos.plantillaCompraId, datos.contactId, datos.proveedorBanco, datos.cuentaId ?? "", JSON.stringify(datos.tags), (actual?.veces ?? 0) + 1, new Date().toISOString()];
    if (actual) await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, fila);
    else await agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, fila);
  });
}
