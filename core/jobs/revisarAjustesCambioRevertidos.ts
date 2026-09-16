import { durableFxResidualAdjustmentStore } from "../holded/durableFxResidualAdjustmentStore";
import { registrarAjusteCambioRevertido } from "../holded/ajusteCambioAprendidoSheet";
import { obtenerCompraHoldedPorId, HoldedApiError } from "../holded/write";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { esDiaHabilEspana } from "../utils/diaHabil";

const VENTANA_DIAS = 30;

/**
 * Pedido explícito de Carlos (2026-09-16): "si en algún momento yo lo corrijo y lo quito, el sistema
 * debe identificar que ahí no va para que vaya aprendiendo" — el ajuste automático de cambio de
 * divisa (core/holded/write.ts, transporteAjusteCambioHolded) corre sin botón de confirmación, así
 * que esta es su única red de seguridad basada en aprendizaje: revisa los ajustes que Wobi ya dio por
 * verificados en los últimos 30 días y confirma si el pago que creó SIGUE existiendo en Holded. Si
 * Carlos lo borró a mano, es una señal real de que ESE proveedor no debía recibir el ajuste
 * automático — se registra la exclusión (ajusteCambioAprendidoSheet.ts) y deja de aplicarse para él,
 * sin afectar a ningún otro. Mismo patrón que revisarCorreccionesCuentaContable.ts: nunca "adivina"
 * nada nuevo, solo confirma explícitamente un cambio que Carlos ya hizo.
 */
export async function revisarAjustesCambioRevertidos(referenceDate: Date = new Date()): Promise<{ revertidos: number; revisados: number }> {
  if (!esDiaHabilEspana(referenceDate)) {
    console.log("[revisarAjustesCambioRevertidos] Fin de semana, no se revisa.");
    return { revertidos: 0, revisados: 0 };
  }

  const verificados = await durableFxResidualAdjustmentStore.listarVerificadosRecientes(VENTANA_DIAS);
  if (verificados.length === 0) {
    console.log("[revisarAjustesCambioRevertidos] No hay ajustes verificados recientes que revisar.");
    return { revertidos: 0, revisados: 0 };
  }

  const revertidos: { proveedor: string; empresa: string; purchaseId: string; monto: number }[] = [];
  let revisados = 0;

  for (const registro of verificados) {
    try {
      const compra = await obtenerCompraHoldedPorId(registro.empresa, registro.purchaseId);
      const sigueExistiendo = (compra.payments_detail ?? []).some((p) => p.id === registro.paymentId);
      if (!sigueExistiendo) {
        const contactId = (compra.contact_id as string | undefined) ?? "";
        const contactName = (compra["contact_name"] as string | undefined) ?? contactId;
        if (contactId) {
          await registrarAjusteCambioRevertido(registro.empresa, contactId, contactName);
          revertidos.push({
            proveedor: contactName,
            empresa: registro.empresa,
            purchaseId: registro.purchaseId,
            monto: registro.montoCentimos / 100,
          });
        }
      }
    } catch (error) {
      const compraBorrada = error instanceof HoldedApiError && error.status === 404;
      if (!compraBorrada) {
        console.error(`[revisarAjustesCambioRevertidos] Error revisando el ajuste de ${registro.purchaseId} (no crítico, sigue con los demás):`, error);
      }
      // Compra borrada: nunca habrá un pago que comparar, se ignora sin marcar reversión (no es una
      // señal real de que el AJUSTE en sí estuviera mal, solo de que el documento entero desapareció).
    }
    revisados++;
  }

  if (revertidos.length === 0) {
    console.log(`[revisarAjustesCambioRevertidos] Revisados ${revisados}, ninguna reversión detectada.`);
    return { revertidos: 0, revisados };
  }

  const admins = await obtenerAdmins();
  if (admins.length === 0) {
    console.error("[revisarAjustesCambioRevertidos] No hay ningún admin registrado, no se puede notificar.");
    return { revertidos: revertidos.length, revisados };
  }

  const lineas = revertidos
    .map((r) => `  • "${r.proveedor}" (${r.empresa}): borraste el ajuste automático de ${r.monto.toFixed(2)} — no se le volverá a aplicar`)
    .join("\n");
  const texto = [
    `📚 Detecté ${revertidos.length} ajuste(s) automático(s) de cambio de divisa que borraste a mano en Holded:`,
    lineas,
    "",
    "Ya quedó aprendido — estos proveedores ya no recibirán el ajuste automático; seguirán avisándote para revisión manual.",
  ].join("\n");

  for (const admin of admins) {
    await sendTelegramMessage(admin.userId, texto).catch((error) =>
      console.error(`[revisarAjustesCambioRevertidos] Error notificando al admin ${admin.userId} (no crítico):`, error)
    );
  }

  return { revertidos: revertidos.length, revisados };
}
