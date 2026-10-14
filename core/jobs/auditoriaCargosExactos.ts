import { estaConciliado, holdedGet, listBankMovements, listTreasuryAccounts, type Empresa } from "../holded/client";
import { auditarCargosExactos, type CargoLibre, type CompraAuditable, type DepsAuditoriaCargos, type ResultadoAuditoriaCargos } from "../holded/auditoriaCargosExactos";
import { buscarMovimientoSimilar, movimientoAgotadoSalvoRedondeo } from "../holded/write";
import { crearTrazaBusqueda } from "../holded/trazaBusqueda";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { idsComprasPropiasEntre } from "./cerrarInciertasAntiguas";
import { clavesYaAvisadas, marcarClavesAvisadas } from "./auditoriaCargosExactosStore";

/** Job diario (8:45): ver core/holded/auditoriaCargosExactos.ts. Solo lectura; un aviso por pareja nueva. */
const MS_DIA = 86_400_000;
const MAX_COMPRAS_A_LEER = 600;

const numero = (v: unknown): number => {
  const t = String(v ?? "").trim();
  return t ? Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t) : NaN;
};

interface CompraCruda { id?: string; date?: string; total?: string; currency?: string; contact_name?: string; description?: string; draft?: boolean; payments_pending?: string; status?: string }

async function comprasPendientes(empresa: Empresa): Promise<CompraAuditable[]> {
  const ahora = Date.now();
  const salida: CompraAuditable[] = [];
  const todas = await idsComprasPropiasEntre(empresa, ahora - 50 * MS_DIA, ahora);
  if (todas.length > MAX_COMPRAS_A_LEER) console.error(`[auditoriaCargosExactos] ${empresa}: ${todas.length} compras propias; solo se leen ${MAX_COMPRAS_A_LEER} (sube MAX_COMPRAS_A_LEER)`);
  for (const id of todas.slice(0, MAX_COMPRAS_A_LEER)) {
    try {
      const d = (await holdedGet(empresa, `/purchases/${id}`)) as CompraCruda;
      const pendiente = numero(d.payments_pending), total = numero(d.total);
      // Solo compras con importe por pagar: una pagada (por cualquier vía) ya no necesita cargo. Un dato ilegible no cuenta como pendiente.
      if (d.draft || !d.id || !Number.isFinite(pendiente) || !Number.isFinite(total) || pendiente <= 0.011 || !d.date) continue;
      salida.push({ empresa, id: d.id, fecha: d.date.slice(0, 10), total, moneda: String(d.currency ?? "EUR").toUpperCase(), proveedor: String(d.contact_name ?? ""), concepto: String(d.description ?? "") });
    } catch (error) {
      console.error(`[auditoriaCargosExactos] No se pudo leer la compra ${id}:`, error instanceof Error ? error.name : "Error");
    }
  }
  return salida;
}

async function cargosLibres(empresa: Empresa, desde: string, hasta: string): Promise<CargoLibre[]> {
  const salida: CargoLibre[] = [];
  for (const cuenta of (await listTreasuryAccounts(empresa)).filter((c) => !c.archived)) {
    for (const m of await listBankMovements(empresa, cuenta.id, desde, hasta)) {
      const monto = numero(m.amount);
      if (!m.id || !Number.isFinite(monto) || monto >= 0 || estaConciliado(m.status) || movimientoAgotadoSalvoRedondeo(m)) continue;
      salida.push({ movementId: String(m.id), cuentaId: cuenta.id, descripcion: m.description ?? "", monto, moneda: String(m.currency ?? "EUR").toUpperCase(), equivalenteEur: m.accounting_amount != null ? numero(m.accounting_amount) : null, fecha: String(m.booking_date ?? "").slice(0, 10) });
    }
  }
  return salida;
}

const depsReales: DepsAuditoriaCargos = {
  comprasPendientes: async (e) => { const r = await comprasPendientes(e); console.log(`[auditoriaCargosExactos] ${e}: ${r.length} compras propias con importe pendiente`); return r; },
  cargosLibres: async (e, d, h) => { const r = await cargosLibres(e, d, h); console.log(`[auditoriaCargosExactos] ${e}: ${r.length} cargos libres entre ${d} y ${h}`); return r; },
  buscar: async (c) => {
    const traza = crearTrazaBusqueda();
    await buscarMovimientoSimilar(c.empresa, { monto: c.total, fecha: c.fecha, moneda: c.moneda, proveedor: c.proveedor, concepto: c.concepto, incluirPorConfirmar: true, traza });
    return traza.mismoImporte;
  },
  yaAvisadas: clavesYaAvisadas,
  marcarAvisadas: marcarClavesAvisadas,
  avisar: async (texto) => { for (const a of await obtenerAdmins()) await sendTelegramMessage(a.userId, texto).catch((e) => console.error("[auditoriaCargosExactos] Error avisando a un admin:", e instanceof Error ? e.name : "Error")); },
};

export async function ejecutarAuditoriaCargosExactos(opciones: { simular?: boolean } = {}): Promise<ResultadoAuditoriaCargos> {
  const r = await auditarCargosExactos({ ...depsReales, simular: opciones.simular });
  console.log(`[auditoriaCargosExactos] ${r.simulado ? "SIMULACIÓN · " : ""}compras con pareja posible ${r.comprasRevisadas}, hallazgos ${r.hallazgos.length}, nuevos ${r.nuevos.length}, ambiguos ${r.ambiguos}`);
  return r;
}
