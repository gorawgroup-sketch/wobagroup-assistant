import type { Empresa } from "../holded/client";

/**
 * ¿A nombre de qué sociedad del grupo está la factura? Pura.
 *
 * Caso real (Carlos, 2026-10-08): la factura de renovación de dominios de Name.com (pedido 28837066, 85,57 €) iba a nombre de
 * «BUSINESS ATELIER EUROPA SL» (WOBA) y se creó en EWORKS porque los dominios renovados eran eworks.studio y eworkstudio.com. Regla de Carlos:
 * «no puedes dar gastos a una empresa con facturas que vienen a nombre de otra». El nombre del COMPRADOR impreso en la factura manda sobre
 * cualquier pista de contexto (dominios, remitente, proyecto).
 *
 * Los nombres legales vienen de `core/holded/automatizacion/empresas.ts` (confirmados por Carlos): WOBA = Business Atelier Europa SL,
 * EWORKS = Compañía de Proyectos eWorks SL, Footprint = BUSINESS FOOTPRINT EU SL. «Business Atelier» a secas NO vale (hay otras sociedades).
 */
const PATRONES: ReadonlyArray<readonly [Empresa, RegExp]> = [
  ["WOBA", /\bbus+ines+s? atelier europa\b/], // tolera la errata «BUSSINES» que trae una factura real de Jesús Gómez Tarriño
  ["EWORKS", /\b(compania de proyectos e ?works|e ?works s ?l)\b/],
  ["Footprint", /\bbusiness footprint eu\b/],
];

const normalizar = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** La empresa del grupo que nombra el texto; undefined si no nombra ninguna o nombra a más de una. */
export function empresaNombradaEnTexto(texto: string | undefined): Empresa | undefined {
  if (!texto?.trim()) return undefined;
  const n = normalizar(texto);
  const halladas = PATRONES.filter(([, re]) => re.test(n)).map(([empresa]) => empresa);
  return halladas.length === 1 ? halladas[0] : undefined;
}
