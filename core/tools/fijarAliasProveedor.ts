import { registrarAliasProveedor } from "../gastos/proveedorAliasSheet";
import { buscarContactoHolded, buscarContactosParecidos } from "../holded/write";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];

function esEmpresaValida(valor: unknown): valor is Empresa {
  return typeof valor === "string" && (EMPRESAS as string[]).includes(valor);
}

/**
 * Pedido explícito de Carlos, tras un caso real: ya había dicho una vez en
 * el chat "cada vez que veas facturas de iRyo, asígnalas a INTERMODALIDAD
 * DE LEVANTE SA" — pero esa instrucción nunca se persistió en ningún lado,
 * así que la siguiente factura real de iRyo volvió a fallar igual. El
 * mecanismo de alias (proveedorAliasSheet.ts) ya existía, pero solo se
 * escribía cuando el usuario confirmaba una alternativa por botón tras un
 * "no encontré el proveedor" — nunca a partir de una instrucción libre
 * dicha de antemano. Esta tool cierra ese hueco: cualquier "cada vez que
 * veas X, asígnalo/asígnaselo a Y" en texto libre queda guardado de
 * inmediato, sin esperar a que aparezca una factura real primero.
 *
 * Nunca inventa el contact_id: reutiliza la misma búsqueda real
 * (buscarContactoHolded / buscarContactosParecidos) que usa el flujo de
 * gastos, así que solo fija el alias contra un contacto que de verdad
 * existe en Holded — si no lo encuentra con confianza, lo dice y no guarda
 * nada en vez de adivinar.
 */
export const fijarAliasProveedorTool: ToolDefinition = {
  name: "fijar_alias_proveedor",
  description:
    "Registra de antemano que un texto de proveedor (tal como aparece en las facturas, ej. 'iryo', 'iRyo', " +
    "'INTERMODALIDAD DE LEVANTE SA') debe asignarse siempre al mismo contacto real de Holded en una empresa — " +
    "úsala cuando el usuario dé una instrucción de este tipo en texto libre (ej. 'cada vez que veas facturas de " +
    "X, asígnalas a Y', 'este proveedor siempre va a nombre de Y'), sin esperar a que llegue una factura real. " +
    "La próxima vez que se procese un gasto de ese proveedor (para esa empresa), el contacto se asigna directo, " +
    "sin volver a preguntar. No la uses para corregir un gasto YA creado con el contacto equivocado — eso se " +
    "corrige aparte.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: EMPRESAS, description: "Empresa (WOBA, EWORKS o Footprint) a la que aplica el alias." },
      texto_proveedor: {
        type: "string",
        description: "El texto tal como aparece/aparecería en la factura o en la instrucción del usuario (ej. 'iryo').",
      },
      nombre_contacto_real: {
        type: "string",
        description: "El nombre real del contacto en Holded al que debe asignarse (ej. 'INTERMODALIDAD DE LEVANTE SA').",
      },
    },
    required: ["empresa", "texto_proveedor", "nombre_contacto_real"],
  },
  handler: async (input) => {
    const empresa = input.empresa;
    const textoProveedor = typeof input.texto_proveedor === "string" ? input.texto_proveedor.trim() : "";
    const nombreContacto = typeof input.nombre_contacto_real === "string" ? input.nombre_contacto_real.trim() : "";

    if (!esEmpresaValida(empresa)) {
      return `Empresa inválida: "${String(input.empresa)}". Debe ser una de: ${EMPRESAS.join(", ")}.`;
    }
    if (!textoProveedor || !nombreContacto) {
      return "Faltan datos: se necesita el texto del proveedor y el nombre real del contacto en Holded.";
    }

    let contacto = await buscarContactoHolded(empresa, nombreContacto).catch(() => undefined);

    if (!contacto) {
      const parecidos = await buscarContactosParecidos(empresa, nombreContacto, 5).catch(() => []);
      const exacto = parecidos.find((c) => (c.name ?? "").trim().toLowerCase() === nombreContacto.toLowerCase());
      if (exacto) {
        contacto = exacto;
      } else if (parecidos.length > 0) {
        const lista = parecidos.map((c) => `- ${c.name} (id ${c.id})`).join("\n");
        return (
          `No encontré un contacto llamado exactamente "${nombreContacto}" en Holded (${empresa}), pero hay ` +
          `nombres parecidos:\n${lista}\n\nPregúntale al usuario cuál es el correcto (o si el nombre real es ` +
          `distinto) antes de fijar el alias — no se guardó nada todavía.`
        );
      } else {
        return (
          `No encontré ningún contacto parecido a "${nombreContacto}" en Holded (${empresa}). Dile al usuario ` +
          `que verifique el nombre exacto, o que cree el contacto primero — no se guardó ningún alias.`
        );
      }
    }

    await registrarAliasProveedor(empresa, textoProveedor, contacto.id, contacto.name ?? nombreContacto);

    return (
      `Listo — a partir de ahora, cualquier gasto de "${empresa}" cuyo proveedor detectado sea "${textoProveedor}" ` +
      `se asignará directo a "${contacto.name}" (id ${contacto.id}), sin volver a preguntar.`
    );
  },
};
