import { fetchResumenSemanas } from "../google/cashflowSheet";
import { validarNumeracionSemanas, mesDeEtiquetaSemana } from "../google/validarNumeracionCashflow";
import type { ToolDefinition } from "./types";

/**
 * Verifica bajo demanda lo mismo que el cron diario revisarNumeracionCashflow
 * (core/jobs/) — formato, duplicados, secuencia real de 7 en 7 días, y que
 * la más reciente no esté a una distancia inverosímil de hoy. Útil para
 * confirmar en el momento sin esperar al aviso automático de las 8:15.
 */
export const verificarNumeracionCashflowTool: ToolDefinition = {
  name: "verificar_numeracion_cashflow",
  seguraParaModoRapido: true,
  description:
    "Verifica que las semanas de la hoja CASHFLOW estén bien numeradas y correspondan al mes real que " +
    "dicen representar — formato correcto, sin semanas duplicadas, sin saltos ni huecos en la secuencia, " +
    "y que la más reciente no esté a una fecha inverosímil. Úsala cuando pregunten si el cashflow 'está " +
    "bien numerado', 'las semanas están correctas', o algo similar sobre la integridad de la numeración " +
    "(no confundir con verificar_cashflow_actualizado, que compara contra Holded).",
  input_schema: { type: "object", properties: {} },
  handler: async () => {
    const semanas = await fetchResumenSemanas();
    const conDatos = semanas.filter((s) => s.balanceFinal.trim() !== "");

    if (conDatos.length === 0) {
      return "La hoja CASHFLOW no tiene ninguna semana con datos todavía.";
    }

    const problemas = validarNumeracionSemanas(conDatos);
    const ultima = conDatos[conDatos.length - 1];
    const mesUltima = mesDeEtiquetaSemana(ultima.semana) ?? "(no se pudo determinar)";

    if (problemas.length === 0) {
      return (
        `✅ Numeración correcta — ${conDatos.length} semana(s) con datos, de ${conDatos[0].semana} a ` +
        `${ultima.semana}, en secuencia sin saltos ni duplicados. La más reciente (${ultima.semana}) ` +
        `corresponde a ${mesUltima}.`
      );
    }

    const lineas = problemas.map((p) => `  • [${p.tipo}] ${p.detalle}`).join("\n");
    return `⚠️ Se encontraron ${problemas.length} problema(s) de numeración:\n${lineas}`;
  },
};
