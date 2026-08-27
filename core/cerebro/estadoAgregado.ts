import { fetchResumenSemanas, type ResumenSemana } from "../google/cashflowSheet";
import { listarPropuestasPendientes } from "../google/proposalSheet";
import { parseValorFormateado } from "../jobs/revisarHoldedVsCashflow";
import { loadCalendarioFiscal, calcularProximasAlertas, calcularProximaFecha } from "../fiscal/calendario";
import { contarFacturasRecientes, listarProximosEventosHolded, buscarGastosSinComprobante } from "../holded/write";
import { contarMovimientosSinConciliar } from "../holded/client";
import type { Empresa } from "../holded/client";
import { contarNoLeidos } from "../gmail/client";
import { obtenerUltimoCheck } from "../gmail/lastCheckStore";
import { contarBorradoresPendientes } from "../gmail/emailDraftStore";
import { listarArchivosRecientesPorRaiz } from "../drive/client";
import { ROOT_FOLDERS } from "../drive/rootFolders";
import { obtenerModoRetrieval, obtenerIndiceDocumentos } from "../knowledge/loader";
import { obtenerCapturasCrudas } from "../knowledge/capturaSheet";
import { obtenerCorreccionesCrudas } from "../knowledge/correctionsStore";
import { obtenerUsuariosAutorizados } from "../telegram/authorizedUsersSheet";
import { obtenerResumenCostos, obtenerCostoPorDia } from "../claude/costTracking";
import { UMBRAL_ANOMALIA } from "../jobs/revisarCostosIA";
import { obtenerUltimoRunHoldedCashflow } from "../jobs/holdedCashflowLastRunStore";
import { mondayOf, lunesDeEtiquetaSemana, weekLabel } from "../utils/isoWeek";
import { formatDateLocal } from "../utils/dateFormat";

const EMPRESAS_HOLDED: Empresa[] = ["WOBA", "EWORKS", "Footprint"];

/**
 * Ejecuta `fn` y devuelve su resultado, o `fallback` + log de error si falla
 * — así una fuente de datos caída (Holded, Gmail, Drive...) no tumba todo el
 * endpoint, solo deja esa sección en su valor por defecto.
 */
async function seguro<T>(etiqueta: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.error(`[cerebro/estadoAgregado] Error en "${etiqueta}":`, error);
    return fallback;
  }
}

const NOMBRES_MES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/**
 * Balance mensual del MES ACTUAL (el que contiene `hoy`) — nunca "el mes más
 * reciente que tenga datos", porque la hoja CASHFLOW arrastra balanceFinal
 * por fórmula hacia semanas futuras (confirmado en vivo: S44/octubre tenía
 * balanceFinal "lleno" con income/gastos en "-", puro arrastre, mientras
 * S35/agosto — la semana real de hoy — tenía actividad real) — así que
 * "última semana con balanceFinal no vacío" casi siempre apunta a un mes
 * futuro, no al actual. Se agrupa por el mes de cada semana (ver
 * lunesDeEtiquetaSemana) y se toma explícitamente el mes de `hoy`, exista o
 * no en la hoja. NUNCA se suman los "balanceFinal" semanales entre sí (son
 * un saldo/nivel en un punto del tiempo, no un flujo) — el balance del mes
 * es el balanceFinal de la última semana que cae en ese mes; ingresos y
 * gastos sí se suman (son flujos reales de ese mes).
 */
function calcularBalanceMesActual(conDatos: ResumenSemana[], hoy: Date) {
  if (conDatos.length === 0) return null;

  const claveMesActual = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;

  const semanasDelMes = conDatos.filter((s) => {
    const lunes = lunesDeEtiquetaSemana(s.semana, hoy);
    if (!lunes) return false;
    return `${lunes.getFullYear()}-${String(lunes.getMonth() + 1).padStart(2, "0")}` === claveMesActual;
  });

  if (semanasDelMes.length === 0) return null;

  const ultimaSemanaDelMes = semanasDelMes[semanasDelMes.length - 1];

  return {
    mesLabel: `${NOMBRES_MES[hoy.getMonth()]} ${hoy.getFullYear()}`,
    semanasIncluidas: semanasDelMes.map((s) => s.semana),
    ingresos: semanasDelMes.reduce((acc, s) => acc + parseValorFormateado(s.income), 0),
    gastos: semanasDelMes.reduce(
      (acc, s) => acc + parseValorFormateado(s.projectExpenses) + parseValorFormateado(s.generalExpenses),
      0
    ),
    balanceFinal: parseValorFormateado(ultimaSemanaDelMes.balanceFinal),
  };
}

