import { buscarDocumentosHolded } from "../holded/write";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

/**
 * Responde "¿ya está esto registrado en Holded, aunque sea sin pagar?" —
 * consulta directamente /purchases (gastos) e /invoices (ingresos), no solo
 * los movimientos bancarios reales. Nace de un caso real: dos gastos del
 * cashflow sin salida bancaria todavía que en realidad SÍ ya estaban
 * cargados en Holded como facturas pendientes de pago — antes el asistente
 * no tenía forma de distinguir "no está registrado" de "está registrado
 * pero pendiente de pago", y lo decía explícitamente en vez de adivinar.
 */
export const consultarEstadoFacturaHoldedTool: ToolDefinition = {
  name: "consultar_estado_factura_holded",
  seguraParaModoRapido: true,
  description:
    "Busca si un pago/cargo concreto YA está registrado en Holded como factura (gasto vía /purchases o " +
    "ingreso vía /invoices) — aunque todavía no se haya pagado ni tenga movimiento bancario. Para cada " +
    "coincidencia devuelve el número de documento, fecha, vencimiento, total, cuánto está pagado vs. " +
    "pendiente, tags, y (para gastos) si tiene comprobante adjunto. Úsala cuando pregunten '¿ya está " +
    "cargada esta factura?', '¿está pendiente de pago o falta registrarla?', '¿cómo va el gasto de X?', " +
    "'¿quedó bien montado?', o para verificar un cargo del cashflow que no aparece todavía en los " +
    "movimientos bancarios (consultar_movimientos_holded) — antes de asumir que falta registrarlo, " +
    "confirma acá si ya existe. Para el estado COMPLETO de un gasto puntual ya creado (documento, " +
    "comprobante, pago) esta es la herramienta correcta — no consultar_movimientos_holded, que solo ve el " +
    "banco y no el documento de Holded. Para un BARRIDO de todos los gastos sin comprobante en un rango " +
    "de fechas (no uno puntual) usa mejor consultar_gastos_sin_comprobante. IMPORTANTE: 'contacto' también " +
    "sirve para buscar una MARCA o PRODUCTO (ej. 'Logitech', 'Booking.com') — si no coincide con ningún " +
    "nombre de proveedor/cliente, esta herramienta también revisa las líneas de concepto/producto de cada " +
    "documento antes de rendirse, porque el proveedor real puede ser un intermediario (ej. se compró un " +
    "producto Logitech a través de Amazon o un distribuidor, no a Logitech directamente) — el resultado " +
    "indica claramente si la coincidencia fue por proveedor o por línea de producto. REGLA DE IDENTIDAD: " +
    "si en el mensaje o el contexto ya se conoce el importe de la factura, debes enviar siempre 'monto'. " +
    "Una coincidencia solo por proveedor, asunto, nombre de archivo o texto de una línea es exploratoria y " +
    "NUNCA demuestra que sea el mismo gasto. Si los importes difieren, son documentos distintos.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint"],
        description: "Empresa del grupo cuyo Holded se consulta.",
      },
      contacto: {
        type: "string",
        description: "Nombre (o parte del nombre) del proveedor o cliente a buscar — coincidencia parcial, no hace falta el nombre exacto de Holded.",
      },
      monto: {
        type: "number",
        description:
          "Monto total de la factura. Es OBLIGATORIO cuando el usuario o el contexto ya dieron un importe; " +
          "la identidad exige coincidencia a un céntimo y no acepta otro gasto del mismo proveedor.",
      },
      moneda: {
        type: "string",
        description:
          "Moneda ISO del documento (EUR, USD, GBP...). Debe enviarse cuando se conoce; una igualdad numérica en otra moneda no identifica la misma factura.",
      },
      numeroDocumento: {
        type: "string",
        description: "Número exacto de factura/comprobante, si fue leído del adjunto.",
      },
      fecha: {
        type: "string",
        description: "Fecha exacta del documento en YYYY-MM-DD, si fue leída del adjunto.",
      },
      tipo: {
        type: "string",
        enum: ["gasto", "ingreso", "ambos"],
        description: "Busca solo en gastos (/purchases), solo en ingresos (/invoices), o ambos. Opcional, por defecto 'ambos'.",
      },
      dias: {
        type: "number",
        description: "Ventana de búsqueda hacia atrás Y hacia adelante, en días (las facturas ya cargadas pueden ser de varias semanas atrás, o tener fecha futura — ej. un viaje reservado con antelación). Opcional, por defecto 120.",
      },
    },
    required: ["empresa", "contacto"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const contacto = typeof input.contacto === "string" ? input.contacto.trim() : "";
    if (!contacto) {
      return "Error: hace falta 'contacto' (nombre o parte del nombre del proveedor/cliente a buscar).";
    }

    const monto = typeof input.monto === "number" ? input.monto : undefined;
    const moneda = typeof input.moneda === "string" && input.moneda.trim()
      ? input.moneda.trim().toUpperCase()
      : undefined;
    const numeroDocumento = typeof input.numeroDocumento === "string" && input.numeroDocumento.trim()
      ? input.numeroDocumento.trim()
      : undefined;
    const fecha = typeof input.fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.fecha.trim())
      ? input.fecha.trim()
      : undefined;
    const tipo =
      input.tipo === "gasto" || input.tipo === "ingreso" || input.tipo === "ambos"
        ? input.tipo
        : "ambos";
    const dias = typeof input.dias === "number" && input.dias > 0 ? input.dias : undefined;

    const resultados = await buscarDocumentosHolded(empresa, {
      contacto,
      monto,
      moneda,
      numeroDocumento,
      fecha,
      tipo,
      dias,
    });

    if (resultados.length === 0) {
      const montoTexto = monto !== undefined
        ? ` con monto ${monto.toFixed(2)} ${moneda ?? "(moneda no indicada)"}`
        : "";
      const ventanaTexto = dias ?? 120;
      return (
        `No encontré ninguna factura de "${contacto}"${montoTexto} en Holded (${empresa}) en los últimos ` +
        `${ventanaTexto} días — ni por nombre de proveedor/cliente, ni como palabra dentro de una línea de ` +
        `concepto/producto de otro documento. Parece que todavía no se ha registrado, no solo que falte ` +
        `pagarla — o que la compra es más antigua que la ventana buscada (puedes reintentar con un "dias" ` +
        `mayor si el usuario cree que fue hace más tiempo).`
      );
    }

    const lineas = resultados.map((r) => {
      const tipoTexto = r.tipo === "gasto" ? "Gasto" : "Ingreso";
      const vencimiento = r.dueDate ? `, vence ${r.dueDate}` : "";
      const borrador = r.draft ? " — borrador" : "";
      const moneda = r.moneda || "EUR";
      const estadoPago =
        r.pendiente > 0.01
          ? `PENDIENTE de pago (${r.pendiente.toFixed(2)} ${moneda} sin pagar de ${r.total.toFixed(2)} ${moneda})`
          : r.pendiente < -0.01
            ? `⚠️ saldo incoherente/sobrepagado (${r.total.toFixed(2)} ${moneda}; pendiente ${r.pendiente.toFixed(2)} ${moneda})`
            : `ya pagada (${r.total.toFixed(2)} ${moneda})`;
      const comprobante =
        r.tipo === "gasto"
          ? r.tieneComprobante === true
            ? " — con comprobante adjunto"
            : r.tieneComprobante === false
              ? " — ⚠️ SIN comprobante adjunto"
              : ""
          : "";
      const tags = r.tags.length > 0 ? ` — tags: ${r.tags.join(", ")}` : " — sin tags";
      const porLinea = r.coincidenciaPorLinea
        ? ` — 🔎 el proveedor NO se llama "${contacto}", coincide porque una línea de este documento dice "${r.lineaCoincidente}"`
        : "";
      return `- [${tipoTexto}] ${r.contactName} — doc ${r.documentNumber}, fecha ${r.fecha}${vencimiento} — ${estadoPago}${borrador}${comprobante}${tags}${porLinea}`;
    });

    const huboCoincidenciaSoloPorMonto = resultados.some((r) => r.coincidenciaSoloPorMonto);
    const nota = huboCoincidenciaSoloPorMonto
      ? `\n\n(No encontré coincidencia por nombre de "${contacto}" — esto(s) resultado(s) matchearon SOLO por el monto, confírmalo con el usuario antes de darlo por seguro.)`
      : "";

    const notaSinMonto = monto === undefined
      ? `\n\n⚠️ Esta fue una búsqueda EXPLORATORIA sin importe. Los resultados comparten proveedor o texto, pero ` +
        `NO identifican la factura concreta. No afirmes que "ya existe" ni que es el mismo documento hasta ` +
        `comparar importe, moneda, número de factura y fecha.`
      : "";

    return `${resultados.length} factura(s) encontrada(s) en Holded (${empresa}) para "${contacto}":\n\n${lineas.join("\n")}${nota}${notaSinMonto}`;
  },
};
