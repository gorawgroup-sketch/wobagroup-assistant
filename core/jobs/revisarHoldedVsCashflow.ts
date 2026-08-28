import { listBankMovements, listTreasuryAccounts } from "../holded/client";
import { fetchDetalleRegistros } from "../google/cashflowSheet";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import { crearPropuesta, actualizarMessageId, consumirPropuesta } from "../google/proposalSheet";
import { previousWeekRange, currentWeekRangeToDate, weekLabel, formatDateISO } from "../utils/isoWeek";
import { guardarUltimoRunHoldedCashflow } from "./holdedCashflowLastRunStore";
import type { BloqueEscritura } from "../google/cashflowWrite";

const TOLERANCIA_EUR = 0.01;
// Deliberadamente acotado a WOBA/EWORKS (no el tipo Empresa completo de
// holded/client.ts, que ya incluye Footprint) — esta reconciliación escribe
// en el cashflow de Sheets, y Footprint no tiene acceso a cashflow todavía.
export type EmpresaCashflow = "WOBA" | "EWORKS";
const EMPRESAS: EmpresaCashflow[] = ["WOBA", "EWORKS"];

export function parseValorFormateado(valor: string): number {
  const limpio = valor.replace(/[^0-9.\-]/g, "");
  const numero = Number(limpio);
  return Number.isFinite(numero) ? numero : 0;
}

function sugerirBloque(amount: number): BloqueEscritura {
  return amount > 0 ? "ingresos" : "pagos_extras";
}

// El cashflow solo registra ingresos externos o pagos a externos — pedido
// explícito de Carlos: conversiones de moneda y traslados entre cuentas
// propias de la misma empresa NUNCA van ahí, así que nunca deben salir como
// "sin registrar". Verificado en vivo el patrón real de Holded/Wise: una
// conversión aparece como DOS movimientos con la MISMA descripción literal
// "Converted Usd To Eur" (uno en cada cuenta propia — ej. "Emoney EUR" y
// "Emoney USD" de WOBA), a veces con "(fee: XXX)" al final. No se intenta
// detectar traslados entre cuentas propias por otros patrones de texto
// todavía — no hay un ejemplo real confirmado del que partir; si aparece
// uno, se agrega aquí con el mismo cuidado (verificado contra datos reales,
// no adivinado).
const RE_CONVERSION_MONEDA = /^converted\s+\S+\s+to\s+\S+/i;

function esMovimientoInternoOConversion(descripcion: string | undefined): boolean {
  return RE_CONVERSION_MONEDA.test(descripcion ?? "");
}

export interface CandidatoNoRegistrado {
  empresa: EmpresaCashflow;
  descripcion: string;
  fecha?: string;
  valorAbs: number;
  esIngreso: boolean;
}

/**
 * Compara los movimientos bancarios reales de Holded (en el rango de fechas
 * dado) contra lo ya registrado en la hoja DATOS para `semanaLabel`, y
 * devuelve los que no encuentran match (por monto, con tolerancia de 1
 * céntimo) — nunca decide que algo "ya está" si hay duda razonable. Misma
 * lógica que usa el cron revisarHoldedVsCashflow, exportada para que
 * también la use el tool conversacional verificar_cashflow_actualizado
 * (core/tools/verificarCashflowActualizado.ts) sin duplicarla.
 */
export async function detectarNoRegistrados(empresa: EmpresaCashflow, semanaLabel: string, desde: string, hasta: string) {
  const cuentas = (await listTreasuryAccounts(empresa)).filter((c) => !c.archived);

  const movimientosHolded = (
    await Promise.all(cuentas.map((c) => listBankMovements(empresa, c.id, desde, hasta)))
  ).flat();

  // Incluye GASTOS_FIJOS y APLAZAMIENTO_IMPUESTOS además de los 3 bloques
  // originales — verificado en vivo que un gasto real (ej. "Sunreuse Woba",
  // S35, 110€) vive en GASTOS_FIJOS y NO se estaba comparando contra los
  // movimientos de Holded, generando un falso "sin registrar" para algo que
  // ya estaba en la hoja (con el mismo monto e incluso el mismo mes).
  // PAGOS_PENDIENTES_ALBERTO/DEUDAS_PENDIENTES se dejan fuera a propósito:
  // son saldos pendientes sin semana asignada, no ejecución de esta semana.
  const CATEGORIAS_EJECUCION_SEMANAL = new Set([
    "INGRESOS",
    "PAGOS_PROYECTOS",
    "PAGOS_EXTRAS",
    "GASTOS_FIJOS",
    "APLAZAMIENTO_IMPUESTOS",
  ]);
  const registrosSemana = (await fetchDetalleRegistros()).filter(
    (r) => r.semana.toUpperCase() === semanaLabel && CATEGORIAS_EJECUCION_SEMANAL.has(r.categoria)
  );

  const valoresRegistrados = registrosSemana.map((r) => Math.abs(parseValorFormateado(r.valor)));

  const candidatos: CandidatoNoRegistrado[] = [];

  for (const mov of movimientosHolded) {
    if (esMovimientoInternoOConversion(mov.description)) continue;

    const amount = typeof mov.amount === "number" ? mov.amount : Number(mov.amount ?? 0);
    const valorAbs = Math.abs(amount);

    const yaExiste = valoresRegistrados.some((v) => Math.abs(v - valorAbs) <= TOLERANCIA_EUR);
    if (yaExiste) continue; // conservador: si hay duda razonable de match, no se propone

    candidatos.push({
      empresa,
      descripcion: mov.description ?? "(sin descripción)",
      fecha: mov.booking_date?.slice(0, 10),
      valorAbs,
      esIngreso: amount > 0,
    });
  }

  return candidatos;
}

