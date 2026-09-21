import { createHash } from "node:crypto";
import { actualizarFila, agregarFilaAtomica, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import { palabrasDe, palabrasParecidas } from "../utils/textoParecido";
import type { Empresa } from "./client";

const TAB_NAME = "_conciliaciones_verificadas_aprendidas";
const HEADERS = [
  "clave",
  "empresa",
  "proveedor",
  "moneda",
  "accountId",
  "descripcionMovimiento",
  "ultimoMonto",
  "vecesConfirmado",
  "primeraConfirmacionEn",
  "ultimaConfirmacionEn",
  "gastoIdUltimo",
  "origenCoincidencia",
];
const NUM_COLS = HEADERS.length;
const CLAVE_MUTEX = `conciliaciones-verificadas:${TAB_NAME}`;

export interface ConciliacionVerificadaAprendida {
  rowIndex: number;
  clave: string;
  empresa: Empresa;
  proveedor: string;
  moneda: string;
  accountId: string;
  descripcionMovimiento: string;
  ultimoMonto: number;
  vecesConfirmado: number;
  primeraConfirmacionEn: string;
  ultimaConfirmacionEn: string;
  gastoIdUltimo: string;
  origenCoincidencia: string;
}

export interface MovimientoParaAprendizajeConciliacion {
  accountId: string;
  descripcion?: string;
  monto: number;
  moneda: string;
  fecha?: string;
  origenCoincidencia?: string;
}

export interface SugerenciaConciliacionAprendida {
  indice: number;
  vecesConfirmado: number;
  descripcionPatron: string;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function empresaValida(valor: string): valor is Empresa {
  return valor === "WOBA" || valor === "EWORKS" || valor === "Footprint";
}

function claveDe(
  empresa: Empresa,
  proveedor: string,
  moneda: string,
  accountId: string,
  descripcionMovimiento: string
): string {
  return createHash("sha256")
    .update([empresa, normalizar(proveedor), moneda.trim().toUpperCase(), accountId.trim(), normalizar(descripcionMovimiento)].join("|"))
    .digest("hex");
}

function desdeFila(rowIndex: number, valores: string[]): ConciliacionVerificadaAprendida | undefined {
  if (!valores[0] || !empresaValida(valores[1]) || !valores[2] || !valores[5]) return undefined;
  return {
    rowIndex,
    clave: valores[0],
    empresa: valores[1],
    proveedor: valores[2],
    moneda: (valores[3] || "EUR").toUpperCase(),
    accountId: valores[4] || "",
    descripcionMovimiento: valores[5],
    ultimoMonto: Number(valores[6]) || 0,
    vecesConfirmado: Math.max(1, Number(valores[7]) || 1),
    primeraConfirmacionEn: valores[8] || "",
    ultimaConfirmacionEn: valores[9] || "",
    gastoIdUltimo: valores[10] || "",
    origenCoincidencia: valores[11] || "exacta",
  };
}

function aFila(registro: Omit<ConciliacionVerificadaAprendida, "rowIndex">): (string | number)[] {
  return [
    registro.clave,
    registro.empresa,
    registro.proveedor,
    registro.moneda,
    registro.accountId,
    registro.descripcionMovimiento,
    registro.ultimoMonto,
    registro.vecesConfirmado,
    registro.primeraConfirmacionEn,
    registro.ultimaConfirmacionEn,
    registro.gastoIdUltimo,
    registro.origenCoincidencia,
  ];
}

async function leerRegistros(): Promise<ConciliacionVerificadaAprendida[]> {
  return (await leerFilas(TAB_NAME, NUM_COLS, HEADERS))
    .map((fila) => desdeFila(fila.rowIndex, fila.valores))
    .filter((fila): fila is ConciliacionVerificadaAprendida => Boolean(fila));
}

/**
 * Persiste únicamente conciliaciones que Holded ya confirmó como aplicadas y enlazadas. La memoria
 * nunca se alimenta de una propuesta, de una búsqueda aproximada sin aprobar ni de un timeout
 * incierto. Así una corrección humana aporta experiencia sin convertir una suposición en regla.
 */
export async function registrarConciliacionVerificada(datos: {
  empresa: Empresa;
  proveedor: string;
  movimiento: MovimientoParaAprendizajeConciliacion;
  gastoId: string;
}): Promise<void> {
  const proveedor = datos.proveedor.trim();
  const descripcionMovimiento = (datos.movimiento.descripcion ?? "").trim();
  const accountId = datos.movimiento.accountId.trim();
  const moneda = (datos.movimiento.moneda || "EUR").trim().toUpperCase();
  if (!proveedor || !descripcionMovimiento || !accountId || !Number.isFinite(datos.movimiento.monto)) return;

  const clave = claveDe(datos.empresa, proveedor, moneda, accountId, descripcionMovimiento);
  await conMutex(CLAVE_MUTEX, async () => {
    const existentes = await leerRegistros();
    const actual = existentes.find((fila) => fila.clave === clave);
    const ahora = new Date().toISOString();
    const siguiente: Omit<ConciliacionVerificadaAprendida, "rowIndex"> = {
      clave,
      empresa: datos.empresa,
      proveedor,
      moneda,
      accountId,
      descripcionMovimiento,
      ultimoMonto: Math.abs(datos.movimiento.monto),
      vecesConfirmado: (actual?.vecesConfirmado ?? 0) + 1,
      primeraConfirmacionEn: actual?.primeraConfirmacionEn || ahora,
      ultimaConfirmacionEn: ahora,
      gastoIdUltimo: datos.gastoId,
      origenCoincidencia: datos.movimiento.origenCoincidencia || "exacta",
    };

    if (actual) {
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
    } else {
      await agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, aFila(siguiente));
    }
  });
}

function puntuarTexto(descripcion: string, patron: string): number {
  const a = normalizar(descripcion);
  const b = normalizar(patron);
  if (!a || !b) return 0;
  if (a === b) return 1_000;

  const palabrasDescripcion = palabrasDe(descripcion, 4);
  const palabrasPatron = palabrasDe(patron, 4);
  let puntaje = 0;
  for (const palabra of palabrasDescripcion) {
    if (palabrasPatron.some((otra) => palabrasParecidas(palabra, otra))) puntaje += palabra.length;
  }
  return puntaje;
}

/**
 * Ordena la evidencia histórica para RESALTAR un candidato cuando hay varios. No concilia ni
 * descarta ninguno. Exige empresa, proveedor y moneda exactos; una cuenta bancaria por sí sola no
 * cuenta como evidencia porque muchos proveedores comparten la misma tarjeta/cuenta.
 */
export function sugerirCandidatoDesdeRegistros(
  proveedor: string,
  empresa: Empresa,
  candidatos: MovimientoParaAprendizajeConciliacion[],
  registros: ConciliacionVerificadaAprendida[]
): SugerenciaConciliacionAprendida | undefined {
  const proveedorNormalizado = normalizar(proveedor);
  if (!proveedorNormalizado || candidatos.length === 0) return undefined;

  const aplicables = registros.filter(
    (registro) => registro.empresa === empresa && normalizar(registro.proveedor) === proveedorNormalizado
  );
  if (aplicables.length === 0) return undefined;

  const resultados = candidatos.map((candidato, indice) => {
    const moneda = (candidato.moneda || "EUR").toUpperCase();
    let mejorPuntaje = 0;
    let mejorRegistro: ConciliacionVerificadaAprendida | undefined;
    for (const registro of aplicables) {
      if (registro.moneda !== moneda) continue;
      const texto = puntuarTexto(candidato.descripcion ?? "", registro.descripcionMovimiento);
      if (texto <= 0) continue;
      const cuenta = registro.accountId === candidato.accountId ? 150 : 0;
      const refuerzo = Math.min(registro.vecesConfirmado, 10) * 5;
      const puntaje = texto + cuenta + refuerzo;
      if (puntaje > mejorPuntaje) {
        mejorPuntaje = puntaje;
        mejorRegistro = registro;
      }
    }
    return { indice, puntaje: mejorPuntaje, registro: mejorRegistro };
  });

  const ordenados = resultados.filter((r) => r.registro && r.puntaje > 0).sort((a, b) => b.puntaje - a.puntaje);
  if (ordenados.length === 0 || (ordenados[1] && ordenados[1].puntaje === ordenados[0].puntaje)) return undefined;
  const mejor = ordenados[0];
  return {
    indice: mejor.indice,
    vecesConfirmado: mejor.registro!.vecesConfirmado,
    descripcionPatron: mejor.registro!.descripcionMovimiento,
  };
}

export async function sugerirCandidatoPorConciliacionesVerificadas(
  proveedor: string,
  empresa: Empresa,
  candidatos: MovimientoParaAprendizajeConciliacion[]
): Promise<SugerenciaConciliacionAprendida | undefined> {
  return sugerirCandidatoDesdeRegistros(proveedor, empresa, candidatos, await leerRegistros());
}

/** Registros visibles en el reporte de aprendizaje. */
export async function obtenerTodasLasConciliacionesAprendidas(): Promise<ConciliacionVerificadaAprendida[]> {
  return leerRegistros();
}
