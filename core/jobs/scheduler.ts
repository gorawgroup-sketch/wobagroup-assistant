import cron from "node-cron";
import { revisarHoldedVsCashflow } from "./revisarHoldedVsCashflow";
import { revisarAlertasFiscales } from "./revisarAlertasFiscales";
import { revisarCorreoNuevo } from "./revisarCorreoNuevo";
import { enviarResumenPendientesDiario } from "./resumenPendientesDiario";
import { revisarCostosIA } from "./revisarCostosIA";
import { revisarNumeracionCashflow } from "./revisarNumeracionCashflow";
import { revisarAplazamientoImpuestos } from "./revisarAplazamientoImpuestos";
import { revisarAnotacionesCashflow } from "./revisarAnotacionesCashflow";
import { revisarAccionesProgramadas } from "./revisarAccionesProgramadas";
import { revisarGastosSinComprobante } from "./revisarGastosSinComprobante";
import { revisarConversacionesAutomaticas } from "./revisarConversacionesAutomaticas";
import { autorrevisionCodigo } from "./autorrevisionCodigo";
import { vigilarProcesamientoAtascado } from "./vigilarProcesamientoAtascado";
import { autoAuditarOperacionesDiarias } from "./autoAuditarOperaciones";

const TIMEZONE = "Europe/Madrid";
const jobsEnCurso = new Set<string>();

/** Evita duplicar trabajo, gasto o acciones si una corrida tarda más que su intervalo. */
function ejecutarSinSolapamiento(nombre: string, tarea: () => Promise<unknown>): void {
  if (jobsEnCurso.has(nombre)) {
    console.warn(`[scheduler] ${nombre} sigue en curso; se omite esta repetición.`);
    return;
  }
  jobsEnCurso.add(nombre);
  tarea()
    .catch((error) => console.error(`[scheduler] Error ejecutando ${nombre}:`, error))
    .finally(() => jobsEnCurso.delete(nombre));
}

/**
 * Registra los crons del sistema. La mayoría son de solo lectura/notificación
 * — ninguno escribe en Holded/cashflow/correo sin aprobación explícita. Dos
 * excepciones: revisarAccionesProgramadas SÍ actúa por su cuenta cuando le
 * toca (pedido explícito de Carlos, "WOBI debe encargarse"), pero solo sobre
 * acciones que un humano ya pidió programar — y cualquier escritura real que
 * termine haciendo falta sigue pasando por su propio flujo de propuesta+botón.
 * revisarConversacionesAutomaticas SÍ manda correos reales sin botón por
 * mensaje, pero solo a contactos que Carlos aprobó uno por uno de antemano
 * (ver autorespuestaContactoStore.ts) — la aprobación existe, solo que es
 * por contacto y no por mensaje. autorrevisionCodigo SÍ escribe en GitHub
 * sin aprobación previa (rama + commit + PR), pero nunca fusiona nada a
 * main por su cuenta — desplegar el arreglo siempre pasa por un tap de
 * aprobación en Telegram (ver autorrepairCallbackHandler.ts).
 */
