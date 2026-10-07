import type Anthropic from "@anthropic-ai/sdk";

/**
 * Marcas de caché de prompts (decisión de Carlos, 07-10-2026: ahorrar solo con medidas que no cambian lo que lee el modelo).
 *
 * El registro de costes mostró que el 85 % del gasto es entrada, y que los bloques fijos (herramientas e instrucciones) se
 * ESCRIBÍAN en caché una y otra vez (p. ej. extracción de facturas: 5,2 M tokens escritos frente a 2,9 M leídos en 14 días)
 * porque la caché de 5 minutos caduca entre una revisión y la siguiente. Con 1 hora, la escritura cuesta 2× la entrada
 * normal (en vez de 1,25×) pero las lecturas cuestan 0,1×: compensa en cuanto el prefijo se reutiliza una vez en esa hora.
 *
 * Reglas: solo para bloques que no cambian entre llamadas (herramientas, instrucciones fijas, reglas aprendidas); un bloque
 * de 1 h debe ir ANTES que cualquier bloque de 5 min; lo que cambia en cada llamada no se marca (pagaría la escritura sin
 * reutilización).
 */
export const CACHE_1H: Anthropic.CacheControlEphemeral = { type: "ephemeral", ttl: "1h" };
export const CACHE_5M: Anthropic.CacheControlEphemeral = { type: "ephemeral" };
