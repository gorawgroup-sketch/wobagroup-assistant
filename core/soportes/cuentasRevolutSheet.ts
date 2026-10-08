import { actualizarFila, agregarFilaAtomica, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import type { Empresa } from "../holded/client";

/**
 * IBAN de cada cuenta de Revolut → empresa, aprendido de los extractos ya analizados con la empresa confirmada por
 * Carlos. Sirve para dos cosas: reconocer de qué empresa es un CSV sin que nadie lo diga, y frenar un CSV que Carlos
 * asignó por error a otra empresa (un extracto de EWORKS no se cruza contra Holded de WOBA).
 */
const TAB_NAME = "_cuentas_revolut_empresa";
const HEADERS = ["iban", "empresa", "actualizadoEn"];
const NUM_COLS = HEADERS.length;
const MUTEX = `soportes-ibans:${TAB_NAME}`;
const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];

const limpio = (iban: string): string => iban.replace(/\s+/g, "").toUpperCase();

/** Empresas ya conocidas para esos IBAN (normalmente una; más de una = el CSV mezcla cuentas de empresas distintas). */
export async function empresasDeIbans(ibans: string[]): Promise<Empresa[]> {
  const buscados = new Set(ibans.map(limpio).filter(Boolean));
  if (buscados.size === 0) return [];
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return [...new Set(filas.filter((f) => buscados.has(limpio(f.valores[0])) && EMPRESAS.includes(f.valores[1] as Empresa)).map((f) => f.valores[1] as Empresa))];
}

export async function aprenderIbans(ibans: string[], empresa: Empresa): Promise<void> {
  const nuevos = [...new Set(ibans.map(limpio).filter(Boolean))];
  if (nuevos.length === 0) return;
  await conMutex(MUTEX, async () => {
    const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
    for (const iban of nuevos) {
      const previa = filas.find((f) => limpio(f.valores[0]) === iban);
      const valores = [iban, empresa, Date.now()];
      if (!previa) await agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, valores);
      else if (previa.valores[1] !== empresa) await actualizarFila(TAB_NAME, previa.rowIndex, NUM_COLS, valores);
    }
  });
}