export interface CandidatoSinMovimientoBancario {
  empresa: EmpresaCashflow;
  descripcion: string;
  categoria: string;
  valorAbs: number;
}

/**
 * Dirección INVERSA de detectarNoRegistrados: en vez de "¿qué hay en el
 * banco que no está en el cashflow?", busca "¿qué gasto está registrado en
 * el cashflow de esta semana que NO tiene un movimiento bancario real que
 * lo respalde?" — un pago que se anotó como hecho/programado pero el banco
 * todavía no refleja ninguna salida de dinero equivalente. Mismo matching
 * por monto (con tolerancia de 1 céntimo) que detectarNoRegistrados, solo
 * que comparando en el sentido contrario. Nace de un pedido real: "para
 * esto debes buscar que los gastos estén en el cashflow para esta semana,
 * pero los pagos efectivamente se ven reflejados en bancos... es básicamente
 * un cruce de info entre el área de bancos y las cuentas y el cashflow".
 */
export async function detectarSinMovimientoBancario(
  empresa: EmpresaCashflow,
  semanaLabel: string,
  desde: string,
  hasta: string
): Promise<CandidatoSinMovimientoBancario[]> {
  const cuentas = (await listTreasuryAccounts(empresa)).filter((c) => !c.archived);

  const movimientosHolded = (
    await Promise.all(cuentas.map((c) => listBankMovements(empresa, c.id, desde, hasta)))
  ).flat();
  const valoresBanco = movimientosHolded.map((m) =>
    Math.abs(typeof m.amount === "number" ? m.amount : Number(m.amount ?? 0))
  );

  // Mismo ajuste que detectarNoRegistrados: incluye GASTOS_FIJOS y
  // APLAZAMIENTO_IMPUESTOS, que también son ejecución real de la semana y
  // antes quedaban fuera de esta comparación.
  const CATEGORIAS_GASTO_SEMANAL = new Set(["PAGOS_PROYECTOS", "PAGOS_EXTRAS", "GASTOS_FIJOS", "APLAZAMIENTO_IMPUESTOS"]);
  const registrosGastos = (await fetchDetalleRegistros()).filter(
    (r) => r.semana.toUpperCase() === semanaLabel && CATEGORIAS_GASTO_SEMANAL.has(r.categoria)
  );

  const candidatos: CandidatoSinMovimientoBancario[] = [];

  for (const registro of registrosGastos) {
    const valorAbs = Math.abs(parseValorFormateado(registro.valor));
    if (valorAbs === 0) continue;

    const yaEnBanco = valoresBanco.some((v) => Math.abs(v - valorAbs) <= TOLERANCIA_EUR);
    if (yaEnBanco) continue;

    candidatos.push({
      empresa,
      descripcion: registro.concepto || registro.cliente || registro.proyecto || "(sin descripción)",
      categoria: registro.categoria,
      valorAbs,
    });
  }

  return candidatos;
}

/**
 * Job: compara movimientos bancarios de Holded contra lo ya registrado en
 * DATOS, y propone por Telegram los que no encuentra match. NO escribe nada
 * — solo detecta y notifica. La escritura solo ocurre si el usuario aprueba
 * con el botón "✅ Agregar" (ver callback_query en src/server.ts).
 *
 * `modo`:
 * - "semana_cerrada" (por defecto, lunes 8:00): revisa la semana ANTERIOR
 *   completa — es la revisión de cierre.
 * - "semana_en_curso" (viernes 17:00): revisa lo que va de la semana ACTUAL
 *   (lunes a la fecha de referencia) — primer punto de control, no
 *   reemplaza la revisión de cierre del lunes siguiente. Si algo se ignora
 *   o queda pendiente aquí, se vuelve a detectar el lunes si sigue sin
 *   registrar (no hay lista de "ya avisado" — es intencional, ver plan de
 *   este cron).
 */
