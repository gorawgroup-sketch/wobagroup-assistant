import { diaMes, diasEntre } from "../vigilante/fechas";
import { formatearEuros } from "../vigilante/importes";
import type { Informe } from "../vigilante/informe";
import type { ResultadoCaja } from "./caja";
import { DIAS_AVISO_PAGO, type PagoSeguro } from "./tipos";

export type NivelAviso = "d3" | "d1";

export interface AvisoPago {
  pago: PagoSeguro;
  dias: number;
  nivel: NivelAviso;
  caja: ResultadoCaja;
}

const tiene = (avisos: string, nivel: NivelAviso): boolean => avisos.split(",").map((s) => s.trim()).includes(nivel);

/**
 * Qué aviso toca HOY para un pago, antes de mirar la caja:
 *  - «d3»: la primera vez que faltan entre 1 y 3 días (aunque el trabajo no corriera el día 3);
 *  - «d1»: el día antes, solo si ya se avisó el d3 (y luego se comprueba que la caja sigue sin alcanzar o sin poder comprobarse).
 * El día del cargo (0) y los pagos ya vencidos no se avisan aquí: lo que pasa después lo vigila el vigilante (banco y devoluciones).
 */
export function nivelQueToca(pago: PagoSeguro, hoy: string): { nivel: NivelAviso; dias: number } | null {
  if (pago.estado !== "previsto") return null;
  const dias = diasEntre(hoy, pago.fecha);
  if (dias < 1 || dias > DIAS_AVISO_PAGO) return null;
  if (!tiene(pago.avisos, "d3")) return { nivel: "d3", dias };
  if (dias === 1 && !tiene(pago.avisos, "d1")) return { nivel: "d1", dias };
  return null;
}

/**
 * Un «d1» solo se envía si la caja sigue sin alcanzar o sin poder comprobarse: si alcanzaba, no se repite el aviso. Una cuenta en
 * descubierto tampoco lo repite: su saldo negativo es permanente y el «d3» ya lo dijo (repetirlo cada vez sería ruido sin información nueva).
 */
export const merecePorCaja = (nivel: NivelAviso, caja: ResultadoCaja): boolean => nivel === "d3" || (caja.estado !== "alcanza" && caja.estado !== "descubierto");

const euros = (valor: number, moneda: string): string => `${formatearEuros(valor)} ${moneda === "EUR" ? "€" : moneda}`;

function textoCaja(caja: ResultadoCaja, moneda: string): string {
  switch (caja.estado) {
    case "alcanza":
      return `✅ alcanza: saldo de «${caja.cuenta}» ${euros(caja.saldo, moneda)}; tras los cargos de seguros previstos quedarían ${euros(caja.sobra, moneda)}.`;
    case "no_alcanza": {
      const otras = caja.otras.length > 0 ? ` Otras cuentas con saldo: ${caja.otras.map((o) => `${o.nombre} ${euros(o.saldo, moneda)}`).join(", ")}.` : "";
      return `⚠️ NO alcanza: «${caja.cuenta}» tiene ${euros(caja.saldo, moneda)} y salen ${euros(caja.necesario, moneda)} (faltan ${euros(caja.faltan, moneda)}).${otras}`;
    }
    case "descubierto":
      return (
        `ℹ️ cuenta en descubierto: «${caja.cuenta}» figura en ${euros(caja.saldo, moneda)} (es el saldo que da el banco). No sé cuánto crédito queda disponible, ` +
        `así que no puedo asegurar el cargo de ${euros(caja.necesario, moneda)}: comprueba el límite de la cuenta antes de esa fecha.`
      );
    default:
      return `❓ no pude comprobar la caja: ${caja.motivo}.`;
  }
}

const cuandoDice = (dias: number): string => (dias === 1 ? "mañana" : `en ${dias} días`);

/** El mensaje de Telegram con todos los pagos que tocan hoy (uno solo, ordenados por fecha), o null si no hay ninguno. */
export function construirInformePagos(avisos: AvisoPago[], hoy: string): Informe | null {
  if (avisos.length === 0) return null;
  const ordenados = [...avisos].sort((a, b) => a.pago.fecha.localeCompare(b.pago.fecha) || a.pago.empresa.localeCompare(b.pago.empresa));
  const hayProblema = ordenados.some((a) => a.caja.estado !== "alcanza");
  const lineas = ordenados.map((a) => {
    const p = a.pago;
    const forma = p.forma === "transferencia" ? "transferencia tuya" : p.forma === "adeudo" ? "adeudo" : "cobro";
    return (
      `- **${diaMes(p.fecha)}** (${cuandoDice(a.dias)}) · [${p.empresa}] ${p.concepto} · ${euros(p.importe, p.moneda)}${p.estimado ? " (estimado)" : ""} · ${forma} en «${p.cuentaDeCargo || "cuenta sin anotar"}»\n` +
      `  ${textoCaja(a.caja, p.moneda)}`
    );
  });
  return {
    titulo: `${hayProblema ? "⚠️" : "🛡️"} Seguros — pagos de los próximos ${DIAS_AVISO_PAGO} días (${diaMes(hoy)})`,
    cuerpo:
      lineas.join("\n") +
      `\n\nComprobación con el saldo de hoy en Holded; no incluye otros cargos domiciliados de la cuenta. No muevo dinero: si hace falta traspasar, decídelo tú. ` +
      `Los importes «estimados» se confirman con el recibo de la corredora.`,
  };
}
