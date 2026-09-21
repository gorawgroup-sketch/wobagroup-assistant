import { evaluarCuentaContable, type CompraPrecedente, type CuentaContableReal } from "../../holded/cuentaContableContexto";
import { mapearInversionSujetoPasivoATaxKey, normalizarEtiquetaHolded, tieneCategoriaGastoAprendida,
  type TaxCatalogEntry } from "../../holded/write";
import { candidatosMovimientoAuto, fechaValida, hash, monedaDocumentoAuto, movimientoEnVentanaAuto, nombresProveedorCompatibles, nombresProveedorEquivalentes,
  normalizar, normalizarProveedorComparable, proveedorEnDescripcion, similitudProveedor, toleranciaMontoAuto,
  VENTANA_DIAS_MOVIMIENTO_AUTO_ADELANTE, VENTANA_DIAS_MOVIMIENTO_AUTO_ATRAS,
  VERSION_POLITICA, type CorreoAuto, type EmpresaAuto, type EvidenciaAuto, type MovimientoAuto, type OperacionAuto, type ReciboAuto } from "./model";
import { mapearConConcurrencia } from "../../utils/mapearConConcurrencia";

type Registro = Record<string, unknown>;
export function objeto(raw: unknown): Registro {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Respuesta Holded inválida.");
  return raw as Registro;
}
function texto(raw: unknown): string { if (typeof raw !== "string" || !raw) throw new Error("Campo Holded ausente."); return raw; }
const idUrl = (id: string) => encodeURIComponent(id);
export const normalizarProveedorExacto = normalizarProveedorComparable;
function centimos(raw: unknown, admiteFormatoES = false): number {
  if (typeof raw !== "number" && typeof raw !== "string") throw new Error("Importe ausente o inválido.");
  let valor = String(raw);
  if (admiteFormatoES && valor.includes(",")) {
    if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(valor)) throw new Error("Importe ES inválido.");
    valor = valor.replace(/\./g, "").replace(",", ".");
  }
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(valor)) throw new Error("Importe inválido o con precisión superior a céntimos.");
  const negativo = valor.startsWith("-");
  const [entero, decimal = ""] = valor.replace(/^-/, "").split(".");
  const resultado = BigInt(entero) * 100n + BigInt(decimal.padEnd(2, "0"));
  if (resultado > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Importe fuera del rango seguro.");
  return Number(negativo ? -resultado : resultado);
}
const KEYS: Record<EmpresaAuto, string> = { WOBA: "HOLDED_API_KEY_WOBA", EWORKS: "HOLDED_API_KEY_EWORKS", Footprint: "HOLDED_API_KEY_FOOTPRINT" };
export interface MemoriaHoldedAuto {
  alias(empresa: EmpresaAuto, proveedor: string): Promise<Array<{ contactId: string; contactName: string }>>;
  duplicadoInterno(c: CorreoAuto, r: ReciboAuto): Promise<boolean>;
  cuentaConfirmada?(empresa: EmpresaAuto, proveedor: string): Promise<{ cuentaId: string; confirmadoEn: string } | undefined>;
}
export interface FlujoGastoExistente {
  clasificar(recibo: ReciboAuto, excluirCompraId?: string): Promise<{ cuentaId: string; nombreCuenta: string; tags: string[]; evidencia: string } | undefined>;
  crear(op: OperacionAuto): Promise<string>;
  corregir(op: OperacionAuto, compraId: string): Promise<void>;
  adjuntar(op: OperacionAuto, data: Buffer, nombre: string, mime: string): Promise<void>;
  conciliar(op: OperacionAuto): Promise<void>;
  verificarConciliacion(op: OperacionAuto): Promise<boolean>;
}