async function construirCashflow() {
  const [semanas, propuestas, ultimoRunUnix] = await Promise.all([
    seguro("cashflow.semanas", fetchResumenSemanas, [] as Awaited<ReturnType<typeof fetchResumenSemanas>>),
    seguro("cashflow.propuestas", listarPropuestasPendientes, [] as Awaited<ReturnType<typeof listarPropuestasPendientes>>),
    seguro("cashflow.ultimoRun", obtenerUltimoRunHoldedCashflow, undefined as number | undefined),
  ]);

  const conDatos = semanas.filter((s) => s.balanceFinal.trim() !== "");
  const hoy = new Date();

  // La semana ACTUAL real (no "la última con balanceFinal no vacío" — ver
  // nota en calcularBalanceMesActual, el mismo arrastre por fórmula aplica
  // acá). Si por lo que sea la semana de hoy todavía no tiene fila en la
  // hoja (ej. el cron semanal no ha corrido aún), cae a la semana pasada más
  // cercana con datos reales — nunca a una futura.
  const etiquetaSemanaActual = weekLabel(hoy);
  const semanaActual =
    conDatos.find((s) => s.semana === etiquetaSemanaActual) ??
    [...conDatos].reverse().find((s) => {
      const lunes = lunesDeEtiquetaSemana(s.semana, hoy);
      return lunes ? lunes <= hoy : false;
    });

  const balanceUltimaSemana = semanaActual
    ? {
        semana: semanaActual.semana,
        ingresos: parseValorFormateado(semanaActual.income),
        gastos: parseValorFormateado(semanaActual.projectExpenses) + parseValorFormateado(semanaActual.generalExpenses),
        balanceFinal: parseValorFormateado(semanaActual.balanceFinal),
      }
    : null;

  const balanceUltimoMes = calcularBalanceMesActual(conDatos, hoy);

  // Catálogo de pagos recurrentes conocidos (calendario_fiscal.json) — solo
  // WOBA/EWORKS, porque este nodo es específicamente "cashflow" y Footprint
  // no tiene cashflow en Sheets (sus pagos recurrentes sí existen, pero solo
  // en Holded — ver holded.porEmpresa). "monto" es siempre null: el importe
  // de un pago recurrente NO está fijo en calendario_fiscal.json, se pide al
  // usuario cada vez que se registra (puede variar año a año) — no hay una
  // fuente de "monto esperado" que no sea inventada.
  const pagosRecurrentes = loadCalendarioFiscal()
    .filter((e) => e.empresaHolded === "WOBA" || e.empresaHolded === "EWORKS")
    .map((e) => ({
      concepto: e.concepto,
      empresa: e.empresaHolded as "WOBA" | "EWORKS",
      periodicidad: e.tipo,
      monto: null as number | null,
    }));

  const propuestasPendientes = propuestas.map((p) => ({
    concepto: p.clienteOConcepto,
    empresa: p.empresa,
    semana: p.semana,
    monto: p.valor,
    detectadoEn: new Date(p.creadoEn).toISOString(),
  }));

  // Alertas de pagos recurrentes que el cron diario (revisarAlertasFiscales)
  // ya está generando/mandando por Telegram AHORA MISMO — mismo cálculo
  // exacto (calcularProximasAlertas, sin I/O extra, solo lee el JSON local),
  // filtrado a las que son de cashflow (WOBA/EWORKS). Antes esto era
  // invisible en este panel: "pagosRecurrentes" solo mostraba el catálogo
  // fijo, nunca lo que el sistema está generando internamente en este
  // momento (Wobi ya sabe que esto vence pronto y ya lo está avisando,
  // aunque todavía no exista ningún movimiento en Holded/cashflow).
  const alertasPagosRecurrentesProximas = seguroSync(
    () =>
      calcularProximasAlertas(new Date())
        .filter((a) => a.empresaHolded === "WOBA" || a.empresaHolded === "EWORKS")
        .map((a) => ({
          concepto: a.concepto,
          empresa: a.empresaHolded as "WOBA" | "EWORKS",
          proveedor: a.proveedor ?? null,
          venceEn: formatDateLocal(a.fecha),
          diasRestantes: a.diasParaVencer,
        })),
    []
  );

  return {
    linkSheet: `https://docs.google.com/spreadsheets/d/${process.env.CASHFLOW_SHEET_ID ?? ""}/edit`,
    balanceUltimaSemana,
    balanceUltimoMes,
    pagosRecurrentes,
    alertasPagosRecurrentesProximas,
    propuestasPendientes,
    // Instrumentado el 2026-08-26 (core/jobs/holdedCashflowLastRunStore.ts,
    // mismo patrón que _gmail_ultimo_check) — antes el cron solo escribía a
    // console.log, sin dejar ningún registro persistente.
    ultimaDeteccionHolded: ultimoRunUnix ? new Date(ultimoRunUnix * 1000).toISOString() : null,
  };
}

