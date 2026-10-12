import type { ToolDefinition } from "./types";
import { generarYProponerDeclaracion } from "../soportes/declaracion/generarDeclaracion";
import type { CargoDeclarado } from "../soportes/declaracion/declaracionStore";
const EMPRESAS = ["WOBA", "EWORKS", "Footprint"] as const;

/**
 * «Prepara la declaración de gastos sin soporte de German y mándasela para firma»: desde el chat o desde una orientación
 * sobre el correo de la persona. Genera el documento con la plantilla de su empresa, lo guarda en Drive y propone el correo
 * con el adjunto; el envío real solo ocurre con el botón «Enviar así». Nunca toca Holded.
 */
export const prepararDeclaracionSinSoporteTool: ToolDefinition = {
  name: "preparar_declaracion_gastos_sin_soporte",
  description:
    "Genera la declaración «GASTOS SIN SOPORTE» de una persona (plantilla oficial de su empresa) con los cargos de tarjeta de los que " +
    "no tiene comprobante, la guarda en Drive y propone por Telegram el correo a esa persona con el documento adjunto para que lo firme y lo " +
    "devuelva. Úsala cuando la persona responda que no tiene los soportes pedidos, o cuando Carlos pida «prepara/manda la declaración de " +
    "gastos sin soporte de X». Si no pasas cargos, se usan los de la última solicitud de soportes enviada a esa persona. No envía nada por " +
    "sí sola: Carlos aprueba el borrador con un botón.",
  input_schema: {
    type: "object",
    required: ["empresa", "titular", "email"],
    properties: {
      empresa: { type: "string", enum: [...EMPRESAS], description: "Empresa cuya plantilla y Drive se usan." },
      titular: { type: "string", description: "Nombre y apellidos de la persona que firma (como figura en la campaña de soportes)." },
      email: { type: "string", description: "Correo de la persona (destinatario del documento)." },
      cargo_firmante: { type: "string", description: "Cargo de la persona en la empresa (p. ej. CEO). Si no se sabe, vacío." },
      cargos: {
        type: "array",
        description: "Opcional: cargos concretos sin soporte. Si falta, se usan todos los de la última solicitud enviada a la persona.",
        items: { type: "object", required: ["fecha", "lugar", "valor"], properties: {
          id: { type: "string" }, fecha: { type: "string", description: "YYYY-MM-DD" }, lugar: { type: "string", description: "Comercio" },
          valor: { type: "number", description: "Importe en la moneda de la cuenta" }, moneda: { type: "string" } } },
      },
      thread_id: { type: "string", description: "Hilo de Gmail del correo de la persona, para responder en él." },
      message_id_header: { type: "string", description: "Message-ID del correo al que se responde." },
    },
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram.";
    const empresa = String(input.empresa ?? "") as (typeof EMPRESAS)[number];
    const titular = String(input.titular ?? "").trim();
    const email = String(input.email ?? "").trim();
    if (!(EMPRESAS as readonly string[]).includes(empresa) || !titular || !email) return "Error: faltan empresa, titular o email.";
    const cargos: CargoDeclarado[] | undefined = Array.isArray(input.cargos)
      ? (input.cargos as Array<Record<string, unknown>>).map((c, i) => ({ id: String(c.id ?? `manual-${i + 1}`), fecha: String(c.fecha ?? ""), lugar: String(c.lugar ?? ""), valor: Number(c.valor), moneda: String(c.moneda ?? "EUR") }))
        .filter((c) => c.fecha && c.lugar && Number.isFinite(c.valor) && c.valor > 0)
      : undefined;
    try {
      const r = await generarYProponerDeclaracion({
        chatId, empresa, titular, email, cargoFirmante: String(input.cargo_firmante ?? "").trim(), cargos,
        threadId: typeof input.thread_id === "string" ? input.thread_id.trim() || undefined : undefined,
        messageIdHeader: typeof input.message_id_header === "string" ? input.message_id_header.trim() || undefined : undefined,
      });
      return `Listo — la declaración ${r.declaracion.nombreArchivo} (${r.declaracion.cargos.length} cargo(s)) está en Drive (${r.declaracion.driveUrl}) y el correo a ${email} con el documento adjunto ya se mostró en Telegram con botones. No hace falta repetirlo: dile al usuario que pulse «Enviar así» cuando lo revise. El envío y la firma se seguirán desde el registro de declaraciones.`;
    } catch (error) {
      return `No pude preparar la declaración: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
