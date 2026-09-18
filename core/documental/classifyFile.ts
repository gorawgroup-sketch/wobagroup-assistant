import Anthropic from "@anthropic-ai/sdk";
import { crearConsultorConocimiento, knowledgeBaseTool } from "../tools/knowledgeBase";
import { listarSubcarpetas } from "../drive/client";
import { ROOT_FOLDERS, type EmpresaConCarpeta } from "../drive/rootFolders";
import { crearMensajeAnthropic } from "../ai/anthropicGateway";
import { crearEjecucionIA } from "../ai/policy";
import { resolverModeloDocumental } from "../ai/modelRouting";
import { buscarReglaClasificacion } from "./carpetaReglaStore";

const MODEL = resolverModeloDocumental("clasificar_documento");
const MAX_ITERATIONS = 6;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY");
  }

  client = new Anthropic({ apiKey });
  return client;
}

export type EmpresaDocumento = "WOBA" | "EWORKS" | "Footprint" | "desconocida";

export interface ClasificacionDocumento {
  empresa: EmpresaDocumento;
  tipoDocumento: string;
  carpetaSugerida: string;
  confianza: "alta" | "media" | "baja";
  razon: string;
  preguntaSiAmbiguo?: string;
  /**
   * true si el texto/caption (típicamente el cuerpo de un correo) pide
   * explícitamente que se RECUERDE o quede registrado este contenido (ej.
   * "para que lo memorices", "que quede de referencia", "guárdalo para
   * consultarlo después") — señal de que además de archivar el documento,
   * hace falta guardarlo como conocimiento (CAPTURA). Caso real que motivó
   * esto: un colaborador mandó una lista de accesos activos por correo
   * diciendo "para que lo memorices" y el sistema solo propuso archivarlo
   * en Drive, sin reconocer que también pedían que quedara como
   * conocimiento consultable.
   */
  pareceIntencionDeCaptura?: boolean;
  /**
   * Hallazgo real de auditoría (Footprint, factura Hotel Columbus/Costa Rica, 2026-09-16): este
   * clasificador es SOLO texto (nombre de archivo + caption, nunca lee el documento real — a
   * diferencia de extraerDatosFactura, que sí lo lee con visión) y puede reconocer por contexto que
   * un documento es una factura de gasto de viaje aunque extraerDatosFactura, releyendo el PDF real,
   * haya decidido lo contrario (es_factura_o_gasto=false) — ambas lecturas son independientes y
   * pueden discrepar. Antes, cuando esto pasaba, el documento quedaba archivado como genérico sin
   * ninguna forma de redirigirlo al flujo de gasto, aunque la propia razón de esta clasificación
   * dijera explícitamente "debe procesarse como gasto". true SOLO si el nombre/caption sugiere
   * fuertemente un recibo, factura o comprobante de un gasto real (transporte, hospedaje, comidas,
   * compras) — no un contrato, certificado u otro documento administrativo que use la palabra
   * "factura" sin ser un gasto a conciliar.
   */
  esProbableGasto?: boolean;
  /**
   * Hallazgo real de auditoría (Footprint, Modelo 303/349, 2026-09-17): pregunta_si_ambiguo ya
   * mencionaba las carpetas reales candidatas por nombre, pero solo como texto libre — no había forma
   * de ofrecer un botón por candidata, el usuario tenía que escribirla a mano. Solo cuando
   * confianza='baja' por HABER VARIAS carpetas reales igual de plausibles (no cuando la empresa misma
   * es incierta, ni cuando no se encontró ninguna candidata real): los mismos nombres EXACTOS de Drive
   * ya mencionados en pregunta_si_ambiguo, para poder ofrecerlos como botones (ver
   * processClassification.ts).
   */
  carpetasCandidatas?: string[];
}

const REPORTAR_TOOL_NAME = "reportar_clasificacion_documento";
const LISTAR_CARPETAS_TOOL_NAME = "listar_carpetas_drive";

