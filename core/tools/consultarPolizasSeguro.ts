import { listarPolizas } from "../seguros/polizaRegistroSheet";
import { calcularAlertasSeguros } from "../seguros/alertas";
import { listarDocumentosPoliza, type DocumentoPoliza } from "../seguros/documentosPolizaStore";
import type { ToolDefinition } from "./types";

/**
 * Da acceso de solo lectura al registro real de pólizas de seguro (WOBA,
 * EWORKS, Footprint — ver docs/wobi-seguros.md §5, §18, §22) desde
 * cualquier conversación de Wobi, no solo desde la tarjeta de Cerebro.
 *
 * Nace de un pedido explícito de Carlos (2026-09-29): todo lo que se le
 * comparte al agente sobre seguros (documentos, correos) es para que quede
 * integrado al conocimiento del sistema, de forma que más adelante, al
 * preguntar por una póliza o un complemento, el agente sepa responder Y
 * avise qué queda pendiente — sin esta tool, esa promesa no se puede
 * cumplir: el registro existía, pero ningún agente conversacional tenía
 * forma de leerlo.
 *
 * Deliberadamente NO es el sub-agente especialista de §6.5 (consultar_agente_seguros,
 * con su propia llamada a Claude y web search) — esto es una consulta de
 * datos simple, igual que consultar_estado_factura_holded o
 * consultar_movimientos_holded; el sub-agente especialista sigue reservado
 * para preguntas interpretativas/investigativas (§6.3, huecos de cobertura),
 * que es un capability distinto todavía sin construir.
 */
