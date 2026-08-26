import { listTreasuryAccounts, listBankMovements, type Empresa } from "../holded/client";
import { formatDateLocal } from "../utils/dateFormat";
import type { ToolDefinition } from "./types";

const DIAS_POR_DEFECTO = 90;
const MAX_CUENTAS_A_REVISAR = 10;

export const movimientosSinConciliarTool: ToolDefinition = {
  name: "consultar_movimientos_sin_conciliar",
  description:
    "Consulta qué movimientos bancarios de Holded (WOBA, EWORKS o Footprint) NO están conciliados " +
    "todavía, en un rango de días hacia atrás. A diferencia de consultar_gastos_sin_comprobante (que " +
    "mira gastos ya registrados sin adjunto), esto mira el lado del banco: cargos/abonos que ni " +
    "siquiera tienen un gasto asociado en Holded todavía. Úsala cuando pregunten qué movimientos " +
    "bancarios faltan por conciliar. Solo consulta — nunca crea ni concilia nada.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa del grupo a consultar." },
      dias: {
        type: "number",
        description: `Cuántos días hacia atrás revisar. Opcional, por defecto ${DIAS_POR_DEFECTO}.`,
      },
    },
    required: ["empresa"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const dias = typeof input.dias === "number" && input.dias > 0 ? input.dias : DIAS_POR_DEFECTO;
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);
    const desdeStr = formatDateLocal(desde);
    const hastaStr = formatDateLocal(hasta);

    const cuentas = (await listTreasuryAccounts(empresa)).filter((c) => !c.archived).slice(0, MAX_CUENTAS_A_REVISAR);
    if (cuentas.length === 0) {
      return `No se encontraron cuentas bancarias activas en Holded para ${empresa}.`;
    }

    const sinConciliar: Array<{ cuenta: string; descripcion: string; monto: number; fecha: string }> = [];
    let total = 0;

    for (const cuenta of cuentas) {
      const movimientos = await listBankMovements(empresa, cuenta.id, desdeStr, hastaStr);
      for (const m of movimientos) {
        total++;
        if (m.status !== "reconciled") {
          sinConciliar.push({
            cuenta: cuenta.name ?? "(sin nombre)",
            descripcion: (m.description as string) ?? "(sin descripción)",
            monto: typeof m.amount === "number" ? m.amount : Number(m.amount ?? 0),
            fecha: m.booking_date ? String(m.booking_date).slice(0, 10) : "",
          });
        }
      }
    }

    if (sinConciliar.length === 0) {
      return `Revisé ${total} movimiento(s) bancario(s) de ${empresa} de los últimos ${dias} días — todos están conciliados.`;
    }

    const lineas = sinConciliar
      .sort((a, b) => b.fecha.localeCompare(a.fecha))
      .map((m) => `- [${m.cuenta}] ${m.descripcion} — ${m.monto.toFixed(2)} € (${m.fecha})`);

    return (
      `${sinConciliar.length} movimiento(s) bancario(s) de ${empresa} sin conciliar (de ${total} revisados, últimos ${dias} días):\n\n` +
      lineas.join("\n")
    );
  },
};
