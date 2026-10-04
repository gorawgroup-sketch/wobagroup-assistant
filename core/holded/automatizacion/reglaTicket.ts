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

type Raw = Record<string, unknown>;
const numES = (v: unknown): number => { const n = Number(String(v ?? "").replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : NaN; };

/** Tipo de cambio (`currency_change`): Holded lo da en decimal plano («1.12», «3718.16»); si trae coma es formato ES. NO quitar el punto: «1.12» no es 112. */
export const tasaDeCambio = (v: unknown): number => {
  const t = String(v ?? "").trim();
  if (t === "") return NaN;
  const n = t.includes(",") ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t);
  return Number.isFinite(n) ? n : NaN;
};

/** Arma la entrada de la regla a partir de la compra de Holded y su contacto. Es la ÚNICA forma de calcularla: el escáner y la cola usan esta. */
export function entradaReglaDesdeCompra(d: Raw, contacto: Raw | null, proveedorConvertidoAntes: boolean): EntradaRegla {
  const nif = String(contacto?.vat_number ?? contacto?.code ?? "").trim();
  const moneda = String(d.currency ?? "EUR");
  const total = numES(d.total), tasa = tasaDeCambio(d.currency_change);
  const totalEUR = moneda.toUpperCase() === "EUR" ? (Number.isFinite(total) ? total : null) : (Number.isFinite(total) && Number.isFinite(tasa) && tasa > 0 ? total / tasa : null);
  return {
    moneda, totalEUR, tieneNif: nif !== "", pais: String((contacto?.bill_address as Raw | undefined)?.country_code ?? ""),
    proveedorConvertidoAntes,
    textoEvidencia: [d.description, (Array.isArray(d.lines) ? (d.lines as Raw[])[0]?.name : "")].filter(Boolean).join(" · "),
  };
}
