import { listBankMovements, listTreasuryAccounts, type BankMovement } from "../holded/client";
import { fetchDetalleRegistros } from "../google/cashflowSheet";
import { sendTelegramMessageWithButtons } from "../telegram/client";
import { crearPropuesta, actualizarMessageId, consumirPropuesta } from "../google/proposalSheet";
import { previousWeekRange, currentWeekRangeToDate, weekLabel, formatDateISO } from "../utils/isoWeek";
import { guardarUltimoRunHoldedCashflow } from "./holdedCashflowLastRunStore";
import { sugerirCategoriasGasto, type CategoriaSugerida } from "../google/sugerirBloqueGasto";
import type { BloqueEscritura } from "../google/cashflowWrite";
import { montosCercanos } from "../utils/montos";
import { textosParecidos } from "../utils/textoParecido";
import { obtenerTodosLosDuplicadosConfirmados, type FilaDuplicado } from "../cashflow/duplicadosConfirmadosSheet";

const TOLERANCIA_EUR = 0.01;
// Tolerancia más ancha para montos que vienen de una conversión de divisa
// (accounting_amount, ver valorEnEuros) — verificado en vivo un caso real:
// Holded convirtió un abono en USD a 7.964,16 €, pero el cashflow lo tenía
// registrado a mano en 7.964,17 € (redondeo de tipo de cambio distinto al
// calcular en momentos diferentes) — la diferencia real es de un céntimo,
// legítima, no un error de nadie.
const TOLERANCIA_EUR_CONVERTIDO = 0.05;
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


/**
 * Convierte el ranking de sugerirCategoriasGasto en opciones de botón: solo
 * las categorías realmente escribibles (bloque != null) con alguna
 * coincidencia real (score > 0), hasta 3. Si ninguna categoría tuvo
 * coincidencia (proveedor nunca visto antes), cae a "Pagos Extras" — el
 * catch-all histórico — en vez de no ofrecer ninguna opción.
 */
// Alternativas genéricas para completar hasta 3 opciones cuando el
// clasificador no tiene (o no tiene suficiente) coincidencia real — pedido
// explícito: siempre sugerir una categoría PERO TAMBIÉN dar alternativa
// para cambiarla, nunca un solo botón sin opción de corregir.
const CATEGORIAS_ALTERNATIVA_GENERICA: Array<{ bloque: BloqueEscritura; etiqueta: string }> = [
  { bloque: "pagos_extras", etiqueta: "Pagos Extras" },
  { bloque: "gastos_fijos", etiqueta: "Gastos Fijos" },
  { bloque: "pagos_proyectos", etiqueta: "Pagos Proyectos" },
];