const REPORTAR_TOOL: Anthropic.Tool = {
  name: REPORTAR_TOOL_NAME,
  description:
    "Reporta la clasificación final propuesta para el documento entrante. Debes llamarla siempre al " +
    "terminar de razonar — nunca respondas solo en texto.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint", "desconocida"] },
      tipo_documento: {
        type: "string",
        description: "Tipo de documento, ej. 'factura', 'contrato', 'certificado ISO', 'otro'.",
      },
      carpeta_sugerida: {
        type: "string",
        description:
          "Nombre EXACTO (copiado literal, con emojis/mayúsculas si los trae) de una carpeta real " +
          "vista con listar_carpetas_drive. No inventes una ruta genérica si no la confirmaste ahí.",
      },
      confianza: { type: "string", enum: ["alta", "media", "baja"] },
      razon: { type: "string", description: "Explicación breve de por qué se propone esta clasificación." },
      pregunta_si_ambiguo: {
        type: "string",
        description:
          "Solo si confianza='baja': la pregunta exacta para desambiguar con el usuario, en vez de " +
          "adivinar. Si hay varias carpetas reales igual de plausibles, menciónalas por su nombre real.",
      },
      carpetas_candidatas: {
        type: "array",
        items: { type: "string" },
        description:
          "Solo si confianza='baja' Y la ambigüedad es por tener VARIAS carpetas reales igual de " +
          "plausibles (mismo caso que activa pregunta_si_ambiguo mencionándolas por nombre): la lista " +
          "de esos nombres EXACTOS (los mismos que ya viste con listar_carpetas_drive, tal cual, " +
          "máximo 3) para poder ofrecerlos como botones. Déjalo vacío si la duda es sobre la EMPRESA " +
          "(no la carpeta), o si no encontraste ninguna carpeta real candidata que valga la pena ofrecer.",
      },
      parece_intencion_de_captura: {
        type: "boolean",
        description:
          "true SOLO si el texto/caption (típicamente el cuerpo de un correo, o el caption de una foto/" +
          "documento enviado por Telegram) pide explícitamente que se RECUERDE o quede registrado este " +
          "contenido (ej. 'para que lo memorices', 'que quede de referencia', 'guárdalo para consultarlo " +
          "después', 'anótalo') — O si el caption contiene literalmente la palabra 'CAPTURA' (mayúsculas " +
          "o minúsculas, ej. una foto enviada con caption 'captura' o 'CAPTURA esto'), que es la palabra " +
          "clave estándar usada en todo el sistema para pedir que algo se guarde como conocimiento — " +
          "tratarla igual aquí que en cualquier otro mensaje. No lo actives solo porque el documento sea " +
          "informativo sin ninguna de estas señales — tiene que haber una petición explícita de " +
          "recordarlo/registrarlo, no solo de archivarlo.",
      },
      es_probable_gasto: {
        type: "boolean",
        description:
          "true SOLO si el nombre de archivo o el caption sugieren fuertemente que este documento es un " +
          "recibo, factura o comprobante de un GASTO REAL a conciliar en Holded (transporte, hospedaje, " +
          "comidas, compras de la empresa) — ej. nombre/asunto con 'factura', 'recibo', 'invoice', " +
          "'receipt', un hotel/aerolínea/Uber/restaurante, o un correo que reenvía una confirmación de " +
          "pago o cargo. false para contratos, certificados, documentación legal/administrativa, o " +
          "cualquier cosa que no sea un gasto propio a registrar — no actives esto solo porque la " +
          "palabra 'factura' aparezca en un contexto no relacionado a un gasto real.",
      },
    },
    required: ["empresa", "tipo_documento", "carpeta_sugerida", "confianza", "razon"],
  },
};

const LISTAR_CARPETAS_TOOL: Anthropic.Tool = {
  name: LISTAR_CARPETAS_TOOL_NAME,
  description:
    "Lista los nombres reales de las subcarpetas dentro de Drive para una empresa (WOBA, EWORKS o " +
    "Footprint). Sin 'carpeta_padre', lista las carpetas de primer nivel. Con 'carpeta_padre' (nombre " +
    "parcial de una carpeta ya vista), lista lo que hay DENTRO de esa carpeta. Úsala antes de proponer " +
    "una carpeta_sugerida — los nombres reales pueden traer emojis o variaciones que no adivinarías " +
    "(ej. 'SEGUROS📜'), y a veces hay más de una carpeta plausible (ej. 'SEGUROS📜' junto a una carpeta " +
    "separada 'MOTO PIAGGIO 300') que debes detectar para preguntar en vez de adivinar.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"] },
      carpeta_padre: {
        type: "string",
        description: "Nombre (parcial) de una subcarpeta ya conocida, para listar su contenido. Opcional.",
      },
    },
    required: ["empresa"],
  },
};

