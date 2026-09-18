/** Clasificación por evidencia, independiente de credenciales y del modelo generativo. */
export interface CuentaContableReal { id: string; name: string; archived?: boolean }
export interface CompraPrecedente {
  id: string; contact_id?: string; contact_name?: string; description?: string; date?: string;
  document_number?: string | null; draft?: boolean; status?: string; tags?: string[];
  lines?: Array<{ name?: string; account?: string }>;
}
export interface CriteriosCuenta {
  proveedor: string; concepto: string; personaAsociada?: string; contextoDeViaje?: boolean;
  contactId?: string; excluirCompraId?: string; tagsCategoria?: string[];
}
export interface EvidenciaCuenta { compraId: string; documento: string; fecha: string; proveedor: string; concepto: string }
export interface CuentaSugeridaContextual {
  accountId: string; nombreCuenta: string; tags: string[]; ejemplo: string;
  aprendidoDe: "proveedor" | "concepto" | "categoria" | "viaje" | "correccion_confirmada";
  evidencia: EvidenciaCuenta[];
}
export interface EvaluacionCuenta {
  sugerencia?: CuentaSugeridaContextual;
  motivo: string;
  descartados: Array<{ compraId: string; cuenta: string; motivo: string }>;
}
const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function esServicioDigital(proveedor: string, concepto: string): boolean {
  const texto = norm(`${proveedor} ${concepto}`);
  return /\b(anthropic|claude|openai|chatgpt|software|saas|api|licencias?|hosting|workspace)\b/.test(texto) ||
    /\b(servicio digital|inteligencia artificial|creditos de ia|suscripcion digital)\b/.test(texto);
}
export function esServicioNoViaje(proveedor: string, concepto: string): boolean {
  return esServicioDigital(proveedor, concepto) || /\b(suscripcion|subscription|consultoria|asesoria|honorarios|contabilidad|seguros?|abogad[oa]|catering)\b/.test(norm(`${proveedor} ${concepto}`));
}
const cuentaViaje = (s: string) => /\b(viajes?|desplazamientos?|dietas?|alojamiento|hospedaje|transporte)\b/.test(norm(s));
const cuentaAjuste = (s: string) => /\b(diferencias? .*cambio|comision|comisiones|intereses|ajustes?|redondeo)\b/.test(norm(s));
const conceptoAjuste = (s: string) => /\b(diferencias? .*cambio|exchange difference|comision bancaria|bank fee|redondeo)\b/.test(norm(s));
const cuentaDigitalCompatible = (s: string) => /\b(software|informatica|informaticos|herramientas?|tecnologia|licencias?|suscripciones?|otros servicios|servicios digitales)\b/.test(norm(s));
const ignoradas = new Set("compra factura recibo purchase creditos credit tarjeta mastercard revolut cuenta personal usada gastos comprobante visual generado desde cuerpo correo adjunto original euros servicio servicios empresa woba footprint eworks business group limited ireland proveedor fecha moneda importe pago pagos cargo nombre".split(" "));
function palabrasConcepto(c: CriteriosCuenta): Set<string> {
  const persona = new Set(norm(c.personaAsociada ?? "").split(" "));
  return new Set(norm(c.concepto).split(" ").filter((p) => p.length >= 5 && !ignoradas.has(p) && !persona.has(p) && !/^\d+$/.test(p)));
}
function mismoProveedor(c: CriteriosCuenta, p: CompraPrecedente): boolean {
  if (c.contactId) return p.contact_id === c.contactId;
  const limpiar = (s: string) => norm(s).replace(/\b(pbc|llc|inc|ltd|limited|sl|sa|slu)\b/g, "").replace(/\s+/g, " ").trim();
  return Boolean(c.proveedor.trim()) && limpiar(c.proveedor) === limpiar(p.contact_name ?? "");
}