// Procedimiento autorizado: crear compra, conciliar y convertir a ticket manualmente en Holded.
// La conversión pendiente se informa en el resumen; no bloquea registrar el gasto.
export class HoldedAuto {
  private readonly listadosEstaticos = new Map<string, Promise<Registro[]>>();
  private readonly objetosEstaticos = new Map<string, Promise<Registro>>();
  /**
   * Los correos de una misma pasada suelen pertenecer al mismo mes. Compartir
   * este listado evita volver a descargar las mismas 12 cuentas por cada
   * comprobante; se invalida la cuenta apenas se concilia un movimiento.
   */
  private readonly movimientosPorVentana = new Map<string, Promise<Registro[]>>();
  constructor(private readonly memoria: MemoriaHoldedAuto, private readonly request: typeof fetch = fetch,
    private readonly empresas: EmpresaAuto[] = ["WOBA", "EWORKS", "Footprint"],
    private readonly flujoExistente?: FlujoGastoExistente) {}
  private async get(empresa: EmpresaAuto, path: string): Promise<Registro> {
    const key = process.env[KEYS[empresa]];
    if (!key) throw new Error(`Falta ${KEYS[empresa]}.`);
    const r = await this.request(`https://api.holded.com/api/v2${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Consulta Holded falló (${r.status}); no se autoriza crear.`);
    return objeto(await r.json());
  }
  async listar(empresa: EmpresaAuto, path: string, filtros: Record<string, string> = {}): Promise<Registro[]> {
    const items: Registro[] = [];
    const cursores = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let pagina = 0; pagina < 1000; pagina++) {
      const params = new URLSearchParams({ ...filtros, limit: "200", ...(cursor ? { cursor } : {}) });
      const data = await this.get(empresa, `${path}?${params}`);
      if (!Array.isArray(data.items)) throw new Error("Listado Holded incompleto.");
      for (const raw of data.items) {
        const item = objeto(raw); const id = texto(item.id);
        if (ids.has(id)) throw new Error("Listado Holded inconsistente: identidad repetida.");
        ids.add(id); items.push(item);
      }
      if (data.has_more === false) return items;
      if (data.has_more !== true || typeof data.cursor !== "string" || !data.cursor || cursores.has(data.cursor)) throw new Error("Paginación Holded incompleta.");
      cursor = data.cursor; cursores.add(cursor);
    }
    throw new Error("Límite de paginación alcanzado; no se considera verificada la ausencia de duplicados.");
  }
  private async listarAdjuntos(empresa: EmpresaAuto, compraId: string): Promise<Registro[]> {
    const unicos = new Map<string, Registro>();
    const cursores = new Set<string>();
    let cursor: string | undefined;
    for (let pagina = 0; pagina < 100; pagina++) {
      const params = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
      const data = await this.get(empresa, `/purchases/${idUrl(compraId)}/attachments?${params}`);
      if (!Array.isArray(data.items)) throw new Error("Listado de comprobantes Holded incompleto.");
      for (const raw of data.items) {
        const item = objeto(raw);
        // Holded puede devolver varias filas del mismo soporte con el mismo id.
        // En adjuntos esa repetición no vuelve ambigua la identidad descargable:
        // se consulta ese recurso una sola vez y se valida por sus bytes.
        const id = texto(item.id);
        if (!unicos.has(id)) unicos.set(id, item);
      }
      if (data.has_more === false) return [...unicos.values()];
      if (data.has_more !== true || typeof data.cursor !== "string" || !data.cursor || cursores.has(data.cursor)) {
        throw new Error("Paginación de comprobantes Holded incompleta.");
      }
      cursor = data.cursor;
      cursores.add(cursor);
    }
    throw new Error("Límite de paginación de comprobantes alcanzado.");
  }
  private listarEstatico(empresa: EmpresaAuto, path: string): Promise<Registro[]> {
    const clave = `${empresa}:${path}`;
    const existente = this.listadosEstaticos.get(clave);
    if (existente) return existente;
    const carga = this.listar(empresa, path);
    this.listadosEstaticos.set(clave, carga);
    return carga;
  }
  private getEstatico(empresa: EmpresaAuto, path: string): Promise<Registro> {
    const clave = `${empresa}:${path}`;
    const existente = this.objetosEstaticos.get(clave);
    if (existente) return existente;
    const carga = this.get(empresa, path);
    this.objetosEstaticos.set(clave, carga);
    return carga;
  }
  private movimientosCuenta(empresa: EmpresaAuto, cuentaId: string, fechaRecibo: string): Promise<Registro[]> {
    const fecha = new Date(`${fechaRecibo.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(fecha.getTime())) throw new Error("Fecha de recibo inválida para consultar banco.");
    const inicioMes = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), 1));
    const finMes = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth() + 1, 0));
    const desde = new Date(inicioMes); desde.setUTCDate(desde.getUTCDate() - VENTANA_DIAS_MOVIMIENTO_AUTO_ATRAS);
    const hasta = new Date(finMes); hasta.setUTCDate(hasta.getUTCDate() + VENTANA_DIAS_MOVIMIENTO_AUTO_ADELANTE);
    const formato = (d: Date) => d.toISOString().slice(0, 10);
    const clave = `${empresa}:${cuentaId}:${formato(inicioMes)}`;
    const existente = this.movimientosPorVentana.get(clave);
    if (existente) return existente;
    const carga = this.listar(empresa, `/treasury/accounts/${idUrl(cuentaId)}/bank-movements`, {
      start_date: formato(desde), end_date: formato(hasta),
    });
    this.movimientosPorVentana.set(clave, carga);
    return carga;
  }
  private invalidarMovimientosCuenta(empresa: EmpresaAuto, cuentaId: string): void {
    const prefijo = `${empresa}:${cuentaId}:`;
    for (const clave of this.movimientosPorVentana.keys()) if (clave.startsWith(prefijo)) this.movimientosPorVentana.delete(clave);
  }
  async evidencias(c: CorreoAuto, r: ReciboAuto): Promise<EvidenciaAuto> {
    const e: EvidenciaAuto = { consultasCompletas: false, duplicados: [], movimientos: [], permiteTicket: true };
    if (!new Set(["ticket", "recibo"]).has(r.tipo) || !fechaValida(r.fecha)) return e;
    if (r.empresa !== "desconocida") {
      return this.empresas.includes(r.empresa) ? this.evidenciasEmpresa(c, r) : e;
    }
    const candidatas: Array<{ empresa: EmpresaAuto; evidencia: EvidenciaAuto }> = [];
    for (const empresa of this.empresas) {
      const evidencia = await this.evidenciasEmpresa(c, { ...r, empresa });
      if (this.identificaEmpresa(r, evidencia)) candidatas.push({ empresa, evidencia });
    }
    if (candidatas.length !== 1) return { ...e, consultasCompletas: true };
    return { ...candidatas[0].evidencia, empresaDetectada: candidatas[0].empresa };
  }
  private identificaEmpresa(r: ReciboAuto, e: EvidenciaAuto): boolean {
    if (!e.consultasCompletas || !e.contacto?.id || e.duplicados.length) return false;
    const candidatas = candidatosMovimientoAuto(r, e).filter(m => m.estado === "pending" && m.conciliadoCentimos === 0 &&
      Boolean(m.origen) && m.origen !== "manual");
    const proveedorBanco = candidatas.length === 1 &&
      (proveedorEnDescripcion(r.proveedor, candidatas[0].descripcion) || proveedorEnDescripcion(e.contacto.nombre, candidatas[0].descripcion));
    const importe = centimos(r.equivalente?.monto ?? r.monto);
    const exacta = candidatas.length === 1 && candidatas[0].fecha === r.fecha && -candidatas[0].centimos === importe;
    const nombreFuerteConImporteExacto = e.contacto.metodo === "aproximado_unico" && (e.contacto.similitud ?? 0) >= 0.5 && exacta;
    const proveedorVerificado = (e.contacto.exacto === true ||
      (e.contacto.metodo === "aproximado_unico" && (proveedorBanco || nombreFuerteConImporteExacto))) &&
      (exacta || proveedorBanco);
    if (!proveedorVerificado) return false;
    return candidatas.length === 1 && new Set(candidatas.map(m => `${m.cuentaId}/${m.id}`)).size === 1;
  }
  private async evidenciasEmpresa(c: CorreoAuto, r: ReciboAuto): Promise<EvidenciaAuto> {
    const e: EvidenciaAuto = { consultasCompletas: false, duplicados: [], movimientos: [], permiteTicket: true };
    const empresa = r.empresa as EmpresaAuto;
    const contactos = (await this.listarEstatico(empresa, "/contacts"))
      .filter(x => x.archived !== true && typeof x.id === "string" && typeof x.name === "string");
    const alias = await this.memoria.alias(empresa, r.proveedor);
    const directos = contactos.filter(x => typeof x.name === "string" && normalizarProveedorExacto(x.name) === normalizarProveedorExacto(r.proveedor));
    const idsAlias = new Set(alias.map(x => x.contactId));
    let seleccionados: Registro[] = [];
    let metodo: NonNullable<EvidenciaAuto["contacto"]>["metodo"] = "nombre_exacto";
    // El nombre exacto actual de Holded prevalece sobre un alias antiguo. Si hay varios contactos
    // idénticos, un alias confirmado puede desambiguar, pero nunca se elige el primero al azar.
    if (directos.length === 1) seleccionados = directos;
    else if (idsAlias.size === 1) {
      const porAlias = contactos.filter(x => idsAlias.has(String(x.id)));
      if (porAlias.length === 1 && (directos.length === 0 || directos.some(x => x.id === porAlias[0].id))) {
        seleccionados = porAlias; metodo = "alias_confirmado";
      } else e.motivoProveedor = "alias_contradictorio";
    } else if (idsAlias.size > 1) e.motivoProveedor = "alias_contradictorio";
    if (!seleccionados.length && directos.length > 1) e.motivoProveedor = "coincidencia_ambigua";
    if (!seleccionados.length && directos.length === 0 && idsAlias.size <= 1) {
      const equivalentes = contactos.filter(x => nombresProveedorEquivalentes(String(x.name), r.proveedor));
      if (equivalentes.length === 1) { seleccionados = equivalentes; metodo = "nombre_equivalente"; }
      else if (equivalentes.length > 1) e.motivoProveedor = "coincidencia_ambigua";
    }
    if (!seleccionados.length && !e.motivoProveedor) {
      const ranking = contactos.map(x => ({ contacto: x, similitud: similitudProveedor(String(x.name), r.proveedor),
        compatible: nombresProveedorCompatibles(String(x.name), r.proveedor) }))
        .filter(x => x.compatible || x.similitud >= 0.5).sort((a, b) => b.similitud - a.similitud);
      const primera = ranking[0], segunda = ranking[1];
      if (primera && (!segunda || primera.similitud - segunda.similitud >= 0.12)) {
        seleccionados = [primera.contacto]; metodo = "aproximado_unico";
      } else if (ranking.length) e.motivoProveedor = "coincidencia_ambigua";
    }
    e.candidatosProveedor = contactos.map(x => ({ id: String(x.id), nombre: String(x.name),
      similitud: similitudProveedor(String(x.name), r.proveedor) }))
      .sort((a, b) => b.similitud - a.similitud).slice(0, 3);
    if (seleccionados.length === 1 && typeof seleccionados[0].name === "string" &&
      !/sin identificar|desconocido|unknown|unidentified/.test(normalizar(seleccionados[0].name))) {
      e.contacto = { id: texto(seleccionados[0].id), nombre: seleccionados[0].name,
        // Un alias aprendido no demuestra por sí solo que ESTE comprobante pertenezca al
        // contacto. Solo la identidad/equivalencia del nombre real se considera exacta;
        // los alias quedan para revisión manual y nunca autorizan una escritura automática.
        exacto: metodo === "nombre_exacto" || metodo === "nombre_equivalente", metodo,
        similitud: similitudProveedor(seleccionados[0].name, r.proveedor) };
    }
    if (!e.contacto && !e.motivoProveedor) e.motivoProveedor = "sin_coincidencias";
    if (await this.memoria.duplicadoInterno(c, r)) e.duplicados.push("historial_o_propuesta_pendiente");
    const fecha = new Date(`${r.fecha}T00:00:00Z`);
    const formato = (d: Date) => d.toISOString().slice(0, 10);
    const desde = new Date(fecha); desde.setUTCDate(desde.getUTCDate() - 15);
    const hasta = new Date(fecha); hasta.setUTCDate(hasta.getUTCDate() + 15);
    const comprasVentana = await this.listar(empresa, "/purchases", { start_date: formato(desde), end_date: formato(hasta) });
    const comprasContacto = e.contacto ? await this.listar(empresa, "/purchases", { contact_id: e.contacto.id }) : [];
    const compras = [...new Map([...comprasVentana, ...comprasContacto].map(p => [texto(p.id), p])).values()];
    const moneda = r.equivalente?.moneda ?? r.moneda;
    const importe = centimos(r.equivalente?.monto ?? r.monto);
    const tolerancia = toleranciaMontoAuto(importe);
    const numero = r.numero?.trim().toUpperCase();
    for (const p of compras) {
      const mismoContacto = p.contact_id === e.contacto?.id || normalizarProveedorExacto(String(p.contact_name ?? "")) === normalizarProveedorExacto(r.proveedor);
      const mismoNumero = numero && numero !== "00000" && numero === String(p.document_number ?? "").trim().toUpperCase();
      const dias = Math.abs(Date.parse(String(p.date).slice(0, 10)) - Date.parse(r.fecha)) / 86400000;
      if (mismoContacto && (mismoNumero || (p.currency === moneda && dias <= 15 && Math.abs(centimos(p.total, true) - importe) <= tolerancia))) {
        e.duplicados.push(texto(p.id));
      }
    }
    const cuentas = await this.listarEstatico(empresa, "/treasury/accounts");
    const movimientosPorCuenta = await mapearConConcurrencia(cuentas.filter(cuenta => cuenta.archived !== true), 4, async cuenta => {
      const cuentaId = texto(cuenta.id);
      const movimientos = await this.movimientosCuenta(empresa, cuentaId, r.fecha);
      return { cuenta, cuentaId, movimientos };
    });
    for (const { cuenta, cuentaId, movimientos } of movimientosPorCuenta) {
      for (const mov of movimientos) {
        if (mov.banking_account_id !== cuentaId || mov.currency !== cuenta.currency) throw new Error("Identidad bancaria inconsistente.");
        const movimiento: MovimientoAuto = { id: texto(mov.id), cuentaId, fecha: texto(mov.booking_date).slice(0, 10),
          moneda: texto(mov.currency), centimos: centimos(mov.amount), conciliadoCentimos: centimos(mov.reconciled_amount),
          estado: texto(mov.status), origen: typeof mov.origin === "string" ? mov.origin : "", descripcion: typeof mov.description === "string" ? mov.description : "",
          ...(mov.accounting_amount !== undefined && mov.accounting_amount !== null
            ? { contabilidadCentimos: centimos(mov.accounting_amount), monedaContable: String(mov.accounting_currency ?? "EUR").toUpperCase().trim() }
            : {}) };
        e.movimientos.push(movimiento);
        // Incluye tickets ya conciliados aunque /purchases no los muestre.
        const proveedorBanco = proveedorEnDescripcion(r.proveedor, movimiento.descripcion) ||
          Boolean(e.contacto?.nombre && proveedorEnDescripcion(e.contacto.nombre, movimiento.descripcion));
        const importeComparable = movimiento.moneda === moneda
          ? movimiento.centimos
          : Boolean(r.equivalente) && moneda === "EUR" && movimiento.monedaContable === "EUR"
            ? movimiento.contabilidadCentimos
            : undefined;
        if (importeComparable !== undefined && movimientoEnVentanaAuto(movimiento.fecha, r.fecha) && importeComparable < 0 &&
          Math.abs(-importeComparable - importe) <= tolerancia &&
          (movimiento.fecha === r.fecha || proveedorBanco) &&
          (movimiento.estado !== "pending" || movimiento.conciliadoCentimos !== 0)) e.duplicados.push(`banco:${cuentaId}/${movimiento.id}`);
      }
    }
    const candidatasLibres = candidatosMovimientoAuto(r, e).filter(m => m.estado === "pending" && m.conciliadoCentimos === 0 &&
      Boolean(m.origen) && m.origen !== "manual");
    // La cuenta contable es opcional. No descargar el catálogo ni hasta 50 compras completas cuando
    // ya sabemos que el correo no puede automatizarse por proveedor, duplicado o movimiento bancario.
    if (!e.contacto?.id || e.duplicados.length || candidatasLibres.length !== 1) {
      e.consultasCompletas = true;
      return e;
    }
    if (this.flujoExistente) {
      const clasificacion = await this.flujoExistente.clasificar(r);
      if (clasificacion) e.cuenta = { id: clasificacion.cuentaId, nombre: clasificacion.nombreCuenta,
        tags: clasificacion.tags, evidencia: clasificacion.evidencia };
      e.consultasCompletas = true;
      return e;
    }
    const datosCatalogo = await this.getEstatico(empresa, "/expenses-accounts");
    if (!Array.isArray(datosCatalogo.items)) throw new Error("Catálogo contable incompleto.");
    const catalogo = datosCatalogo.items.map(objeto);
    const precedentes: Registro[] = [];
    const contactoId = e.contacto.id;
    const candidatosCuenta = comprasContacto.filter(p => p.contact_id === contactoId)
      .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 50);
    const completos = await mapearConConcurrencia(candidatosCuenta, 4, async p => {
      const completo = typeof p.draft === "boolean" ? p : await this.get(empresa, `/purchases/${idUrl(texto(p.id))}`);
      if (completo.id !== p.id || completo.contact_id !== contactoId) throw new Error("Precedente contable inconsistente.");
      return completo;
    });
    precedentes.push(...completos);
    const correccion = await this.memoria.cuentaConfirmada?.(empresa, r.proveedor);
    const evaluacion = evaluarCuentaContable({ proveedor: r.proveedor, concepto: r.concepto, contactId: contactoId,
      personaAsociada: r.persona, contextoDeViaje: r.viaje }, precedentes as unknown as CompraPrecedente[], catalogo as unknown as CuentaContableReal[], correccion);
    if (evaluacion.sugerencia) e.cuenta = { id: evaluacion.sugerencia.accountId, evidencia: evaluacion.motivo };
    e.consultasCompletas = true;
    return e;
  }
  private async compra(op: OperacionAuto): Promise<Registro> {
    if (!op.compraId) throw new Error("No hay ID de compra persistido.");
    return this.get(op.plan.empresa, `/purchases/${idUrl(op.compraId)}`);
  }
  private async post(empresa: EmpresaAuto, path: string, body: unknown, archivo = false): Promise<Response> {
    const keyName = `HOLDED_API_KEY_WRITE_${empresa.toUpperCase()}`;
    const key = process.env[keyName];
    if (!key) throw new Error(`Falta ${keyName}.`);
    const { protegerEscrituraHolded } = await import("./postgres");
    return protegerEscrituraHolded(empresa, async () => {
      const response = await this.request(`https://api.holded.com/api/v2${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, Accept: "application/json",
          ...(archivo ? {} : { "Content-Type": "application/json" }) },
        body: archivo ? body as FormData : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Holded respondió ${response.status}; resultado pendiente de verificar, no se repetirá el POST.`);
      return response;
    });
  }
  async crear(op: OperacionAuto): Promise<string> {
    if (this.flujoExistente) return this.flujoExistente.crear(op);
    const p = op.plan;
    const documento = monedaDocumentoAuto(p.recibo);
    let cambio = documento.tasaCambio;
    if (documento.moneda !== "EUR" && cambio === undefined) {
      const { obtenerTasaCambioHistorica } = await import("../../utils/exchangeRate");
      cambio = await obtenerTasaCambioHistorica(p.recibo.fecha, "EUR", documento.moneda);
      if (!cambio || !Number.isFinite(cambio)) throw new Error("Tipo de cambio contable no verificado.");
    }
    const response = await this.post(p.empresa, "/purchases", {
      contact_id: p.contactoId, date: p.recibo.fecha, number: p.recibo.numero || "00000",
      description: `${p.recibo.concepto} — recibo original ${p.recibo.monto} ${p.recibo.moneda}; convertir a ticket.`,
      notes: `WOBI_AUTO:${op.id}`, tags: [`wobi-auto-${op.id}`, "wobi-ticket-pendiente"],
      currency: documento.moneda, ...(cambio ? { currency_change: cambio } : {}), draft: true,
      items: [{ name: p.recibo.concepto, units: 1, price: documento.monto, taxes: [], ...(p.cuentaId ? { account: p.cuentaId } : {}) }],
    });
    return texto(objeto(await response.json()).id);
  }
  async recuperarCreacion(op: OperacionAuto): Promise<string | undefined> {
    if (op.compraId) {
      const conocida = await this.get(op.plan.empresa, `/purchases/${idUrl(op.compraId)}`);
      if (conocida.id !== op.compraId) throw new Error("Holded devolvió otra compra al recuperar la operación.");
      const identidadPorNota = conocida.notes === `WOBI_AUTO:${op.id}`;
      // Las primeras versiones guardaron compraId de forma durable en PostgreSQL
      // antes de añadir la nota privada a la compra. En una migración de política,
      // ese vínculo directo sigue siendo una identidad más fuerte que una búsqueda
      // por importe. El servicio ya releyó el recibo y validó proveedor compatible
      // antes de llegar aquí; se corrige exactamente ese id y jamás se crea otro.
      const identidadLegadaPorLedger = Boolean(this.flujoExistente) && op.plan.version !== VERSION_POLITICA;
      if (identidadPorNota || identidadLegadaPorLedger) {
        if (this.flujoExistente) {
          try { await this.flujoExistente.corregir(op, op.compraId); }
          catch (error) {
            // Holded ordena sus tags. La edición durable antigua podía quedar incierta aunque
            // cuenta, tags y demás campos sí hubieran quedado correctos. Una relectura completa
            // con la política actual demuestra el resultado sin repetir el PUT.
            if (!await this.verificarCreacion(op)) throw error;
          }
        }
        return op.compraId;
      }
      // Las operaciones de la política actual ya usan el ledger durable del flujo uno a uno.
      // Volver a invocarlo solo consulta ese ledger y recupera su marcador; no repite un POST incierto.
      if (this.flujoExistente && op.plan.version === VERSION_POLITICA) return this.flujoExistente.crear(op);
      throw new Error("La compra persistida no conserva la identidad privada de esta operación.");
    }
    const candidatas = await this.listar(op.plan.empresa, "/purchases", {
      contact_id: op.plan.contactoId, start_date: op.plan.recibo.fecha, end_date: op.plan.recibo.fecha,
    });
    // El listado resumido de Holded omite notes y normaliza tags. Releer cada candidato es
    // imprescindible para recuperar los borradores creados por la versión anterior.
    const completas = await mapearConConcurrencia(candidatas, 4, async candidata =>
      typeof candidata.notes === "string" ? candidata : this.get(op.plan.empresa, `/purchases/${idUrl(texto(candidata.id))}`));
    const legado = completas.filter(c => c.notes === `WOBI_AUTO:${op.id}`);
    if (legado.length > 1) throw new Error("Más de una compra con la identidad de operación; revisión manual.");
    if (legado.length === 1) {
      const id = texto(legado[0].id);
      op.compraId = id;
      if (this.flujoExistente) {
        try { await this.flujoExistente.corregir(op, id); }
        catch (error) { if (!await this.verificarCreacion(op)) throw error; }
      }
      return id;
    }
    // La ruta durable usada por el flujo manual sabe recuperar su propio POST incierto por lectura
    // y nunca lo repite a ciegas.
    return this.flujoExistente && op.plan.version === VERSION_POLITICA
      ? this.flujoExistente.crear(op)
      : undefined;
  }
  async verificarCreacion(op: OperacionAuto): Promise<boolean> {
    const c = await this.compra(op); const p = op.plan;
    const documento = monedaDocumentoAuto(p.recibo);
    const tagsEsperados = new Set((p.evidencia.cuenta?.tags ?? []).map(normalizarEtiquetaHolded).filter(Boolean));
    const tagsActuales = new Set(Array.isArray(c.tags)
      ? c.tags.filter((tag): tag is string => typeof tag === "string").map(normalizarEtiquetaHolded).filter(Boolean)
      : []);
    const coincidenciaExactaTags = tagsEsperados.size === tagsActuales.size &&
      [...tagsEsperados].every(tag => tagsActuales.has(tag));
    const clasificacionNuevaParcial = this.flujoExistente &&
      !tieneCategoriaGastoAprendida([...tagsEsperados]);
    const tagsCorrectos = clasificacionNuevaParcial
      ? [...tagsEsperados].every(tag => tagsActuales.has(tag)) &&
        tieneCategoriaGastoAprendida([...tagsActuales])
      : coincidenciaExactaTags;
    const tasaActual = Number(c.currency_change ?? (documento.moneda === "EUR" ? 1 : NaN));
    const tasaCorrecta = documento.tasaCambio === undefined ||
      (Number.isFinite(tasaActual) && (Math.abs(tasaActual - documento.tasaCambio) < 0.000001 ||
        // Holded devuelve algunas tasas con solo dos decimales aunque el POST
        // haya recibido más precisión. El redondeo debe coincidir; una tasa
        // vecina (1,14 frente a 1,154346) sigue siendo incorrecta.
        Math.round(tasaActual * 100) === Math.round(documento.tasaCambio * 100)));
    let impuestosCorrectos = true;
    if (this.flujoExistente) {
      const catalogoCrudo = await this.getEstatico(p.empresa, "/taxes");
      const catalogo = (Array.isArray(catalogoCrudo.items) ? catalogoCrudo.items : [])
        .map(objeto)
        .filter(item => item.scope === "purchases" && typeof item.key === "string")
        .map(item => ({ key: String(item.key), name: typeof item.name === "string" ? item.name : undefined,
          amount: item.amount == null || item.amount === "" ? null : Number(item.amount),
          type: typeof item.type === "string" ? item.type : undefined,
          visible: typeof item.visible === "boolean" ? item.visible : undefined,
          items: Array.isArray(item.items) ? item.items.filter((id): id is string => typeof id === "string") : undefined,
        } satisfies TaxCatalogEntry));
      const impuestoEsperado = mapearInversionSujetoPasivoATaxKey(catalogo);
      const impuestosActuales = Array.isArray(c.lines) && c.lines.length === 1 && Array.isArray(objeto(c.lines[0]).taxes)
        ? objeto(c.lines[0]).taxes as unknown[] : [];
      impuestosCorrectos = Boolean(impuestoEsperado) && impuestosActuales.length === 1 &&
        impuestosActuales[0] === impuestoEsperado;
    }
    const unaLinea = Array.isArray(c.lines) && c.lines.length === 1;
    const lineaUnica = unaLinea ? objeto((c.lines as unknown[])[0]) : undefined;
    const numeroEsperado = p.recibo.numero?.trim();
    // El flujo aprendido conserva el número que ya existe cuando una
    // relectura no logra extraerlo. En ese caso no hay un valor exacto con
    // el cual compararlo: se exige que Holded mantenga un número no vacío,
    // sin imponer el placeholder 00000 y sin degradar un dato anterior.
    const numeroDocumentoCorrecto = numeroEsperado
      ? String(c.document_number) === numeroEsperado
      : this.flujoExistente
        ? Boolean(String(c.document_number ?? "").trim())
        : String(c.document_number) === "00000";
    const comprobaciones = {
      identidad: c.id === op.compraId,
      contacto: c.contact_id === p.contactoId,
      moneda: String(c.currency || "EUR").toUpperCase().trim() === documento.moneda,
      fecha: String(c.date).slice(0, 10) === p.recibo.fecha,
      total: centimos(c.total, true) === Math.round(documento.monto * 100),
      unaLinea,
      cuenta: lineaUnica !== undefined && (!p.cuentaId || lineaUnica.account === p.cuentaId),
      tasaCambio: tasaCorrecta,
      impuestos: impuestosCorrectos && centimos(c.tax, true) === 0,
      numeroDocumento: numeroDocumentoCorrecto,
      tags: tagsCorrectos,
    };
    const base = Object.entries(comprobaciones).every(([nombre, ok]) => nombre === "tags" || ok);
    if (this.flujoExistente) {
      const verificada = base && comprobaciones.tags;
      if (!verificada) {
        console.warn("[correo-auto] Campos que impiden verificar la compra:", {
          compraId: op.compraId,
          ...comprobaciones,
        });
      }
      return verificada;
    }
    return base && Array.isArray(c.tags) && c.tags.includes(`wobi-auto-${op.id}`);
  }
  private nombreAdjunto(op: OperacionAuto): string { return `wobi-${op.id}-${op.plan.fuenteHash.slice(0, 16)}`; }
  async adjuntar(op: OperacionAuto, c: CorreoAuto): Promise<void> {
    if (!op.compraId || !await this.verificarCreacion(op)) throw new Error("Compra no verificada antes de adjuntar.");
    const a = c.adjuntos.find(x => x.id === op.plan.recibo.fuente);
    const data = op.plan.recibo.fuente === "cuerpo" ? Buffer.from(c.cuerpo, "utf8") : a?.data;
    if (!data || hash(data) !== op.plan.fuenteHash) throw new Error("El comprobante cambió; no se adjuntará otro archivo.");
    const extension = a ? (a.nombre.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1] ?? (a.mime === "application/pdf" ? "pdf" : "bin")) : "txt";
    if (this.flujoExistente) {
      await this.flujoExistente.adjuntar(op, data, a?.nombre ?? `${this.nombreAdjunto(op)}.${extension}`, a?.mime ?? "text/plain");
      return;
    }
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type: a?.mime ?? "text/plain" }), `${this.nombreAdjunto(op)}.${extension}`);
    await this.post(op.plan.empresa, `/purchases/${idUrl(op.compraId)}/attachments`, form, true);
  }
  async verificarAdjunto(op: OperacionAuto): Promise<boolean> {
    if (!op.compraId) return false;
    const adjuntos = await this.listarAdjuntos(op.plan.empresa, op.compraId);
    const candidatos = this.flujoExistente ? adjuntos : adjuntos.filter(a =>
      [a.id, a.name, a.filename, a.file_name].some(x => typeof x === "string" && x.startsWith(this.nombreAdjunto(op))));
    if (!candidatos.length) return false;
    // Holded puede repetir en el listado varias representaciones del mismo id.
    // Verificar ese id una vez impide interpretar la repetición como soportes
    // distintos y volver a cargar el mismo comprobante en cada reparación.
    const candidatosUnicos = [...new Map(candidatos.map((candidato, indice) => {
      const clave = [candidato.id, candidato.identifier, candidato.name, candidato.filename, candidato.file_name]
        .find((valor): valor is string => typeof valor === "string" && Boolean(valor.trim()))?.trim() ??
        `sin-referencia-${indice}`;
      return [clave, candidato] as const;
    })).values()];
    const coincidencias = await mapearConConcurrencia(candidatosUnicos, 3, async candidato => {
      const response = await this.request(`https://api.holded.com/api/v2/purchases/${idUrl(op.compraId!)}/attachments/${idUrl(texto(candidato.id))}`, {
        headers: { Authorization: `Bearer ${process.env[KEYS[op.plan.empresa]]}` }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("No se pudo verificar el contenido del comprobante en Holded.");
      return hash(Buffer.from(await response.arrayBuffer())) === op.plan.fuenteHash;
    });
    return coincidencias.some(Boolean);
  }
  private async movimientoActual(op: OperacionAuto): Promise<Registro> {
    const p = op.plan; const ref = p.movimiento;
    const cuenta = await this.get(p.empresa, `/treasury/accounts/${idUrl(ref.cuentaId)}`);
    if (cuenta.id !== ref.cuentaId || cuenta.currency !== ref.moneda || cuenta.archived === true) throw new Error("Cuenta bancaria modificada.");
    const todos = await this.listar(p.empresa, `/treasury/accounts/${idUrl(ref.cuentaId)}/bank-movements`);
    const m = todos.find(m => m.id === ref.id);
    if (!m || m.banking_account_id !== ref.cuentaId || m.currency !== ref.moneda ||
      String(m.booking_date).slice(0, 10) !== ref.fecha || centimos(m.amount) !== ref.centimos || !m.origin || m.origin === "manual") throw new Error("Movimiento bancario modificado o ausente.");
    return m;
  }
  async conciliar(op: OperacionAuto): Promise<void> {
    const p = op.plan;
    if (!await this.verificarCreacion(op) || !await this.verificarAdjunto(op)) throw new Error("Compra o comprobante no verificados.");
    if (this.flujoExistente) {
      try { await this.flujoExistente.conciliar(op); }
      finally { this.invalidarMovimientosCuenta(p.empresa, p.movimiento.cuentaId); }
      return;
    }
    const c = await this.compra(op); const m = await this.movimientoActual(op);
    if (centimos(c.payments_total, true) !== 0 || centimos(c.payments_pending, true) !== p.totalCentimos ||
      m.status !== "pending" || centimos(m.reconciled_amount) !== 0) throw new Error("La compra o el movimiento ya tienen pagos/conciliación.");
    try {
      await this.post(p.empresa, `/treasury/accounts/${idUrl(p.movimiento.cuentaId)}/bank-movements/${idUrl(p.movimiento.id)}/reconcile`, {
        documents: [{ document_id: op.compraId, document_type: "purchase" }],
      });
    } finally { this.invalidarMovimientosCuenta(p.empresa, p.movimiento.cuentaId); }
  }
  async verificarConciliacion(op: OperacionAuto): Promise<boolean> {
    if (this.flujoExistente) return this.flujoExistente.verificarConciliacion(op);
    const c = await this.compra(op); const m = await this.movimientoActual(op); const p = op.plan;
    if (!await this.verificarCreacion(op) || !["reconciled", "forced_reconciled"].includes(String(m.status)) ||
      Math.abs(centimos(m.reconciled_amount)) !== p.totalCentimos || centimos(c.payments_pending, true) !== 0 ||
      centimos(c.payments_total, true) !== p.totalCentimos || !Array.isArray(c.payments_detail) || c.payments_detail.length !== 1) return false;
    const pago = objeto(c.payments_detail[0]);
    return typeof pago.id === "string" && pago.bank_id === p.movimiento.cuentaId &&
      centimos(pago.amount, true) === p.totalCentimos && String(pago.date).slice(0, 10) === p.movimiento.fecha;
  }
}
