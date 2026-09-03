import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { knowledgeBaseTool } from "../tools/knowledgeBase";
import { obtenerClasificacionesAprendidas } from "../gastos/clasificacionAprendidaSheet";
import { registrarUsoIA } from "../claude/costTracking";
import { mimeADocumentBlock, type DocumentOrImageBlock } from "./documentBlock";

const MODEL = "claude-sonnet-4-6";
const MAX_ITERATIONS = 4;

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

export type EmpresaGasto = "WOBA" | "EWORKS" | "Footprint" | "desconocida";

export interface LineaFactura {
  concepto: string;
  base: number;
  tipoIvaPct: number;
  /**
   * Porcentaje de retención de IRPF de esta línea, SI la factura lo muestra
   * (típico en alquileres/arrendamientos y servicios profesionales en
   * España — ej. "I.R.P.F. (19%)" restando del total, no sumando como el
   * IVA). 0/undefined si no aplica. Bug real encontrado en vivo: una
   * factura de alquiler (base 3.380,66€ + IVA 21% = 4.090,60€) tenía además
   * una retención de IRPF del 19% (-642,32€), así que el "Total a Ingresar"
   * real era 3.448,28€ — pero el gasto se registró en Holded sin la
   * retención, con un total (4.090,60€) que NO coincidía con lo que de
   * verdad salió del banco, aunque la conciliación bancaria sí había usado
   * el monto correcto.
   */
  retencionPct?: number;
}

export interface DatosFactura {
  esFacturaOGasto: boolean;
  proveedor: string;
  /** Total real de la factura (base + todo el IVA), tal como aparece impreso — se usa para el matching. */
  monto: number;
  moneda: string;
  /**
   * Solo cuando `moneda` no es la moneda real de la tarjeta/cuenta que hizo
   * el cargo: el monto equivalente, SI el propio documento o el correo lo
   * muestra explícitamente (ej. una notificación de tarjeta: "40.46 EUR |
   * 148.346 COP", o "6.41 USD | 109 MXN"). undefined si no hay ningún
   * equivalente explícito — nunca se calcula ni se inventa un tipo de
   * cambio. Va SIEMPRE junto con `monedaEquivalente` (la moneda REAL de ese
   * monto, que puede ser EUR, USD, u otra — NUNCA asumas que es EUR, hay
   * que leer literalmente qué código/símbolo de moneda acompaña a esa
   * cifra). Casos reales que motivaron esto: (1) un gasto de Uber en
   * Colombia se registró por error con 148.346 (el monto en COP) tratado
   * como si fueran EUR; (2) un gasto de Starbucks en México ("6.41 USD |
   * 109 MXN") se registró por error con 6.41 tratado como si fueran EUR,
   * cuando el correo decía USD explícitamente — la conciliación bancaria
   * necesita el monto en la moneda REAL que usó la tarjeta/cuenta, sea cual
   * sea.
   */
  montoEquivalente?: number;
  /** Moneda ISO 4217 de `montoEquivalente` (ej. "EUR", "USD") — nunca asumida, siempre la que dice el documento/correo. */
  monedaEquivalente?: string;
  /**
   * Nombre de la persona a la que corresponde este gasto en concreto (para
   * usarlo como tag en Holded), si hay evidencia clara — nunca inventado.
   * Caso real que motivó esto: un gasto de Uber de Alejandro se etiquetó
   * "Kelly" porque inferirCuentaGasto solo sabe repetir el tag más frecuente
   * históricamente en esa cuenta contable, sin ninguna relación con quién
   * hizo ESTE gasto en particular. Cuando este campo viene informado, debe
   * usarse en vez del tag histórico.
   */
  personaAsociada?: string;
  fecha: string; // YYYY-MM-DD, según lo que diga el documento
  concepto: string;
  /**
   * Pedido explícito de Carlos: al crear el gasto en Holded, "Número de
   * documento" debe quedar diligenciado con el número real de la factura/
   * recibo/ticket tal como aparece impreso (ej. "Número de recibo",
   * "Nº factura", "Invoice number") — NUNCA un número inventado o adivinado.
   * undefined si el documento no muestra ninguno con claridad (Holded
   * simplemente lo deja en blanco/genera el suyo propio en ese caso, en vez
   * de recibir un dato falso).
   */
  numeroDocumento?: string;
  /** Desglose por tipo de IVA (una o varias líneas). El % es el que aparece impreso, no un código de Holded. */
  lineas: LineaFactura[];
  empresaProbable: EmpresaGasto;
  confianza: "alta" | "media" | "baja";
  razon: string;
}

