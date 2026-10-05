import type { GastoEtiquetado } from "../holded/gastosPorEtiqueta";

/**
 * Filtros del informe de reintegro (caso Nuria/MIMO, 2026-10-05): dejar solo los gastos pagados en bancos y excluir
 * proveedores que se cobran por separado (Northgate España Renting Flexible). Deben aplicarse IGUAL al PDF y al ZIP de
 * comprobantes (que reconstruye la lista desde el botón), o la numeración no coincidiría: por eso viajan dentro del
 * `callback_data` (máx. 64 bytes) en un segmento compacto y ambos lados usan estas mismas funciones.
 */
export interface FiltrosReintegro {
  /** Solo gastos totalmente pagados desde una cuenta bancaria; los sin pagar o parciales quedan fuera. */
  soloPagados: boolean;
  /** Fragmentos compactos (minúsculas, sin acentos ni símbolos) que, si aparecen en proveedor o concepto, excluyen el gasto. */
  excluir: string[];
}

export const SIN_FILTROS: FiltrosReintegro = { soloPagados: false, excluir: [] };
const MAX_BYTES_CALLBACK = 64;
const MIN_FRAGMENTO = 4;

export const compacto = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Términos libres («Northgate España») → fragmentos compactos únicos; los demasiado cortos se descartan (excluirían de más). */
export function normalizarExclusiones(terminos: string[], maxLongitud = 14): string[] {
  const fragmentos = terminos.map((t) => compacto(t).slice(0, maxLongitud)).filter((t) => t.length >= MIN_FRAGMENTO);
  return [...new Set(fragmentos)];
}

export function codificarFiltros(f: FiltrosReintegro): string {
  if (!f.soloPagados && f.excluir.length === 0) return "";
  return `${f.soloPagados ? "p" : "-"}${f.excluir.map((x) => `~${x}`).join("")}`;
}

export function decodificarFiltros(segmento: string | undefined): FiltrosReintegro {
  if (!segmento) return SIN_FILTROS;
  const [bandera, ...resto] = segmento.split("~");
  return { soloPagados: bandera === "p", excluir: resto.filter((x) => x.length >= MIN_FRAGMENTO) };
}

/** Filtros efectivos: acorta los fragmentos hasta que el `callback_data` completo quepa en 64 bytes; el informe usa ESTOS mismos. */
export function ajustarFiltrosAlBoton(base: string, f: FiltrosReintegro): FiltrosReintegro {
  for (let largo = 14; largo >= MIN_FRAGMENTO; largo--) {
    const candidatos: FiltrosReintegro = { soloPagados: f.soloPagados, excluir: [...new Set(f.excluir.map((x) => x.slice(0, largo)))] };
    const seg = codificarFiltros(candidatos);
    if (Buffer.byteLength(`${base}${seg ? `:${seg}` : ""}`) <= MAX_BYTES_CALLBACK) return candidatos;
  }
  throw new Error("Demasiadas exclusiones para el botón de comprobantes; usa menos o términos más cortos.");
}

export interface GastosFiltrados {
  gastos: GastoEtiquetado[];
  excluidos: GastoEtiquetado[];
  /** Con soloPagados: registrados pero sin cargo en banco (o pago parcial) que se dejan fuera. */
  omitidosSinPagar: GastoEtiquetado[];
}

export function aplicarFiltrosReintegro(gastos: GastoEtiquetado[], f: FiltrosReintegro): GastosFiltrados {
  const coincide = (g: GastoEtiquetado) => {
    const texto = compacto(`${g.proveedor} ${g.descripcion}`);
    return f.excluir.some((x) => texto.includes(x));
  };
  const excluidos = gastos.filter(coincide);
  const restantes = gastos.filter((g) => !coincide(g));
  if (!f.soloPagados) return { gastos: restantes, excluidos, omitidosSinPagar: [] };
  return { gastos: restantes.filter((g) => g.estado === "pagado"), excluidos, omitidosSinPagar: restantes.filter((g) => g.estado !== "pagado") };
}

/**
 * Un gasto PAGADO cuyo documento está en otra moneda (p. ej. Air France 152,00 EUR registrado tras conciliarlo como
 * 176,12 USD contra un cargo de la cuenta USD) se reintegra por lo que de verdad salió del banco en EUR: la suma de sus pagos
 * (Holded guarda los pagos en EUR). El importe original queda en el concepto. Sin esto, el informe lo dejaba fuera de los
 * totales como «gasto en otra moneda». Los no pagados o parciales no se tocan: no tienen cargo que valorar.
 */
export function aEquivalenteEurSiPagado(g: GastoEtiquetado): GastoEtiquetado {
  if (g.moneda === "EUR" || g.estado !== "pagado" || g.pagos.length === 0) return g;
  const eur = Math.round(g.pagos.reduce((suma, p) => suma + p.importe, 0) * 100) / 100;
  if (!(eur > 0)) return g;
  return {
    ...g,
    total: eur,
    moneda: "EUR",
    pendiente: 0,
    descripcion: `${g.descripcion} (cargo bancario; documento por ${g.total.toFixed(2)} ${g.moneda})`.trim(),
  };
}

/** Misma preparación para el PDF y para el ZIP de comprobantes: equivalente en EUR y después filtros. */
export function prepararGastosReintegro(gastos: GastoEtiquetado[], f: FiltrosReintegro): GastosFiltrados {
  return aplicarFiltrosReintegro(gastos.map(aEquivalenteEurSiPagado), f);
}
