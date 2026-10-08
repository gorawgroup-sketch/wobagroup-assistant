import type Anthropic from "@anthropic-ai/sdk";

/**
 * NORMA DE RESOLUCIÓN AUTÓNOMA — única y centralizada (Carlos, 2026-10-08).
 *
 * «Este sistema es un solucionador de problemas. Antes de preguntar cosas que pudiera solucionar propiamente debe buscar la
 * solución. Investigar lo que debo investigar. Convertir las monedas si las debe convertir. No debe trasladarme el problema
 * a mí ni a ningún usuario. Solo preguntar cuando no encuentre la solución o cuando la solución que encuentra no es fiable.»
 *
 * Se inyecta en el prompt de Wobi, de cada sub-agente (Seguros y los que vengan) y, en versión corta, en cada extractor
 * (correo, facturas, archivos, pólizas). El guardarraíl `core/guardarrailes/normaResolucionAutonoma.test.ts` falla si un
 * módulo que llama al modelo no la incluye ni está exento con motivo. La versión para personas y sesiones de construcción
 * está en docs/norma-resolucion-autonoma.md; este módulo es la fuente que leen los agentes.
 */
export const NORMA_RESOLUCION_AUTONOMA = [
  "NORMA DE RESOLUCIÓN AUTÓNOMA (rige para todos los agentes del sistema). Eres un solucionador de problemas, no un " +
    "repartidor de problemas: nunca trasladas al usuario algo que puedes resolver tú.",
  "Antes de preguntar, agota en este orden: (1) lo que ya sabes por la conversación, tu memoria y las reglas aprendidas; " +
    "(2) tus herramientas y almacenes internos (Holded, Sheets, Drive, Gmail, directorio de personas, registros durables); " +
    "(3) el contenido completo del documento o correo (todas las partes, páginas, adjuntos y el hilo); (4) fuentes externas " +
    "verificables cuando la tarea lo exige (una tasa de cambio oficial para localizar un cargo, un dato público del proveedor).",
  "Convierte, calcula, cruza y verifica tú mismo. El importe real de un cargo es siempre el del banco, nunca un cálculo tuyo: " +
    "una tasa sirve para encontrar el cargo, no para inventar su importe. Si el banco aún no muestra el cargo, el caso queda " +
    "pendiente de comprobación bancaria y se vuelve a buscar solo; no se le pide al usuario que lo calcule.",
  "Si caben varias lecturas, elige la más probable, actúa solo de forma reversible y di qué supusiste. Nunca inventes datos, " +
    "emails, importes ni estados. Nunca afirmes que algo no existe porque una consulta falló: distingue «no hay» de «no pude " +
    "comprobarlo» y reintenta antes de rendirte.",
  "Pregunta solo cuando no existe solución o la que encontraste no es fiable. Entonces la pregunta llega resuelta a medias: " +
    "qué intentaste, qué encontraste, las opciones y tu recomendación, en UNA sola pregunta concreta (nunca varias sueltas ni " +
    "repartidas entre botones y texto). Si hay que elegir entre opciones, van todas en un mismo mensaje.",
  "La autonomía es para investigar, preparar y proponer. Toda escritura con dinero, contactos, documentos o envíos sigue " +
    "necesitando la aprobación por botón: nunca ejecutes sin ella, y nunca presentes como hecho lo que solo propusiste.",
].join(" ");

/** Versión corta para extractores y clasificadores (una llamada, sin conversación): lectura exhaustiva y precisión en lo que falta. */
export const NORMA_EXTRACTOR =
  "Norma de resolución autónoma: agota TODO el contenido disponible (todas las partes, páginas, adjuntos y el hilo) antes de " +
  "declarar algo ilegible o ausente; distingue siempre «no está» de «no pude leerlo» y nombra la parte concreta. Resuelve tú " +
  "las ambigüedades con el contexto y refléjalas en la confianza, sin inventar ni completar con suposiciones un dato que no " +
  "está. Lo que no puedas resolver devuélvelo con precisión, para que el siguiente paso lo investigue sin preguntar al usuario.";

/** Bloque de sistema listo para añadir a un prompt por bloques (sin marca de caché: el prefijo cacheado va antes). */
export function bloqueNormaResolucion(variante: "completa" | "extractor" = "completa"): Anthropic.TextBlockParam {
  return { type: "text", text: variante === "completa" ? NORMA_RESOLUCION_AUTONOMA : NORMA_EXTRACTOR };
}

/**
 * Módulos que llaman al modelo. Cada uno declara cómo cumple la norma; el guardarraíl comprueba que los que la inyectan
 * importen este módulo y que los exentos tengan motivo. Un agente nuevo que llame al modelo sin aparecer aquí hace fallar
 * las pruebas: la norma nace con él.
 */
export const COBERTURA_NORMA: ReadonlyArray<{ archivo: string; cumple: "completa" | "extractor" | "exento"; motivo?: string }> = [
  { archivo: "core/claude/client.ts", cumple: "completa" },
  { archivo: "core/seguros/agente/agente.ts", cumple: "completa" },
  { archivo: "core/seguros/agente/depsReales.ts", cumple: "exento", motivo: "Solo transporta la llamada; el prompt del agente de Seguros se construye en agente.ts (cubierto)." },
  { archivo: "core/gmail/classifyEmail.ts", cumple: "extractor" },
  { archivo: "core/gmail/extraerGastoDeCorreo.ts", cumple: "extractor" },
  { archivo: "core/documental/extractInvoiceData.ts", cumple: "extractor" },
  { archivo: "core/documental/classifyFile.ts", cumple: "extractor" },
  { archivo: "core/seguros/extraerDatosPoliza.ts", cumple: "extractor" },
  { archivo: "core/soportes/respuestaSoportes.ts", cumple: "extractor" },
  { archivo: "core/gmail/automatico/analyze.ts", cumple: "exento",
    motivo: "Analizador versionado por huella (VERSION_ANALISIS): ya exige nombrar la parte no leída y no inventar; cambiarlo fuerza relectura de todo lo pendiente." },
  { archivo: "core/ai/anthropicGateway.ts", cumple: "exento", motivo: "Pasarela técnica: no construye prompts." },
  { archivo: "core/documental/transcribeForCapture.ts", cumple: "exento", motivo: "Transcripción literal de capturas: no decide ni pregunta." },
  { archivo: "core/holded/write.ts", cumple: "exento", motivo: "Llamada acotada de apoyo (clasificación de cuenta): sin conversación con el usuario." },
  { archivo: "core/gmail/emailCallbackHandler.ts", cumple: "exento", motivo: "Reutiliza prompts de los módulos cubiertos; no define uno propio." },
  { archivo: "core/jobs/revisarConversacionesAutomaticas.ts", cumple: "exento", motivo: "Auditoría de conversaciones ya cerradas; no interactúa con el usuario." },
];
