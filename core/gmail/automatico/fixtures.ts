import { hash, type AnalisisAuto, type ConfigAuto, type CorreoAuto, type EvidenciaAuto, type ReciboAuto } from "./model";
export const configFixture: ConfigAuto = { modo: "execute", empresas: ["WOBA", "EWORKS", "Footprint"], buzon: "test@example.com" };
export function correoFixture(id = "m1"): CorreoAuto {
  return { id, threadId: `t-${id}`, de: "Proveedor", asunto: "Recibo", fecha: "2026-09-18", recibidoEn: 1,
    cuerpo: "Recibo real 20 EUR 2026-09-18", contextoHilo: "", adjuntos: [], huella: hash(id) };
}
export function reciboFixture(): ReciboAuto { return { fuente: "cuerpo", tipo: "ticket", confianza: "alta", empresa: "WOBA",
  proveedor: "Proveedor", numero: "R-1", fecha: "2026-09-18", moneda: "EUR", monto: 20, concepto: "Transporte",
  evidencia: "Recibo real 20 EUR 2026-09-18", evidenciaEmpresa: "WOBA en el documento" }; }
export function analisisFixture(r = reciboFixture()): AnalisisAuto { return { completo: true, resumen: "Recibo", otrasAcciones: false, recibos: [r] }; }
export function evidenciaFixture(): EvidenciaAuto { return { contacto: { id: "p1", nombre: "Proveedor", exacto: true },
  cuenta: { id: "c1", evidencia: "Precedentes confirmados" }, consultasCompletas: true, duplicados: [], permiteTicket: true,
  movimientos: [{ id: "b1", cuentaId: "a1", moneda: "EUR", fecha: "2026-09-18", centimos: -2000, conciliadoCentimos: 0, estado: "pending", origen: "bank", descripcion: "Proveedor" }] }; }
