import { obtenerAsignacionesPendientesDeRevisar, consumirAsignacionCuenta, purgarAsignacionesVencidas } from "../holded/asignacionCuentaLogSheet";
import { registrarCuentaCorregidaAprendida } from "../holded/cuentaCorregidaAprendidaSheet";
import { obtenerCompraHoldedPorId } from "../holded/write";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { esDiaHabilEspana } from "../utils/diaHabil";

/**
 * Pedido explícito de Carlos ("que la práctica y los días te vayan dando la
 * experiencia... para que cada día seas más inteligente y rápido"):
 * inferirCuentaGasto (core/holded/write.ts) ya se beneficia PASIVAMENTE de
 * una corrección de cuenta hecha a mano en Holded, porque sus tiers buscan
 * precedente en compras YA existentes con datos en vivo — pero eso es
 * implícito y nunca se confirma explícitamente. Este job (semanal) relee
 * cada gasto creado por inferencia en los últimos 30 días
 * (asignacionCuentaLogSheet.ts) y compara la cuenta que se le asignó al
 * crearlo contra su cuenta ACTUAL en Holded — si ya no coincide, es una
 * señal real de que Carlos la corrigió a mano, y esa corrección queda
 * confirmada explícitamente (cuentaCorregidaAprendidaSheet.ts), que
 * inferirCuentaGasto consulta PRIMERO en la próxima factura del mismo
 * proveedor, antes que cualquiera de sus tiers normales.
 *
 * Nunca "adivina" nada nuevo — solo confirma explícitamente un cambio que
 * Carlos YA hizo. Silencio si no encuentra ninguna corrección (mismo
 * criterio que el resto de los crons de este proyecto).
 */
export async function revisarCorreccionesCuentaContable(referenceDate: Date = new Date()): Promise<{ corregidas: number; revisadas: number }> {
  if (!esDiaHabilEspana(referenceDate)) {
    console.log("[revisarCorreccionesCuentaContable] Fin de semana, no se revisa.");
    return { corregidas: 0, revisadas: 0 };
  }

  await purgarAsignacionesVencidas().catch((error) =>
    console.error("[revisarCorreccionesCuentaContable] Error purgando asignaciones vencidas (no crítico):", error)
  );

  const pendientes = await obtenerAsignacionesPendientesDeRevisar();
  if (pendientes.length === 0) {
    console.log("[revisarCorreccionesCuentaContable] No hay asignaciones pendientes de revisar.");
    return { corregidas: 0, revisadas: 0 };
  }

  const correcciones: { proveedor: string; empresa: string; cuentaAnterior: string; cuentaNueva: string }[] = [];
  let revisadas = 0;

  for (const asignacion of pendientes) {
    try {
      const compra = await obtenerCompraHoldedPorId(asignacion.empresa, asignacion.gastoId);
      const cuentaActual = compra.lines?.[0]?.account ?? undefined;

      // Solo se aprende de un cambio REAL y confirmado — si el gasto ya no
      // existe, o no tiene cuenta actual, o sigue igual, no hay nada que
      // hacer más que dejar de revisarlo.
      if (cuentaActual && cuentaActual !== asignacion.cuentaIdAsignada) {
        await registrarCuentaCorregidaAprendida(asignacion.proveedor, asignacion.empresa, cuentaActual, "");
        correcciones.push({
          proveedor: asignacion.proveedor,
          empresa: asignacion.empresa,
          cuentaAnterior: asignacion.cuentaIdAsignada,
          cuentaNueva: cuentaActual,
        });
      }
    } catch (error) {
      // Un gasto borrado, o un error puntual de Holded, no debe tumbar la revisión de los demás.
      console.error(`[revisarCorreccionesCuentaContable] Error revisando el gasto ${asignacion.gastoId} (no crítico, sigue con los demás):`, error);
    } finally {
      revisadas++;
      await consumirAsignacionCuenta(asignacion.id).catch((error) =>
        console.error(`[revisarCorreccionesCuentaContable] Error marcando como revisada la asignación ${asignacion.id} (no crítico):`, error)
      );
    }
  }

  if (correcciones.length === 0) {
    console.log(`[revisarCorreccionesCuentaContable] Revisadas ${revisadas}, ninguna corrección detectada.`);
    return { corregidas: 0, revisadas };
  }

  const admins = await obtenerAdmins();
  if (admins.length === 0) {
    console.error("[revisarCorreccionesCuentaContable] No hay ningún admin registrado, no se puede notificar.");
    return { corregidas: correcciones.length, revisadas };
  }

  const lineas = correcciones.map((c) => `  • "${c.proveedor}" (${c.empresa}): cuenta corregida — quedó aprendida para la próxima vez`).join("\n");
  const texto = [
    `📚 Detecté ${correcciones.length} corrección(es) de cuenta contable hecha(s) a mano en Holded esta semana:`,
    lineas,
    "",
    "Ya quedaron aprendidas — la próxima factura de estos proveedores usará directamente la cuenta corregida.",
  ].join("\n");

  for (const admin of admins) {
    await sendTelegramMessage(admin.userId, texto).catch((error) =>
      console.error(`[revisarCorreccionesCuentaContable] Error notificando al admin ${admin.userId} (no crítico):`, error)
    );
  }

  return { corregidas: correcciones.length, revisadas };
}
