import { listTreasuryAccounts, type Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

/**
 * Saldos bancarios reales — Holded devuelve un campo `balance` ya calculado
 * por cuenta (confirmado en vivo contra la API real: coincide con lo que
 * muestra la app de Holded), así que no hace falta sumar movimientos a
 * mano. También expone `transactions_pending_to_reconcile`, el conteo
 * directo de Holded de movimientos sin conciliar por cuenta.
 */
export const saldosBancariosTool: ToolDefinition = {
  name: "consultar_saldos_bancarios",
  seguraParaModoRapido: true,
  description:
    "Consulta el saldo real y actualizado de cada cuenta bancaria/tarjeta en Holded para una empresa " +
    "del grupo (WOBA, EWORKS o Footprint) — cuánto hay HOY en cada banco, no un cálculo ni una " +
    "proyección. Úsala cuando pregunten '¿cuánto hay en el banco?', '¿qué saldo tiene la cuenta de...?' " +
    "o similar. Incluye cuántos movimientos de cada cuenta están pendientes de conciliar.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS", "Footprint"],
        description: "Empresa del grupo cuyas cuentas bancarias se consultan.",
      },
      incluirArchivadas: {
        type: "boolean",
        description: "Si se deben incluir cuentas archivadas/inactivas. Opcional, por defecto false.",
      },
    },
    required: ["empresa"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }
    const incluirArchivadas = input.incluirArchivadas === true;

    const cuentas = await listTreasuryAccounts(empresa);
    const visibles = incluirArchivadas ? cuentas : cuentas.filter((c) => !c.archived);

    if (visibles.length === 0) {
      return `No se encontraron cuentas bancarias para ${empresa}.`;
    }

    const lineas = visibles.map((c) => {
      const saldo = c.balance ?? "0.00";
      const moneda = c.currency ?? "EUR";
      const banco = c.institution_name ? ` (${c.institution_name})` : "";
      const pendientes = c.transactions_pending_to_reconcile ?? 0;
      const pendientesTxt = pendientes > 0 ? ` — ${pendientes} movimiento(s) sin conciliar` : "";
      const archivadaTxt = c.archived ? " [archivada]" : "";
      return `${c.name ?? "(sin nombre)"}${banco}: ${saldo} ${moneda}${pendientesTxt}${archivadaTxt}`;
    });

    const activas = visibles.filter((c) => !c.archived && c.currency === "EUR");
    const totalEUR = activas.reduce((acc, c) => acc + (Number(c.balance) || 0), 0);

    return [
      `Saldos bancarios de ${empresa}:`,
      ...lineas,
      "",
      `Total en cuentas activas en EUR: ${totalEUR.toFixed(2)} EUR (no incluye cuentas en otra moneda ni archivadas).`,
    ].join("\n");
  },
};
