import type { Empresa } from "./client";
import {
  enviarConciliacionMovimientoHolded,
  HoldedApiError,
  leerEstadoMovimiento,
  margenResiduoConversion,
  obtenerCompraHoldedPorId,
} from "./write";

/**
 * Compra pagada con un cargo MAYOR que su total porque el comercio devolvió después la diferencia.
 *
 * Caso real (Carlos, 2026-09-29, Rappi «Snacks oficina Medellín», Footprint): Rappi cobró 43,53 USD (38,23 EUR) al
 * hacer el pedido, quitó dos productos y devolvió 11,55 EUR. El comprobante final es de 93.854 COP. El gasto real es
 * lo que salió del banco en neto: 38,23 − 11,55 = 26,68 EUR. La propuesta ajusta antes la tasa del documento a ese
 * valor (edición durable normal) y, ya verificada, este módulo enlaza reembolso y cargo a la compra.
 *
 * Contrato: lee antes y después de cada envío; nunca repite un envío; se detiene en el primer resultado que no
 * puede confirmar. Si Holded rechaza enlazar el reembolso (4xx: no pasó nada), sigue con el cargo y lo dice.
 */
export interface MovimientoPlan { accountId: string; movementId: string; fecha: string }
export interface PlanCargoReembolso { cargo: MovimientoPlan; reembolso: MovimientoPlan }
export interface ResultadoCargoReembolso { completo: boolean; nota: string }

const numero = (valor: unknown): number => {
  if (typeof valor === "number") return valor;
  const texto = String(valor ?? "").trim();
  if (!texto) return NaN;
  return Number(texto.includes(",") ? texto.replace(/\./g, "").replace(",", ".") : texto);
};
const conciliado = (estado?: string) => estado === "reconciled" || estado === "forced_reconciled";

const depsDefault = {
  leerCompra: obtenerCompraHoldedPorId as (empresa: Empresa, id: string) => Promise<{ payments_pending?: unknown; total?: unknown }>,
  leerMovimiento: leerEstadoMovimiento as (
    empresa: Empresa, accountId: string, movementId: string, fecha: string
  ) => Promise<{ amount?: unknown; status?: string; reconciled_amount?: unknown } | undefined>,
  enviar: enviarConciliacionMovimientoHolded,
};

export async function conciliarCargoConReembolso(
  empresa: Empresa,
  purchaseId: string,
  plan: PlanCargoReembolso,
  deps: typeof depsDefault = depsDefault
): Promise<ResultadoCargoReembolso> {
  const leer = (m: MovimientoPlan) => deps.leerMovimiento(empresa, m.accountId, m.movementId, m.fecha);
  const [cargo, reembolso] = await Promise.all([leer(plan.cargo), leer(plan.reembolso)]);
  if (!cargo || !reembolso) return { completo: false, nota: "No pude leer el cargo o el reembolso en el banco; no enlacé nada." };
  if (!(numero(cargo.amount) < 0) || !(numero(reembolso.amount) > 0)) {
    return { completo: false, nota: "El cargo debe ser una salida y el reembolso una entrada; no enlacé nada." };
  }

  const notas: string[] = [];
  // 1) Reembolso.
  if (conciliado(reembolso.status)) {
    notas.push("El reembolso ya figuraba enlazado.");
  } else if (Math.abs(numero(reembolso.reconciled_amount) || 0) > 0.005) {
    return { completo: false, nota: "El reembolso ya está usado en parte por otro documento; no enlacé nada." };
  } else {
    try {
      await deps.enviar(empresa, plan.reembolso.accountId, plan.reembolso.movementId, purchaseId);
    } catch (error) {
      const rechazo = error instanceof HoldedApiError && error.status >= 400 && error.status < 500 &&
        ![408, 409, 425, 429].includes(error.status);
      if (!rechazo) {
        const despues = await leer(plan.reembolso).catch(() => undefined);
        if (!conciliado(despues?.status)) {
          return { completo: false, nota: "Holded no confirmó el enlace del reembolso. No repito el envío ni sigo con el cargo; " +
            `revísalo en Holded. ${error instanceof Error ? error.message : String(error)}` };
        }
      } else {
        notas.push("Holded no admite enlazar ese reembolso a la compra por esta vía (no cambió nada en el reembolso).");
      }
    }
    const despues = await leer(plan.reembolso);
    if (conciliado(despues?.status)) notas.push("Reembolso enlazado a la compra.");
    else if (!notas.some((n) => n.startsWith("Holded no admite"))) {
      return { completo: false, nota: "Envié el enlace del reembolso pero el banco no lo muestra conciliado. No sigo con el cargo; revísalo en Holded." };
    }
  }

  // 2) Resto del cargo, solo si la compra tiene saldo pendiente que cubrir.
  const compra = await deps.leerCompra(empresa, purchaseId);
  const pendiente = numero(compra.payments_pending);
  const margen = margenResiduoConversion(numero(compra.total));
  const cargoAhora = await leer(plan.cargo);
  if (conciliado(cargoAhora?.status)) {
    notas.push("El cargo ya figuraba enlazado por completo.");
  } else if (!(pendiente > margen)) {
    notas.push("La compra no tiene saldo pendiente, así que no enlacé más importe del cargo.");
  } else {
    try {
      await deps.enviar(empresa, plan.cargo.accountId, plan.cargo.movementId, purchaseId);
    } catch (error) {
      const despues = await leer(plan.cargo).catch(() => undefined);
      if (Math.abs(numero(despues?.reconciled_amount) || 0) <= Math.abs(numero(cargoAhora?.reconciled_amount) || 0) + 0.005) {
        return { completo: false, nota: `${notas.join(" ")} El enlace del resto del cargo no se aplicó: ` +
          `${error instanceof Error ? error.message : String(error)}` };
      }
    }
    notas.push("Resto del cargo enlazado a la compra.");
  }

  const [compraFinal, cargoFinal, reembolsoFinal] = await Promise.all([
    deps.leerCompra(empresa, purchaseId), leer(plan.cargo), leer(plan.reembolso),
  ]);
  const pendienteFinal = numero(compraFinal.payments_pending);
  const completo = Math.abs(pendienteFinal) <= margen && conciliado(cargoFinal?.status) && conciliado(reembolsoFinal?.status);
  notas.push(
    `Estado leído de Holded: compra con ${Number.isFinite(pendienteFinal) ? pendienteFinal.toFixed(2) : "?"} pendiente; ` +
    `cargo «${cargoFinal?.status ?? "?"}» (${String(cargoFinal?.reconciled_amount ?? "?")} enlazado); ` +
    `reembolso «${reembolsoFinal?.status ?? "?"}».`
  );
  return { completo, nota: notas.join(" ") };
}
