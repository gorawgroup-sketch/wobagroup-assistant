import { buscarMovimientoSimilar } from "../holded/write";
import { crearTrazaBusqueda, describirTrazaBusqueda } from "../holded/trazaBusqueda";
import type { ToolDefinition } from "./types";

const EMPRESAS = ["WOBA", "EWORKS", "Footprint"] as const;

/**
 * «¿Por qué no encuentras el cargo?» Repite EN VIVO la búsqueda del cargo bancario de un gasto y explica qué cuentas revisó,
 * qué cargos con el mismo importe encontró y, sobre todo, cuáles descartó y por qué regla. Solo lectura. Caso real
 * 2026-09-28: el sistema decía «no encontré ningún movimiento» aunque el cargo existía y se había descartado por el nombre;
 * averiguarlo costaba horas de leer logs (que además se borran en cada despliegue).
 */
export const explicarBusquedaCargoTool: ToolDefinition = {
  name: "explicar_busqueda_cargo",
  description:
    "Solo lectura. Explica POR QUÉ el sistema encontró o no encontró el cargo bancario de un gasto: repite la búsqueda en " +
    "Holded en vivo y devuelve qué cuentas revisó, qué cargos con el mismo importe encontró y cuáles descartó y por qué " +
    "(ya conciliado, categorías contradictorias, nombre no reconocido, no es un cargo…). Úsala cuando el usuario diga " +
    "«¿por qué no encuentras el cargo de X?», «el cargo existe pero no lo ves», «explícame por qué no salió el movimiento» o " +
    "cuando dude de un «no encontré ningún movimiento». Pide proveedor, importe, moneda y fecha del gasto (del ticket o de la " +
    "propuesta pendiente); no adivines la empresa: si el usuario no la dijo y no consta, pregúntala. Nunca crea, concilia ni " +
    "modifica nada.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: [...EMPRESAS], description: "Empresa del gasto (WOBA, EWORKS o Footprint)." },
      proveedor: { type: "string", description: "Proveedor tal como aparece en el ticket o propuesta (ej. «JUST B CUZ PLM»)." },
      concepto: { type: "string", description: "Concepto o descripción del gasto (ayuda a reconocer la categoría). Opcional." },
      monto: { type: "number", description: "Importe del gasto en su moneda (positivo)." },
      moneda: { type: "string", description: "Moneda del gasto: EUR, USD, COP…" },
      fecha: { type: "string", description: "Fecha del gasto YYYY-MM-DD." },
    },
    required: ["empresa", "proveedor", "monto", "moneda", "fecha"],
  },
  handler: async (input) => {
    const empresa = typeof input.empresa === "string" ? input.empresa : "";
    const proveedor = typeof input.proveedor === "string" ? input.proveedor.trim() : "";
    const monto = typeof input.monto === "number" ? Math.abs(input.monto) : NaN;
    const moneda = typeof input.moneda === "string" ? input.moneda.trim().toUpperCase() : "";
    const fecha = typeof input.fecha === "string" ? input.fecha.trim() : "";
    const concepto = typeof input.concepto === "string" ? input.concepto : "";
    if (!(EMPRESAS as readonly string[]).includes(empresa) || !proveedor || !Number.isFinite(monto) || monto <= 0 || !moneda || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return "Faltan datos: hacen falta empresa (WOBA, EWORKS o Footprint), proveedor, importe, moneda y fecha (YYYY-MM-DD) del gasto.";
    }
    const traza = crearTrazaBusqueda();
    try {
      const candidatos = await buscarMovimientoSimilar(empresa as (typeof EMPRESAS)[number], { monto, fecha, moneda, proveedor, concepto, incluirPorConfirmar: true, traza });
      const resumen = candidatos.length === 0
        ? `No encontré ningún cargo utilizable para ${proveedor} (${monto.toFixed(2)} ${moneda}, ${fecha}) en ${empresa}.`
        : `Encontré ${candidatos.length} cargo(s) utilizable(s) para ${proveedor} (${monto.toFixed(2)} ${moneda}, ${fecha}) en ${empresa}: ` +
          candidatos.map((c) => `“${c.descripcion}” (${c.fecha}, ${c.monto.toFixed(2)} ${c.moneda}${c.compatibilidad === "por_confirmar" ? ", por confirmar: nombre distinto" : c.compatibilidad === "aprendido" ? ", confirmado antes" : ""})`).join("; ") + ".";
      return `${resumen}\n${describirTrazaBusqueda(traza)}\nEsta consulta es solo lectura: no se creó ni concilió nada.`;
    } catch (error) {
      return `No pude repetir la búsqueda: ${error instanceof Error ? error.message : String(error)}. La consulta a Holded falló, así que no puedo afirmar que el cargo exista o no.`;
    }
  },
};
