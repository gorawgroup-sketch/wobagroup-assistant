import { restarDias } from "../vigilante/fechas";
import { formatearEuros } from "../vigilante/importes";
import { DIAS_AVISO_PAGO, type PagoSeguro } from "./tipos";

/** Desfase (en minutos) de Madrid respecto a UTC en un instante dado: +60 en invierno, +120 en verano. */
function desfaseMadridMinutos(instante: Date): number {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(instante)
      .map((p) => [p.type, p.value])
  );
  const comoUtc = Date.UTC(Number(partes.year), Number(partes.month) - 1, Number(partes.day), Number(partes.hour), Number(partes.minute));
  return Math.round((comoUtc - Math.floor(instante.getTime() / 60_000) * 60_000) / 60_000);
}

/** El instante (ISO UTC) de las `hora` (HH:MM) de Madrid de una fecha YYYY-MM-DD, con el horario de verano de ese día. */
export function instanteMadrid(fecha: string, hora = "09:00"): string {
  const [anio, mes, dia] = fecha.split("-").map(Number);
  const [h, m] = hora.split(":").map(Number);
  const aproximado = Date.UTC(anio, mes - 1, dia, h, m);
  const desfase = desfaseMadridMinutos(new Date(aproximado));
  // Un segundo ajuste cubre la hora en que cambia el horario (el desfase se calculó con una hora ya algo desplazada).
  const resultado = aproximado - desfase * 60_000;
  const corregido = aproximado - desfaseMadridMinutos(new Date(resultado)) * 60_000;
  return new Date(corregido).toISOString();
}

const fechaLarga = (fecha: string): string => fecha.split("-").reverse().join("/");

/** Día del evento: DIAS_AVISO_PAGO días antes del pago. */
export const fechaDelEvento = (pago: Pick<PagoSeguro, "fecha">): string => restarDias(pago.fecha, DIAS_AVISO_PAGO);

/** El evento del calendario de Carlos para un pago (a las 9:00 de Madrid, tres días antes). */
export function eventoDePago(pago: PagoSeguro): { resumen: string; descripcion: string; fechaHoraInicioISO: string; duracionMinutos: number } {
  const importe = `${formatearEuros(pago.importe)} ${pago.moneda === "EUR" ? "€" : pago.moneda}${pago.estimado ? " (estimado)" : ""}`;
  return {
    resumen: `🛡️ Seguro: ${pago.concepto} — ${importe} el ${fechaLarga(pago.fecha)}`,
    descripcion:
      `Pago de seguro en ${DIAS_AVISO_PAGO} días (${fechaLarga(pago.fecha)}).\n` +
      `Empresa: ${pago.empresa} · ${pago.concepto}\nImporte: ${importe}\nCuenta de cargo: ${pago.cuentaDeCargo || "sin anotar"} (${pago.forma})\n\n` +
      `Wobi Seguros avisará por Telegram con la comprobación de saldo de la cuenta. ` +
      (pago.notas ? `\nNotas: ${pago.notas}` : ""),
    fechaHoraInicioISO: instanteMadrid(fechaDelEvento(pago), "09:00"),
    duracionMinutos: 30,
  };
}
