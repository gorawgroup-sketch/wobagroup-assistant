import { listTreasuryAccountsConMeta, obtenerSaldoHistoricoCuenta, type Empresa } from "../holded/client";
import { notaFrescura } from "../utils/readCache";
import type { ToolDefinition } from "./types";

/**
 * Saldos bancarios reales — Holded devuelve un campo `balance` ya calculado
 * por cuenta (confirmado en vivo contra la API real: coincide con lo que
 * muestra la app de Holded), así que no hace falta sumar movimientos a
 * mano. También expone `transactions_pending_to_reconcile`, el conteo
 * directo de Holded de movimientos sin conciliar por cuenta.
 *
 * Pedido explícito de Carlos (2026-09-17): también acepta `fecha` para reconstruir el saldo a una
 * fecha PASADA — ver obtenerSaldoHistoricoCuenta (core/holded/client.ts) para el mecanismo real
 * (último movimiento bancario en o antes de esa fecha, cuyo campo `balance` ya es el saldo de la
 * cuenta en ese momento). Antes de esto la herramienta solo podía dar el saldo de HOY y no había
 * ninguna forma de responder "¿cuánto había el domingo pasado?" sin revisar Holded a mano.
 */
export const saldosBancariosTool: ToolDefinition = {
  name: "consultar_saldos_bancarios",
  seguraParaModoRapido: true,
  lecturaAcotable: true,
  lecturaParalela: "holded",
  description:
    "Consulta el saldo real de cada cuenta bancaria/tarjeta en Holded para una empresa del grupo " +
    "(WOBA, EWORKS o Footprint) — cuánto hay HOY en cada banco, no un cálculo ni una proyección. " +
    "Úsala cuando pregunten '¿cuánto hay en el banco?', '¿qué saldo tiene la cuenta de...?' o similar. " +
    "Incluye cuántos movimientos de cada cuenta están pendientes de conciliar. Si además dan una " +
    "fecha PASADA ('¿cuánto había el domingo pasado?', '¿cuál era el saldo al cierre de agosto?'), " +
    "pásala en `fecha` (YYYY-MM-DD) para reconstruir el saldo real de ese día — nunca inventes ni " +
    "calcules ese número tú mismo restando a mano, esta herramienta ya lo hace con datos reales de Holded.",
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
      fecha: {
        type: "string",
        description:
          "Fecha PASADA (YYYY-MM-DD) para reconstruir el saldo real de ese día en vez del saldo de hoy. Opcional — si se omite, da el saldo actual.",
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
    const fecha = typeof input.fecha === "string" ? input.fecha.trim() : undefined;
    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return "Error: 'fecha' debe tener el formato YYYY-MM-DD.";
    }

    const lectura = await listTreasuryAccountsConMeta(empresa);
    const cuentas = lectura.datos;
    const responder = (texto: string) => `${texto}\n${notaFrescura(lectura.meta)}`;
    const visibles = incluirArchivadas ? cuentas : cuentas.filter((c) => !c.archived);

    if (visibles.length === 0) {
      return responder(`No se encontraron cuentas bancarias para ${empresa}.`);
    }

    if (!fecha) {
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

      return responder([
        `Saldos bancarios de ${empresa}:`,
        ...lineas,
        "",
        `Total en cuentas activas en EUR: ${totalEUR.toFixed(2)} EUR (no incluye cuentas en otra moneda ni archivadas).`,
      ].join("\n"));
    }

    // Secuencial (no Promise.all): pocas cuentas por empresa (hasta ~16), y evita disparar ráfagas
    // de llamadas concurrentes contra la API de Holded para algo que se pregunta ocasionalmente.
    const lineas: string[] = [];
    let totalEUR = 0;
    let totalCuentasEUR = 0;
    for (const c of visibles) {
      const moneda = c.currency ?? "EUR";
      const banco = c.institution_name ? ` (${c.institution_name})` : "";
      const archivadaTxt = c.archived ? " [archivada]" : "";
      try {
        const historico = await obtenerSaldoHistoricoCuenta(empresa, c.id, fecha);
        if (!historico) {
          lineas.push(`${c.name ?? "(sin nombre)"}${banco}: sin movimientos encontrados hasta ${fecha} (no se puede reconstruir)${archivadaTxt}`);
          continue;
        }
        const notaFecha = historico.fechaMovimiento === fecha ? "" : ` (último movimiento real: ${historico.fechaMovimiento})`;
        lineas.push(`${c.name ?? "(sin nombre)"}${banco}: ${historico.balance.toFixed(2)} ${moneda}${notaFecha}${archivadaTxt}`);
        if (!c.archived && moneda === "EUR") {
          totalEUR += historico.balance;
          totalCuentasEUR++;
        }
      } catch (error) {
        console.error(`[saldosBancariosTool] Error reconstruyendo el saldo histórico de la cuenta ${c.id} (${c.name}):`, error);
        lineas.push(`${c.name ?? "(sin nombre)"}${banco}: error al consultar el histórico${archivadaTxt}`);
      }
    }

    return responder([
      `Saldo histórico de ${empresa} al cierre de ${fecha} (reconstruido a partir de movimientos bancarios reales, no una proyección):`,
      ...lineas,
      "",
      totalCuentasEUR > 0
        ? `Total en cuentas activas en EUR: ${totalEUR.toFixed(2)} EUR (no incluye cuentas en otra moneda ni archivadas).`
        : "No se pudo calcular un total en EUR — ver el detalle de cada cuenta arriba.",
    ].join("\n"));
  },
};
