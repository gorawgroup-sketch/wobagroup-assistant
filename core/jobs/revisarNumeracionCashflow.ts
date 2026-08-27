import { fetchResumenSemanas } from "../google/cashflowSheet";
import { validarNumeracionSemanas } from "../google/validarNumeracionCashflow";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";

/**
 * Job diario: valida que las semanas de la hoja CASHFLOW estén bien
 * numeradas (formato, sin duplicados, en secuencia real de 7 en 7 días, sin
 * saltos ni huecos, y que la más reciente no esté a una distancia
 * inverosímil de hoy) — ver core/google/validarNumeracionCashflow.ts. Solo
 * avisa a los admins si encuentra algo raro; si todo está bien, no manda
 * nada (mismo criterio de "silencio = todo bien" que el resto de crons de
 * este proyecto). Nace de un pedido explícito: "asegúrate de monitorizar
 * esto" tras construir la vista mensual, que depende de que la numeración
 * sea correcta para agrupar bien las semanas por mes.
 */
export async function revisarNumeracionCashflow(referenceDate: Date = new Date()): Promise<{ problemas: number }> {
  const admins = await obtenerAdmins();
  if (admins.length === 0) {
    console.error("[revisarNumeracionCashflow] No hay ningún admin registrado, no se puede notificar.");
    return { problemas: 0 };
  }

  const semanas = await fetchResumenSemanas();
  const conDatos = semanas.filter((s) => s.balanceFinal.trim() !== "");
  const problemas = validarNumeracionSemanas(conDatos, referenceDate);

  if (problemas.length === 0) {
    console.log("[revisarNumeracionCashflow] Numeración de semanas OK, no se envía nada.");
    return { problemas: 0 };
  }

  const lineas = problemas.map((p) => `  • [${p.tipo}] ${p.detalle}`).join("\n");
  const texto = [
    `⚠️ La numeración de semanas del cashflow tiene ${problemas.length} problema(s):`,
    lineas,
    "",
    "Esto puede afectar la agrupación mensual del panel de /cerebro y el chequeo automático semanal contra Holded — conviene revisar la hoja CASHFLOW directamente.",
  ].join("\n");

  for (const admin of admins) {
    try {
      await sendTelegramMessage(admin.userId, texto);
    } catch (error) {
      console.error(`[revisarNumeracionCashflow] Error notificando a admin ${admin.userId}:`, error);
    }
  }

  return { problemas: problemas.length };
}
