import { obtenerTodosLosAlias } from "../gastos/proveedorAliasSheet";
import { obtenerTodasLasClasificaciones } from "../gastos/clasificacionAprendidaSheet";
import { obtenerTodosLosDuplicadosConfirmados } from "../cashflow/duplicadosConfirmadosSheet";
import { obtenerTodosLosMovimientosAprendidos } from "../holded/movimientoAmbiguoAprendidoSheet";
import { obtenerTodasLasFilasAprendidas } from "../google/cashflowFilaAprendidaSheet";
import { obtenerTodasLasCuentasCorregidas } from "../holded/cuentaCorregidaAprendidaSheet";
import { obtenerCorreccionesCrudas } from "../knowledge/correctionsStore";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos: "que la práctica y los días te vayan dando la
 * experiencia... asegúrate de hacerme recomendaciones" — sin esto, no había
 * ninguna forma de VER que el sistema efectivamente está aprendiendo, solo
 * confiar en que los 5 mecanismos de memoria (alias de proveedor,
 * clasificación, duplicados confirmados, conciliación ambigua aprendida,
 * correcciones generales) están acumulando algo real. Este reporte lee los
 * 5 y muestra cuánto hay acumulado, con los casos más reforzados (mayor
 * "vecesConfirmado") como evidencia concreta — no solo un conteo ciego.
 */
export const reporteAprendizajeTool: ToolDefinition = {
  name: "reporte_aprendizaje",
  description:
    "Muestra cuánto ha aprendido el sistema hasta ahora: alias de proveedores confirmados, clasificaciones de gastos " +
    "aprendidas, tolerancias de duplicados confirmadas, patrones de conciliación bancaria ambigua aprendidos, y " +
    "correcciones generales guardadas. Úsala cuando te pregunten algo como '¿cuánto has aprendido?', '¿está " +
    "funcionando la memoria?', 'muéstrame qué has aprendido' o similar.",
  input_schema: { type: "object", properties: {} },
  seguraParaModoRapido: true,
  handler: async () => {
    const [alias, clasificaciones, duplicados, movimientos, filasCashflow, cuentasCorregidas, correcciones] = await Promise.all([
      obtenerTodosLosAlias().catch((error) => {
        console.error("[reporteAprendizaje] Error leyendo alias de proveedor:", error);
        return [];
      }),
      obtenerTodasLasClasificaciones().catch((error) => {
        console.error("[reporteAprendizaje] Error leyendo clasificaciones aprendidas:", error);
        return [];
      }),
      obtenerTodosLosDuplicadosConfirmados().catch((error) => {
        console.error("[reporteAprendizaje] Error leyendo duplicados confirmados:", error);
        return [];
      }),
      obtenerTodosLosMovimientosAprendidos().catch((error) => {
        console.error("[reporteAprendizaje] Error leyendo conciliaciones ambiguas aprendidas:", error);
        return [];
      }),
      obtenerTodasLasFilasAprendidas().catch((error) => {
        console.error("[reporteAprendizaje] Error leyendo filas de cashflow aprendidas:", error);
        return [];
      }),
      obtenerTodasLasCuentasCorregidas().catch((error) => {
        console.error("[reporteAprendizaje] Error leyendo cuentas contables corregidas:", error);
        return [];
      }),
      obtenerCorreccionesCrudas().catch((error) => {
        console.error("[reporteAprendizaje] Error leyendo correcciones generales:", error);
        return [];
      }),
    ]);

    const topAlias = [...alias].sort((a, b) => b.vecesConfirmado - a.vecesConfirmado).slice(0, 3);
    const topClasificaciones = [...clasificaciones].sort((a, b) => b.vecesConfirmado - a.vecesConfirmado).slice(0, 3);

    const lineas = [
      `📚 *Reporte de aprendizaje acumulado*`,
      ``,
      `• Alias de proveedor confirmados: ${alias.length}` +
        (topAlias.length > 0 ? ` — más reforzados: ${topAlias.map((a) => `"${a.nombreDetectado}" (${a.vecesConfirmado}x)`).join(", ")}` : ""),
      `• Clasificaciones de gasto aprendidas: ${clasificaciones.length}` +
        (topClasificaciones.length > 0
          ? ` — más reforzadas: ${topClasificaciones.map((c) => `"${c.proveedor}" → ${c.empresa} (${c.vecesConfirmado}x)`).join(", ")}`
          : ""),
      `• Tolerancias de duplicado confirmadas: ${duplicados.length}`,
      `• Patrones de conciliación ambigua aprendidos: ${movimientos.length}`,
      `• Filas de cashflow recordadas (búsqueda instantánea): ${filasCashflow.length}`,
      `• Cuentas contables corregidas a mano y aprendidas: ${cuentasCorregidas.length}`,
      `• Correcciones generales guardadas: ${correcciones.length}`,
      ``,
      `Total de casos reales que ya no se vuelven a preguntar/buscar desde cero: ${
        alias.length +
        clasificaciones.length +
        duplicados.length +
        movimientos.length +
        filasCashflow.length +
        cuentasCorregidas.length +
        correcciones.length
      }.`,
    ];

    return lineas.join("\n");
  },
};
