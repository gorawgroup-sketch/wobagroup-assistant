import { prepararSolicitudesDatosPeriodico } from "../gastos/datosFaltantes/prepararSolicitudes";

/**
 * Job (laborables 9:05 y 15:05): prepara el correo que pide a los creadores de los gastos lo que falta (ver core/gastos/datosFaltantes/). Da dos horas a quien
 * opera para resolverlo por su cuenta, no repite lo ya pedido en 7 días y no envía nada: deja el resumen con el botón «Enviar» para un superadministrador.
 */
export async function ejecutarSolicitudDatosFaltantes(): Promise<number> {
  const n = await prepararSolicitudesDatosPeriodico();
  console.log(`[solicitarDatosFaltantes] ${n} resumen(es) preparados`);
  return n;
}