async function construirHolded() {
  const DIAS_RECIENTES = 7;

  const porEmpresaEntries = await Promise.all(
    EMPRESAS_HOLDED.map(async (empresa) => {
      const [facturas, sinComprobante, sinConciliar] = await Promise.all([
        seguro(`holded.facturas.${empresa}`, () => contarFacturasRecientes(empresa, DIAS_RECIENTES), 0),
        seguro(
          `holded.sinComprobante.${empresa}`,
          async () => (await buscarGastosSinComprobante(empresa, formatDateLocal(new Date(Date.now() - 90 * 86400000)), formatDateLocal(new Date()))).sinComprobante.length,
          0
        ),
        seguro(`holded.sinConciliar.${empresa}`, () => contarMovimientosSinConciliar(empresa, 90), 0),
      ]);

      return [empresa, { facturasUltimos7dias: facturas, gastosSinComprobante: sinComprobante, movimientosSinConciliar: sinConciliar }] as const;
    })
  );

  const porEmpresa = Object.fromEntries(porEmpresaEntries) as Record<
    Empresa,
    { facturasUltimos7dias: number; gastosSinComprobante: number; movimientosSinConciliar: number }
  >;

  return {
    // Suma de TODOS los documentos de compra creados en Holded en los
    // últimos 7 días, en las 3 empresas — no distingue si lo creó el
    // asistente o si se cargó a mano en Holded, porque no existe ninguna
    // etiqueta que los separe.
    facturasProcesadasUltimos7dias: Object.values(porEmpresa).reduce((acc, e) => acc + e.facturasUltimos7dias, 0),
    // gastosSinComprobante / movimientosSinConciliar: ventana de 90 días,
    // igual que el comportamiento por defecto de los tools existentes
    // (consultar_gastos_sin_comprobante, consultar_movimientos_sin_conciliar).
    gastosSinComprobante: Object.values(porEmpresa).reduce((acc, e) => acc + e.gastosSinComprobante, 0),
    movimientosSinConciliar: Object.values(porEmpresa).reduce((acc, e) => acc + e.movimientosSinConciliar, 0),
    porEmpresa,
  };
}

async function construirCrm() {
  const DIAS_FUTURO = 30;

  const listas = await Promise.all(
    EMPRESAS_HOLDED.map((empresa) => seguro(`crm.eventos.${empresa}`, () => listarProximosEventosHolded(empresa, DIAS_FUTURO), []))
  );

  return {
    actividadesProgramadas: listas.flat(),
    // No existe ningún log/auditoría de "qué acción se ejecutó, cuándo y
    // quién la aprobó" en todo el sistema (ni para gastos, ni eventos, ni
    // correos enviados) — cada módulo solo persiste su propuesta MIENTRAS
    // está pendiente y la borra al resolverse, no guarda un historial.
    // Dejar en null en vez de inventar: instrumentar esto requeriría un
    // store de auditoría nuevo, no reusar uno existente.
    accionesRecientes: null as unknown[] | null,
  };
}