export const consultarPolizasSeguroTool: ToolDefinition = {
  name: "consultar_polizas_seguro",
  seguraParaModoRapido: true,
  description:
    "Consulta el registro real de pólizas de seguro del grupo (WOBA, EWORKS, Footprint): qué pólizas " +
    "existen, aseguradora, corredor, número de póliza, capital asegurado, prima, vigencia, y — lo más " +
    "importante — qué está PENDIENTE ahora mismo (pagos sin confirmar o devueltos por el banco, pólizas " +
    "próximas a vencer en los próximos 30 días). Úsala para cualquier pregunta sobre seguros: '¿cómo " +
    "está la póliza de RC de WOBA?', '¿tenemos algo pendiente de seguros?', '¿cuándo vence el seguro de " +
    "Footprint?', '¿está pagado el complemento del showroom?'. El campo 'notas' de cada póliza suele " +
    "tener el detalle completo (de dónde salió el dato, qué decisión está esperando el usuario, etc.) — " +
    "inclúyelo o resúmelo si la pregunta lo amerita, no te quedes solo con los campos estructurados. Si " +
    "hay algo urgente (ej. una póliza en suspenso por impago con plazo corriendo) dilo primero y con " +
    "claridad, no lo mezcles al final de una lista larga. Cada póliza trae además los DOCUMENTOS que Wobi Seguros ya " +
    "leyó (condiciones, suplementos…) con su resumen y su enlace de Drive: responde con ese resumen y, si hace falta " +
    "un detalle que no está en él (una cláusula, una exclusión concreta), lee el documento completo con " +
    "leer_documento_drive usando su nombre de archivo.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint"],
        description: "Filtra a una sola empresa. Si se omite, devuelve las de las 3.",
      },
      soloPendientes: {
        type: "boolean",
        description:
          "true para devolver SOLO lo que necesita atención ahora (pagos sin confirmar/devueltos, " +
          "próximas a vencer en 30 días) en vez del registro completo — úsalo cuando la pregunta es " +
          "genérica tipo '¿tenemos algo pendiente de seguros?' sin mencionar una póliza concreta.",
      },
    },
    required: [],
  },
  handler: async (input) => {
    const empresa =
      input.empresa === "WOBA" || input.empresa === "EWORKS" || input.empresa === "Footprint"
        ? input.empresa
        : undefined;
    const soloPendientes = input.soloPendientes === true;

    // El conocimiento documental es un complemento: si su lectura falla, la consulta del registro sigue respondiendo.
    let documentos: DocumentoPoliza[] = [];
    let avisoDocumentos = "";
    try {
      documentos = await listarDocumentosPoliza();
    } catch (error) {
      console.error("[consultarPolizasSeguro] No se pudieron leer los documentos de pólizas:", error instanceof Error ? error.message : error);
      avisoDocumentos = "\n\n(No pude leer ahora los documentos de pólizas integrados; el registro de arriba sí está completo.)";
    }
    const describirDocumento = (d: DocumentoPoliza) =>
      `      · ${d.tipoDocumento || "documento"}${d.fechaDocumento ? ` (${d.fechaDocumento})` : ""} — archivo "${d.nombreArchivo}"` +
      `${d.enlaceDrive ? ` ${d.enlaceDrive}` : ""}${d.prima ? ` — prima ${d.prima}` : ""}\n        ${d.resumen}`;

    const todas = await listarPolizas();
    const polizas = empresa ? todas.filter((p) => p.empresa === empresa) : todas;

    if (polizas.length === 0) {
      return empresa
        ? `No hay ninguna póliza registrada todavía para ${empresa}.`
        : "El registro de pólizas de seguro está vacío.";
    }

    const { proximasARenovar, pagosSinConfirmar } = calcularAlertasSeguros(polizas);

    const bloqueAlertas: string[] = [];
    if (pagosSinConfirmar.length > 0) {
      bloqueAlertas.push(
        `⚠️ ${pagosSinConfirmar.length} póliza(s) con pago pendiente/sin confirmar:\n` +
          pagosSinConfirmar
            .map((p) => `  - [${p.empresa}] ${p.tipoCobertura} (${p.aseguradora}) — ${p.prima} ${p.moneda}. ${p.notas || "Sin notas adicionales."}`)
            .join("\n")
      );
    }
    if (proximasARenovar.length > 0) {
      bloqueAlertas.push(
        `📅 ${proximasARenovar.length} póliza(s) vencen en 30 días o menos:\n` +
          proximasARenovar
            .map((p) => {
              const urgencia = p.diasRestantes < 0 ? `VENCIDA hace ${Math.abs(p.diasRestantes)} día(s)` : `${p.diasRestantes} día(s)`;
              return `  - [${p.empresa}] ${p.tipoCobertura} (${p.numeroPoliza}, ${p.aseguradora}) — ${urgencia}, vence ${p.fechaVencimiento}`;
            })
            .join("\n")
      );
    }
    const alertasTexto = bloqueAlertas.length > 0 ? bloqueAlertas.join("\n\n") : "Nada pendiente ni próximo a vencer ahora mismo.";

    if (soloPendientes) {
      return alertasTexto;
    }

    const detalle = polizas
      .map((p) => {
        const partes = [
          `[${p.empresa}] ${p.tipoCobertura}`,
          p.numeroPoliza ? `póliza ${p.numeroPoliza}` : null,
          p.aseguradora || null,
          p.correduria ? `corredor: ${p.correduria}` : null,
          `estado: ${p.estado}`,
          `pago: ${p.estadoPago}`,
          p.prima ? `prima: ${p.prima} ${p.moneda}` : null,
          p.capitalAsegurado ? `capital: ${p.capitalAsegurado}` : null,
          p.fechaVencimiento ? `vence: ${p.fechaVencimiento}` : null,
        ].filter(Boolean);
        const notas = p.notas ? `\n    Notas: ${p.notas}` : "";
        const suyos = documentos.filter((d) => d.polizaId === p.id);
        const docs = suyos.length > 0 ? `\n    Documentos leídos por Wobi Seguros:\n${suyos.map(describirDocumento).join("\n")}` : "";
        return `- ${partes.join(" — ")}${notas}${docs}`;
      })
      .join("\n");

    const idsRegistro = new Set(todas.map((p) => p.id));
    const sueltos = documentos.filter((d) => !idsRegistro.has(d.polizaId) && (!empresa || !d.empresa || d.empresa === empresa));
    const bloqueSueltos = sueltos.length > 0
      ? `\n\nDocumentos de seguros leídos que no corresponden a ninguna póliza del registro:\n` +
        sueltos.map((d) => `  - [${d.empresa || "empresa sin identificar"}] ${d.numeroPoliza || "sin número"} ${d.aseguradora}\n${describirDocumento(d)}`).join("\n")
      : "";

    return `${polizas.length} póliza(s)${empresa ? ` de ${empresa}` : ""}:\n\n${detalle}${bloqueSueltos}${avisoDocumentos}\n\n---\n${alertasTexto}`;
  },
};
