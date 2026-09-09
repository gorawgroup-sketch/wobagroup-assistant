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
    // Solo se consume (se deja de revisar) una asignación cuando queda
    // REALMENTE resuelta: se detectó y registró una corrección, o el gasto
    // ya no existe en Holded (nunca habrá nada que comparar). Si todavía no
    // hay corrección, o si el registro del aprendizaje falla, se deja
    // pendiente — la próxima corrida semanal la vuelve a revisar, hasta que
    // purgarAsignacionesVencidas la borre por su verdadero TTL de 30 días.
    // Hallazgo real de auditoría: consumir siempre acá (como antes) mataba
    // el aprendizaje en dos casos reales: (a) Carlos corrige la cuenta a
    // mano DESPUÉS de la primera revisión semanal mataba la ventana de 30
    // días a solo 1 semana; (b) un fallo de escritura en Sheets tras
    // agotar reintentos perdía la corrección detectada para siempre.
    let resuelto = false;

    try {
      const compra = await obtenerCompraHoldedPorId(asignacion.empresa, asignacion.gastoId);
      const cuentaActual = compra.lines?.[0]?.account ?? undefined;

      if (cuentaActual && cuentaActual !== asignacion.cuentaIdAsignada) {
        await registrarCuentaCorregidaAprendida(asignacion.proveedor, asignacion.empresa, cuentaActual, "");
        correcciones.push({
          proveedor: asignacion.proveedor,
          empresa: asignacion.empresa,
          cuentaAnterior: asignacion.cuentaIdAsignada,
          cuentaNueva: cuentaActual,
        });
        resuelto = true;
      }
      // cuentaActual sin corrección, o sin cuenta legible: todavía no hay
      // nada que aprender, pero puede haberlo en una revisión futura — no
      // se marca como resuelto.
    } catch (error) {
      const gastoBorrado = error instanceof Error && /\(404\)|No se encontró la compra/.test(error.message);
      if (gastoBorrado) {
        // El gasto ya no existe — nunca habrá una cuenta que comparar.
        resuelto = true;
      }
      console.error(`[revisarCorreccionesCuentaContable] Error revisando el gasto ${asignacion.gastoId} (no crítico, sigue con los demás):`, error);
    }

    revisadas++;
    if (resuelto) {
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

  const lineas = correcciones
    .map((c) => `  • "${c.proveedor}" (${c.empresa}): ${c.cuentaAnterior} → ${c.cuentaNueva} — quedó aprendida para la próxima vez`)
    .join("\n");
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