const REPORTAR_TOOL_NAME = "reportar_datos_factura";

const REPORTAR_TOOL: Anthropic.Tool = {
  name: REPORTAR_TOOL_NAME,
  description:
    "Reporta los datos extraídos del documento (o que no es una factura/gasto). Debes llamarla " +
    "siempre al terminar — nunca respondas solo en texto.",
  input_schema: {
    type: "object",
    properties: {
      es_factura_o_gasto: {
        type: "boolean",
        description: "true si el documento es una factura, recibo, ticket o comprobante de gasto/pago.",
      },
      proveedor: { type: "string", description: "Nombre del proveedor/emisor tal como aparece en el documento." },
      monto: {
        type: "number",
        description:
          "Importe FINAL real de la factura (base + IVA, MENOS cualquier retención de IRPF si la hay) — el " +
          "que de verdad sale de la cuenta, normalmente etiquetado 'Total a pagar', 'Total a ingresar' o " +
          "similar. NUNCA el subtotal antes de la retención, aunque también aparezca impreso — si hay una " +
          "línea de IRPF/retención, réstala tú de cabeza para reportar el total real (base+IVA-retención), " +
          "tal como aparece impreso en el total final del documento.",
      },
      moneda: { type: "string", description: "Código de moneda, ej. EUR, USD." },
      monto_equivalente: {
        type: "number",
        description:
          "El monto real que salió de la cuenta/tarjeta, SI el propio documento o el correo lo muestra " +
          "explícitamente (ej. una notificación de tarjeta '40.46 EUR | 148.346 COP', o '6.41 USD | 109 " +
          "MXN', o el asunto de un reenvío que solo menciona el equivalente: '11.98 euros - Uber...'). " +
          "Repórtalo si existe ese dato explícito, AUNQUE 'moneda' (la del comprobante) también sea una " +
          "moneda válida para el grupo — que el grupo tenga cuentas reales en varias monedas no significa " +
          "que ESTA tarjeta sea esa cuenta. Si no hay ningún equivalente explícito en ningún lado, omite " +
          "este campo por completo — NUNCA calcules ni inventes un tipo de cambio tú mismo. Debes reportar " +
          "SIEMPRE junto con 'moneda_equivalente'.",
      },
      moneda_equivalente: {
        type: "string",
        description:
          "Código de moneda ISO 4217 de 'monto_equivalente' — LITERALMENTE el que aparece impreso junto a " +
          "esa cifra (ej. 'EUR' en '40.46 EUR | 148.346 COP', pero 'USD' en '6.41 USD | 109 MXN'). NUNCA " +
          "asumas que es EUR por defecto — algunas tarjetas están en USD, no en EUR. Lee el símbolo/código " +
          "exacto que acompaña al número.",
      },
      persona_asociada: {
        type: "string",
        description:
          "Nombre de la persona a la que corresponde ESTE gasto en concreto (se usará como tag en " +
          "Holded), SOLO si hay evidencia clara. Prioridad: (1) si el contexto del correo muestra una " +
          "cadena de reenvío ('---------- Forwarded message --------- From: X'), usa el remitente " +
          "ORIGINAL de esa cadena (no quien hizo el último reenvío) — normalmente es quien realmente " +
          "incurrió en el gasto y lo está reportando hacia arriba; (2) si no hay cadena de reenvío, un " +
          "nombre de persona específico que aparezca en el propio documento (ej. el viajero en un recibo " +
          "de Uber/vuelo/hotel). Si no hay ninguna evidencia clara de una persona concreta, omite este " +
          "campo — nunca inventes un nombre.",
      },
      fecha: { type: "string", description: "Fecha del documento en formato YYYY-MM-DD." },
      numero_documento: {
        type: "string",
        description:
          "El número real del documento tal como aparece impreso, EXCLUSIVAMENTE junto a una etiqueta que " +
          "lo identifique como tal (ej. 'Número de recibo', 'Nº factura', 'Invoice number', 'Ticket nº', " +
          "'Nº de documento'). Cópialo LITERAL, con ceros a la izquierda y guiones si los trae. NO uses " +
          "ningún otro número que aparezca en el documento aunque parezca un identificador (ej. número de " +
          "cliente, número de pedido/reserva, NIF/CIF, teléfono, IBAN, código de terminal o autorización de " +
          "tarjeta) — esos NO son el número de documento. Omite este campo por completo si no hay ninguno " +
          "etiquetado con claridad como número de factura/recibo/documento — NUNCA inventes ni adivines uno, " +
          "y nunca uses un número parecido a falta de uno real.",
      },
      concepto: { type: "string", description: "Breve descripción de qué es el gasto." },
      lineas: {
        type: "array",
        description:
          "Desglose por tipo de IVA, tal como aparece en la factura (una línea por cada base+IVA " +
          "distinto). Si la factura no desglosa nada (un solo total, sin IVA separado), reporta UNA " +
          "línea con base = monto y tipo_iva_pct = 0 (nunca inventes un desglose que no está impreso).",
        items: {
          type: "object",
          properties: {
            concepto: { type: "string", description: "Descripción de esta línea/concepto." },
            base: { type: "number", description: "Base imponible de esta línea (sin IVA, sin restar la retención)." },
            tipo_iva_pct: {
              type: "number",
              description: "Porcentaje de IVA de esta línea tal como aparece impreso (ej. 21, 10, 0). NUNCA un código de Holded.",
            },
            retencion_pct: {
              type: "number",
              description:
                "Porcentaje de retención de IRPF de esta línea, SI la factura lo muestra (ej. 'I.R.P.F. " +
                "(19%)' — típico en alquileres/arrendamientos y servicios profesionales en España, resta " +
                "del total en vez de sumar como el IVA). Omite este campo si la factura no muestra ninguna " +
                "retención — nunca la inventes.",
            },
          },
          required: ["concepto", "base", "tipo_iva_pct"],
        },
      },
      empresa_probable: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint", "desconocida"],
        description: "A qué empresa del grupo pertenece este gasto, según el documento y el contexto conocido.",
      },
      confianza: { type: "string", enum: ["alta", "media", "baja"] },
      razon: { type: "string", description: "Explicación breve de la clasificación (o de por qué no es una factura)." },
    },
    required: ["es_factura_o_gasto", "confianza", "razon"],
  },
};

