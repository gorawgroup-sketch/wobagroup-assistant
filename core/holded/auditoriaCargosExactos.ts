import type { Empresa } from "./client";
import type { EntradaTraza } from "./trazaBusqueda";

/**
 * Auditoría diaria de CARGOS EXACTOS no ofrecidos (pedida por Carlos tras el caso «Bk» −20,15 €, 2026-10-12): una compra propia que sigue
 * pendiente de pago mientras en el banco hay UN cargo libre con su mismo importe a pocos días. Para cada pareja pregunta al MISMO buscador que
 * usa el chat (con su traza) si ese cargo se ofrecería; el que no se ofrece es el hueco que esta auditoría caza antes de que lo encuentre un
 * humano. Solo lectura: no concilia, no escribe en Holded ni crea nada; avisa una sola vez por pareja y sin botones.
 *
 * Para no ser ruidosa solo considera parejas ÚNICAS por ambos lados (un cargo ↔ una compra) y con importe exacto, a un máximo de
 * DIAS_MAXIMOS días; las coincidencias de importe con categorías contradictorias o ya conciliadas son descartes correctos y no se avisan.
 */
export const DIAS_MINIMOS_ANTIGUEDAD_COMPRA = 2;
export const DIAS_MAXIMOS_DISTANCIA_CARGO = 3;
/**
 * Una factura (no un ticket) se paga días o semanas después de su fecha: caso real 2026-10-14, Business Atelier 2.372,42 USD del 28-09 y
 * cargo «Sent Money To Business Atelier» de 2.372,42 USD el 08-10, fuera de la ventana de +5 días del buscador. Un cargo posterior de importe
 * exacto solo cuenta como pista a partir de IMPORTE_MINIMO_PAGO_DIFERIDO: con importes pequeños la coincidencia fortuita es demasiado probable.
 */
export const DIAS_MAXIMOS_PAGO_DIFERIDO = 30;
export const IMPORTE_MINIMO_PAGO_DIFERIDO = 50;
/** Días hacia delante que cubre el buscador real (VENTANA_DIAS_MOVIMIENTO de write.ts); más allá no puede ver el cargo. */
export const DIAS_VENTANA_BUSCADOR = 5;
export const DIAS_MAXIMOS_COMPRA_AUDITADA = 45;
export const TOLERANCIA_IMPORTE_EXACTO = 0.011;

/** Descartes del buscador que pueden ocultar un cargo legítimo (los demás —categoría contradictoria, ya conciliado, ingreso— son correctos). */
const MOTIVOS_DESCARTE_REPORTABLES = [
  "el nombre no se reconoce y no coinciden la fecha",
  "el nombre no se reconoce y la descripción del cargo está vacía",
  "el nombre no se reconoce y no hay evidencia suficiente",
  "solo coincide la categoría y la fecha difiere",
];

export interface CompraAuditable { empresa: Empresa; id: string; fecha: string; total: number; moneda: string; proveedor: string; concepto: string }
export interface CargoLibre { movementId: string; cuentaId: string; descripcion: string; monto: number; moneda: string; equivalenteEur: number | null; fecha: string }
export type TipoHallazgo = "no_ofrecido" | "fuera_de_ventana" | "ofrecido_sin_conciliar";
export interface HallazgoCargoExacto { clave: string; tipo: TipoHallazgo; compra: CompraAuditable; cargo: { movementId: string; descripcion: string; fecha: string }; dias: number; motivo: string }

export interface DepsAuditoriaCargos {
  comprasPendientes(empresa: Empresa): Promise<CompraAuditable[]>;
  cargosLibres(empresa: Empresa, desde: string, hasta: string): Promise<CargoLibre[]>;
  /** El buscador real del chat (con traza) para esa compra: devuelve los cargos de su mismo importe y qué hizo con cada uno. */
  buscar(compra: CompraAuditable): Promise<EntradaTraza[]>;
  yaAvisadas(): Promise<Set<string>>;
  marcarAvisadas(claves: string[]): Promise<void>;
  avisar(texto: string): Promise<void>;
  ahora?: () => number;
  /** Solo calcula y devuelve; no avisa ni marca nada. */
  simular?: boolean;
}

export interface ResultadoAuditoriaCargos { hallazgos: HallazgoCargoExacto[]; nuevos: HallazgoCargoExacto[]; ambiguos: number; comprasRevisadas: number; simulado: boolean }

const MS_DIA = 86_400_000;
const dias = (a: string, b: string): number => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / MS_DIA;
/** Días con signo: positivo si el cargo es posterior a la fecha del gasto. */
const diasConSigno = (cargo: string, gasto: string): number => (Date.parse(cargo.slice(0, 10)) - Date.parse(gasto.slice(0, 10))) / MS_DIA;
const cercaDelGasto = (c: CompraAuditable, g: CargoLibre): boolean => {
  const d = diasConSigno(g.fecha, c.fecha);
  return Math.abs(d) <= DIAS_MAXIMOS_DISTANCIA_CARGO || (d > 0 && d <= DIAS_MAXIMOS_PAGO_DIFERIDO && Math.abs(c.total) >= IMPORTE_MINIMO_PAGO_DIFERIDO);
};
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const claveDe = (c: CompraAuditable, movementId: string): string => `${c.empresa}|${c.id}|${movementId}`;

export function esDescarteReportable(motivo: string): boolean {
  return MOTIVOS_DESCARTE_REPORTABLES.some((m) => motivo.startsWith(m));
}

