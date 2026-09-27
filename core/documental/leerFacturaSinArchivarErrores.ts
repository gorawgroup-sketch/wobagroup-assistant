/** A technical failure is never a negative expense classification. */
export async function leerFacturaSinArchivarErrores<T>(leer: () => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try { return await leer(); }
    catch (error) {
      const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown }; message?: string };
      const limitado = Number(e?.response?.status ?? e?.status ?? e?.code) === 429 ||
        /quota exceeded|rate.?limit|presupuesto|budget/i.test(e?.message ?? '');
      // The caller persists a technical retry. Do not repeat budget/quota checks
      // immediately or spend another classification call to offer Drive instead.
      if (limitado || intento >= 1) throw error;
    }
  }
}
