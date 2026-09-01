import { detectarNoRegistrados, type EmpresaCashflow } from "../jobs/revisarHoldedVsCashflow";
import { previousWeekRange, currentWeekRangeToDate, weekLabel, formatDateISO, lunesDeEtiquetaSemana } from "../utils/isoWeek";
import type { ToolDefinition } from "./types";

const EMPRESAS: EmpresaCashflow[] = ["WOBA", "EWORKS"];

/**
 * A diferencia de consultar_cashflow_resumen (que solo lee los números ya
 * calculados en la hoja CASHFLOW), esta herramienta hace la comparación
 * real: trae los movimientos bancarios de Holded del período y los cruza
 * contra lo que YA está registrado en DATOS — exactamente la misma lógica
 * que usa el cron semanal (revisarHoldedVsCashflow), pero bajo demanda y
 * sin crear propuestas ni escribir nada. Nace de una corrección real: el
 * asistente respondía "está actualizado" leyendo solo el resumen, sin
 * verificar contra Holded — esta herramienta existe para que eso no vuelva
 * a pasar cuando pregunten específicamente si el cashflow "está al día".
 *
 * Bug real encontrado en vivo: al preguntar por una semana pasada CONCRETA
 * (ej. "revisa S36"), esta tool solo sabía calcular "semana actual" o
 * "semana anterior" — nada más atrás. Sin forma de pedirle una semana
 * específica, el asistente terminaba improvisando su propia comparación
 * manual (leyendo consultar_cashflow_detalle y los movimientos de Holded
 * por separado, sin el matching por tolerancia/duplicados/agrupación que
 * esta función ya tiene) — eso produjo falsos "falta registrar" para cosas
 * que sí estaban, y hasta mezcló datos de Footprint (que NO tiene cashflow
 * en esta hoja) con la revisión de WOBA/EWORKS. Ahora acepta `semana`
 * directamente (ej. "S36"), reutilizando lunesDeEtiquetaSemana — así
 * cualquier semana pasada usa la MISMA lógica robusta, nunca una
 * improvisada.
 */