function buildSystemPrompt(clasificacionesAprendidas: string | null): string {
  return [
    "Eres el lector de facturas/gastos entrantes del grupo (WOBA/BAE, Footprint, eWorks).",
    "Recibes el contenido REAL de un documento (PDF o imagen) — léelo con atención, no adivines.",
    "Primero decide si es una factura, recibo, ticket o comprobante de gasto/pago. Si es cualquier otra " +
      "cosa (contrato, certificado, documento de RRHH, etc.), reporta es_factura_o_gasto=false y no " +
      "sigas extrayendo los demás campos.",
    "Si sí es un gasto, extrae proveedor, monto total, moneda, fecha y un concepto breve, tal como " +
      "aparecen en el documento — no inventes ni redondees.",
    "Extrae también el desglose de IVA en 'lineas': si la factura muestra bases y tipos de IVA " +
      "distintos (ej. una parte al 21% y otra al 10%), repórtalos como líneas separadas. Si solo hay un " +
      "total sin desglose, repórtalo como una sola línea. El porcentaje de IVA es el que está impreso " +
      "en el documento (un número como 21 o 10) — nunca un código interno de Holded, eso se resuelve " +
      "después con datos reales del sistema.",
    "IMPORTANTE — retención de IRPF: muchas facturas de alquiler/arrendamiento de local y de " +
      "profesionales autónomos en España incluyen, además del IVA (que SUMA), una retención de IRPF que " +
      "RESTA del total (ej. 'I.R.P.F. (19%) sobre B.I.: -642,32€'), dejando un 'Total a Ingresar'/'Total " +
      "a pagar' final menor que base+IVA. Si ves una línea así, repórtala en 'retencion_pct' de la línea " +
      "correspondiente (el % tal como aparece, ej. 19), y asegúrate de que 'monto' (el total general) sea " +
      "el importe FINAL real (base+IVA-retención), no el subtotal antes de restarla — de lo contrario el " +
      "gasto se registra por un importe que nunca salió realmente del banco. Si la factura no muestra " +
      "ninguna retención, omite 'retencion_pct' — nunca la inventes ni asumas que aplica.",
    "Para decidir la empresa probable (WOBA, EWORKS o Footprint), usa consultar_base_conocimiento si " +
      "hace falta contexto sobre qué proveedores/gastos son de cada empresa.",
    "Si el documento o el correo muestran un monto equivalente al que trae el propio comprobante (típico " +
      "en notificaciones de tarjeta por gastos en el extranjero: '40.46 EUR | 148.346 COP', o '6.41 USD | " +
      "109 MXN'), repórtalo SIEMPRE en 'monto_equivalente' + 'moneda_equivalente' — ese es el monto real " +
      "que salió de la cuenta, no el de la moneda local del comercio. Repórtalo aunque 'moneda' (la del " +
      "comprobante) te parezca una moneda 'normal' o válida para el grupo — el hecho de que el grupo tenga " +
      "cuentas reales en varias monedas (EUR, USD, COP, etc.) no significa que ESTA tarjeta en particular " +
      "sea esa cuenta; lo único que importa es qué moneda declara explícitamente el equivalente. IMPORTANTE: " +
      "'moneda_equivalente' NUNCA se asume EUR por defecto — lee literalmente el código/símbolo que " +
      "acompaña a esa cifra (algunas tarjetas del grupo están en USD, no en EUR; ej. '6.41 USD' es USD, no " +
      "EUR, aunque el resto de la operación del grupo use euros). Si no hay ningún equivalente en ningún " +
      "lado, omite ambos campos — nunca calcules tú un tipo de cambio.",
    "Además del documento adjunto, puede que recibas 'Contexto del correo' (asunto/cuerpo del mensaje " +
      "que traía este adjunto, ej. un reenvío de notificación bancaria). Es habitual que el recibo/factura " +
      "en sí (ej. de Uber, Starbucks) NO muestre el monto equivalente, pero el correo que lo reenvía sí lo " +
      "diga en el asunto — a veces emparejado con el monto local ('Fwd: 40.46 EUR | 148.346 COP - Uber', " +
      "'Fwd: 6.41USD | 109MXN - Starbucks'), y a veces MENCIONANDO SOLO el equivalente, sin el monto local " +
      "al lado ('Fwd: 11.98 euros - Uber aeropuerto - Visa', donde el comprobante en sí trae el monto en " +
      "pesos). AMBOS casos cuentan igual — no hace falta que el asunto muestre las dos cifras juntas: si " +
      "menciona una moneda/monto DISTINTO al del comprobante, usa ESE texto para reportar " +
      "'monto_equivalente'/'moneda_equivalente' igual que si viniera impreso en el documento — sigue siendo " +
      "un dato real, no un cálculo tuyo, y la moneda es la que literalmente aparece ahí (nunca asumas EUR " +
      "sin leerlo). Si ni el documento ni el contexto del correo traen un equivalente explícito, omite " +
      "ambos campos.",
    "Ese mismo 'Contexto del correo' también sirve para identificar 'persona_asociada' — mira si hay una " +
      "cadena de reenvío y usa el remitente ORIGINAL (el 'From:' dentro del bloque 'Forwarded message', no " +
      "quien hizo el último reenvío) como la persona a la que corresponde el gasto.",
    clasificacionesAprendidas
      ? `Además, estas son clasificaciones aprendidas de facturas anteriores del mismo proveedor — ` +
        `dales prioridad sobre cualquier suposición genérica:\n\n${clasificacionesAprendidas}`
      : "",
    "Si no tienes certeza de la empresa o algún dato clave, usa confianza='baja' o 'media' en vez de " +
      "inventar — es preferible preguntar que asumir mal en un tema de dinero.",
    `SIEMPRE debes terminar llamando a la herramienta ${REPORTAR_TOOL_NAME} con tu conclusión final.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}


/**
 * Lee el CONTENIDO real de un documento (PDF/imagen, no solo su nombre) y
 * decide si es una factura/gasto y, si lo es, extrae sus datos. Nunca escribe
 * ni sube nada — es puramente lectura/clasificación, igual que
 * classifyFile.ts. Si el documento no es legible o no es una factura,
 * es_factura_o_gasto vuelve false para que el llamador siga el flujo normal
 * de archivado en Drive.
 */
export async function extraerDatosFactura(
  rutaLocal: string,
  mimeType: string | undefined,
  contextoCorreo?: string
): Promise<DatosFactura> {
  const fallback: DatosFactura = {
    esFacturaOGasto: false,
    proveedor: "",
    monto: 0,
    moneda: "",
    fecha: "",
    concepto: "",
    lineas: [],
    empresaProbable: "desconocida",
    confianza: "baja",
    razon: "No fue posible leer el documento.",
  };

  let documentBlock: DocumentOrImageBlock;
  try {
    const data = await readFile(rutaLocal);
    documentBlock = mimeADocumentBlock(rutaLocal, mimeType, data);
  } catch (error) {
    console.error("[extractInvoiceData] Error leyendo/preparando el archivo:", error);
    return fallback;
  }

  const anthropic = getClient();
  const clasificacionesAprendidas = await obtenerClasificacionesAprendidas().catch(() => null);

  const tools: Anthropic.Tool[] = [
    { name: knowledgeBaseTool.name, description: knowledgeBaseTool.description, input_schema: knowledgeBaseTool.input_schema },
    REPORTAR_TOOL,
  ];

  const textoInstruccion = contextoCorreo
    ? `Lee este documento y reporta sus datos.\n\nContexto del correo que traía este adjunto:\n${contextoCorreo}`
    : "Lee este documento y reporta sus datos.";

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      // El cast es necesario porque el SDK instalado no declara bloques
      // "document"/"image" con source base64 en su tipo MessageParam,
      // aunque la API sí los acepta (ver DocumentOrImageBlock arriba).
      content: [documentBlock, { type: "text", text: textoInstruccion }] as unknown as Anthropic.MessageParam["content"],
    },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(clasificacionesAprendidas),
      tools,
      messages,
    });

    // Bug real encontrado en vivo: esta llamada real a Claude nunca se
    // registraba en _costos_ia (a diferencia de core/claude/client.ts) —
    // el gasto real de leer facturas no aparecía en el panel de costos.
    registrarUsoIA(undefined, MODEL, response.usage).catch((error) =>
      console.error("[extractInvoiceData] Error registrando uso de IA:", error)
    );

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    const reportar = toolUseBlocks.find((b) => b.name === REPORTAR_TOOL_NAME);
    if (reportar) {
      const input = reportar.input as Record<string, unknown>;
      const monto = typeof input.monto === "number" ? input.monto : 0;

      const lineasRaw = Array.isArray(input.lineas) ? input.lineas : [];
      const lineas: LineaFactura[] = lineasRaw
        .map((l): LineaFactura | null => {
          if (typeof l !== "object" || l === null) return null;
          const linea = l as Record<string, unknown>;
          return {
            concepto: typeof linea.concepto === "string" ? linea.concepto : "",
            base: typeof linea.base === "number" ? linea.base : 0,
            tipoIvaPct: typeof linea.tipo_iva_pct === "number" ? linea.tipo_iva_pct : 0,
            retencionPct: typeof linea.retencion_pct === "number" && linea.retencion_pct > 0 ? linea.retencion_pct : undefined,
          };
        })
        .filter((l): l is LineaFactura => l !== null);

      return {
        esFacturaOGasto: Boolean(input.es_factura_o_gasto),
        proveedor: (input.proveedor as string) ?? "",
        monto,
        moneda: (input.moneda as string) ?? "EUR",
        montoEquivalente: typeof input.monto_equivalente === "number" ? input.monto_equivalente : undefined,
        monedaEquivalente:
          typeof input.moneda_equivalente === "string" && input.moneda_equivalente.trim()
            ? input.moneda_equivalente.trim().toUpperCase()
            : undefined,
        personaAsociada: typeof input.persona_asociada === "string" && input.persona_asociada.trim() ? input.persona_asociada.trim() : undefined,
        fecha: (input.fecha as string) ?? "",
        numeroDocumento: typeof input.numero_documento === "string" && input.numero_documento.trim() ? input.numero_documento.trim() : undefined,
        concepto: (input.concepto as string) ?? "",
        // Si Claude no reportó líneas (o vinieron vacías), se usa una sola
        // línea con el total completo a 0% en vez de perder el importe —
        // crearGastoHolded siempre necesita al menos una línea.
        lineas: lineas.length > 0 ? lineas : [{ concepto: (input.concepto as string) ?? "", base: monto, tipoIvaPct: 0 }],
        empresaProbable: (input.empresa_probable as EmpresaGasto) ?? "desconocida",
        confianza: (input.confianza as DatosFactura["confianza"]) ?? "baja",
        razon: (input.razon as string) ?? "",
      };
    }

    if (toolUseBlocks.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.name === knowledgeBaseTool.name) {
        const resultado = await knowledgeBaseTool.handler(block.input as Record<string, unknown>);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultado });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return fallback;
}
