import { evaluarCuentaContable, type CompraPrecedente, type CuentaContableReal } from "../../holded/cuentaContableContexto";
import { normalizarEtiquetaHolded } from "../../holded/write";
import { candidatosMovimientoAuto, diferenciaDiasCalendario, fechaValida, hash, nombresProveedorCompatibles, nombresProveedorEquivalentes,
  normalizar, normalizarProveedorComparable, proveedorEnDescripcion, similitudProveedor, toleranciaMontoAuto, VENTANA_DIAS_MOVIMIENTO_AUTO,
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
  clasificar(recibo: ReciboAuto): Promise<{ cuentaId: string; nombreCuenta: string; tags: string[]; evidencia: string } | undefined>;
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
        exacto: metodo !== "aproximado_unico", metodo, similitud: similitudProveedor(seleccionados[0].name, r.proveedor) };
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
    const desdeBanco = new Date(fecha); desdeBanco.setUTCDate(desdeBanco.getUTCDate() - VENTANA_DIAS_MOVIMIENTO_AUTO);
    const hastaBanco = new Date(fecha); hastaBanco.setUTCDate(hastaBanco.getUTCDate() + VENTANA_DIAS_MOVIMIENTO_AUTO);
    const movimientosPorCuenta = await mapearConConcurrencia(cuentas.filter(cuenta => cuenta.archived !== true), 4, async cuenta => {
      const cuentaId = texto(cuenta.id);
      const movimientos = await this.listar(empresa, `/treasury/accounts/${idUrl(cuentaId)}/bank-movements`, {
        start_date: formato(desdeBanco), end_date: formato(hastaBanco),
      });
      return { cuenta, cuentaId, movimientos };
    });
    for (const { cuenta, cuentaId, movimientos } of movimientosPorCuenta) {
      for (const mov of movimientos) {
        if (mov.banking_account_id !== cuentaId || mov.currency !== cuenta.currency) throw new Error("Identidad bancaria inconsistente.");
        const movimiento: MovimientoAuto = { id: texto(mov.id), cuentaId, fecha: texto(mov.booking_date).slice(0, 10),
          moneda: texto(mov.currency), centimos: centimos(mov.amount), conciliadoCentimos: centimos(mov.reconciled_amount),
          estado: texto(mov.status), origen: typeof mov.origin === "string" ? mov.origin : "", descripcion: typeof mov.description === "string" ? mov.description : "" };
        e.movimientos.push(movimiento);
        // Incluye tickets ya conciliados aunque /purchases no los muestre.
        const proveedorBanco = proveedorEnDescripcion(r.proveedor, movimiento.descripcion) ||
          Boolean(e.contacto?.nombre && proveedorEnDescripcion(e.contacto.nombre, movimiento.descripcion));
        if (movimiento.moneda === moneda && diferenciaDiasCalendario(movimiento.fecha, r.fecha) <= VENTANA_DIAS_MOVIMIENTO_AUTO && movimiento.centimos < 0 &&
          Math.abs(-movimiento.centimos - importe) <= tolerancia &&
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
    let cambio: number | undefined;
    if (p.movimiento.moneda !== "EUR") {
      const { obtenerTasaCambioHistorica } = await import("../../utils/exchangeRate");
      cambio = await obtenerTasaCambioHistorica(p.recibo.fecha, "EUR", p.movimiento.moneda);
      if (!cambio || !Number.isFinite(cambio)) throw new Error("Tipo de cambio contable no verificado.");
    }
    const response = await this.post(p.empresa, "/purchases", {
      contact_id: p.contactoId, date: p.recibo.fecha, number: p.recibo.numero || "00000",
      description: `${p.recibo.concepto} — recibo original ${p.recibo.monto} ${p.recibo.moneda}; convertir a ticket.`,
      notes: `WOBI_AUTO:${op.id}`, tags: [`wobi-auto-${op.id}`, "wobi-ticket-pendiente"],
      currency: p.movimiento.moneda, ...(cambio ? { currency_change: cambio } : {}), draft: true,
      items: [{ name: p.recibo.concepto, units: 1, price: p.totalCentimos / 100, taxes: [], ...(p.cuentaId ? { account: p.cuentaId } : {}) }],
    });
    return texto(objeto(await response.json()).id);
  }
  async recuperarCreacion(op: OperacionAuto): Promise<string | undefined> {
    if (op.compraId) {
      const conocida = await this.get(op.plan.empresa, `/purchases/${idUrl(op.compraId)}`);
      if (conocida.id !== op.compraId) throw new Error("Holded devolvió otra compra al recuperar la operación.");
      if (conocida.notes === `WOBI_AUTO:${op.id}`) {
        if (this.flujoExistente) await this.flujoExistente.corregir(op, op.compraId);
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
      if (this.flujoExistente) await this.flujoExistente.corregir(op, id);
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
    const tagsEsperados = new Set((p.evidencia.cuenta?.tags ?? []).map(normalizarEtiquetaHolded).filter(Boolean));
    const tagsActuales = new Set(Array.isArray(c.tags)
      ? c.tags.filter((tag): tag is string => typeof tag === "string").map(normalizarEtiquetaHolded).filter(Boolean)
      : []);
    const tagsCorrectos = tagsEsperados.size === tagsActuales.size &&
      [...tagsEsperados].every(tag => tagsActuales.has(tag));
    const base = c.id === op.compraId && c.contact_id === p.contactoId && (c.currency || "EUR") === p.movimiento.moneda &&
      String(c.date).slice(0, 10) === p.recibo.fecha && centimos(c.total, true) === p.totalCentimos &&
      Array.isArray(c.lines) && c.lines.length === 1 && (!p.cuentaId || objeto(c.lines[0]).account === p.cuentaId) &&
      centimos(c.tax, true) === 0 && String(c.document_number) === (p.recibo.numero || "00000");
    if (this.flujoExistente) return base && tagsCorrectos;
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
    const adjuntos = await this.listar(op.plan.empresa, `/purchases/${idUrl(op.compraId)}/attachments`);
    const candidatos = this.flujoExistente ? adjuntos : adjuntos.filter(a =>
      [a.id, a.name, a.filename, a.file_name].some(x => typeof x === "string" && x.startsWith(this.nombreAdjunto(op))));
    if (!candidatos.length) return false;
    const coincidencias = await mapearConConcurrencia(candidatos, 3, async candidato => {
      const response = await this.request(`https://api.holded.com/api/v2/purchases/${idUrl(op.compraId!)}/attachments/${idUrl(texto(candidato.id))}`, {
        headers: { Authorization: `Bearer ${process.env[KEYS[op.plan.empresa]]}` }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("No se pudo verificar el contenido del comprobante en Holded.");
      return hash(Buffer.from(await response.arrayBuffer())) === op.plan.fuenteHash;
    });
    return coincidencias.filter(Boolean).length === 1;
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
      await this.flujoExistente.conciliar(op);
      return;
    }
    const c = await this.compra(op); const m = await this.movimientoActual(op);
    if (centimos(c.payments_total, true) !== 0 || centimos(c.payments_pending, true) !== p.totalCentimos ||
      m.status !== "pending" || centimos(m.reconciled_amount) !== 0) throw new Error("La compra o el movimiento ya tienen pagos/conciliación.");
    await this.post(p.empresa, `/treasury/accounts/${idUrl(p.movimiento.cuentaId)}/bank-movements/${idUrl(p.movimiento.id)}/reconcile`, {
      documents: [{ document_id: op.compraId, document_type: "purchase" }],
    });
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
