import type { Empresa } from "../holded/client";
import type { MovimientoBancarioCandidato } from "../holded/write";
import { movimientoEnVentanaAuto } from "../gmail/automatico/model";

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

/**
 * Un movimiento solo puede fijar automáticamente el importe contable si la
 * evidencia es inequívoca: moneda exigida por la política, fecha real del
 * cargo dentro de la misma ventana ya establecida para "el documento puede
 * llegar después del cargo real" (`movimientoEnVentanaAuto`, ver su
 * comentario en gmail/automatico/model.ts — hasta 90 días hacia atrás, 5
 * hacia adelante), proveedor reconocido y un único candidato. La tasa
 * histórica solo sirve para encontrar candidatos; el número que se registra
 * es el cargo bancario real, nunca el resultado calculado con esa tasa.
 *
 * Hallazgo real de auditoría (Carlos, caso real WOBA, Anthropic, factura de 24,20 USD fechada
 * 2026-09-28, 2026-09-29): el único cargo bancario real y sin ambigüedad ("Anthropic", −21,23 EUR,
 * coincide en proveedor e importe dentro de tolerancia) estaba fechado 2026-09-25 — tres días antes
 * que la propia factura. Verificado en vivo contra el banco real de WOBA (cuenta "Main" EUR): desde
 * que Anthropic empezó a facturar créditos de API de uso frecuente (no solo la suscripción mensual
 * "Claude Sub"), los cargos reales llegan cada 1-5 días y la factura/comprobante del proveedor se
 * emite con demora respecto al cargo real — nunca el mismo día. Antes, con una sola factura mensual y
 * su único cargo del mismo día, exigir "mismo día calendario" nunca fallaba; con facturación frecuente
 * por uso, ese supuesto ya no es cierto y el gasto se quedaba indefinidamente en "pendiente de
 * comprobación bancaria" aunque el cargo real ya existiera y fuera inequívoco. Hallazgo de la revisión
 * adversarial: el mismo archivo del flujo automático (gmail/automatico/holded.ts) ya tenía esta EXACTA
 * ventana resuelta y probada para el mismo fenómeno ("viajes y reservas pueden emitir el recibo
 * después del cargo") — se reutiliza esa, en vez de inventar una ventana nueva y quedar inconsistente
 * con el resto del sistema. La seguridad real de esta función no depende de la ventana exacta —
 * depende de que quede EXACTAMENTE UN candidato tras filtrar por moneda, proveedor e importe
 * (`exactos.length === 1`, sin cambios); ampliar la ventana de fecha nunca hace que se elija mal entre
 * dos candidatos reales, solo deja de rechazar por fecha al único candidato real cuando la ventana lo
 * cubre.
 */
export function seleccionarMovimientoLiquidacionSeguro(
  candidatos: MovimientoBancarioCandidato[],
  proveedor: string,
  fechaDocumento: string,
  monedaLiquidacion: string
): MovimientoBancarioCandidato | undefined {
  const proveedorNormalizado = normalizarTexto(proveedor);
  const monedaObjetivo = monedaLiquidacion.toUpperCase().trim();

  const exactos = candidatos.filter((candidato) => {
    const descripcion = normalizarTexto(candidato.descripcion ?? "");
    const coincideProveedor =
      candidato.coincideProveedor === true ||
      (proveedorNormalizado.length >= 3 &&
        (descripcion.includes(proveedorNormalizado) || proveedorNormalizado.includes(descripcion)));
    return (
      candidato.moneda.toUpperCase().trim() === monedaObjetivo &&
      movimientoEnVentanaAuto(candidato.fecha, fechaDocumento) &&
      coincideProveedor &&
      Number.isFinite(candidato.monto) &&
      candidato.monto !== 0
    );
  });

  return exactos.length === 1 ? exactos[0] : undefined;
}
