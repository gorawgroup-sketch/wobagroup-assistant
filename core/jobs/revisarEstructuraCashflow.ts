import { fetchDetalleRegistros, obtenerUltimaVerificacionEstructura, invalidarCacheDetalleRegistros } from "../google/cashflowSheet";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { esDiaHabilEspana } from "../utils/diaHabil";

/**
 * Job diario: pedido explícito de Carlos (2026-09-09) — "algunas veces incluimos o quitamos filas o
 * columnas y esto mueve las áreas de acción y lectura de los datos", tras encontrar en vivo, esa misma
 * sesión, que la sección de Pendientes (X:Z) llevaba tiempo con su columna de título desplazada (Carlos
 * agregó EMPRESA y AÑO delante) y CADA fila real (Alberto, Carrefour, Susana Iso...) se descartaba en
 * silencio en TODAS las lecturas del cashflow, sin ningún error, hasta que se investigó a mano.
 *
 * fetchDetalleRegistros ya corre este chequeo en cada lectura fresca (ver verificarEstructuraDatos en
 * cashflowSheet.ts) y lo deja en obtenerUltimaVerificacionEstructura — este job solo fuerza una lectura
 * fresca diaria (por si ningún humano ni cron toca el cashflow ese día) y avisa a los admins si algo
 * cambió de lugar, mismo criterio de "silencio = todo bien" que revisarNumeracionCashflow.ts.
 */
export async function revisarEstructuraCashflow(referenceDate: Date = new Date()): Promise<{ problemas: number }> {
  if (!esDiaHabilEspana(referenceDate)) {
    console.log("[revisarEstructuraCashflow] Fin de semana, no se envía el aviso.");
    return { problemas: 0 };
  }

  const admins = await obtenerAdmins();
  if (admins.length === 0) {
    console.error("[revisarEstructuraCashflow] No hay ningún admin registrado, no se puede notificar.");
    return { problemas: 0 };
  }

  invalidarCacheDetalleRegistros();
  await fetchDetalleRegistros();
  const problemas = obtenerUltimaVerificacionEstructura();

  if (problemas.length === 0) {
    console.log("[revisarEstructuraCashflow] Estructura de la hoja DATOS OK, no se envía nada.");
    return { problemas: 0 };
  }

  const lineas = problemas.map((p) => `  • [${p.bloque}] ${p.detalle}`).join("\n");
  const texto = [
    `⚠️ Detecté ${problemas.length} posible(s) cambio(s) de estructura en la hoja DATOS del cashflow:`,
    lineas,
    "",
    "Si moviste/agregaste/quitaste filas o columnas a mano, avísame qué cambió para que ajuste la lectura — mientras tanto, algunos datos de esa área podrían estar leyéndose mal o quedando invisibles.",
  ].join("\n");

  for (const admin of admins) {
    try {
      await sendTelegramMessage(admin.userId, texto);
    } catch (error) {
      console.error(`[revisarEstructuraCashflow] Error notificando a admin ${admin.userId}:`, error);
    }
  }

  return { problemas: problemas.length };
}
