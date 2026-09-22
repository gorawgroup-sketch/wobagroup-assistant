/** Reintenta solo lecturas: jamás envolver una escritura o un callback completo. */
export async function leerSheetsConReintento<T>(
  leer: () => Promise<T>,
  esperar: (ms: number) => Promise<void> = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await leer();
    } catch (error) {
      const e = error as { response?: { status?: number }; code?: number | string };
      if (Number(e?.response?.status ?? e?.code) !== 429 || intento >= 2) throw error;
      // Cuota por minuto: dos pausas acotadas cubren una ventana sin sondeo continuo.
      await esperar(35_000);
    }
  }
}
