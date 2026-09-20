import type { ResultadoAuto } from "./model";
import { hayCoordinacionDurable, poolAuto } from "./postgres";
import { fechaHoyEspana } from "../../utils/diaHabil";
import type { SlotInformeCorreo } from "../../jobs/politicaRevisionCorreo";

const EVENTO_REVISION_CRON = "revision_cron_terminada";
const EVENTO_INFORME_CRON = "informe_cron_publicado";

const buzonActual = (): string => process.env.GMAIL_IMPERSONATE_EMAIL ?? "";
const claveGasto = (gasto: ResultadoAuto["gastos"][number]): string => `${gasto.empresa}:${gasto.id}`;

/**
 * El informe muestra el estado más reciente de los pendientes, pero acumula
 * cada compra realmente terminada desde el informe anterior. Así un gasto
 * creado en un pase silencioso nunca desaparece del reporte de las 10/18.
 */
export function consolidarResultadosCron(resultados: ResultadoAuto[]): ResultadoAuto {
  if (!resultados.length) {
    return { modo: "execute", revisados: 0, completados: 0, simulados: 0, pendientes: [], gastos: [], reparados: [] };
  }
  const ultimo = resultados[resultados.length - 1];
  const gastos = new Map<string, ResultadoAuto["gastos"][number]>();
  const reparados = new Map<string, NonNullable<ResultadoAuto["reparados"]>[number]>();
  for (const resultado of resultados) {
    for (const gasto of resultado.gastos) {
      gastos.set(claveGasto(gasto), gasto);
      reparados.delete(claveGasto(gasto));
    }
    for (const gasto of resultado.reparados ?? []) {
      if (!gastos.has(claveGasto(gasto))) reparados.set(claveGasto(gasto), gasto);
    }
  }
  return {
    ...ultimo,
    completados: gastos.size,
    gastos: [...gastos.values()],
    reparados: [...reparados.values()],
  };
}

export async function registrarRevisionCron(resultado: ResultadoAuto): Promise<boolean> {
  if (!hayCoordinacionDurable()) return false;
  await poolAuto().query(
    "INSERT INTO wobi_mail_events(mailbox,message_id,kind,data) VALUES($1,NULL,$2,$3)",
    [buzonActual(), EVENTO_REVISION_CRON, JSON.stringify(resultado)]
  );
  return true;
}

export interface InformeCronPreparado {
  resultado: ResultadoAuto;
  revisionesIncluidas: number;
}

export async function prepararInformeCron(
  resultadoActual: ResultadoAuto,
  resultadoActualRegistrado: boolean
): Promise<InformeCronPreparado> {
  if (!hayCoordinacionDurable()) {
    return { resultado: resultadoActual, revisionesIncluidas: 1 };
  }
  const db = poolAuto();
  const ultimoInforme = await db.query(
    "SELECT id FROM wobi_mail_events WHERE mailbox=$1 AND kind=$2 ORDER BY id DESC LIMIT 1",
    [buzonActual(), EVENTO_INFORME_CRON]
  );
  const desdeId = Number(ultimoInforme.rows[0]?.id ?? 0);
  const revisiones = await db.query(
    "SELECT data FROM wobi_mail_events WHERE mailbox=$1 AND kind=$2 AND id>$3 ORDER BY id",
    [buzonActual(), EVENTO_REVISION_CRON, desdeId]
  );
  const resultados = revisiones.rows.map(fila => fila.data as ResultadoAuto);
  // Si el INSERT anterior falló, el estado actual sigue siendo la fuente
  // más reciente y jamás debe perderse por existir eventos más antiguos.
  if (!resultadoActualRegistrado) resultados.push(resultadoActual);
  return {
    resultado: consolidarResultadosCron(resultados.length ? resultados : [resultadoActual]),
    revisionesIncluidas: Math.max(1, resultados.length),
  };
}

/** Reserva atómica del máximo de dos informes diarios. Un crash deja el slot
 * reclamado y evita un duplicado; el siguiente slot conserva el acumulado. */
export async function reservarSlotInformeCron(slotHora: SlotInformeCorreo): Promise<{ slot: string; reservado: boolean }> {
  const slot = `${fechaHoyEspana()}:${slotHora}`;
  if (!hayCoordinacionDurable()) return { slot, reservado: true };
  const r = await poolAuto().query(
    `INSERT INTO wobi_mail_report_slots(mailbox,slot,state,data) VALUES($1,$2,'claimed',$3)
     ON CONFLICT (mailbox,slot) DO NOTHING RETURNING slot`,
    [buzonActual(), slot, JSON.stringify({ hora: slotHora })]
  );
  return { slot, reservado: r.rowCount === 1 };
}

async function marcarInformeCronPublicadoUnaVez(slot: string): Promise<void> {
  if (!hayCoordinacionDurable()) return;
  const db = await poolAuto().connect();
  try {
    await db.query("BEGIN");
    const actualizado = await db.query(
      "UPDATE wobi_mail_report_slots SET state='sent',updated_at=now() WHERE mailbox=$1 AND slot=$2",
      [buzonActual(), slot]
    );
    if (actualizado.rowCount !== 1) throw new Error("El slot del informe no estaba reservado.");
    await db.query(
      `INSERT INTO wobi_mail_events(mailbox,message_id,kind,data)
       SELECT $1,NULL,$2,$3 WHERE NOT EXISTS (
         SELECT 1 FROM wobi_mail_events WHERE mailbox=$1 AND kind=$2 AND data->>'slot'=$4
       )`,
      [buzonActual(), EVENTO_INFORME_CRON, JSON.stringify({ slot }), slot]
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

/** El envío a Telegram ya ocurrió: reintenta el cierre durable para que el
 * siguiente informe no repita contenido ante una caída breve de PostgreSQL. */
export async function marcarInformeCronPublicado(slot: string): Promise<void> {
  let ultimoError: unknown;
  for (const esperaMs of [0, 250, 1_000]) {
    if (esperaMs) await new Promise(resolve => setTimeout(resolve, esperaMs));
    try {
      await marcarInformeCronPublicadoUnaVez(slot);
      return;
    } catch (error) {
      ultimoError = error;
    }
  }
  throw ultimoError;
}
