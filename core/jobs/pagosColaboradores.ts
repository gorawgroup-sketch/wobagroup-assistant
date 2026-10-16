import { holdedGet, listBankMovements, listTreasuryAccounts, type Empresa } from "../holded/client";
import { conMutex } from "../utils/asyncMutex";
import { numeroHolded } from "../gastos/parConciliacionElegida";
import { envioDePar, envioDeResto, proponerPagosColaboradores, type CargoAbierto, type CompraAbierta, type ResultadoPropuestaColaboradores } from "../holded/pagosColaboradores";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { executeTool } from "../tools/registry";
import { marcarPropuestas, propuestasRecientes } from "./pagosColaboradoresStore";

/**
 * Job diario (laborables 10:30, tras la sincronización bancaria y el aviso de copias): propone los pagos a colaboradores en divisa. Ver
 * core/holded/pagosColaboradores.ts. SOLO PROPONE: cada par sale como la pregunta «Conciliar con #1» de siempre (botón de superadmin).
 */
const EMPRESAS: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"];
const MS_DIA = 86_400_000;
const DIAS_GASTOS = 150;
const DIAS_CARGOS = 90;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

interface CompraListada { id?: string; contact_name?: string; document_number?: string; description?: string; date?: string; total?: unknown; payments_pending?: unknown; currency?: string; draft?: boolean }

/** Gastos aprobados con saldo pendiente, todas las páginas (el listado v2 pagina por cursor; un listado a medias no vale como «no hay»). */
async function comprasSinPagar(empresa: Empresa): Promise<CompraAbierta[]> {
  const ahora = Date.now();
  const salida: CompraAbierta[] = [];
  let cursor: string | undefined;
  for (let pagina = 0; pagina < 30; pagina++) {
    const r = await holdedGet<{ items?: CompraListada[]; has_more?: boolean; cursor?: string | null }>(empresa, "/purchases", {
      status: "pending", start_date: iso(ahora - DIAS_GASTOS * MS_DIA), end_date: iso(ahora), limit: "200", cursor,
    });
    for (const c of r.items ?? []) {
      const total = numeroHolded(c.total), pendiente = numeroHolded(c.payments_pending);
      if (!c.id || c.draft || !Number.isFinite(total) || !Number.isFinite(pendiente) || pendiente <= 0.011 || !FECHA.test(String(c.date ?? "").slice(0, 10))) continue;
      salida.push({ id: c.id, contacto: String(c.contact_name ?? ""), numero: String(c.document_number ?? ""), descripcion: String(c.description ?? ""), fecha: String(c.date ?? "").slice(0, 10), total, pendiente, moneda: String(c.currency ?? "EUR").toUpperCase() });
    }
    if (!r.has_more) return salida;
    // Un listado a medias no vale como «no hay»: sin cursor o con cursor repetido se aborta en vez de seguir con una lista parcial.
    if (!r.cursor || r.cursor === cursor) throw new Error("Holded devolvió un listado de gastos incompleto.");
    cursor = r.cursor;
  }
  throw new Error("Listado de gastos sin pagar incompleto.");
}

/** Transferencias pendientes o conciliadas en parte de las cuentas bancarias NO en euros (las de euros las cubre el buscador de cargos exactos). */
async function cargosAbiertos(empresa: Empresa): Promise<CargoAbierto[]> {
  const ahora = Date.now();
  const salida: CargoAbierto[] = [];
  for (const cuenta of (await listTreasuryAccounts(empresa)).filter((c) => !c.archived && String(c.currency ?? "").toUpperCase() !== "EUR")) {
    const movimientos = await listBankMovements(empresa, cuenta.id, iso(ahora - DIAS_CARGOS * MS_DIA), iso(ahora), "pending,partial");
    for (const m of movimientos) {
      const importe = numeroHolded(m.amount), moneda = String(m.currency ?? "").toUpperCase();
      if (!m.id || !Number.isFinite(importe) || importe >= 0 || !moneda || moneda === "EUR" || !FECHA.test(String(m.booking_date ?? "").slice(0, 10))) continue;
      const estado = m.status === "partial" ? "partial" : m.status === "pending" ? "pending" : undefined;
      if (!estado) continue;
      salida.push({ cuentaId: cuenta.id, cuenta: cuenta.name ?? cuenta.id, id: String(m.id), fecha: String(m.booking_date ?? "").slice(0, 10), importe, conciliado: numeroHolded(m.reconciled_amount) || 0, moneda, descripcion: String(m.description ?? ""), estado });
    }
  }
  return salida;
}

async function chatSuperadmin(): Promise<number | undefined> {
  return (await obtenerAdmins()).find((a) => a.rol === "superadmin")?.userId;
}

export async function ejecutarPropuestaPagosColaboradores(opciones: { simular?: boolean } = {}): Promise<ResultadoPropuestaColaboradores> {
  // Un solo ejecutor a la vez: el cron y la ruta manual no pueden proponer lo mismo en paralelo.
  return conMutex("pagosColaboradores", () => ejecutar(opciones));
}

async function ejecutar(opciones: { simular?: boolean }): Promise<ResultadoPropuestaColaboradores> {
  const chatId = await chatSuperadmin();
  if (!chatId && !opciones.simular) throw new Error("No hay un superadministrador al que mandar las propuestas.");
  const r = await proponerPagosColaboradores({
    empresas: EMPRESAS,
    leerCompras: comprasSinPagar,
    leerCargos: cargosAbiertos,
    yaPropuestas: () => propuestasRecientes(),
    marcarPropuestas,
    proponerPar: async (p) => envioDePar(await executeTool("conciliar_movimiento_bancario", {
      empresa: p.empresa, gasto_id: p.compra.id, cuenta_id: p.cargo.cuentaId, movimiento_id: p.cargo.id, fecha_movimiento: p.cargo.fecha, cargo_mayor: p.comision > 0.011,
    }, { chatId: chatId! })),
    proponerResto: async (x) => envioDeResto(await executeTool("proponer_cerrar_cargo_sin_soporte", {
      modo: "resto", empresa: x.empresa, motivo: "comisión y diferencia de cambio de la transferencia a colaborador", proveedor: x.proveedor,
      movimientos: [{ cuenta_id: x.cargo.cuentaId, movimiento_id: x.cargo.id, fecha: x.cargo.fecha }],
    }, { chatId: chatId! })),
    avisar: async (texto) => { await sendTelegramMessage(chatId!, texto); },
    ahora: Date.now,
    simular: opciones.simular,
  });
  console.log(`[pagosColaboradores] ${r.simulado ? "SIMULACIÓN · " : ""}pares ${r.pares.length}, restos ${r.restosPropuestos.length}+${r.restosAManoOCerrados.length}, dudosos ${r.dudosos.length}, enviados ${r.enviados.length}, fallos ${r.fallos.length}${r.empresasConError.length ? `, error en ${r.empresasConError.join("/")}` : ""}`);
  return r;
}