export function evaluarCuentaContable(
  criterios: CriteriosCuenta, compras: CompraPrecedente[], cuentas: CuentaContableReal[],
  correccion?: { cuentaId: string; confirmadoEn: string }, ahora = Date.now()
): EvaluacionCuenta {
  const descartados: EvaluacionCuenta["descartados"] = [];
  const catalogo = new Map(cuentas.filter((c) => c.id && c.name && c.archived === false).map((c) => [c.id, c]));
  const digital = esServicioDigital(criterios.proveedor, criterios.concepto);
  const noViaje = esServicioNoViaje(criterios.proveedor, criterios.concepto);
  const ajuste = conceptoAjuste(criterios.concepto);
  const naturalezaViaje = !noViaje && ((criterios.tagsCategoria ?? []).some((t) =>
    ["alimentacion", "transporte", "taxi", "tren", "avion", "hospedaje", "parking", "gasolina", "peaje", "alquilercoche"].includes(t)) ||
    /\b(hotel|taxi|tren|vuelo|almuerzo|restaurante|hospedaje|alojamiento|parking|gasolina|peaje)\b/.test(norm(`${criterios.proveedor} ${criterios.concepto}`)));
  const incompatible = (cuenta: CuentaContableReal): boolean =>
    (!naturalezaViaje && cuentaViaje(cuenta.name)) || (!ajuste && cuentaAjuste(cuenta.name)) ||
    (digital && !ajuste && !cuentaDigitalCompatible(cuenta.name));
  type Fila = { compra: CompraPrecedente; cuenta: CuentaContableReal; concepto: string };
  const filas: Fila[] = [];
  // Una factura con muchas líneas no equivale a múltiples precedentes independientes.
  const vistas = new Set<string>();
  for (const compra of compras) {
    if (!compra.id || compra.id === criterios.excluirCompraId || vistas.has(compra.id)) continue;
    vistas.add(compra.id);
    if (compra.draft !== false || !["pending", "completed", "partial"].includes(compra.status ?? "")) continue;
    for (const linea of compra.lines ?? []) {
      const cuenta = catalogo.get(linea.account ?? "");
      if (!cuenta || incompatible(cuenta)) {
        descartados.push({ compraId: compra.id, cuenta: cuenta?.name ?? linea.account ?? "sin cuenta", motivo: "Cuenta no vigente o incompatible con la naturaleza del gasto." });
        continue;
      }
      const concepto = linea.name || compra.description || "";
      // Un ajuste del mismo proveedor no es una suscripción ni una compra de créditos.
      if (!ajuste && conceptoAjuste(concepto)) continue;
      filas.push({ compra, cuenta, concepto });
    }
  }
  const resultado = (seleccion: Fila[], origen: CuentaSugeridaContextual["aprendidoDe"], minimo = 2): CuentaSugeridaContextual | undefined => {
    if (new Set(seleccion.map((f) => f.compra.id)).size < minimo || new Set(seleccion.map((f) => f.cuenta.id)).size !== 1) return undefined;
    const evidencia = [...new Map(seleccion.map((f) => [f.compra.id, {
      compraId: f.compra.id, documento: f.compra.document_number ?? "", fecha: f.compra.date ?? "",
      proveedor: f.compra.contact_name ?? "", concepto: f.concepto,
    }])).values()];
    return { accountId: seleccion[0].cuenta.id, nombreCuenta: seleccion[0].cuenta.name, tags: [],
      ejemplo: evidencia[0].concepto, aprendidoDe: origen, evidencia };
  };
  const responder = (sugerencia: CuentaSugeridaContextual | undefined, motivo: string): EvaluacionCuenta => ({ sugerencia, motivo, descartados });
  if (correccion) {
    const edad = ahora - Date.parse(correccion.confirmadoEn);
    const cuenta = catalogo.get(correccion.cuentaId);
    if (edad >= 0 && edad <= 180 * 86400000 && cuenta && !incompatible(cuenta)) {
      return responder({ accountId: cuenta.id, nombreCuenta: cuenta.name, tags: [], ejemplo: "corrección confirmada vigente",
        aprendidoDe: "correccion_confirmada", evidencia: [] }, "Corrección confirmada, contrastada con el catálogo y la naturaleza del gasto.");
    }
  }
  const proveedor = filas.filter((f) => mismoProveedor(criterios, f.compra));
  // Primero proveedor + servicio. El viaje de una persona nunca convierte su software en viaje.
  const sugeridaProveedor = resultado(proveedor, "proveedor");
  if (sugeridaProveedor) return responder(sugeridaProveedor, "Precedentes independientes del mismo proveedor en una cuenta compatible.");
  if (new Set(proveedor.map((f) => f.cuenta.id)).size > 1) return responder(undefined, "El proveedor tiene cuentas distintas en precedentes comparables; se requiere revisión.");

  const categoria = criterios.tagsCategoria ?? [];
  const viajeAplicable = criterios.contextoDeViaje === true && !noViaje && categoria.some((t) =>
    ["alimentacion", "transporte", "taxi", "tren", "avion", "hospedaje", "parking", "gasolina", "peaje", "alquilercoche"].includes(t));
  const comparables = filas.filter((f) => {
    const texto = `${f.concepto} ${f.compra.description ?? ""}`;
    if (digital) return esServicioDigital(f.compra.contact_name ?? "", texto);
    if (viajeAplicable) return cuentaViaje(f.cuenta.name) && (f.compra.tags ?? []).some((t) => ["transporte", "hospedaje", "avion", "taxi", "tren"].includes(norm(t)));
    if (categoria.length) return categoria.every((tag) => (f.compra.tags ?? []).includes(tag));
    const palabras = palabrasConcepto(criterios);
    const palabrasLinea = palabrasConcepto({ proveedor: "", concepto: texto, personaAsociada: criterios.personaAsociada });
    return [...palabras].filter((p) => palabrasLinea.has(p)).length >= 2;
  });
  const sugerida = resultado(comparables, viajeAplicable ? "viaje" : categoria.length || digital ? "categoria" : "concepto");
  return responder(sugerida, sugerida ? "Dos o más documentos comparables respaldan la misma cuenta activa." :
    "No hay evidencia suficiente y unívoca de una cuenta compatible. No se asignará una cuenta por defecto ni por frecuencia general.");
}

export class CuentaContableRevisionError extends Error {}

export function exigirCuentaRevalidada(aprobada: string | undefined, evaluacion: EvaluacionCuenta): CuentaSugeridaContextual {
  if (!aprobada || !evaluacion.sugerencia || evaluacion.sugerencia.accountId !== aprobada) {
    throw new CuentaContableRevisionError(`Clasificación contable pendiente de revisión: ${evaluacion.motivo}` +
      (evaluacion.sugerencia ? ` Cuenta respaldada ahora: ${evaluacion.sugerencia.nombreCuenta} [${evaluacion.sugerencia.accountId}]. Requiere una nueva propuesta.` : ""));
  }
  return evaluacion.sugerencia;
}