const SYSTEM_PROMPT = [
  "Eres el clasificador de documentos entrantes del grupo (WOBA/BAE, Footprint, eWorks).",
  "Te llega el nombre de un archivo y, si existe, el texto/caption que el usuario escribió al enviarlo " +
    "por Telegram. Tu trabajo es proponer a qué empresa pertenece el documento y en qué carpeta REAL de " +
    "Drive debería archivarse, basándote en esas pistas.",
  "Antes de proponer una carpeta, usa listar_carpetas_drive para ver los nombres reales (de primer " +
    "nivel, y si hace falta explora dentro de alguna con carpeta_padre). NUNCA propongas una ruta " +
    "genérica o inventada ('Facturas/2025', etc.) — carpeta_sugerida debe ser el nombre EXACTO de una " +
    "carpeta que efectivamente viste con esta herramienta.",
  "Si al explorar encuentras más de una carpeta igual de plausible para este documento (ej. una carpeta " +
    "general de 'Seguros' y también una carpeta específica de un activo, como un vehículo, que podría " +
    "aplicar), NO elijas una al azar: marca confianza='baja' y en pregunta_si_ambiguo pregunta al " +
    "usuario mencionando los nombres reales de esas carpetas para que elija — y en ese mismo caso " +
    "(varias carpetas reales candidatas, no duda sobre la empresa) pon esos mismos nombres exactos " +
    "también en carpetas_candidatas, para poder ofrecerlos como botones.",
  "Si hace falta contexto sobre qué tipos de documentos van a qué carpetas (ej. documentos de un " +
    "colaborador nuevo, de un proveedor, de ISO...), usa también consultar_base_conocimiento " +
    "(documento de responsabilidades del grupo).",
  "No tienes acceso al contenido del archivo (PDF/imagen), solo al nombre y al caption — no inventes ni " +
    "asumas contenido que no esté en esas pistas.",
  "Además de decidir dónde archivarlo, revisa si el caption (el texto del correo/mensaje que trae el " +
    "documento) pide explícitamente que se RECUERDE o quede registrado — no solo que se archive — o si " +
    "contiene literalmente la palabra 'CAPTURA' (la palabra clave estándar de todo el sistema para pedir " +
    "que algo se guarde como conocimiento). Si es así, marca parece_intencion_de_captura=true.",
  "También revisa si el nombre o el caption sugieren que este documento es en realidad un recibo/factura " +
    "de un GASTO REAL (transporte, hospedaje, comidas, compras) que debería procesarse y conciliarse en " +
    "Holded, no solo archivarse — marca es_probable_gasto=true en ese caso. Puede coexistir con " +
    "cualquier tipo_documento/carpeta_sugerida: archivar y procesar como gasto no son mutuamente " +
    "excluyentes, es al usuario a quien le toca elegir.",
  `SIEMPRE debes terminar llamando a la herramienta ${REPORTAR_TOOL_NAME} con tu conclusión final.`,
].join("\n\n");

/**
 * Clasifica un documento entrante usando solo el nombre de archivo y el
 * caption (sin leer contenido), con Claude apoyándose en
 * consultar_base_conocimiento y listar_carpetas_drive (nombres reales de
 * Drive) para no adivinar. Nunca sube nada a Drive — solo propone.
 */
