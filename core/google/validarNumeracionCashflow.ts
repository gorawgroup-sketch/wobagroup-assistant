import type { ResumenSemana } from "./cashflowSheet";
import { lunesDeEtiquetaSemana, weekLabel } from "../utils/isoWeek";

export interface ProblemaNumeracionSemana {
  tipo: "formato_invalido" | "duplicada" | "salto" | "fuera_de_secuencia" | "fecha_inverosimil";
  semana: string;
  detalle: string;
}

const NOMBRES_MES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** "S44" -> "octubre 2026", usando el mismo cálculo que agrupa el balance mensual. */
export function mesDeEtiquetaSemana(semanaLabel: string, hoy: Date = new Date()): string | null {
  const lunes = lunesDeEtiquetaSemana(semanaLabel, hoy);
  if (!lunes) return null;
  return `${NOMBRES_MES[lunes.getMonth()]} ${lunes.getFullYear()}`;
}

// Si la última semana de la hoja está a más de esto (en días) de hoy, en
// cualquier dirección, algo probablemente está mal etiquetado — un salto de
// varios años por un typo, o una hoja que quedó completamente desactualizada.
const MAX_DIAS_DESVIO_RAZONABLE = 200; // ~28 semanas

/**
 * Valida que las semanas de la hoja CASHFLOW estén bien numeradas: formato
 * correcto ("SNN"), sin duplicados, en secuencia estricta (cada una exactamente
 * 7 días después de la anterior — así se detecta tanto un salto/hueco como
 * una semana repetida o fuera de orden), y que la más reciente no esté a una
 * distancia inverosímil de hoy. No asume que la hoja está bien — la razón de
 * ser de este validador es precisamente detectar cuando no lo está.
 */
export function validarNumeracionSemanas(
  semanas: ResumenSemana[],
  hoy: Date = new Date()
): ProblemaNumeracionSemana[] {
  const problemas: ProblemaNumeracionSemana[] = [];
  const vistas = new Set<string>();
  let anterior: { semana: string; lunes: Date } | null = null;

  for (const s of semanas) {
    const etiqueta = s.semana.trim();
    const match = /^S(\d{1,2})$/i.exec(etiqueta);
    if (!match) {
      problemas.push({ tipo: "formato_invalido", semana: etiqueta, detalle: `Etiqueta "${etiqueta}" no tiene el formato esperado "SNN".` });
      continue;
    }

    const numero = parseInt(match[1], 10);
    if (numero < 1 || numero > 53) {
      problemas.push({ tipo: "formato_invalido", semana: etiqueta, detalle: `Número de semana ${numero} fuera de rango (1-53).` });
      continue;
    }

    if (vistas.has(etiqueta)) {
      problemas.push({ tipo: "duplicada", semana: etiqueta, detalle: `La semana ${etiqueta} aparece más de una vez en la hoja.` });
    }
    vistas.add(etiqueta);

    const lunes = lunesDeEtiquetaSemana(etiqueta, hoy);
    if (!lunes) continue;

    if (anterior) {
      const diffDias = Math.round((lunes.getTime() - anterior.lunes.getTime()) / 86_400_000);
      if (diffDias !== 7) {
        problemas.push({
          tipo: diffDias <= 0 ? "fuera_de_secuencia" : "salto",
          semana: etiqueta,
          detalle:
            diffDias <= 0
              ? `${etiqueta} no va después de ${anterior.semana} en el calendario (${diffDias} día(s) de diferencia, debería ser +7).`
              : `Faltan semanas entre ${anterior.semana} y ${etiqueta} (${diffDias} días de diferencia, debería ser exactamente 7).`,
        });
      }
    }

    anterior = { semana: etiqueta, lunes };
  }

  if (anterior) {
    const diffDiasHoy = Math.abs(Math.round((anterior.lunes.getTime() - hoy.getTime()) / 86_400_000));
    if (diffDiasHoy > MAX_DIAS_DESVIO_RAZONABLE) {
      problemas.push({
        tipo: "fecha_inverosimil",
        semana: anterior.semana,
        detalle: `La última semana de la hoja (${anterior.semana}) queda a ${diffDiasHoy} días de hoy (${weekLabel(hoy)}) — revisar si el año/número está bien.`,
      });
    }
  }

  return problemas;
}
