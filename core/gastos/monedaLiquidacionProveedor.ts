import type { Empresa } from "../holded/client";
import type { MovimientoBancarioCandidato } from "../holded/write";

export interface PoliticaMonedaLiquidacion {
  moneda: string;
  motivo: string;
}

function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Reglas de liquidación confirmadas por el responsable financiero. No son
 * tipos de cambio ni inferencias del modelo: indican en qué moneda debe
 * registrarse el cargo real cuando la factura del proveedor usa otra.
 *
 * Anthropic factura sus créditos en USD, pero el cargo de las empresas del
 * grupo se liquida en EUR. El importe final nunca se calcula: se toma del
 * equivalente explícitamente informado o de un único movimiento bancario
 * EUR del mismo proveedor y fecha (ver seleccionarMovimientoLiquidacionSeguro).
 */
export function obtenerPoliticaMonedaLiquidacion(
  _empresa: Empresa,
  proveedor: string,
  monedaDocumento: string
): PoliticaMonedaLiquidacion | undefined {
  const tokens = normalizarTexto(proveedor).split(" ");
  if (monedaDocumento.toUpperCase().trim() === "USD" && tokens.includes("anthropic")) {
    return {
      moneda: "EUR",
      motivo: "Las facturas de Anthropic se liquidan siempre desde una cuenta EUR del grupo.",
    };
  }
  return undefined;
}

function fechaCalendario(fecha: string): string {
  return fecha.slice(0, 10);
}

/**
 * Un movimiento solo puede fijar automáticamente el importe contable si la
 * evidencia es inequívoca: moneda exigida por la política, mismo día,
 * proveedor reconocido y un único candidato. La tasa histórica solo sirve
 * para encontrar candidatos; el número que se registra es el cargo bancario
 * real, nunca el resultado calculado con esa tasa.
 */
export function seleccionarMovimientoLiquidacionSeguro(
  candidatos: MovimientoBancarioCandidato[],
  proveedor: string,
  fechaDocumento: string,
  monedaLiquidacion: string
): MovimientoBancarioCandidato | undefined {
  const proveedorNormalizado = normalizarTexto(proveedor);
  const fechaObjetivo = fechaCalendario(fechaDocumento);
  const monedaObjetivo = monedaLiquidacion.toUpperCase().trim();

  const exactos = candidatos.filter((candidato) => {
    const descripcion = normalizarTexto(candidato.descripcion ?? "");
    const coincideProveedor =
      candidato.coincideProveedor === true ||
      (proveedorNormalizado.length >= 3 &&
        (descripcion.includes(proveedorNormalizado) || proveedorNormalizado.includes(descripcion)));
    return (
      candidato.moneda.toUpperCase().trim() === monedaObjetivo &&
      fechaCalendario(candidato.fecha) === fechaObjetivo &&
      coincideProveedor &&
      Number.isFinite(candidato.monto) &&
      candidato.monto !== 0
    );
  });

  return exactos.length === 1 ? exactos[0] : undefined;
}