/** ¿El cargo (en su moneda o en su equivalente en euros) tiene el importe exacto de la compra? */
function importeExacto(c: CompraAuditable, g: CargoLibre): boolean {
  const total = Math.abs(c.total);
  if (g.moneda.toUpperCase() === c.moneda.toUpperCase()) return Math.abs(Math.abs(g.monto) - total) <= TOLERANCIA_IMPORTE_EXACTO;
  return c.moneda.toUpperCase() === "EUR" && g.equivalenteEur != null && Math.abs(Math.abs(g.equivalenteEur) - total) <= TOLERANCIA_IMPORTE_EXACTO;
}

export async function auditarCargosExactos(deps: DepsAuditoriaCargos, empresas: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"]): Promise<ResultadoAuditoriaCargos> {
  const ahora = (deps.ahora ?? Date.now)();
  const hallazgos: HallazgoCargoExacto[] = [];
  let ambiguos = 0, comprasRevisadas = 0;

  for (const empresa of empresas) {
    const hoy = iso(ahora);
    const compras = (await deps.comprasPendientes(empresa)).filter((c) => {
      const edad = (ahora - Date.parse(c.fecha.slice(0, 10))) / MS_DIA;
      return Number.isFinite(edad) && edad >= DIAS_MINIMOS_ANTIGUEDAD_COMPRA && edad <= DIAS_MAXIMOS_COMPRA_AUDITADA && c.total > 0;
    });
    if (compras.length === 0) continue;
    const masAntigua = compras.reduce((m, c) => (c.fecha < m ? c.fecha : m), compras[0].fecha);
    const cargos = await deps.cargosLibres(empresa, iso(Date.parse(masAntigua) - DIAS_MAXIMOS_DISTANCIA_CARGO * MS_DIA), hoy);

    // Prefiltro barato: parejas de importe exacto y fecha cercana. Solo ellas llegan al buscador real.
    const parejas = compras.map((c) => ({ c, g: cargos.filter((x) => cercaDelGasto(c, x) && importeExacto(c, x)) })).filter((p) => p.g.length > 0);
    const comprasPorCargo = new Map<string, number>();
    for (const p of parejas) for (const g of p.g) comprasPorCargo.set(g.movementId, (comprasPorCargo.get(g.movementId) ?? 0) + 1);

    for (const { c, g } of parejas) {
      comprasRevisadas++;
      // Pareja única por ambos lados: una compra con varios cargos posibles, o un cargo con varias compras posibles, no es un hueco claro.
      if (g.length !== 1 || (comprasPorCargo.get(g[0].movementId) ?? 0) !== 1) { ambiguos++; continue; }
      const cargo = g[0];
      const entrada = (await deps.buscar(c)).find((e) => e.movementId === cargo.movementId);
      const base = { clave: claveDe(c, cargo.movementId), compra: c, cargo: { movementId: cargo.movementId, descripcion: cargo.descripcion, fecha: cargo.fecha }, dias: dias(cargo.fecha, c.fecha) };
      if (!entrada) {
        // El buscador ni lo vio: solo se explica si el cargo cae más allá de su ventana hacia delante; si no, es otra cosa y no se avisa.
        if (diasConSigno(cargo.fecha, c.fecha) > DIAS_VENTANA_BUSCADOR) hallazgos.push({ ...base, tipo: "fuera_de_ventana", motivo: `el cargo es ${Math.round(base.dias)} días posterior al gasto y mi búsqueda solo mira ${DIAS_VENTANA_BUSCADOR} días hacia delante` });
      } else if (entrada.resultado === "ofrecido") hallazgos.push({ ...base, tipo: "ofrecido_sin_conciliar", motivo: entrada.motivo });
      else if (esDescarteReportable(entrada.motivo)) hallazgos.push({ ...base, tipo: "no_ofrecido", motivo: entrada.motivo });
    }
  }

  const avisadas = await deps.yaAvisadas();
  const nuevos = hallazgos.filter((h) => !avisadas.has(h.clave));
  if (!deps.simular && nuevos.length > 0) {
    await deps.avisar(textoAviso(nuevos));
    await deps.marcarAvisadas(nuevos.map((h) => h.clave));
  }
  return { hallazgos, nuevos, ambiguos, comprasRevisadas, simulado: Boolean(deps.simular) };
}

const linea = (h: HallazgoCargoExacto): string => {
  const importe = `${h.compra.total.toFixed(2)} ${h.compra.moneda}`;
  const cargo = `«${h.cargo.descripcion || "sin descripción"}» del ${h.cargo.fecha}`;
  return `  • ${h.compra.empresa} · ${h.compra.proveedor} ${importe} (${h.compra.fecha}) ↔ cargo ${cargo}`;
};

export function textoAviso(nuevos: readonly HallazgoCargoExacto[]): string {
  const noOfrecidos = nuevos.filter((h) => h.tipo !== "ofrecido_sin_conciliar");
  const ofrecidos = nuevos.filter((h) => h.tipo === "ofrecido_sin_conciliar");
  const partes = ["🔎 Auditoría de cargos exactos (solo lectura, no he conciliado nada):"];
  if (noOfrecidos.length > 0) partes.push("", `Compras pendientes de pago con UN cargo libre del mismo importe exacto que mi búsqueda NO ofrecería (${noOfrecidos.length}):`, ...noOfrecidos.slice(0, 8).map((h) => `${linea(h)}\n      motivo: ${h.motivo}`));
  if (ofrecidos.length > 0) partes.push("", `Compras pendientes con un cargo libre exacto que SÍ se ofrecería pero nadie ha conciliado (${ofrecidos.length}):`, ...ofrecidos.slice(0, 8).map(linea));
  partes.push("", "Si alguno es el cargo correcto, dime «concilia <proveedor>» y te preparo la conciliación para que la confirmes. Este aviso no se repite para la misma pareja.");
  return partes.join("\n");
}