async function construirCorreo() {
  const [noLeidos, ultimoCheckUnix, borradoresPendientes] = await Promise.all([
    seguro("correo.noLeidos", contarNoLeidos, 0),
    seguro("correo.ultimoCheck", obtenerUltimoCheck, 0),
    // emailDraftStore vive en disco local (ephemeral) — cuenta lo que este
    // proceso conoce desde su último arranque, ver nota en el store mismo.
    seguro("correo.borradores", contarBorradoresPendientes, 0),
  ]);

  return {
    correosNoLeidos: noLeidos,
    ultimoProcesado: ultimoCheckUnix > 0 ? new Date(ultimoCheckUnix * 1000).toISOString() : null,
    borradoresPendientesDeAprobacion: borradoresPendientes,
  };
}

async function construirFiscal() {
  // Misma ventana que usa el cron real (revisarAlertasFiscales): 3 días para
  // mensuales con día exacto, 7 para el resto — sin override, para que este
  // campo refleje EXACTAMENTE lo que el bot ya alertó o alertará por su cuenta.
  const alertas = seguroSync(() => calcularProximasAlertas(new Date()), []);

  // El catálogo COMPLETO (no solo lo que cae en ventana de aviso ahora
  // mismo) — antes solo se veían las alertas inminentes, y en un día
  // cualquiera eso puede ser 0 o 1 entradas de las 20+ que existen, dando la
  // impresión de que "faltan" pagos recurrentes que en realidad sí están
  // catalogados, solo que no vencen pronto. A diferencia del catálogo que
  // muestra el nodo Cashflow (solo WOBA/EWORKS, porque ese nodo es
  // específicamente cashflow en Sheets), este incluye las 3 empresas —
  // Footprint no tiene cashflow en Sheets pero sí tiene pagos recurrentes
  // reales catalogados (Adobe, Canva, Google Workspace, etc.).
  const catalogoPagosRecurrentes = seguroSync(() => {
    const hoy = new Date();
    return loadCalendarioFiscal().map((e) => ({
      concepto: e.concepto,
      empresa: e.empresa,
      periodicidad: e.tipo,
      proximaFecha: formatDateLocal(calcularProximaFecha(e, hoy)),
    }));
  }, []);

  return {
    proximasAlertas: alertas.map((a) => ({
      concepto: a.concepto,
      empresa: a.empresa,
      venceEn: formatDateLocal(a.fecha),
      diasRestantes: a.diasParaVencer,
    })),
    catalogoPagosRecurrentes,
  };
}

function seguroSync<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    console.error("[cerebro/estadoAgregado] Error síncrono:", error);
    return fallback;
  }
}

async function construirDrive() {
  const DIAS_RECIENTES = 7;
  const desdeISO = new Date(Date.now() - DIAS_RECIENTES * 86400000).toISOString();

  const empresasPorFolderId = Object.fromEntries(Object.entries(ROOT_FOLDERS).map(([empresa, folderId]) => [folderId, empresa]));
  const folderIds = Object.values(ROOT_FOLDERS);

  const porRaiz = await seguro(
    "drive.recientes",
    () => listarArchivosRecientesPorRaiz(folderIds, desdeISO),
    Object.fromEntries(folderIds.map((id) => [id, []])) as Record<string, Array<{ name: string; createdTime: string; webViewLink: string }>>
  );

  // Sin filtro por nombre: los archivos del sistema de Backup en desarrollo
  // aparte (_execution_log, _manifest.json, ingresos_EWORKS_*, etc.) los
  // borra ese mismo proceso — no son permanentes, así que no vale la pena
  // excluirlos aquí. Cuenta TODO lo que Drive reporta como creado en la
  // ventana, tal cual.
  const todos = Object.entries(porRaiz)
    .flatMap(([folderId, archivos]) => archivos.map((a) => ({ ...a, empresa: empresasPorFolderId[folderId] })))
    .sort((a, b) => (b.createdTime > a.createdTime ? 1 : -1));

  const ultimo = todos[0];

  const porEmpresa = Object.fromEntries(
    Object.entries(ROOT_FOLDERS).map(([empresa, folderId]) => [empresa, { archivosUltimos7dias: (porRaiz[folderId] ?? []).length }])
  ) as Record<string, { archivosUltimos7dias: number }>;

  return {
    archivosSubidosUltimos7dias: todos.length,
    ultimoArchivo: ultimo ? { nombre: ultimo.name, empresa: ultimo.empresa, fecha: ultimo.createdTime } : null,
    porEmpresa,
  };
}

