import type { RegistroConciliacionMovimiento } from "./durableBankReconciliation";
import { compraTienePagos } from "./recuperarConciliacionCompra";
import { leerEstadoMovimiento, movimientoLibreParaConciliar, obtenerCompraHoldedPorId } from "./write";
import type { CompraHoldedCruda } from "./write";

/**
 * Tiempo mínimo desde que el registro quedó «incierta»: un efecto tardío de Holded (POST aceptado que aún no se
 * refleja al releer) debe haber tenido tiempo de aparecer antes de dar por demostrado que no hubo efecto.
 */
export const EDAD_MINIMA_INCIERTA_MS = 5 * 60_000;

export type VerificacionAusenciaEfecto = { ok: true; motivo: string } | { ok: false; motivo: string };

interface DependenciasLectura {
  leerCompra: (empresa: RegistroConciliacionMovimiento["empresa"], id: string) => Promise<CompraHoldedCruda>;
  leerMovimiento: typeof leerEstadoMovimiento;
}

const dependenciasReales: DependenciasLectura = {
  leerCompra: obtenerCompraHoldedPorId,
  leerMovimiento: leerEstadoMovimiento,
};

/**
 * Demuestra POR LECTURA que una conciliación «incierta» no tuvo ningún efecto en Holded: la compra no tiene pagos ni
 * estado de pagos dudoso y el movimiento sigue pendiente sin importe conciliado. Solo entonces es seguro volver a
 * «preparada» (ver StoreConciliacionesMovimiento.revertirIncierta) y permitir un único reintento protegido por el
 * registro durable. Nunca escribe. Cualquier duda o fallo de lectura devuelve `ok: false`.
 */
export async function verificarAusenciaDeEfectoPorLectura(
  registro: RegistroConciliacionMovimiento,
  ahora: number = Date.now(),
  deps: DependenciasLectura = dependenciasReales
): Promise<VerificacionAusenciaEfecto> {
  if (registro.estado !== "incierta") {
    return { ok: false, motivo: `El registro está en «${registro.estado}», no en «incierta».` };
  }
  const edad = ahora - registro.actualizadoEn;
  if (!Number.isFinite(edad) || edad < EDAD_MINIMA_INCIERTA_MS) {
    return { ok: false, motivo: "El registro quedó incierto hace menos de 5 minutos; espera a que un efecto tardío de Holded pueda aparecer." };
  }
  try {
    const [compra, movimiento] = await Promise.all([
      deps.leerCompra(registro.empresa, registro.documentId),
      deps.leerMovimiento(registro.empresa, registro.accountId, registro.movementId, registro.fechaAproximada),
    ]);
    if (compraTienePagos(compra)) {
      return { ok: false, motivo: "La compra tiene pagos o un estado de pagos no verificable: puede haber un efecto." };
    }
    if (!movimiento) return { ok: false, motivo: "El movimiento no aparece en Holded." };
    if (!movimientoLibreParaConciliar(movimiento)) {
      return { ok: false, motivo: `El movimiento no está libre (estado ${movimiento.status ?? "?"}, conciliado ${movimiento.reconciled_amount ?? "?"}).` };
    }
    return {
      ok: true,
      motivo:
        `verificado por lectura: compra sin pagos (pagado ${compra.payments_total ?? "?"}) y cargo pendiente sin importe conciliado; ` +
        "el POST anterior no tuvo efecto",
    };
  } catch (error) {
    return { ok: false, motivo: `No se pudo leer Holded: ${error instanceof Error ? error.message : String(error)}` };
  }
}