export async function clasificarDocumento(
  nombreArchivo: string,
  caption: string | undefined
): Promise<ClasificacionDocumento> {
  // Regla aprendida (ver carpetaReglaStore.ts / botón "📚 Enseñar regla") —
  // se revisa ANTES de gastar una llamada a Claude. Si coincide, la
  // clasificación sale directa y determinista, sin volver a preguntar.
  const regla = await buscarReglaClasificacion(nombreArchivo, caption).catch((error) => {
    console.error("[classifyFile] Error consultando reglas aprendidas (se sigue con clasificación normal):", error);
    return undefined;
  });
  if (regla) {
    return {
      empresa: regla.empresa as EmpresaDocumento,
      tipoDocumento: regla.tipoDocumento,
      carpetaSugerida: regla.carpetaDestino,
      confianza: "alta",
      razon: `Coincide con una regla aprendida antes: "${regla.criterio}" → ${regla.carpetaDestino}.`,
    };
  }

  const anthropic = getClient();
  const ejecucion = crearEjecucionIA("clasificar_documento");

  const tools: Anthropic.Tool[] = [
    {
      name: knowledgeBaseTool.name,
      description: knowledgeBaseTool.description,
      input_schema: knowledgeBaseTool.input_schema,
    },
    LISTAR_CARPETAS_TOOL,
    REPORTAR_TOOL,
  ];

  const userText = [
    `Nombre del archivo: ${nombreArchivo}`,
    caption ? `Texto adjunto (caption): ${caption}` : "(sin texto adjunto)",
  ].join("\n");

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userText }];
  // La clasificación de carpetas no necesita el Plan General Contable. Se conserva el corpus completo,
  // pero este flujo solo puede recuperar contexto documental compacto una vez por ejecución.
  const consultarConocimiento = crearConsultorConocimiento({
    ambito: "documental",
    maxCaracteres: 14_000,
    maxConsultas: 1,
  });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await crearMensajeAnthropic(anthropic, ejecucion, {
      model: MODEL,
      // Preventivo — mismo patrón que ya causó un bug real confirmado en vivo
      // en core/gmail/classifyEmail.ts (dos correos seguidos cayeron en el
      // fallback genérico porque el modelo se quedaba sin presupuesto antes
      // de llegar a llamar la tool de reportar). Este archivo comparte la
      // misma estructura (tool-calling con razonamiento) con un techo
      // igual de ajustado — 8192 es el estándar ya establecido en este
      // proyecto para este tipo de llamada (ver core/claude/client.ts).
      max_tokens: 8192,
      // Prefijo estable compartido por los archivos procesados en el mismo
      // lote; los metadatos del archivo siguen siendo entrada no cacheada.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      // Desde la segunda vuelta, cachea además el historial de herramientas. No se activa en la primera
      // para no pagar una escritura de caché sobre una entrada única si Claude resuelve de inmediato.
      cache_control: i > 0 ? { type: "ephemeral" } : undefined,
      tools,
      messages,
    });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const reportar = toolUseBlocks.find((b) => b.name === REPORTAR_TOOL_NAME);
    if (reportar) {
      const input = reportar.input as Record<string, unknown>;
      return {
        empresa: (input.empresa as EmpresaDocumento) ?? "desconocida",
        tipoDocumento: (input.tipo_documento as string) ?? "otro",
        carpetaSugerida: (input.carpeta_sugerida as string) ?? "(sin sugerencia)",
        confianza: (input.confianza as ClasificacionDocumento["confianza"]) ?? "baja",
        razon: (input.razon as string) ?? "",
        preguntaSiAmbiguo: input.pregunta_si_ambiguo as string | undefined,
        pareceIntencionDeCaptura: input.parece_intencion_de_captura === true,
        esProbableGasto: input.es_probable_gasto === true,
        carpetasCandidatas: Array.isArray(input.carpetas_candidatas)
          ? (input.carpetas_candidatas as unknown[]).filter((c): c is string => typeof c === "string" && c.trim().length > 0).slice(0, 3)
          : undefined,
      };
    }

    if (toolUseBlocks.length === 0) {
      break; // Claude respondió solo en texto sin llamar al tool obligatorio; usamos el fallback.
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const campos = Object.keys(block.input as Record<string, unknown>);
      console.log(`[classifyFile] tool_use -> ${block.name} (campos: ${campos.join(",") || "ninguno"})`);

      let resultado: string;

      if (block.name === knowledgeBaseTool.name) {
        resultado = await consultarConocimiento(block.input as Record<string, unknown>);
      } else if (block.name === LISTAR_CARPETAS_TOOL_NAME) {
        const input = block.input as { empresa?: EmpresaConCarpeta; carpeta_padre?: string };
        const rootId = input.empresa ? ROOT_FOLDERS[input.empresa] : undefined;
        if (!rootId) {
          resultado = `Error: empresa "${input.empresa}" no reconocida.`;
        } else {
          const nombres = await listarSubcarpetas(rootId, input.carpeta_padre);
          resultado = nombres.length > 0 ? nombres.join("\n") : "(sin subcarpetas encontradas ahí)";
        }
      } else {
        continue;
      }

      console.log(`[classifyFile] tool_result <- ${block.name} (${resultado.length} caracteres)`);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultado });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    empresa: "desconocida",
    tipoDocumento: "otro",
    carpetaSugerida: "(sin sugerencia)",
    confianza: "baja",
    razon: "No fue posible clasificar automáticamente.",
    preguntaSiAmbiguo: "¿A qué empresa y carpeta pertenece este documento?",
  };
}