// Antes este panel solo mostraba conteos y timestamps ("5 documentos",
// "hace 6h") sin decir de QUÉ documentos se trata ni QUÉ se capturó o
// corrigió — el dato ya se leía completo (capturas/correcciones) pero se
// descartaba todo menos la fecha. Ahora se expone el contenido real.
const MAX_ITEMS_RECIENTES = 5;

async function construirConocimiento() {
  const [modo, capturas, correcciones] = await Promise.all([
    seguro("conocimiento.modo", async () => obtenerModoRetrieval(), { modo: "carga_completa" as const, tamanoTotalCaracteres: 0, umbralCaracteres: 0, documentos: 0 }),
    seguro("conocimiento.capturas", obtenerCapturasCrudas, []),
    seguro("conocimiento.correcciones", obtenerCorreccionesCrudas, []),
  ]);

  const indiceDocumentos = seguroSync(() => obtenerIndiceDocumentos(), []);

  const ultimaCaptura = capturas.length > 0 ? capturas[capturas.length - 1].fecha : null;
  const ultimaCorreccion = correcciones.length > 0 ? correcciones[correcciones.length - 1].fecha : null;

  const primeraLinea = (texto: string) => texto.split("\n").find((l) => l.trim().length > 0)?.trim().slice(0, 160) ?? "";

  const ultimasCapturas = capturas
    .slice(-MAX_ITEMS_RECIENTES)
    .reverse()
    .map((c) => ({ fecha: c.fecha, autor: c.autor, empresas: c.empresas, resumen: primeraLinea(c.texto) }));

  const ultimasCorrecciones = correcciones
    .slice(-MAX_ITEMS_RECIENTES)
    .reverse()
    .map((c) => ({ fecha: c.fecha, antes: c.contextoPrevio.slice(0, 140), ahora: c.correccion.slice(0, 200) }));

  return {
    documentos: modo.documentos,
    listaDocumentos: indiceDocumentos,
    modoActual: modo.modo,
    // "carga_completa" y "scoring" son nombres internos sin sentido para
    // quien no programó el sistema — se traduce a una frase clara.
    explicacionModo:
      modo.modo === "carga_completa"
        ? "Todos los documentos caben completos en cada consulta — no hace falta elegir cuáles son relevantes."
        : "Hay demasiado contenido para mandarlo completo en cada consulta — se seleccionan los documentos más relevantes según palabras clave de la pregunta.",
    ultimaCaptura,
    ultimaCorreccion,
    totalCapturas: capturas.length,
    totalCorrecciones: correcciones.length,
    ultimasCapturas,
    ultimasCorrecciones,
  };
}

async function construirAccesos() {
  const [usuarios, costoHoy, costoSemana, costosPor7Dias] = await Promise.all([
    seguro("accesos.usuarios", obtenerUsuariosAutorizados, []),
    seguro("accesos.costoHoy", async () => {
      const hoy = new Date();
      const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
      const manana = new Date(inicioHoy.getTime() + 86400000);
      return (await obtenerResumenCostos(inicioHoy, manana)).costoUSD;
    }, 0),
    seguro("accesos.costoSemana", async () => {
      const hoy = new Date();
      const inicioSemana = mondayOf(hoy);
      const manana = new Date(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).getTime() + 86400000);
      return (await obtenerResumenCostos(inicioSemana, manana)).costoUSD;
    }, 0),
    seguro("accesos.costosPor7Dias", () => obtenerCostoPorDia(7, new Date()), [] as number[]),
  ]);

  const promedio7Dias = costosPor7Dias.reduce((a, b) => a + b, 0) / (costosPor7Dias.length || 1);

  return {
    usuariosAutorizados: {
      admins: usuarios.filter((u) => u.rol === "admin").length,
      colaboradores: usuarios.filter((u) => u.rol === "colaborador").length,
    },
    costoIaHoy: costoHoy,
    costoIaEstaSemana: costoSemana,
    // Umbral DINÁMICO: no es un número fijo, es promedio de los últimos 7
    // días * UMBRAL_ANOMALIA — el mismo cálculo exacto que usa
    // revisarCostosIA.ts para decidir si avisar de un gasto inusual.
    umbraLAlertaCosto: promedio7Dias * UMBRAL_ANOMALIA,
  };
}

