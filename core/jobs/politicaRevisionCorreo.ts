/**
 * La revisión y el informe tienen cadencias distintas:
 * - lunes a viernes se procesa el buzón cada dos horas;
 * - sábados y domingos solo se procesa a las 10:00 y 18:00;
 * - los únicos pases automáticos que publican un informe son los de las
 *   10:00 y 18:00, todos los días.
 *
 * Separar los cron evita depender del reloj dentro del job y hace imposible
 * que un pase silencioso publique por error el resumen rutinario.
 */
export const CRON_CORREO_HABIL_SILENCIOSO = "0 0,2,4,6,8,12,14,16,20,22 * * 1-5";
export const CRON_CORREO_INFORME_MANANA = "0 10 * * *";
export const CRON_CORREO_INFORME_TARDE = "0 18 * * *";

/**
 * Interruptor independiente del modo de escritura. Cuando está apagado no se
 * registran lectores de Gmail en segundo plano; las órdenes manuales siguen
 * usando exactamente el mismo flujo y sus controles durables.
 */
export function lecturasCorreoAutomaticasHabilitadas(env: NodeJS.ProcessEnv = process.env): boolean {
  const valor = (env.WOBI_MAIL_AUTOMATIC_READS_ENABLED ?? "true").trim().toLowerCase();
  return valor === "true" || valor === "1";
}

export type SlotInformeCorreo = "10" | "18";
export type SolicitudRevisionCorreo =
  | { origen: "manual"; chatId?: number }
  | { origen: "cron"; informe: "silencioso" }
  | { origen: "cron"; informe: "consolidado"; slot: SlotInformeCorreo };

/**
 * La cola manual puede sincronizarse cada dos horas sin pagar una lectura
 * con IA. El análisis automático de gastos se concentra en los dos pases
 * con informe y en órdenes manuales explícitas.
 */
export function debeEjecutarAnalisisAutomatico(solicitud: SolicitudRevisionCorreo): boolean {
  return solicitud.origen === "manual" || solicitud.informe === "consolidado";
}

/** Una orden manual siempre informa, aunque se una a un pase silencioso. */
export function debePublicarInformeCorreo(
  solicitud: SolicitudRevisionCorreo,
  revisionInteractivaUnida = false,
  slotNoDisponible = false
): boolean {
  if (solicitud.origen === "manual" || revisionInteractivaUnida) return true;
  return solicitud.informe === "consolidado" && !slotNoDisponible;
}
