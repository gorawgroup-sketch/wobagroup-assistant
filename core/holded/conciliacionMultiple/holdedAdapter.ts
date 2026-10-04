import { protegerEscrituraHolded } from "../../gmail/automatico/postgres";
import type { Empresa } from "../client";
import { centimos, validarReferencia, type CompraExacta, type MovimientoExacto, type PuertoHolded, type ReferenciaMovimiento, type ResultadoCierreResiduo } from "./model";

type Registro = Record<string, unknown>;
function objeto(raw: unknown): Registro {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Respuesta de Holded incompleta.");
  return raw as Registro;
}
function texto(raw: unknown, campo: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`Holded no devolvió ${campo}.`);
  return raw;
}
function fecha(raw: unknown): string {
  const dia = texto(raw, "fecha").slice(0, 10);
  validarReferencia({ accountId: "validacion", movementId: "validacion", fecha: dia });
  return dia;
}
const READ_KEYS: Record<Empresa, string> = { WOBA: "HOLDED_API_KEY_WOBA", EWORKS: "HOLDED_API_KEY_EWORKS", Footprint: "HOLDED_API_KEY_FOOTPRINT" };

/** Una sola petición por POST: jamás reintentar errores, timeouts, 429 o respuestas ilegibles. */
export class HoldedConciliacionAdapter implements PuertoHolded {
  constructor(private readonly request: typeof fetch = fetch) {}
  private async api(empresa: Empresa, path: string, body?: unknown): Promise<unknown> {
    const keyName = body === undefined ? READ_KEYS[empresa] : `HOLDED_API_KEY_WRITE_${empresa.toUpperCase()}`;
    const key = process.env[keyName];
    if (!key) throw new Error(`Falta ${keyName}.`);
    const response = await this.request(`https://api.holded.com/api/v2${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Holded respondió HTTP ${response.status}.`);
    // El POST puede devolver null, {} o cuerpo vacío; el servicio verifica por GET.
    return body === undefined ? response.json() : undefined;
  }
  async validarClasificacion(empresa: Empresa, compraId: string): Promise<void> {
    // Precondición equivalente a la del refactor local de Carlos (que no está en main): la compra debe tener contacto y UNA sola cuenta
    // contable, y esa cuenta no puede contradecir la que WOBI aprendió para ese proveedor (excluyendo esta misma compra del precedente).
    const { obtenerCompraHoldedPorId, inferirCuentaGasto } = await import("../write");
    const compra = await obtenerCompraHoldedPorId(empresa, compraId);
    const cuentas = new Set((compra.lines ?? []).map((l) => (l as { account?: string | null }).account ?? null));
    if (!compra.contact_id || cuentas.size !== 1 || cuentas.has(null)) throw new Error("La compra requiere revisar su clasificación contable antes de conciliar (líneas sin cuenta o con cuentas distintas).");
    const sugerida = await inferirCuentaGasto(empresa, {
      proveedor: String((compra as { contact_name?: string }).contact_name ?? ""),
      concepto: [compra.description, ...(compra.lines ?? []).map((l) => (l as { name?: string }).name)].filter(Boolean).join(" "),
      excluirCompraId: compraId,
    }).catch(() => undefined);
    const actual = [...cuentas][0];
    if (sugerida && actual && sugerida.accountId !== actual && (sugerida.evidencias ?? 0) >= 2) {
      throw new Error("La cuenta contable de la compra contradice la que WOBI aprendió para este proveedor; corrígela antes de conciliar.");
    }
  }
  async compra(empresa: Empresa, id: string): Promise<CompraExacta> {
    const c = objeto(await this.api(empresa, `/purchases/${encodeURIComponent(id)}`));
    if (c.id !== id || !Array.isArray(c.payments_detail) || !Array.isArray(c.lines) || c.lines.length === 0) throw new Error("No se pudo verificar la compra y su detalle de pagos.");
    // Las compras que crea WOBI nacen en borrador y se concilian sobre ese borrador (flujo normal de gastos); lo que sí se exige es conocer el estado.
    if (typeof c.draft !== "boolean") throw new Error("No se pudo leer si la compra es un borrador.");
    if (c.payments_refunds != null && centimos(c.payments_refunds, true) !== 0) throw new Error("Compra con devoluciones: requiere revisión específica.");
    return {
      cuentasContables: [...new Set(c.lines.map((raw) => texto(objeto(raw).account, "cuenta contable")))],
      id, proveedorId: texto(c.contact_id, "proveedor ID"), proveedor: texto(c.contact_name, "proveedor"),
      numero: typeof c.document_number === "string" ? c.document_number : "", fecha: fecha(c.date),
      moneda: texto(c.currency, "moneda").toUpperCase(), totalCentimos: centimos(c.total, true),
      pagadoCentimos: centimos(c.payments_total, true), pendienteCentimos: centimos(c.payments_pending, true),
      estado: texto(c.status, "estado de compra"), borrador: c.draft,
      pagos: c.payments_detail.map((raw) => {
        const p = objeto(raw);
        return { id: texto(p.id, "pago ID"), centimos: centimos(p.amount, true), accountId: texto(p.bank_id, "cuenta del pago"), fecha: fecha(p.date) };
      }),
    };
  }
  async movimiento(empresa: Empresa, ref: ReferenciaMovimiento): Promise<MovimientoExacto> {
    validarReferencia(ref);
    const cuenta = objeto(await this.api(empresa, `/treasury/accounts/${encodeURIComponent(ref.accountId)}`));
    if (cuenta.id !== ref.accountId || cuenta.archived === true) throw new Error("Cuenta bancaria inexistente o archivada.");
    // El filtro de Holded usa value_date, no booking_date: recorrer por cursor evita perder
    // pagos cuyo valor bancario y fecha de contabilización no coinciden.
    let cursor: string | undefined;
    const cursores = new Set<string>();
    for (let pagina = 0; pagina < 100; pagina++) {
      const params = new URLSearchParams({ limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const data = objeto(await this.api(empresa, `/treasury/accounts/${encodeURIComponent(ref.accountId)}/bank-movements?${params}`));
      if (!Array.isArray(data.items)) throw new Error("Listado bancario incompleto.");
      const matches = data.items.map(objeto).filter((m) => m.id === ref.movementId);
      if (matches.length > 1) throw new Error("ID de movimiento duplicado en Holded.");
      if (matches.length === 1) {
        const m = matches[0];
        if (m.banking_account_id !== ref.accountId || fecha(m.booking_date) !== ref.fecha) throw new Error("La cuenta o la fecha no coinciden con el movimiento identificado.");
        const moneda = texto(m.currency, "moneda bancaria").toUpperCase();
        if (moneda !== texto(cuenta.currency, "moneda de cuenta").toUpperCase()) throw new Error("Monedas bancarias inconsistentes.");
        return {
          ...ref, descripcion: typeof m.description === "string" ? m.description : "", cuenta: texto(cuenta.name, "nombre de cuenta"),
          moneda, centimos: centimos(m.amount), conciliadoCentimos: centimos(m.reconciled_amount), estado: texto(m.status, "estado bancario"),
          // accounting_amount: el equivalente en EUR que Holded usa para pagar la compra cuando la cuenta está en otra divisa.
          ...(m.accounting_amount != null && String(m.accounting_currency ?? "").toUpperCase() === "EUR"
            ? { contableCentimos: Math.abs(centimos(m.accounting_amount)) } : {}),
        };
      }
      if (data.has_more === false) throw new Error("El movimiento seleccionado no existe en la cuenta indicada.");
      if (data.has_more !== true || typeof data.cursor !== "string" || !data.cursor || cursores.has(data.cursor)) throw new Error("Paginación bancaria incompleta.");
      cursor = data.cursor;
      cursores.add(cursor);
    }
    throw new Error("No se pudo completar la búsqueda bancaria; no se conciliará nada.");
  }
  async cerrarResiduoCambio(empresa: Empresa, compraId: string, ancla: ReferenciaMovimiento): Promise<ResultadoCierreResiduo> {
    validarReferencia(ancla);
    const { cerrarResiduoCambioConciliacionMultiple } = await import("../write");
    return cerrarResiduoCambioConciliacionMultiple(empresa, compraId, ancla);
  }
  async conciliar(empresa: Empresa, ref: ReferenciaMovimiento, compraId: string): Promise<void> {
    validarReferencia(ref);
    await protegerEscrituraHolded(empresa, () => this.api(empresa, `/treasury/accounts/${encodeURIComponent(ref.accountId)}/bank-movements/${encodeURIComponent(ref.movementId)}/reconcile`, {
      documents: [{ document_id: compraId, document_type: "purchase" }],
    }), { path: `/treasury/accounts/${encodeURIComponent(ref.accountId)}/bank-movements/${encodeURIComponent(ref.movementId)}/reconcile` });
  }
}
