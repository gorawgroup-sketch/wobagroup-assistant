import type { DatosFactura } from "../../documental/extractInvoiceData";
import type { AnalisisAuto } from "./model";

export type ReutilizacionGastoCorreo = { concluyente: false } | { concluyente: true; gasto?: DatosFactura };

/**
 * Reutiliza en la cola manual la lectura completa ya persistida por la fase automática.
 * Solo decide cuando el análisis fue completo y el cuerpo contiene cero o un gasto; los casos
 * múltiples o incompletos conservan el extractor manual para no perder información.
 */
export function reutilizarGastoDeAnalisisAutomatico(analisis: AnalisisAuto | undefined): ReutilizacionGastoCorreo {
  if (!analisis?.completo) return { concluyente: false };
  const recibosCuerpo = analisis.recibos.filter(r => r.fuente === "cuerpo");
  // Una factura necesita desglose de IVA/retenciones que el analizador automático de tickets no
  // recopila. En ese caso se conserva el extractor fiscal manual completo.
  if (recibosCuerpo.some(r => r.tipo === "factura")) return { concluyente: false };
  const candidatos = recibosCuerpo.filter(r => r.tipo === "ticket" || r.tipo === "recibo");
  if (candidatos.length === 0) return { concluyente: true };
  if (candidatos.length !== 1) return { concluyente: false };
  const r = candidatos[0];
  if (!r.proveedor.trim() || !r.concepto.trim() || !r.fecha || !r.moneda || !(r.monto > 0)) return { concluyente: false };
  const gasto: DatosFactura = {
    esFacturaOGasto: true,
    proveedor: r.proveedor,
    monto: r.monto,
    moneda: r.moneda,
    montoEquivalente: r.equivalente?.monto,
    monedaEquivalente: r.equivalente?.moneda,
    personaAsociada: r.persona,
    contextoDeViaje: r.viaje,
    fecha: r.fecha,
    concepto: r.concepto,
    numeroDocumento: r.numero,
    reciboSimplificado: true,
    lineas: [{ concepto: r.concepto, base: r.monto, tipoIvaPct: 0, tratamientoFiscal: "inversion_sujeto_pasivo" }],
    empresaProbable: r.empresa,
    confianza: r.confianza,
    razon: "Datos reutilizados de la lectura automática completa del mismo mensaje.",
  };
  return { concluyente: true, gasto };
}
