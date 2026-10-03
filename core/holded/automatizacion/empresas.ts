import type { Empresa } from "../client";

/**
 * Nombres LEGALES de las empresas del grupo (confirmados por Carlos y vistos en Holded → Configuración, 2026-10-03). El título que
 * Holded muestra arriba a la izquierda NO es el nombre legal: WOBA = Business Atelier Europa SL, Eworks = Compañía de Proyectos
 * eWorks SL, Footprint Global = BUSINESS FOOTPRINT EU SL.
 */
export const NOMBRES_LEGALES: Record<Empresa, string> = {
  WOBA: "Business Atelier Europa SL",
  EWORKS: "Compañía de Proyectos eWorks SL",
  Footprint: "BUSINESS FOOTPRINT EU SL",
};

/** Título que Holded muestra en el selector de empresa (no es el nombre legal). */
export const TITULOS_EN_HOLDED: Record<Empresa, string> = { WOBA: "WOBA", EWORKS: "Eworks", Footprint: "Footprint Global" };

export const normalizarNombre = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** true si el texto leído en Holded corresponde al nombre legal esperado de la empresa (sin tildes, mayúsculas ni puntuación). */
export function coincideNombreLegal(empresa: Empresa, texto: string): boolean {
  return normalizarNombre(texto) === normalizarNombre(NOMBRES_LEGALES[empresa]);
}

/** «WOBA (Business Atelier Europa SL)»: para mensajes a personas, donde el título solo no basta. */
export const etiquetaEmpresa = (empresa: string) => (empresa in NOMBRES_LEGALES ? `${empresa} (${NOMBRES_LEGALES[empresa as Empresa]})` : empresa);