export const verificarCashflowActualizadoTool: ToolDefinition = {
  name: "verificar_cashflow_actualizado",
  description:
    "Verifica si el cashflow de WOBA y/o EWORKS está REALMENTE al día, comparando los movimientos " +
    "bancarios reales de Holded contra lo ya registrado en la hoja DATOS — no es un resumen de números, " +
    "hace la comparación real (con tolerancia de monto, agrupación de cargos repetidos, y detección de " +
    "posibles duplicados por nombre/monto parecido que pregunta en vez de asumir). Úsala SIEMPRE que " +
    "pregunten '¿está actualizado el cashflow?', '¿está al día?', '¿falta algo por registrar?', 'revisa la " +
    "semana X/S36', o pidan comparar contra Holded — para CUALQUIER semana, pasada o presente, no solo la " +
    "actual/anterior. Nunca compares manualmente leyendo consultar_cashflow_detalle y los movimientos de " +
    "Holded por separado — esta tool ya tiene la lógica de matching correcta (tolerancias, agrupación, " +
    "duplicados aprendidos) y evita falsos 'falta registrar'. Footprint NO tiene cashflow en esta hoja — " +
    "nunca la uses para Footprint, ni mezcles sus números de Holded con este resultado, aunque el concepto " +
    "(ej. 'Seguridad Social') también aplique a Footprint por separado. Para preguntas de 'cómo va el " +
    "balance' sin pedir verificación, usa mejor consultar_cashflow_resumen (más rápido, no cruza contra " +
    "Holded). Nunca escribe ni propone nada — solo reporta qué falta, si falta algo.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS"],
        description: "Empresa a verificar. Si no se indica, verifica ambas.",
      },
      periodo: {
        type: "string",
        enum: ["semana_actual", "semana_anterior"],
        description:
          "'semana_actual' (por defecto si no se da 'semana') revisa lo que va de la semana en curso, de " +
          "lunes a hoy. 'semana_anterior' revisa la semana pasada completa (lunes a domingo). Ignorado si " +
          "se da 'semana'.",
      },
      semana: {
        type: "string",
        description:
          "Etiqueta de una semana CONCRETA a revisar, ej. 'S36' — para cuando preguntan por una semana " +
          "pasada específica (no solo actual/anterior). Si se da, tiene prioridad sobre 'periodo'.",
      },
    },
  },
  handler: async (input) => {
    const empresaFiltro = input.empresa as EmpresaCashflow | undefined;
    if (empresaFiltro && empresaFiltro !== "WOBA" && empresaFiltro !== "EWORKS") {
      return "Error: 'empresa' debe ser WOBA o EWORKS (Footprint no tiene cashflow en Sheets).";
    }
    const empresas = empresaFiltro ? [empresaFiltro] : EMPRESAS;

    const semanaInput = typeof input.semana === "string" ? input.semana.trim() : "";
    const referencia = new Date();
    const esSemanaAnterior = input.periodo === "semana_anterior";

    let start: Date;
    let end: Date;

    if (semanaInput) {
      const lunes = lunesDeEtiquetaSemana(semanaInput, referencia);
      if (!lunes) {
        return `Error: "${semanaInput}" no es una etiqueta de semana válida (formato esperado: "S36").`;
      }
      start = lunes;
      end = new Date(lunes);
      end.setDate(end.getDate() + 6);
      end.setHours(23, 59, 59, 999);
    } else {
      ({ start, end } = esSemanaAnterior ? previousWeekRange(referencia) : currentWeekRangeToDate(referencia));
    }

    const semanaLabel = weekLabel(start);
    const desde = formatDateISO(start);
    const hasta = formatDateISO(end);

    const partes: string[] = [];
    let algoFalta = false;

    for (const empresa of empresas) {
      try {
        const candidatos = await detectarNoRegistrados(empresa, semanaLabel, desde, hasta);

        if (candidatos.length === 0) {
          partes.push(`✅ ${empresa}: al día — todos los movimientos bancarios de Holded en ${semanaLabel} (${desde} a ${hasta}) están registrados en el cashflow.`);
        } else {
          algoFalta = true;
          const lineas = candidatos
            .map((c) => {
              const categoria = c.categoriasSugeridas?.[0];
              const sugerencia = categoria && categoria.score > 0 ? ` — probablemente ${categoria.etiqueta}` : "";
              const duplicado = c.posibleDuplicadoDe
                ? ` — 🔎 posible duplicado de "${c.posibleDuplicadoDe.descripcionRegistro}" ya registrado, confirma con el usuario si es el mismo pago`
                : "";
              return `  • ${c.descripcion} — ${c.valorAbs.toFixed(2)} € (${c.esIngreso ? "abono" : "cargo"}${c.fecha ? `, ${c.fecha}` : ""})${sugerencia}${duplicado}`;
            })
            .join("\n");
          partes.push(`⚠️ ${empresa}: faltan ${candidatos.length} movimiento(s) de Holded por registrar en ${semanaLabel}:\n${lineas}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        partes.push(`⚠️ ${empresa}: no se pudo verificar (${message}).`);
      }
    }

    const encabezado = semanaInput
      ? `Verificación de ${semanaLabel} (${desde} a ${hasta}) contra Holded:`
      : esSemanaAnterior
        ? `Verificación de ${semanaLabel} (semana anterior completa) contra Holded:`
        : `Verificación de ${semanaLabel} (lo que va de esta semana, hasta hoy) contra Holded:`;

    const pie = algoFalta
      ? "\nSi quieres que los registre, dímelo y te muestro cada uno con botón de aprobación (o espera al chequeo automático del viernes/lunes)."
      : "";

    return [encabezado, "", ...partes, pie].filter(Boolean).join("\n");
  },
};
