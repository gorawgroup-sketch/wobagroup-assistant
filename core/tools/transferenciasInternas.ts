import type { Empresa } from "../holded/client";
import { EMPRESAS_TRANSFERENCIAS } from "../holded/transferencias/modo";
import { publicarPropuestasTransferencias } from "../holded/transferencias/telegram";
import type { ToolDefinition } from "./types";

/** Punto de entrada por chat de core/holded/transferencias/: detectar y proponer operaciones entre cuentas propias. */
export const transferenciasInternasTool: ToolDefinition = {
  name: "revisar_transferencias_internas",
  description:
    "Detecta transferencias y conversiones de moneda entre cuentas bancarias de la MISMA empresa que siguen sin conciliar " +
    "en Holded (traspasos propios, cambios USD/EUR/GBP/COP) y publica en el chat una propuesta con botones por cada una " +
    "(«Conciliar transferencia», «Saltar por ahora», «No es una transferencia», «Revisar manualmente»). Úsala cuando pidan " +
    "revisar, proponer o conciliar transferencias internas, traspasos entre cuentas propias o cambios de divisa. Solo lee " +
    "Holded: la conciliación real ocurre únicamente al pulsar el botón y solo para las parejas autorizadas.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa a revisar. Si se omite, las tres." },
    },
    required: [],
  },
  handler: async (input, context) => {
    const chatId = context?.chatId;
    if (!chatId) return "Error: no se pudo determinar el chat de Telegram donde publicar las propuestas.";
    const empresa = EMPRESAS_TRANSFERENCIAS.find((e) => e === input.empresa) as Empresa | undefined;
    return publicarPropuestasTransferencias(chatId, empresa ? [empresa] : EMPRESAS_TRANSFERENCIAS);
  },
};
