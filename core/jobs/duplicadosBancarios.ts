import { listBankMovements, listTreasuryAccounts, type Empresa } from "../holded/client";
import { avisarDuplicadosBancarios, DIAS_AUDITADOS, type CuentaConMovimientos, type ResultadoAvisoDuplicados } from "../holded/duplicadosBancarios";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { lotesYaAvisados, marcarLotesAvisados } from "./duplicadosBancariosStore";

/** Job diario (laborables 10:05, tras cerrar la sincronización bancaria de las 9:45): ver core/holded/duplicadosBancarios.ts. Solo lectura. */
const MS_DIA = 86_400_000;
const EMPRESAS: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"];
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const numero = (v: unknown): number => {
  const t = String(v ?? "").trim();
  return t ? Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t) : Number.NaN;
};

/** Solo cuentas con banco enlazado: las manuales no reciben importaciones del agregador. Un fallo de lectura de una cuenta no tumba el resto ni se toma como «sin copias». */
async function cuentasConMovimientos(): Promise<CuentaConMovimientos[]> {
  const ahora = Date.now();
  const salida: CuentaConMovimientos[] = [];
  for (const empresa of EMPRESAS) {
    for (const cuenta of (await listTreasuryAccounts(empresa)).filter((c) => !c.archived && c.institution_name)) {
      try {
        const movimientos = (await listBankMovements(empresa, cuenta.id, iso(ahora - DIAS_AUDITADOS * MS_DIA), iso(ahora))).flatMap((m) => m.id
          ? [{ id: String(m.id), fecha: String(m.booking_date ?? ""), monto: numero(m.amount), descripcion: String(m.description ?? ""), saldo: numero(m.balance), estado: String(m.status ?? "") }]
          : []);
        salida.push({ empresa, cuentaId: cuenta.id, cuenta: cuenta.name ?? cuenta.id, movimientos });
      } catch (error) {
        console.error(`[duplicadosBancarios] No se pudo leer ${empresa} · ${cuenta.name ?? cuenta.id}:`, error instanceof Error ? error.name : "Error");
      }
    }
  }
  return salida;
}

export async function ejecutarAvisoDuplicadosBancarios(opciones: { simular?: boolean } = {}): Promise<ResultadoAvisoDuplicados> {
  const r = await avisarDuplicadosBancarios({
    cuentas: cuentasConMovimientos,
    yaAvisados: lotesYaAvisados,
    marcarAvisados: marcarLotesAvisados,
    avisar: async (texto) => {
      for (const a of await obtenerAdmins()) {
        try { await sendTelegramMessage(a.userId, texto); } catch (error) { console.error("[duplicadosBancarios] Error avisando a un admin:", error instanceof Error ? error.name : "Error"); }
      }
    },
    simular: opciones.simular,
  });
  console.log(`[duplicadosBancarios] ${r.simulado ? "SIMULACIÓN · " : ""}cuentas ${r.cuentasRevisadas}, lotes ${r.lotes.length}, nuevos ${r.nuevos.length}`);
  return r;
}