export function startScheduler(): void {
  cron.schedule(
    "0 8 * * 1",
    () => {
      ejecutarSinSolapamiento("revisarHoldedVsCashflow_cierre", () => revisarHoldedVsCashflow(new Date(), "semana_cerrada"));
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarHoldedVsCashflow (cierre semanal) programado: lunes 8:00 (${TIMEZONE})`);

  cron.schedule(
    "0 17 * * 5",
    () => {
      ejecutarSinSolapamiento("revisarHoldedVsCashflow_preliminar", () => revisarHoldedVsCashflow(new Date(), "semana_en_curso"));
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarHoldedVsCashflow (chequeo preliminar) programado: viernes 17:00 (${TIMEZONE})`);

  cron.schedule(
    "0 8 * * *",
    () => {
      ejecutarSinSolapamiento("revisarAlertasFiscales", () => revisarAlertasFiscales());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarAlertasFiscales programado: diario 8:00 (${TIMEZONE})`);

  cron.schedule(
    "0 * * * *",
    () => {
      ejecutarSinSolapamiento("revisarCorreoNuevo", () => revisarCorreoNuevo());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarCorreoNuevo programado: cada hora (${TIMEZONE})`);

  cron.schedule(
    "0 19 * * *",
    () => {
      ejecutarSinSolapamiento("enviarResumenPendientesDiario", () => enviarResumenPendientesDiario());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] enviarResumenPendientesDiario programado: diario 19:00 (${TIMEZONE})`);

  cron.schedule(
    "30 23 * * *",
    () => {
      ejecutarSinSolapamiento("autoAuditarOperacionesDiarias", () => autoAuditarOperacionesDiarias());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] autoAuditarOperacionesDiarias programado: diario 23:30 (${TIMEZONE})`);

  cron.schedule(
    "30 8 * * *",
    () => {
      ejecutarSinSolapamiento("revisarCostosIA", () => revisarCostosIA());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarCostosIA programado: diario 8:30 (${TIMEZONE})`);

  cron.schedule(
    "15 8 * * *",
    () => {
      ejecutarSinSolapamiento("revisarNumeracionCashflow", () => revisarNumeracionCashflow());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarNumeracionCashflow programado: diario 8:15 (${TIMEZONE})`);

  cron.schedule(
    "10 8 * * *",
    () => {
      ejecutarSinSolapamiento("revisarAplazamientoImpuestos", () => revisarAplazamientoImpuestos());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarAplazamientoImpuestos programado: diario 8:10 (${TIMEZONE})`);

  cron.schedule(
    "20 8 * * *",
    () => {
      ejecutarSinSolapamiento("revisarAnotacionesCashflow", () => revisarAnotacionesCashflow());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarAnotacionesCashflow programado: diario 8:20 (${TIMEZONE})`);

  cron.schedule(
    "5 * * * *",
    () => {
      ejecutarSinSolapamiento("revisarAccionesProgramadas", () => revisarAccionesProgramadas());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarAccionesProgramadas programado: cada hora, minuto 5 (${TIMEZONE})`);

  cron.schedule(
    "35 8 * * *",
    () => {
      ejecutarSinSolapamiento("revisarGastosSinComprobante", () => revisarGastosSinComprobante());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarGastosSinComprobante programado: diario 8:35 (${TIMEZONE})`);

  // Cada 15 minutos — pedido explícito de Carlos: "conversación fluida" pero
  // "controlar el costo... no debe ser inmediato". Gmail list() con filtro
  // de remitentes es prácticamente gratis; el costo real (Claude) solo se
  // paga cuando de verdad hay un mensaje nuevo de un contacto aprobado, así
  // que revisar cada 15 min no dispara gasto salvo que haya trabajo real.
  cron.schedule(
    "*/15 * * * *",
    () => {
      ejecutarSinSolapamiento("revisarConversacionesAutomaticas", () => revisarConversacionesAutomaticas());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] revisarConversacionesAutomaticas programado: cada 15 minutos (${TIMEZONE})`);

  // "Al final del día" — pedido explícito de Carlos. 22:00, después de todos los demás avisos del
  // día (el más tardío hasta ahora es el resumen de pendientes a las 19:00).
  cron.schedule(
    "0 22 * * *",
    () => {
      ejecutarSinSolapamiento("autorrevisionCodigo", () => autorrevisionCodigo());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] autorrevisionCodigo programado: diario 22:00 (${TIMEZONE})`);

  // Pedido explícito de Carlos, tras un caso real: un correo quedó "activo" 7+ minutos sin que Wobi
  // mandara nada al chat ni registrara ningún error — atascado en silencio, solo detectado porque
  // Carlos avisó y hubo que diagnosticarlo a mano. "Asegúrate que el sistema identifica todos estos
  // errores... de manera inmediata... y lo corrija inmediatamente para que no nos quedemos esperando
  // una respuesta." Cada 2 minutos es suficientemente frecuente para reaccionar rápido sin generar
  // carga real (son lecturas de Sheets, no llamadas a Claude, salvo que de verdad haya algo atascado).
  cron.schedule(
    "*/2 * * * *",
    () => {
      ejecutarSinSolapamiento("vigilarProcesamientoAtascado", () => vigilarProcesamientoAtascado());
    },
    { timezone: TIMEZONE }
  );
  console.log(`[scheduler] vigilarProcesamientoAtascado programado: cada 2 minutos (${TIMEZONE})`);
}
