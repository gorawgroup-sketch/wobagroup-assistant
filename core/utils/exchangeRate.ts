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

const cacheHistorica = new Map<string, { hasta: number; valor: Promise<number | undefined> }>();

/** Cache compartida entre revisión automática y manual, sin gastar llamadas de IA. */
export function obtenerTasaCambioHistorica(fecha: string, origen: string, destino: string): Promise<number | undefined> {
  origen = origen.trim().toUpperCase(); destino = destino.trim().toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^[A-Z]{3}$/.test(origen) || !/^[A-Z]{3}$/.test(destino)) return Promise.resolve(undefined);
  if (origen === destino) return Promise.resolve(1);
  const clave = `${fecha}:${origen}:${destino}`;
  const anterior = cacheHistorica.get(clave);
  if (anterior && anterior.hasta > Date.now()) return anterior.valor;
  if (cacheHistorica.size >= 1000) cacheHistorica.clear();
  const valor = consultarTasaHistorica(fecha, origen, destino);
  cacheHistorica.set(clave, { hasta: Date.now() + 15 * 60_000, valor });
  return valor;
}

async function tasaHistoricaAmpliada(fecha: string, origen: string, destino: string): Promise<number | undefined> {
  // Cotizar COP por EUR/USD evita perder precisión al redondearse 1 COP a cinco decimales.
  const inversa = origen === "COP";
  const base = inversa ? destino : origen, quote = inversa ? origen : destino;
  const response = await fetch(`https://api.frankfurter.dev/v2/rate/${base}/${quote}?date=${fecha}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return undefined;
  const d = await response.json() as { date?: string; base?: string; quote?: string; rate?: number };
  const dias = (Date.parse(fecha) - Date.parse(d.date ?? "")) / 86_400_000;
  if (d.base !== base || d.quote !== quote || !Number.isFinite(dias) || dias < 0 || dias > 7 ||
      typeof d.rate !== "number" || !Number.isFinite(d.rate) || d.rate <= 0) return undefined;
  return inversa ? 1 / d.rate : d.rate;
}
const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";

/**
 * Tasa histórica: BCE v1 y cobertura ampliada v2 ante 404, para una fecha (YYYY-MM-DD). Devuelve undefined si la
 * API falla o si la fecha cae en fin de semana/festivo sin publicación — nunca inventa una tasa ni
 * usa un valor aproximado. Frankfurter ya resuelve fines de semana con la última tasa hábil anterior,
 * así que un undefined acá normalmente significa un problema real de red, no un día sin datos.
 */
async function consultarTasaHistorica(
  fecha: string,
  monedaOrigen: string,
  monedaDestino: string
): Promise<number | undefined> {
  if (monedaOrigen === monedaDestino) return 1;

  try {
    const url = `${FRANKFURTER_BASE}/${fecha}?base=${encodeURIComponent(monedaOrigen)}&symbols=${encodeURIComponent(monedaDestino)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      if (response.status === 404) {
        return await tasaHistoricaAmpliada(fecha, monedaOrigen, monedaDestino);
      }
      // Los errores distintos de falta de cobertura se conservan como no disponibles.
      console.error(`[exchangeRate] Tasa histórica no disponible ${monedaOrigen}->${monedaDestino} del ${fecha} (HTTP ${response.status}); esto no demuestra que falte el cargo bancario.`);
      return undefined;
    }

    const data = (await response.json()) as { rates?: Record<string, number> };
    const tasa = data.rates?.[monedaDestino];
    return typeof tasa === "number" && Number.isFinite(tasa) ? tasa : undefined;
  } catch (error) {
    console.error(`[exchangeRate] Error consultando la tasa de cambio ${monedaOrigen}->${monedaDestino} del ${fecha}:`, error);
    return undefined;
  }
}

const ER_API_BASE = "https://open.er-api.com/v6/latest";

/**
 * Hallazgo real de auditoría xhigh (2026-09-09): Frankfurter (arriba) solo cubre las ~30 monedas que
 * reporta el BCE — no incluye COP, aunque Footprint SÍ tiene una cuenta de tesorería real en COP (ver
 * core/holded/write.ts). Sin ningún fallback, un gasto en COP quedaba con el mismo bug original
 * (paridad ficticia 1:1) que este mecanismo existe para corregir, y en silencio.
 *
 * open.er-api.com es gratis, sin API key, sin límite de uso conocido (a diferencia de
 * exchangerate.host, que ahora exige key — verificado en vivo, devuelve error sin una) — pero solo
 * publica la tasa ACTUAL, no histórica por fecha. Para el caso de uso real (fijar currency_change al
 * CREAR un gasto, casi siempre con fecha de hoy o de los últimos días) esto es una aproximación
 * razonable — mejor la tasa de hoy que la paridad ficticia 1:1 — nunca se usa para decidir un monto
 * "correcto" con precisión histórica, mismo criterio que verificarConversion de arriba.
 */
export async function obtenerTasaCambioActual(monedaOrigen: string, monedaDestino: string): Promise<number | undefined> {
  if (monedaOrigen === monedaDestino) return 1;

  try {
    const url = `${ER_API_BASE}/${encodeURIComponent(monedaOrigen)}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[exchangeRate] open.er-api.com no devolvió una tasa actual para ${monedaOrigen}->${monedaDestino} (HTTP ${response.status}).`);
      return undefined;
    }

    const data = (await response.json()) as { result?: string; rates?: Record<string, number> };
    if (data.result !== "success") return undefined;
    const tasa = data.rates?.[monedaDestino];
    return typeof tasa === "number" && Number.isFinite(tasa) ? tasa : undefined;
  } catch (error) {
    console.error(`[exchangeRate] Error consultando la tasa de cambio ACTUAL ${monedaOrigen}->${monedaDestino}:`, error);
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
  const diferenciaAbsoluta = Math.abs(montoConvertidoReal - montoEsperado);
  // El denominador también debe ser absoluto: notas de crédito/reembolsos usan montos negativos y
  // antes producían un porcentaje negativo que nunca superaba el umbral de alerta. Si el monto
  // esperado es cero, cualquier registro no nulo es una discrepancia completa (100%), no un 0%.
  const diferenciaPct = montoEsperado === 0
    ? (diferenciaAbsoluta === 0 ? 0 : 100)
    : (diferenciaAbsoluta / Math.abs(montoEsperado)) * 100;

  return { tasaReal, montoEsperado, diferenciaPct };
}