function construirOpcionesBloque(
  categorias: CategoriaSugerida[] | undefined
): Array<{ bloque: BloqueEscritura; etiqueta: string }> {
  const escribibles = (categorias ?? [])
    .filter((c): c is CategoriaSugerida & { bloque: BloqueEscritura } => c.bloque !== null && c.score > 0)
    .slice(0, 3)
    .map((c) => ({ bloque: c.bloque, etiqueta: c.etiqueta }));

  const opciones = [...escribibles];
  for (const alternativa of CATEGORIAS_ALTERNATIVA_GENERICA) {
    if (opciones.length >= 3) break;
    if (!opciones.some((o) => o.bloque === alternativa.bloque)) opciones.push(alternativa);
  }

  return opciones;
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

/**
 * El cashflow SIEMPRE está en EUR, pero varias cuentas de Holded operan en
 * otras divisas (USD, GBP...) — `amount` viene en la divisa nativa de la
 * cuenta. Cuando `currency` no es EUR, Holded ya trae el equivalente
 * convertido en `accounting_amount`/`accounting_currency` (visible en el
 * propio Holded como la cifra en gris debajo del monto) — verificado en
 * vivo (pedido explícito de Carlos, con capturas de Holded): comparar el
 * monto nativo en USD contra el cashflow en EUR daba falsos "sin
 * registrar" para movimientos que sí estaban, solo que registrados por su
 * valor ya convertido a euros.
 */
function valorEnEuros(mov: BankMovement): number {
  const monedaNativa = (mov.currency ?? "EUR").toUpperCase();
  if (monedaNativa !== "EUR" && mov.accounting_amount != null) {
    const convertido =
      typeof mov.accounting_amount === "number" ? mov.accounting_amount : Number(mov.accounting_amount);
    if (Number.isFinite(convertido)) return convertido;
  }
  const nativo = typeof mov.amount === "number" ? mov.amount : Number(mov.amount ?? 0);
  return Number.isFinite(nativo) ? nativo : 0;
}

export interface PosibleDuplicado {
  descripcionRegistro: string;
  /** Monto ya registrado en el cashflow para la fila parecida — necesario para registrarDuplicadoConfirmado si el usuario confirma. */
  montoRegistrado: number;
  /** true si hizo falta el margen APRENDIDO (más ancho que el genérico de 5€) para reconocerlo — ver duplicadosConfirmadosSheet.ts. */
  aprendido: boolean;
}

export interface CandidatoNoRegistrado {
  empresa: EmpresaCashflow;
  descripcion: string;
  fecha?: string;
  valorAbs: number;
  esIngreso: boolean;
  /** Solo para gastos (esIngreso=false) — categorías candidatas rankeadas, ver sugerirBloqueGasto.ts. */
  categoriasSugeridas?: CategoriaSugerida[];
  /** Si hay una fila ya registrada con nombre parecido y monto cercano (no exacto). */
  posibleDuplicadoDe?: PosibleDuplicado;
}

// Un mismo proveedor a veces cambia de tarifa entre facturas (ej. "Banahosting"
// registrado en 204,68€ una semana y el cargo real de Holded llega en
// 208,73€ la siguiente) — la diferencia es real, no un error, pero el
// monto no coincide dentro de la tolerancia normal (1 céntimo). Pedido
// explícito: cuando el NOMBRE es parecido Y el monto está razonablemente
// cerca, se avisa como posible duplicado en vez de proponerlo como un
// movimiento nuevo sin más — NUNCA se decide sola cuál es, siempre
// pregunta con botón, sin excepción, ni siquiera cuando ya hay un caso
// aprendido de ese mismo proveedor (el aprendizaje solo hace que dude
// MENOS con el tiempo — más contexto en la pregunta, un margen más ancho
// si el proveedor ya mostró antes esa variación — nunca que deje de
// preguntar).
const POSIBLE_DUPLICADO_TOLERANCIA_EUR = 5;

function buscarPosibleDuplicado(
  descripcion: string,
  empresa: EmpresaCashflow,
  valorAbs: number,
  registrosSemana: Array<{ cliente?: string; concepto?: string; semana: string; valor: string }>,
  duplicadosAprendidos: FilaDuplicado[]
): PosibleDuplicado | undefined {
  const aprendidosDeEsteProveedor = duplicadosAprendidos.filter(
    (d) => d.empresa === empresa && textosParecidos(descripcion, d.proveedor)
  );
  const toleranciaAprendida =
    aprendidosDeEsteProveedor.length > 0 ? Math.max(...aprendidosDeEsteProveedor.map((d) => d.diferencia)) : 0;
  const toleranciaEfectiva = Math.max(POSIBLE_DUPLICADO_TOLERANCIA_EUR, toleranciaAprendida);

  const match = registrosSemana.find((r) => {
    const textoRegistro = [r.cliente, r.concepto].filter(Boolean).join(" ");
    if (!textoRegistro) return false;
    if (!textosParecidos(descripcion, textoRegistro)) return false;
    const valorRegistro = Math.abs(parseValorFormateado(r.valor));
    return montosCercanos(valorRegistro, valorAbs, toleranciaEfectiva) && !montosCercanos(valorRegistro, valorAbs, TOLERANCIA_EUR);
  });

  if (!match) return undefined;

  return {
    descripcionRegistro: `${match.cliente ?? match.concepto} — ${match.semana} — ${match.valor}`,
    montoRegistrado: Math.abs(parseValorFormateado(match.valor)),
    aprendido: aprendidosDeEsteProveedor.length > 0,
  };
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
  const todosLosRegistros = await fetchDetalleRegistros();
  const registrosSemana = todosLosRegistros.filter(
    (r) => r.semana.toUpperCase() === semanaLabel && CATEGORIAS_EJECUCION_SEMANAL.has(r.categoria)
  );
  const duplicadosAprendidos = await obtenerTodosLosDuplicadosConfirmados().catch((error) => {
    console.error("[revisarHoldedVsCashflow] Error leyendo duplicados aprendidos (no crítico):", error);
    return [] as FilaDuplicado[];
  });

  const valoresRegistrados = registrosSemana.map((r) => Math.abs(parseValorFormateado(r.valor)));

  const sinMatchIndividual: CandidatoNoRegistrado[] = [];

  for (const mov of movimientosHolded) {
    if (esMovimientoInternoOConversion(mov.description)) continue;

    const amountEur = valorEnEuros(mov);
    const valorAbs = Math.abs(amountEur);
    const esConvertido = (mov.currency ?? "EUR").toUpperCase() !== "EUR";
    const tolerancia = esConvertido ? TOLERANCIA_EUR_CONVERTIDO : TOLERANCIA_EUR;

    const yaExiste = valoresRegistrados.some((v) => montosCercanos(v, valorAbs, tolerancia));
    if (yaExiste) continue; // conservador: si hay duda razonable de match, no se propone

    sinMatchIndividual.push({
      empresa,
      descripcion: mov.description ?? "(sin descripción)",
      fecha: mov.booking_date?.slice(0, 10),
      valorAbs,
      esIngreso: amountEur > 0,
    });
  }

  // Segunda pasada, pedida explícitamente: varios cargos del mismo
  // proveedor (ej. varias compras de "Www.amazon" la misma semana) a veces
  // no se registran uno a uno en el cashflow, sino como un solo total
  // agrupado. Se agrupan por descripción exacta (normalizada) los que NO
  // matchearon individualmente, y si la SUMA del grupo sí coincide con
  // algún valor ya registrado, se da por registrado el grupo completo —
  // mismo criterio conservador que el match individual (tolerancia de 1
  // céntimo, nunca inventa un total que no está). Grupos de un solo
  // movimiento no aportan nada nuevo (ya se probaron arriba), se dejan tal
  // cual.
  const porDescripcion = new Map<string, CandidatoNoRegistrado[]>();
  for (const c of sinMatchIndividual) {
    const clave = c.descripcion.trim().toLowerCase();
    const grupo = porDescripcion.get(clave);
    if (grupo) grupo.push(c);
    else porDescripcion.set(clave, [c]);
  }

  const candidatos: CandidatoNoRegistrado[] = [];
  for (const grupo of porDescripcion.values()) {
    if (grupo.length > 1) {
      const suma = grupo.reduce((acc, c) => acc + c.valorAbs, 0);
      const sumaYaExiste = valoresRegistrados.some((v) => montosCercanos(v, suma, TOLERANCIA_EUR));
      if (sumaYaExiste) continue;
    }
    candidatos.push(...grupo);
  }

  // Clasifica solo los gastos (los ingresos se resuelven solos por el
  // signo) contra TODO el historial de la empresa, sin filtrar por semana —
  // hace falta suficiente historial para que la comparación por palabras
  // parecidas tenga con qué comparar (ver sugerirBloqueGasto.ts).
  for (const candidato of candidatos) {
    if (!candidato.esIngreso) {
      candidato.categoriasSugeridas = sugerirCategoriasGasto(candidato.descripcion, todosLosRegistros);
    }
    candidato.posibleDuplicadoDe = buscarPosibleDuplicado(
      candidato.descripcion,
      candidato.empresa,
      candidato.valorAbs,
      registrosSemana,
      duplicadosAprendidos
    );
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
  const valoresBanco = movimientosHolded.map((m) => Math.abs(valorEnEuros(m)));

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

    const yaEnBanco = valoresBanco.some((v) => montosCercanos(v, valorAbs, TOLERANCIA_EUR));
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
 * Crea la propuesta (fila en _propuestas_pendientes) y manda el mensaje con
 * botones de categoría para UN candidato — extraído de revisarHoldedVsCashflow
 * para poder reutilizarlo también desde el tool conversacional
 * proponer_registro_cashflow (core/tools/proponerRegistroCashflow.ts), que
 * dispara el MISMO flujo de aprobación bajo demanda en vez de esperar al
 * cron del viernes/lunes. Nunca escribe nada por sí sola — solo propone.
 * Devuelve true si se envió correctamente.
 */
export async function enviarPropuestaCandidato(
  chatId: number,
  candidato: CandidatoNoRegistrado,
  semanaLabel: string,
  esChequeoPreliminar: boolean
): Promise<boolean> {
  const opciones = candidato.esIngreso
    ? [{ bloque: "ingresos" as BloqueEscritura, etiqueta: "Ingresos" }]
    : construirOpcionesBloque(candidato.categoriasSugeridas);
  const bloqueSugerido = opciones[0].bloque;

  const mejorSugerencia = candidato.categoriasSugeridas?.[0];
  const notaNoEscribible =
    mejorSugerencia && mejorSugerencia.bloque === null && mejorSugerencia.score > 0
      ? `\n\n⚠️ Por el concepto, esto se parece más a "${mejorSugerencia.etiqueta}" — esa categoría todavía no tiene ` +
        `escritura automática, regístralo a mano en el Sheet si aplica.`
      : "";

  const notaPosibleDuplicado = candidato.posibleDuplicadoDe
    ? `\n\n🔎 POSIBLE DUPLICADO — ya hay una fila parecida registrada esta semana: "${candidato.posibleDuplicadoDe.descripcionRegistro}". ` +
      `El monto no es idéntico (puede ser un cambio de tarifa real, o el mismo pago con una cifra distinta) — ` +
      (candidato.posibleDuplicadoDe.aprendido
        ? `ya has confirmado antes un caso parecido con este proveedor. `
        : "") +
      `¿es el mismo pago (usa "🔁 Es duplicado") o es realmente otro cargo aparte (entonces elige la categoría)?`
    : "";

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
    `¿A qué categoría corresponde?`,
  ].join("\n") + notaPosibleDuplicado + notaNoEscribible;

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
      montoDuplicado: candidato.posibleDuplicadoDe?.montoRegistrado,
    });
    propuestaId = propuesta.id;

    const botones = [
      ...opciones.map((o) => [{ text: `✅ ${o.etiqueta}`, callback_data: `cf_approve:${propuesta.id}:${o.bloque}` }]),
      ...(candidato.posibleDuplicadoDe
        ? [[{ text: "🔁 Es duplicado", callback_data: `cf_duplicado:${propuesta.id}` }]]
        : []),
      [{ text: "❌ Ignorar", callback_data: `cf_reject:${propuesta.id}` }],
    ];

    const messageId = await sendTelegramMessageWithButtons(chatId, texto, botones);

    await actualizarMessageId(propuesta.id, messageId);
    return true;
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
    return false;
  }
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
      const enviada = await enviarPropuestaCandidato(chatId, candidato, semanaLabel, esChequeoPreliminar);
      if (enviada) propuestasCreadas++;
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
