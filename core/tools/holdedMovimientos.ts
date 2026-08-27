import { listBankMovements, listTreasuryAccounts, type Empresa } from "../holded/client";
import { formatDateLocal } from "../utils/dateFormat";
import type { ToolDefinition } from "./types";

const DIAS_POR_DEFECTO = 30;

function esIngreso(amount: number): boolean {
  return amount > 0;
}

/**
 * Lee movimientos bancarios (no facturas) desde la API de Holded, solo lectura
 * (GET). Usa la API key de la empresa solicitada — WOBA y EWORKS nunca se
 * mezclan, cada una tiene su propia key y sus propias cuentas.
 */
export const holdedMovimientosTool: ToolDefinition = {
  name: "consultar_movimientos_holded",
  seguraParaModoRapido: true,
  description:
    "Consulta los movimientos bancarios (no facturas) registrados en Holded para una empresa del " +
    "grupo (WOBA, EWORKS o Footprint), en un rango de fechas. Úsala cuando el usuario pregunte por " +
    "cargos, abonos, ingresos o gastos reales según el banco, a diferencia del cashflow proyectado en " +
    "Sheets. Footprint no tiene cashflow en Sheets todavía — solo esta consulta directa a Holded. " +
    "Para saber CUÁNDO se cobra normalmente algo, con qué tarjeta, o cómo descargar la factura, usa " +
    "primero consultar_base_conocimiento (ahí vive esa información capturada por el equipo) — esta " +
    "herramienta sirve para confirmar cargos que ya ocurrieron, no para el calendario de pagos.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint"],
        description: "Empresa del grupo cuya cuenta de Holded se consulta.",
      },
      desde: {
        type: "string",
        description: "Fecha inicial del rango, formato 'YYYY-MM-DD'. Opcional, por defecto hace 30 días.",
      },
      hasta: {
        type: "string",
        description: "Fecha final del rango, formato 'YYYY-MM-DD'. Opcional, por defecto hoy.",
      },
      tipo: {
        type: "string",
        enum: ["ingreso", "gasto", "todos"],
        description: "Filtra por tipo de movimiento. Opcional, por defecto 'todos'.",
      },
    },
    required: ["empresa"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const hoy = new Date();
    const hace30Dias = new Date(hoy.getTime() - DIAS_POR_DEFECTO * 24 * 60 * 60 * 1000);

    const desde = typeof input.desde === "string" && input.desde ? input.desde : formatDateLocal(hace30Dias);
    const hasta = typeof input.hasta === "string" && input.hasta ? input.hasta : formatDateLocal(hoy);
    const tipo = (typeof input.tipo === "string" ? input.tipo : "todos") as "ingreso" | "gasto" | "todos";

    const cuentas = (await listTreasuryAccounts(empresa)).filter((cuenta) => !cuenta.archived);
    if (cuentas.length === 0) {
      return `No se encontraron cuentas bancarias activas en Holded para ${empresa}.`;
    }

    const movimientos = (
      await Promise.all(cuentas.map((cuenta) => listBankMovements(empresa, cuenta.id, desde, hasta)))
    ).flat();

    const filtrados = movimientos.filter((m) => {
      const amount = typeof m.amount === "number" ? m.amount : Number(m.amount ?? 0);
      if (tipo === "ingreso") return esIngreso(amount);
      if (tipo === "gasto") return !esIngreso(amount);
      return true;
    });

    if (filtrados.length === 0) {
      return `No se encontraron movimientos bancarios para ${empresa} entre ${desde} y ${hasta}.`;
    }

    return filtrados
      .map((m) => {
        const amount = typeof m.amount === "number" ? m.amount : Number(m.amount ?? 0);
        const tipoMov = esIngreso(amount) ? "abono" : "cargo";
        const fecha = m.booking_date ? m.booking_date.slice(0, 10) : "(sin fecha)";
        const desc = m.description ?? "(sin descripción)";
        return `${fecha} — ${desc} — ${amount} — ${tipoMov}`;
      })
      .join("\n");
  },
};
