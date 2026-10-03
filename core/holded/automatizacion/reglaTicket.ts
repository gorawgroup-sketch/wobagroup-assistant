import { clasificarDocumento } from "./clasificacionTicket";

/**
 * Regla amplia de conversión a ticket (aprobada por Carlos, 2026-10-03), para las tres empresas. Se aplica DESPUÉS de las
 * condiciones de seguridad de siempre (creado por WOBI, conciliado, completo, con comprobante), que comprueba la cola.
 * Basta UNA señal de ticket, y las exclusiones ganan siempre.
 */
export const TOPE_EUR_AUTOMATICO = 500;
const PAISES_UE = new Set(["ES","AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","SE"]);

export interface EntradaRegla {
  moneda: string;
  /** Importe en euros (total ÷ tasa de cambio del documento); null si no se puede calcular. */
  totalEUR: number | null;
  /** El contacto tiene NIF/CIF/VAT registrado (factura formal). */
  tieneNif: boolean;
  /** País del contacto (ISO-2) si se conoce. */
  pais?: string;
  /** Ya se convirtió antes un gasto de este mismo proveedor (aprendizaje). */
  proveedorConvertidoAntes: boolean;
  textoEvidencia?: string;
}
export interface ResultadoRegla { decision: "ticket" | "revisar" | "nunca"; motivos: string[] }

export function evaluarReglaTicket(e: EntradaRegla): ResultadoRegla {
  // Exclusiones: ganan siempre, aunque haya señales de ticket.
  if (e.tieneNif) return { decision: "nunca", motivos: ["el proveedor tiene NIF/CIF registrado: es una factura formal"] };
  if (e.totalEUR === null) return { decision: "revisar", motivos: ["no se pudo calcular el importe en euros"] };
  if (e.totalEUR > TOPE_EUR_AUTOMATICO) return { decision: "nunca", motivos: [`importe superior a ${TOPE_EUR_AUTOMATICO} € (equivalente ${e.totalEUR.toFixed(0)} €)`] };

  const motivos: string[] = [];
  const moneda = e.moneda.toUpperCase().trim();
  if (moneda !== "EUR") motivos.push(`proveedor sin NIF y gasto en ${moneda} (no es euro)`);
  const pais = (e.pais ?? "").toUpperCase();
  if (pais && !PAISES_UE.has(pais)) motivos.push(`proveedor sin NIF de fuera de la UE (${pais})`);
  if (e.proveedorConvertidoAntes) motivos.push("ya se convirtió antes un gasto de este proveedor");
  if (e.textoEvidencia && clasificarDocumento({ proveedor: "", textoEvidencia: e.textoEvidencia }).tipo === "ticket") motivos.push("el documento se declara ticket / factura simplificada");
  return motivos.length > 0 ? { decision: "ticket", motivos } : { decision: "revisar", motivos: ["sin señal clara de ticket"] };
}
