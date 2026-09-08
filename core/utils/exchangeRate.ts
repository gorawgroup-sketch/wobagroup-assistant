/**
 * Pedido explícito de Carlos, tras un caso real: un gasto de Google Workspace facturado en USD
 * (382.16 USD) se registró en Holded convertido a EUR (329.71 EUR) — "debes asegurarte de ser muy
 * inteligente para no dejar esto sin respuesta, si es necesario entras al internet y ves la tasa de
 * cambio del día". Verificado en vivo contra Frankfurter (mismo día, tasa real): 382.16 USD × 0.86237
 * = 329.51 EUR — 0.20 EUR de diferencia con lo registrado (0.06%), dentro del margen normal de
 * spread de tarjeta. Esta función es la pieza reutilizable para hacer esa misma verificación de forma
 * automática — la usa autoAuditarOperaciones.ts (auditoría nocturna) para marcar cualquier conversión
 * de moneda que se aleje demasiado de la tasa real del día, en vez de confiar ciegamente en el monto
 * equivalente que trajo el correo/documento original.
 *
 * Frankfurter (frankfurter.dev) publica las tasas de referencia diarias del Banco Central Europeo —
 * gratis, sin API key, sin límite de uso conocido. No es la tasa exacta que aplicó cada tarjeta (los
 * bancos/redes de tarjeta añaden su propio spread, típicamente 1-3%), así que esto NUNCA debe usarse
 * para decidir un monto "correcto" — solo para detectar una diferencia tan grande que no se explica
 * por un spread normal y amerita revisión humana.
 */
export interface VerificacionTasaCambio {
  tasaReal: number;
  montoEsperado: number;
  diferenciaPct: number;
}

const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";

/**
 * Tasa de cambio histórica publicada por el BCE para una fecha (YYYY-MM-DD). Devuelve undefined si la
 * API falla o si la fecha cae en fin de semana/festivo sin publicación — nunca inventa una tasa ni
 * usa un valor aproximado. Frankfurter ya resuelve fines de semana con la última tasa hábil anterior,
 * así que un undefined acá normalmente significa un problema real de red, no un día sin datos.
 */
export async function obtenerTasaCambioHistorica(
  fecha: string,
  monedaOrigen: string,
  monedaDestino: string
): Promise<number | undefined> {
  if (monedaOrigen === monedaDestino) return 1;

  try {
    const url = `${FRANKFURTER_BASE}/${fecha}?base=${encodeURIComponent(monedaOrigen)}&symbols=${encodeURIComponent(monedaDestino)}`;
    const response = await fetch(url);
    if (!response.ok) return undefined;

    const data = (await response.json()) as { rates?: Record<string, number> };
    const tasa = data.rates?.[monedaDestino];
    return typeof tasa === "number" && Number.isFinite(tasa) ? tasa : undefined;
  } catch (error) {
    console.error(`[exchangeRate] Error consultando la tasa de cambio ${monedaOrigen}->${monedaDestino} del ${fecha}:`, error);
    return undefined;
  }
}

/**
 * Compara un monto convertido real (ej. lo que quedó registrado en Holded) contra lo que la tasa REAL
 * del día habría dado — devuelve undefined si no se pudo consultar la tasa (nunca falla como "hay un
 * error", una duda no es una alarma). El llamador decide qué diferencia porcentual considerar
 * suficientemente grande como para avisar (el spread normal de tarjeta ronda 1-3%; más que eso ya vale
 * la pena revisar a mano).
 */
export async function verificarConversion(
  montoOriginal: number,
  monedaOriginal: string,
  montoConvertidoReal: number,
  monedaConvertida: string,
  fecha: string
): Promise<VerificacionTasaCambio | undefined> {
  const tasaReal = await obtenerTasaCambioHistorica(fecha, monedaOriginal, monedaConvertida);
  if (tasaReal === undefined) return undefined;

  const montoEsperado = montoOriginal * tasaReal;
  const diferenciaPct = montoEsperado === 0 ? 0 : (Math.abs(montoConvertidoReal - montoEsperado) / montoEsperado) * 100;

  return { tasaReal, montoEsperado, diferenciaPct };
}
