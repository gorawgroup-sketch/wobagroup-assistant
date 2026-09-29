import type { Empresa } from "../holded/client";
import {
  editarCompraHolded,
  leerEstadoMovimiento,
  margenImporteAproximado,
  movimientoLibreParaConciliar,
  obtenerCompraHoldedPorId,
} from "../holded/write";
import type { MovimientoBancarioCandidato } from "../holded/write";
import { compraTienePagos } from "../holded/recuperarConciliacionCompra";

/**
 * Comprobante en EUR pagado desde una cuenta bancaria en OTRA moneda.
 *
 * Caso real (Carlos, 2026-09-29, Station Gomerco, Footprint): ticket de 48,65 EUR pagado con la cuenta
 * «FTG USD». El cargo real es −55,32 USD y Holded le asigna un equivalente contable de −48,58 EUR. La
 * búsqueda lo encontró por ese equivalente y lo mostró como «−48,58 EUR»; el gasto se creó en EUR y, al
 * conciliar, la guardia lo rechazó con «el documento está en EUR y el movimiento pertenece a una cuenta
 * USD». El gasto quedó creado, sin conciliar y con el correo atascado.
 *
 * El sistema ya sabía conciliar entre monedas en el sentido contrario (comprobante en COP/MXN contra un
 * cargo en EUR, ver alinearTasaAlMovimiento.ts) y el flujo automático ya registra el documento en la
 * moneda del cargo (monedaRegistroPlanAuto). Faltaba este sentido en el flujo manual:
 * ajustarCompraAlMovimientoElegido sale sin hacer nada cuando la cuenta está en otra divisa.
 *
 * Regla: el gasto vale lo que salió del banco. Antes de conciliar, el documento se pasa a la moneda del
 * cargo, por el importe nativo del cargo y con la tasa implícita del propio cargo (nativo ÷ equivalente
 * contable en EUR). Así documento y movimiento están en la misma moneda y por el mismo importe: la
 * conciliación queda sin diferencia y sin pagos extra.
 *
 * Falla cerrado, igual que el ajuste de tasa: gasto con pagos, cargo ocupado o cambiado, o una diferencia
 * entre el comprobante y el equivalente contable mayor que el margen de las coincidencias aproximadas.
 */
function numero(valor: unknown): number {
  if (typeof valor === "number") return valor;
  if (valor == null || String(valor).trim() === "") return NaN;
  const texto = String(valor).trim();
  return Number(texto.includes(",") ? texto.replace(/\./g, "").replace(",", ".") : texto);
}
const centimos = (importe: number) => Math.round(importe * 100);

export type ResultadoAlineacionDocumento =
  | { estado: "no_aplica"; motivo: string }
  | { estado: "ya_alineado"; moneda: string; importe: number }
  | { estado: "alineado"; moneda: string; importe: number; tasa: number; importeComprobanteEur: number; equivalenteContableEur: number };

const depsDefault = {
  leerCompra: obtenerCompraHoldedPorId,
  leerMovimiento: leerEstadoMovimiento,
  editar: editarCompraHolded,
};

export async function alinearDocumentoAlCargoEnOtraMoneda(
  empresa: Empresa,
  gastoId: string,
  elegido: MovimientoBancarioCandidato,
  deps = depsDefault
): Promise<ResultadoAlineacionDocumento> {
  const [compra, movimiento] = await Promise.all([
    deps.leerCompra(empresa, gastoId),
    deps.leerMovimiento(empresa, elegido.accountId, elegido.movementId, elegido.fecha),
  ]);
  if (!movimiento) return { estado: "no_aplica", motivo: "no se pudo leer el cargo elegido" };

  const monedaDocumento = (compra.currency || "EUR").toUpperCase().trim();
  const monedaMovimiento = (movimiento.currency || "EUR").toUpperCase().trim();
  const nativo = numero(movimiento.amount);
  const cargoNativo = Math.abs(nativo);
  const total = numero(compra.total);

  if (monedaDocumento === monedaMovimiento) {
    // Un reintento tras haber alineado: documento y cargo ya coinciden en moneda e importe.
    return centimos(total) === centimos(cargoNativo) && monedaDocumento !== "EUR"
      ? { estado: "ya_alineado", moneda: monedaDocumento, importe: cargoNativo }
      : { estado: "no_aplica", motivo: "gasto y cargo están en la misma moneda" };
  }
  if (monedaDocumento !== "EUR") {
    return { estado: "no_aplica", motivo: `el gasto está en ${monedaDocumento}: lo resuelve el ajuste de tasa` };
  }

  if (!movimientoLibreParaConciliar(movimiento)) {
    throw new Error("El movimiento elegido ya no está libre; no se cambió la moneda del gasto.");
  }
  const contable = Math.abs(numero(movimiento.accounting_amount));
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(cargoNativo) || cargoNativo <= 0 || nativo >= 0 ||
      !Number.isFinite(contable) || contable <= 0) {
    throw new Error(`El cargo está en una cuenta en ${monedaMovimiento} y Holded no da su equivalente en EUR; no se cambió el gasto.`);
  }
  // El candidato se ofreció por su equivalente contable en EUR: si ya no coincide, el cargo cambió.
  if (elegido.moneda.toUpperCase() === "EUR" && Math.abs(contable - Math.abs(elegido.monto)) > 0.005) {
    throw new Error("El cargo cambió desde la selección; no se cambió la moneda del gasto.");
  }
  if (Math.abs(total - contable) > margenImporteAproximado(total)) {
    throw new Error(
      `El comprobante suma ${total.toFixed(2)} EUR y el cargo equivale a ${contable.toFixed(2)} EUR: la diferencia supera el margen; ` +
      "requiere revisión antes de conciliar."
    );
  }
  if (compraTienePagos(compra)) {
    throw new Error("El gasto ya tiene pagos; no se cambia su moneda automáticamente.");
  }

  const tasa = Number((cargoNativo / contable).toFixed(6));
  if (!Number.isFinite(tasa) || tasa <= 0) throw new Error("No se pudo calcular la tasa de cambio del cargo elegido.");

  const editada = await deps.editar(empresa, gastoId,
    { monedaNueva: monedaMovimiento, tasaCambioNueva: tasa, montoNuevo: cargoNativo },
    {
      idempotencyKey: `alinear-documento-cargo:${gastoId}:${elegido.movementId}:${monedaMovimiento}:${centimos(cargoNativo)}`,
      proceso: "alinear_documento_al_cargo_en_otra_moneda",
    });

  // Holded devuelve la tasa a dos decimales: se comprueba con ese margen, y que moneda e importe son los del cargo.
  const monedaLeida = (editada.currency || "").toUpperCase().trim();
  if (monedaLeida !== monedaMovimiento || centimos(numero(editada.total)) !== centimos(cargoNativo) ||
      Math.abs(numero(editada.currency_change) - tasa) > 0.0051) {
    throw new Error("Holded aceptó el cambio, pero la relectura no confirma moneda, importe y tasa; revisa el gasto antes de repetir.");
  }
  return { estado: "alineado", moneda: monedaMovimiento, importe: cargoNativo, tasa, importeComprobanteEur: total, equivalenteContableEur: contable };
}
