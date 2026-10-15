import type { ToolDefinition } from "./types";
import { proponerAplicacion } from "../soportes/declaracion/aplicarDeclaracion";
import { listarDeclaraciones, obtenerDeclaracion } from "../soportes/declaracion/declaracionStore";
import { seleccionarDeclaracionPendiente } from "../soportes/declaracion/reenviarDeclaracion";
const EMPRESAS = ["WOBA", "EWORKS", "Footprint"] as const;

/**
 * «Aplica la declaración firmada de German»: la frase que el sistema mismo sugiere en sus avisos no tenía herramienta
 * (15-10-2026, caso German: el modelo no podía hacer nada). Localiza la declaración FIRMADA de la persona y vuelve a
 * proponer el paso C (un gasto por el total + conciliación múltiple de sus cargos) con su botón; si todo está ya hecho,
 * la marca aplicada. No escribe en Holded: solo propone.
 */
export const aplicarDeclaracionFirmadaTool: ToolDefinition = {
  name: "aplicar_declaracion_firmada",
  description:
    "Aplica (o reintenta aplicar) como soporte en Holded la declaración «GASTOS SIN SOPORTE» ya FIRMADA de una persona: un solo gasto por el " +
    "total de sus cargos y todos esos cargos del banco conciliados contra él. Localiza la declaración firmada por el nombre de la persona (y la " +
    "empresa si se dice) y manda al chat el plan con su botón «Aplicar», o cierra la declaración si ya estaba todo conciliado. Úsala cuando el " +
    "usuario diga «aplica la declaración firmada de X», «reintenta la declaración de X» o tras resolver lo que bloqueaba (banco sincronizado, gasto creado). " +
    "No pidas ids ni correos: basta el nombre.",
  input_schema: {
    type: "object",
    properties: {
      titular: { type: "string", description: "Nombre (o parte) de la persona, p. ej. «German»." },
      empresa: { type: "string", enum: [...EMPRESAS] },
      declaracion_id: { type: "string", description: "Id de la declaración, si se conoce." },
    },
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram.";
    const empresa = typeof input.empresa === "string" && (EMPRESAS as readonly string[]).includes(input.empresa) ? input.empresa : undefined;
    const titular = typeof input.titular === "string" ? input.titular.trim() || undefined : undefined;
    const id = typeof input.declaracion_id === "string" ? input.declaracion_id.trim() || undefined : undefined;
    try {
      let d = id ? await obtenerDeclaracion(id) : undefined;
      if (id && !d) return `No existe la declaración ${id}.`;
      if (!d) d = seleccionarDeclaracionPendiente(await listarDeclaraciones({ estados: ["firmada"] }), { empresa, titular });
      if (d.estado !== "firmada") return `La declaración de ${d.titular} está «${d.estado}», no «firmada»: no hay nada que aplicar.`;
      await proponerAplicacion(chatId, d);
      return `Listo — el plan de la declaración firmada de ${d.titular} (${d.empresa}, ${d.cargos.length} cargo(s)) ya se mostró en el chat: si procede, con el botón «Aplicar»; si estaba todo conciliado, queda marcada como aplicada. No repitas el mensaje: dile al usuario que lo revise arriba.`;
    } catch (error) {
      console.error("[aplicarDeclaracionFirmada] Fallo con entrada", JSON.stringify(input), ":", error instanceof Error ? error.message : error);
      return `No pude aplicar la declaración: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