export interface EstadoCerebroDatos {
  cashflow: Awaited<ReturnType<typeof construirCashflow>>;
  holded: Awaited<ReturnType<typeof construirHolded>>;
  crm: Awaited<ReturnType<typeof construirCrm>>;
  correo: Awaited<ReturnType<typeof construirCorreo>>;
  fiscal: Awaited<ReturnType<typeof construirFiscal>>;
  drive: Awaited<ReturnType<typeof construirDrive>>;
  conocimiento: Awaited<ReturnType<typeof construirConocimiento>>;
  accesos: Awaited<ReturnType<typeof construirAccesos>>;
}

export interface EstadoCerebro extends EstadoCerebroDatos {
  /** Instante de ESTA respuesta HTTP — cambia en cada request, cacheado o no. */
  generadoEn: string;
  /** Instante en que se calcularon realmente los datos de abajo — solo cambia cada CACHE_TTL_MS. Compara con generadoEn para saber si esta respuesta vino del caché. */
  cacheadoEn: string;
}

/**
 * Agrega el estado actual de todos los módulos del sistema, para el front
 * del "cerebro" (dashboard de solo lectura). Reutiliza los mismos
 * clientes/lógica que ya usan los tools y crons — no llama a ninguna
 * función de escritura, en ningún caso. Cada sección se calcula por
 * separado y de forma tolerante a fallos (ver `seguro`): si una fuente
 * falla, esa sección queda en su valor por defecto en vez de tumbar todo
 * el endpoint.
 */
async function construirEstadoCerebro(): Promise<EstadoCerebroDatos> {
  const [cashflow, holded, crm, correo, fiscal, drive, conocimiento, accesos] = await Promise.all([
    construirCashflow(),
    construirHolded(),
    construirCrm(),
    construirCorreo(),
    construirFiscal(),
    construirDrive(),
    construirConocimiento(),
    construirAccesos(),
  ]);

  return { cashflow, holded, crm, correo, fiscal, drive, conocimiento, accesos };
}

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { datos: EstadoCerebroDatos; cacheadoEnMs: number } | null = null;
let recalculoEnCurso: Promise<{ datos: EstadoCerebroDatos; cacheadoEnMs: number }> | null = null;

/**
 * Caché de proceso de 5 minutos: agregar todo (Sheets, Holded ×3 empresas,
 * Drive, Gmail...) toma 12-22s en vivo, demasiado para que un front lo pida
 * en cada carga de página. `cacheadoEn` en la respuesta indica cuándo se
 * calcularon realmente los datos — si es igual a `generadoEn`, esta
 * respuesta se calculó de cero; si es anterior, vino del caché.
 * `recalculoEnCurso` evita que dos requests simultáneas que lleguen justo
 * cuando el caché expiró disparen el cálculo completo dos veces en paralelo.
 */
export async function obtenerEstadoCerebro(): Promise<EstadoCerebro> {
  const ahora = Date.now();

  if (!cache || ahora - cache.cacheadoEnMs >= CACHE_TTL_MS) {
    if (!recalculoEnCurso) {
      recalculoEnCurso = construirEstadoCerebro()
        .then((datos) => ({ datos, cacheadoEnMs: Date.now() }))
        .finally(() => {
          recalculoEnCurso = null;
        });
    }
    cache = await recalculoEnCurso;
  }

  return {
    generadoEn: new Date().toISOString(),
    cacheadoEn: new Date(cache.cacheadoEnMs).toISOString(),
    ...cache.datos,
  };
}