export async function revisarHoldedVsCashflow(
  referenceDate: Date = new Date(),
  modo: "semana_cerrada" | "semana_en_curso" = "semana_cerrada"
): Promise<{
  propuestasCreadas: number;
}> {
  const chatId = process.env.CASHFLOW_ALERTS_CHAT_ID ? Number(process.env.CASHFLOW_ALERTS_CHAT_ID) : undefined;

  if (!chatId) {
    console.error("[revisarHoldedVsCashflow] Falta CASHFLOW_ALERTS_CHAT_ID, no se puede notificar.");
    return { propuestasCreadas: 0 };
  }

  const { start, end } = modo === "semana_en_curso" ? currentWeekRangeToDate(referenceDate) : previousWeekRange(referenceDate);
  const semanaLabel = weekLabel(start);
  const desde = formatDateISO(start);
  const hasta = formatDateISO(end);
  const esChequeoPreliminar = modo === "semana_en_curso";

  console.log(
    `[revisarHoldedVsCashflow] Revisando semana ${semanaLabel} (${desde} a ${hasta})` +
      (esChequeoPreliminar ? " [chequeo preliminar viernes]" : "")
  );

  let propuestasCreadas = 0;

  for (const empresa of EMPRESAS) {
    let candidatos: CandidatoNoRegistrado[] = [];

    try {
      candidatos = await detectarNoRegistrados(empresa, semanaLabel, desde, hasta);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[revisarHoldedVsCashflow] Error revisando ${empresa}:`, message);
      continue;
    }

    for (const candidato of candidatos) {
      const bloqueSugerido = sugerirBloque(candidato.esIngreso ? 1 : -1);

      const texto = [
        esChequeoPreliminar
          ? `📋 Chequeo preliminar (viernes) — movimiento de Holded sin registrar en el cashflow de esta semana`
          : `📋 Movimiento de Holded sin registrar en el cashflow`,
        ``,
        `Empresa: ${candidato.empresa}`,
        `Fecha: ${candidato.fecha ?? "(sin fecha)"}`,
        `Semana: ${semanaLabel}`,
        `Concepto: ${candidato.descripcion}`,
        `Valor: ${candidato.valorAbs.toFixed(2)} € (${candidato.esIngreso ? "abono" : "cargo"})`,
        ``,
        `Bloque sugerido: ${bloqueSugerido}` +
          (bloqueSugerido === "pagos_extras"
            ? " (no puedo distinguir si es un pago a proyecto — corrígelo si aplica)"
            : ""),
      ].join("\n");

      // Se persiste primero (con messageId=0 provisional) para tener el id real
      // antes de mandar los botones; se actualiza el messageId tras enviarlos.
      let propuestaId: string | undefined;
      try {
        const propuesta = await crearPropuesta({
          empresa: candidato.empresa,
          bloqueSugerido,
          clienteOConcepto: candidato.descripcion,
          semana: semanaLabel,
          valor: candidato.valorAbs,
          fechaMovimiento: candidato.fecha,
          chatId,
          messageId: 0,
        });
        propuestaId = propuesta.id;

        const messageId = await sendTelegramMessageWithButtons(chatId, texto, [
          [
            { text: "✅ Agregar", callback_data: `cf_approve:${propuesta.id}` },
            { text: "❌ Ignorar", callback_data: `cf_reject:${propuesta.id}` },
          ],
        ]);

        await actualizarMessageId(propuesta.id, messageId);
        propuestasCreadas++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[revisarHoldedVsCashflow] Error enviando propuesta a Telegram:`, message);

        // Si la fila ya se creó pero el envío/actualización falló, el usuario
        // nunca verá botones válidos para ella — se borra de inmediato en vez
        // de dejarla como basura hasta el purgado por TTL (7 días).
        if (propuestaId) {
          await consumirPropuesta(propuestaId).catch((cleanupError) => {
            console.error(`[revisarHoldedVsCashflow] Error limpiando propuesta huérfana:`, cleanupError);
          });
        }
      }
    }
  }

  console.log(
    `[revisarHoldedVsCashflow] ${propuestasCreadas} propuesta(s) enviada(s) para la semana ${semanaLabel}` +
      (esChequeoPreliminar ? " (chequeo preliminar)." : ".")
  );

  await guardarUltimoRunHoldedCashflow(Math.floor(Date.now() / 1000)).catch((error) => {
    console.error("[revisarHoldedVsCashflow] Error guardando último run (no crítico):", error);
  });

  return { propuestasCreadas };
}
