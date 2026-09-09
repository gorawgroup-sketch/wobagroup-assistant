import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { knowledgeBaseTool } from "../tools/knowledgeBase";
import { obtenerClasificacionesAprendidas } from "../gastos/clasificacionAprendidaSheet";
import { crearMensajeAnthropic } from "../ai/anthropicGateway";
import { crearEjecucionIA } from "../ai/policy";
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
  /**
   * true si hay evidencia real de que este gasto ocurrió durante un viaje/desplazamiento de trabajo
   * de `personaAsociada`. Pedido explícito de Carlos, casos reales (Simon Talloen, tickets ALDI/
   * Ahorramas): decide la cuenta contable (inferirCuentaGasto, ver core/holded/write.ts) — un gasto
   * cotidiano de alguien de viaje se contabiliza como gasto de viaje, no como gasto normal de oficina.
   */
  contextoDeViaje?: boolean;
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
  /**
   * true si el documento es un recibo/tique simplificado (sin los datos
   * fiscales de la empresa compradora impresos) — legalmente no deducible
   * de IVA. Pedido explícito de Carlos, casos reales ALDI/Ahorramas: cuando
   * es true, `lineas` se colapsa a un solo importe sin desglosar IVA antes
   * de llegar a Holded (ver procesarGastoEntrante.ts), sin importar qué
   * desglose venga impreso en el propio tique.
   */
  reciboSimplificado: boolean;
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
        description:
          "true SOLO si el documento es una factura, recibo, ticket o comprobante de un GASTO real — " +
          "dinero que SALE del grupo. false si es cualquier otra cosa (contrato, certificado, documento " +
          "de RRHH), y también false si describe dinero que ENTRA al grupo: una factura de VENTA que el " +
          "grupo emite a un cliente, una certificación de obra/avance de proyecto (la contrapartida " +
          "habitual de esa venta), o cualquier documento donde el grupo es quien COBRA en vez de quien " +
          "paga. El grupo también factura y cobra a sus propios clientes en muchos proyectos — antes de " +
          "reportar true, confirma que el grupo es quien PAGA en esta transacción, no quien la emite/cobra.",
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
      contexto_de_viaje: {
        type: "boolean",
        description:
          "true si este es un gasto INDIVIDUAL de comida, transporte u hospedaje de UNA persona " +
          "identificada (ver persona_asociada) — un almuerzo/cena/taxi/hotel de esa persona en " +
          "concreto, no una compra o contrato a nombre de la empresa (ej. un servicio de catering para " +
          "toda la oficina, una suscripción, un proveedor recurrente). El grupo contabiliza este tipo de " +
          "gasto individual como 'Gastos de viaje', sin importar si la persona viajó literalmente a otra " +
          "ciudad o no — un almuerzo/cena de una sola persona en un restaurante normal ya cuenta, aunque " +
          "sea en su ciudad habitual. Pedido explícito de Carlos, casos reales: tickets de supermercado " +
          "de Simon Talloen en desplazamiento (ALDI, Ahorramas), y un ticket de restaurante de Carlos " +
          "González en Madrid (Nori Nori) — en los tres, 'los productos y demás consideraciones ' " +
          "inteligentes' ya bastan para reconocerlo como gasto de viaje: 1-2 platos/bebidas para una " +
          "sola persona, sin más contexto que lo clasifique de otra forma. true por defecto siempre que " +
          "persona_asociada quede identificada Y el gasto sea de esta naturaleza individual — false SOLO " +
          "si es claramente otra cosa (una factura/contrato formal a nombre de la empresa, un pedido para " +
          "varias personas/toda la oficina, o si no se identificó ninguna persona asociada).",
      },
      fecha: { type: "string", description: "Fecha del documento en formato YYYY-MM-DD." },
      numero_documento: {
        type: "string",
        description:
          "El número real del documento tal como aparece impreso, junto a una etiqueta que lo identifique " +
          "como tal. PRIORIDAD 1 — un número de documento propiamente dicho: 'Número de recibo', 'Nº " +
          "factura', 'Invoice number', 'Ticket nº/Nº billete', 'Nº de documento', 'Localizador/Booking " +
          "reference/PNR'. PRIORIDAD 2 (hallazgo real de auditoría: quedaba '00000' en Holded en casi TODOS " +
          "los tickets/recibos simples, aunque casi siempre traen ALGUNA referencia real impresa) — si no " +
          "hay un número de documento propiamente dicho, usa la MEJOR referencia real que el ticket/recibo " +
          "sí traiga, en este orden: folio ('Folio', 'Nº de operación/transacción', 'ID de pedido/venta'), " +
          "luego autorización/referencia de pago ('Autorización', 'AUT', 'Referencia', 'REF', 'ID de sesión'). " +
          "Cualquiera de estos identifica DE VERDAD esta compra puntual — es preferible usar uno de estos a " +
          "dejar el campo vacío (y que Holded quede con '00000', un placeholder sin ningún valor real para " +
          "encontrar el ticket después). Cópialo LITERAL, con ceros a la izquierda y guiones si los trae. Si " +
          "el documento trae VARIOS de estos (ej. folio Y autorización), prefiere el que tenga la etiqueta " +
          "más específica de 'documento/operación/pedido' sobre la de 'autorización de pago' pura. Si el " +
          "documento cubre VARIAS líneas/tramos con su PROPIO número cada uno (ej. billete de ida y billete " +
          "de vuelta) y no hay un único número que sirva para las dos, usa el localizador/número de reserva " +
          "COMPARTIDO que identifica la compra completa. NO uses NUNCA (estos NO identifican esta compra en " +
          "concreto, identifican a la PERSONA/cuenta en general): número de cliente/cuenta, NIF/CIF, " +
          "teléfono, IBAN, o los últimos dígitos de la tarjeta. Omite este campo por completo solo si el " +
          "documento genuinamente no trae NINGÚN número/folio/referencia identificable — NUNCA inventes ni " +
          "adivines uno, y nunca uses un número parecido a falta de uno real.",
      },
      concepto: { type: "string", description: "Breve descripción de qué es el gasto." },
      recibo_simplificado: {
        type: "boolean",
        description:
          "true si el documento es un recibo/tique SIMPLIFICADO — NO muestra los datos fiscales " +
          "completos de la empresa COMPRADORA (nombre/razón social + NIF/CIF en España, o razón " +
          "social + RFC en México) impresos en el propio documento, normalmente porque solo trae un " +
          "único total al consumidor final. false si es una factura FORMAL COMPLETA que sí identifica " +
          "a la empresa compradora con su nombre y número fiscal (una sección tipo 'Datos del " +
          "cliente'/'Facturar a', con el nombre y NIF/CIF/RFC del grupo o su razón social legal). " +
          "Pedido explícito de Carlos, tras varios casos reales (tickets de supermercado como ALDI, " +
          "Ahorramas): un recibo simplificado NO se puede usar legalmente para deducir el IVA, aunque " +
          "el propio tique muestre un desglose de IVA impreso — el desglose de esos documentos no " +
          "tiene validez fiscal para el grupo, así que deben registrarse como un solo importe total, " +
          "SIN desglosar IVA (ver 'lineas' más abajo). Repórtalo también cuando el documento no es " +
          "legible del todo o no queda claro (true por defecto ante la duda — es preferible no " +
          "deducir un IVA real que deducir uno que luego no se pueda justificar ante Hacienda).",
      },
      lineas: {
        type: "array",
        description:
          "Desglose por tipo de IVA, tal como aparece en la factura (una línea por cada base+IVA " +
          "distinto). Si la factura no desglosa nada (un solo total, sin IVA separado), reporta UNA " +
          "línea con base = monto y tipo_iva_pct = 0 (nunca inventes un desglose que no está impreso). " +
          "Si 'recibo_simplificado' es true, reporta SIEMPRE una sola línea con base = monto y " +
          "tipo_iva_pct = 0, sin importar qué desglose de IVA traiga impreso el propio tique — ese " +
          "desglose no tiene validez fiscal para el grupo en un recibo simplificado.",
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
    "Primero decide si es una factura, recibo, ticket o comprobante de un GASTO real (dinero que SALE " +
      "del grupo). Si es cualquier otra cosa (contrato, certificado, documento de RRHH, etc.), reporta " +
      "es_factura_o_gasto=false y no sigas extrayendo los demás campos.",
    "IMPORTANTE — dirección del dinero: el grupo también FACTURA y COBRA a sus propios clientes en " +
      "muchos proyectos. Una factura de VENTA que el grupo emite, o una certificación de obra/avance de " +
      "proyecto (la contrapartida habitual de esa venta), es un INGRESO — nunca es_factura_o_gasto=true, " +
      "aunque tenga toda la forma de una factura real con monto y proveedor identificables. Antes de " +
      "concluir que es un gasto, confirma que el grupo es quien PAGA en esa transacción, no quien la " +
      "emite/cobra.",
    "Si sí es un gasto, extrae proveedor, monto total, moneda, fecha y un concepto breve, tal como " +
      "aparecen en el documento — no inventes ni redondees.",
    "Extrae también el desglose de IVA en 'lineas': si la factura muestra bases y tipos de IVA " +
      "distintos (ej. una parte al 21% y otra al 10%), repórtalos como líneas separadas. Si solo hay un " +
      "total sin desglose, repórtalo como una sola línea. El porcentaje de IVA es el que está impreso " +
      "en el documento (un número como 21 o 10) — nunca un código interno de Holded, eso se resuelve " +
      "después con datos reales del sistema.",
    "IMPORTANTE — recibo simplificado vs. factura formal: antes de desglosar IVA en 'lineas', decide " +
      "si el documento es un recibo/tique SIMPLIFICADO (no muestra el nombre y NIF/CIF/RFC de la " +
      "empresa compradora, solo un total al consumidor final — típico de tickets de supermercado, " +
      "gasolinera, parking, taxi) o una factura FORMAL COMPLETA (sí identifica a la empresa compradora " +
      "con nombre + número fiscal, típica sección 'Datos del cliente'/'Facturar a'). Si el propio " +
      "documento imprime literalmente 'Factura Simplificada' (caso real: ticket de Nori Nori) es la " +
      "señal más fuerte posible — repórtalo true sin dudar, no hace falta ningún otro análisis. Reporta " +
      "'recibo_simplificado'. Un recibo simplificado NO se puede usar legalmente para deducir IVA, así " +
      "que su 'lineas' debe reportarse como UNA sola línea con base = monto y tipo_iva_pct = 0 — nunca " +
      "reportes el desglose de IVA que traiga impreso, aunque lo traiga. Ante la duda, marca " +
      "recibo_simplificado=true (mejor no deducir un IVA real que deducir uno que luego no se pueda " +
      "justificar ante Hacienda).",
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
    "IMPORTANTE — contexto de viaje/desplazamiento: si 'persona_asociada' quedó identificada, revisa " +
      "también si hay evidencia real de que estaba de viaje (lugar distinto a su base habitual mencionado " +
      "en el documento o en el contexto del correo/caption, o consultar_base_conocimiento lo confirma) y " +
      "repórtalo en 'contexto_de_viaje'. Un gasto cotidiano (comida, transporte, alojamiento) de alguien " +
      "de viaje se contabiliza como gasto de viaje/desplazamiento, aunque el propio ticket (ej. un " +
      "supermercado) no lo diga por sí mismo — no lo asumas sin evidencia real.",
    clasificacionesAprendidas
      ? `Además, estas son clasificaciones aprendidas de facturas anteriores del mismo proveedor — ` +
        `dales prioridad sobre cualquier suposición genérica:\n\n${clasificacionesAprendidas}`
      : "",
    "IMPORTANTE — estados de cuenta con 'saldo inicial'/'saldo final' (ej. los resúmenes semanales de " +
      "Google Workspace 'Transactions'): estos NO son una factura simple — muestran un PAGO real (línea " +
      "'Automatic payment: ...', con signo negativo) que salda un saldo ACUMULADO de antes, y por separado " +
      "el USO NUEVO acumulado en ESTE período (que se cobrará en el PRÓXIMO pago, todavía no en este). Caso " +
      "real que motivó esto: un estado de cuenta mostraba 'Starting balance: $789.09' → 'Automatic payment: " +
      "-$789.09' → dos líneas de uso nuevo que suman '$157.68' → 'Ending balance: $157.68' — el pago real " +
      "que salió del banco fue $789.09 (el 'monto' correcto de este gasto, y lo que de verdad conciliará " +
      "contra el banco), pero las líneas de $157.68 describen uso de un período DISTINTO y NO son el " +
      "desglose de ese pago — usarlas como 'lineas' habría registrado un gasto de $789.09 con un desglose " +
      "que solo suma $157.68, un descuadre real. Cuando veas este patrón (saldo inicial + pago automático + " +
      "uso nuevo del período + saldo final): 'monto' es el importe de la línea de PAGO (el saldo inicial que " +
      "está saldando), y 'lineas' debe ser una única línea por ese mismo monto total — el documento no " +
      "muestra el desglose real de qué compone ESE pago (viene de un período anterior no detallado acá), así " +
      "que no lo inventes ni uses el desglose del período nuevo, que es para un cobro futuro distinto.",
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
    reciboSimplificado: true,
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
  const ejecucion = crearEjecucionIA("extraer_factura");
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
    const response = await crearMensajeAnthropic(anthropic, ejecucion, {
      model: MODEL,
      // Preventivo — mismo patrón que ya causó un bug real confirmado en vivo
      // en core/gmail/classifyEmail.ts (dos correos seguidos cayeron en el
      // fallback genérico porque el modelo se quedaba sin presupuesto antes
      // de llegar a llamar la tool de reportar). Este archivo comparte la
      // misma estructura (tool-calling con razonamiento) con un techo
      // igual de ajustado — 8192 es el estándar ya establecido en este
      // proyecto para este tipo de llamada (ver core/claude/client.ts). Acá
      // el riesgo es más serio todavía: esto extrae datos de FACTURAS reales.
      max_tokens: 8192,
      // Las reglas aprendidas cambian rara vez y se repiten entre adjuntos
      // del mismo lote. El PDF/imagen nunca se incluye en este breakpoint.
      system: [
        {
          type: "text",
          text: buildSystemPrompt(clasificacionesAprendidas),
          cache_control: { type: "ephemeral" },
        },
      ],
      tools,
      messages,
    });

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    const reportar = toolUseBlocks.find((b) => b.name === REPORTAR_TOOL_NAME);
    if (reportar) {
      const input = reportar.input as Record<string, unknown>;
      const monto = typeof input.monto === "number" ? input.monto : 0;

      // Ante duda/omisión, se asume NO simplificado (preserva el comportamiento existente de
      // desglosar IVA) — el riesgo real de un falso negativo puntual (un recibo simplificado que se
      // cuela con IVA desglosado) es mucho menor que el de un default al revés, que colapsaría el IVA
      // de TODAS las facturas formales legítimas si este campo alguna vez llegara vacío por un bug.
      // === "true" además de === true — hallazgo real de auditoría: mismo patrón defensivo ya usado
      // para booleans de origen no 100% confiable en otras partes del proyecto (ver
      // gastoPendienteDatosStore.ts) — si el modelo alguna vez devuelve el string "true" en vez del
      // boolean literal, no debe caer silenciosamente al default (que acá SÍ importa: decide si se
      // puede deducir IVA).
      const reciboSimplificado = input.recibo_simplificado === true || input.recibo_simplificado === "true";

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
      const lineaUnica: LineaFactura = { concepto: (input.concepto as string) ?? "", base: monto, tipoIvaPct: 0 };

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
        contextoDeViaje: input.contexto_de_viaje === true || input.contexto_de_viaje === "true",
        fecha: (input.fecha as string) ?? "",
        numeroDocumento: typeof input.numero_documento === "string" && input.numero_documento.trim() ? input.numero_documento.trim() : undefined,
        concepto: (input.concepto as string) ?? "",
        reciboSimplificado,
        // Si Claude no reportó líneas (o vinieron vacías), se usa una sola
        // línea con el total completo a 0% en vez de perder el importe —
        // crearGastoHolded siempre necesita al menos una línea. En un recibo
        // simplificado se fuerza el colapso acá también (no solo aguas abajo
        // en procesarGastoEntrante.ts) aunque Claude haya reportado un
        // desglose — defensa en profundidad: ese desglose nunca tiene
        // validez fiscal en este tipo de documento, así que no debe llegar
        // ni siquiera a mostrarse como si fuera real.
        lineas: reciboSimplificado || lineas.length === 0 ? [lineaUnica] : lineas,
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
