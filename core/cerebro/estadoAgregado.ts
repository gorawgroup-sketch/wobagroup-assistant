import { crearOrquestadorEstado, type DefinicionSeccion, type ResultadoSeccion } from "./estadoOrquestador";
import { ConteosHoldedPesados, type ConteosHolded } from "./conteosHolded";
import { contarSuscriptoresCerebro, publicarCambioCerebro } from "./realtime";
import { LecturaFuentes, type EstadoFuente } from "./lecturaFuentes";
import { obtenerEstadoConexiones, type ConexionEstado } from "./conexiones";
import { fetchResumenSemanas, invalidarCachesCashflow, type ResumenSemana } from "../google/cashflowSheet";
import { listarPropuestasPendientes } from "../google/proposalSheet";
import { parseValorFormateado } from "../jobs/revisarHoldedVsCashflow";
import { loadCalendarioFiscal, calcularProximasAlertas, calcularProximaFecha } from "../fiscal/calendario";
import { contarFacturasRecientes, listarProximosEventosHolded, buscarGastosSinComprobante, invalidarCacheEventosHolded } from "../holded/write";
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
import { obtenerUltimoRunHoldedCashflow } from "../jobs/holdedCashflowLastRunStore";
import { lunesDeEtiquetaSemana, weekLabel } from "../utils/isoWeek";
import { formatDateLocal } from "../utils/dateFormat";
import { construirControlDiario, type ControlDiario } from "./controlDiario";
import {
  obtenerEstadoAuditoriaProgramada,
  type EstadoAuditoriaProgramadaFront,
} from "./auditoriaProgramadaStore";

const EMPRESAS_HOLDED: Empresa[] = ["WOBA", "EWORKS", "Footprint"];

const lecturas = new LecturaFuentes();
const seguro = <T>(etiqueta: string, fn: () => Promise<T>, fallback: T) => lecturas.leer(etiqueta, fn, fallback);

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

/**
 * Parte LIGERA de Holded: facturas de los últimos 7 días (1 llamada por empresa, ~0,3 s). Los conteos de
 * «gastos sin comprobante» y «movimientos sin conciliar» (90 días) NO están aquí: recorren cientos de
 * documentos y tardaban ~23 s dentro de cada lectura del panel — ahora los calcula aparte, en segundo plano,
 * ConteosHoldedPesados (ver conteosHolded.ts) y se combinan al componer la respuesta.
 */
async function construirHoldedLigero() {
  const DIAS_RECIENTES = 7;
  const entradas = await Promise.all(
    EMPRESAS_HOLDED.map(async (empresa) => {
      const facturas = await seguro(`holded.facturas.${empresa}`, () => contarFacturasRecientes(empresa, DIAS_RECIENTES), 0);
      return [empresa, facturas] as const;
    })
  );
  return Object.fromEntries(entradas) as Record<Empresa, number>;
}

/** Combina la parte ligera con los últimos conteos pesados conocidos (null = todavía sin calcular). */
function combinarHolded(facturas: Record<Empresa, number>, conteos: ConteosHolded) {
  const porEmpresa = Object.fromEntries(
    EMPRESAS_HOLDED.map((empresa) => [
      empresa,
      {
        facturasUltimos7dias: facturas[empresa] ?? 0,
        gastosSinComprobante: conteos.porEmpresa[empresa]?.gastosSinComprobante ?? null,
        movimientosSinConciliar: conteos.porEmpresa[empresa]?.movimientosSinConciliar ?? null,
      },
    ])
  ) as Record<Empresa, { facturasUltimos7dias: number; gastosSinComprobante: number | null; movimientosSinConciliar: number | null }>;

  return {
    // Suma de TODOS los documentos de compra creados en Holded en los
    // últimos 7 días, en las 3 empresas — no distingue si lo creó el
    // asistente o si se cargó a mano en Holded, porque no existe ninguna
    // etiqueta que los separe.
    facturasProcesadasUltimos7dias: Object.values(porEmpresa).reduce((acc, e) => acc + e.facturasUltimos7dias, 0),
    // gastosSinComprobante / movimientosSinConciliar: ventana de 90 días, igual que los tools existentes
    // (consultar_gastos_sin_comprobante, consultar_movimientos_sin_conciliar). null mientras no haya un
    // primer cálculo completo: el panel debe mostrar «calculando», nunca un cero inventado.
    gastosSinComprobante: conteos.gastosSinComprobante,
    movimientosSinConciliar: conteos.movimientosSinConciliar,
    /** Cuándo se calcularon realmente esos dos conteos (son de segundo plano y pueden tener minutos). */
    conteosActualizadoEn: conteos.actualizadoEn,
    conteosRefrescando: conteos.refrescando,
    conteosConservados: conteos.conservado,
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
    seguro("conocimiento.modo", async () => obtenerModoRetrieval(), {
      modo: "carga_completa" as const,
      tamanoTotalCaracteres: 0,
      umbralCaracteres: 0,
      documentos: 0,
      fragmentos: 0,
      maxCaracteresPorConsulta: 14_000,
    }),
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
    // Los nombres internos del modo no son útiles para quien opera el sistema; se traducen a una frase clara.
    explicacionModo:
      modo.modo === "carga_completa"
        ? "Todos los documentos caben completos en cada consulta — no hace falta elegir cuáles son relevantes."
        : `Las fuentes completas están conservadas, pero cada consulta recibe solo fragmentos relevantes ` +
          `(máximo ${modo.maxCaracteresPorConsulta.toLocaleString("es-ES")} caracteres de documentos) para evitar coste y latencia innecesarios.`,
    ultimaCaptura,
    ultimaCorreccion,
    totalCapturas: capturas.length,
    totalCorrecciones: correcciones.length,
    ultimasCapturas,
    ultimasCorrecciones,
  };
}

function construirAccesos(
  usuarios: Awaited<ReturnType<typeof obtenerUsuariosAutorizados>>,
  controlDiario: ControlDiario | null
) {
  const costos = controlDiario?.costos;
  return {
    usuariosAutorizados: {
      superadmins: usuarios.filter((u) => u.rol === "superadmin").length,
      admins: usuarios.filter((u) => u.rol === "admin").length,
      colaboradores: usuarios.filter((u) => u.rol === "colaborador").length,
    },
    costoIaHoy: costos?.hoy.gastoRealApiUSD ?? null,
    costoIaEstaSemana: costos?.semanaActual.gastoRealApiUSD ?? null,
    // Umbral dinámico calculado por el control diario desde los siete días
    // anteriores a ayer; el día evaluado nunca infla su propia referencia.
    umbraLAlertaCosto: costos?.umbralAnomaliaUSD ?? null,
  };
}

export interface EstadoCerebroDatos {
  cashflow: Awaited<ReturnType<typeof construirCashflow>>;
  holded: ReturnType<typeof combinarHolded>;
  crm: Awaited<ReturnType<typeof construirCrm>>;
  correo: Awaited<ReturnType<typeof construirCorreo>>;
  fiscal: Awaited<ReturnType<typeof construirFiscal>>;
  drive: Awaited<ReturnType<typeof construirDrive>>;
  conocimiento: Awaited<ReturnType<typeof construirConocimiento>>;
  accesos: ReturnType<typeof construirAccesos>;
  controlDiario: ControlDiario | null;
  auditoriaProgramada: EstadoAuditoriaProgramadaFront;
}

export interface EstadoCerebro extends EstadoCerebroDatos {
  fuentes: EstadoFuente[];
  conexiones: ConexionEstado[];
  actualizacionParcial: boolean;
  /** Instante de ESTA respuesta HTTP — cambia en cada request, cacheado o no. */
  generadoEn: string;
  /**
   * Instante en que se calculó realmente el dato MÁS ANTIGUO del panel (todas las secciones). Compara con
   * generadoEn para saber cuánto se sirvió desde caché.
   */
  cacheadoEn: string;
  /**
   * true si hay secciones recalculándose ahora mismo: lo recibido puede estar desactualizado unos segundos y
   * llegará un aviso «estado_actualizado» (o el siguiente sondeo) con el dato nuevo.
   */
  refrescando: boolean;
}

const ESTADO_AUDITORIA_POR_DEFECTO = {
  nombre: "Auditoría técnica diaria de WOBI",
  descripcion:
    "Revisa código, pruebas, rutas de IA, costes, permisos, conexiones y memoria desde una copia limpia.",
  programacion: {
    activa: true as const,
    frecuencia: "Diaria",
    horaLocal: "09:00",
    zonaHoraria: "Europe/Lisbon",
    modo: "Codex con suscripción de ChatGPT · sin API de IA de pago",
  },
  ultimaEjecucion: null,
  historial: [],
} satisfies EstadoAuditoriaProgramadaFront;

/**
 * Secciones del panel, cada una con su propia caché «servir lo último y refrescar detrás» (ver
 * estadoOrquestador.ts / seccionSWR.ts). Cada una se calcula por separado y de forma tolerante a fallos (ver
 * `seguro`): si una fuente falla, esa sección conserva su última lectura buena en vez de tumbar el panel.
 * Reutiliza los mismos clientes/lógica que los tools y crons — no llama a ninguna función de escritura.
 */
const enSeccion = async <T>(fn: () => Promise<T>): Promise<ResultadoSeccion<T>> => lecturas.ejecutar(fn);
const vacio = <T>(datos: T): ResultadoSeccion<T> => ({ datos, fuentes: [] });

const SECCIONES: DefinicionSeccion[] = [
  { nombre: "cashflow", ttlMs: 45_000, cargar: () => enSeccion(construirCashflow), alInvalidar: invalidarCachesCashflow,
    fallback: vacio(null as unknown) },
  { nombre: "holded", ttlMs: 60_000, cargar: () => enSeccion(construirHoldedLigero),
    fallback: vacio(Object.fromEntries(EMPRESAS_HOLDED.map((e) => [e, 0]))) },
  { nombre: "crm", ttlMs: 60_000, cargar: () => enSeccion(construirCrm), alInvalidar: invalidarCacheEventosHolded,
    fallback: vacio({ actividadesProgramadas: [], accionesRecientes: null }) },
  { nombre: "correo", ttlMs: 45_000, cargar: () => enSeccion(construirCorreo),
    fallback: vacio({ correosNoLeidos: 0, ultimoProcesado: null, borradoresPendientesDeAprobacion: 0 }) },
  { nombre: "drive", ttlMs: 60_000, cargar: () => enSeccion(construirDrive),
    fallback: vacio({ archivosSubidosUltimos7dias: 0, ultimoArchivo: null, porEmpresa: {} }) },
  { nombre: "conocimiento", ttlMs: 60_000, cargar: () => enSeccion(construirConocimiento),
    fallback: vacio(null as unknown) },
  { nombre: "usuarios", ttlMs: 60_000, cargar: () => enSeccion(() => seguro("accesos.usuarios", obtenerUsuariosAutorizados, [])),
    fallback: vacio([] as unknown) },
  { nombre: "controlDiario", ttlMs: 60_000, cargar: () => enSeccion(() => seguro("controlDiario", construirControlDiario, null)),
    fallback: vacio(null as unknown) },
  { nombre: "auditoria", ttlMs: 60_000,
    cargar: () => enSeccion(() => seguro("auditoriaProgramada", obtenerEstadoAuditoriaProgramada, ESTADO_AUDITORIA_POR_DEFECTO as EstadoAuditoriaProgramadaFront)),
    fallback: vacio(ESTADO_AUDITORIA_POR_DEFECTO as unknown) },
  // Verifica todas las conexiones (Telegram, Sheets, Drive, Gmail, Calendar, Holded ×3): ~8 llamadas por lectura,
  // por eso solo se repite cada minuto en vez de en cada carga del panel.
  { nombre: "conexiones", ttlMs: 60_000,
    cargar: async () => ({ datos: await obtenerEstadoConexiones(true), fuentes: [] }),
    fallback: vacio([] as unknown) },
];

const conteosHolded = new ConteosHoldedPesados({
  gastosSinComprobante: async (empresa) =>
    (await buscarGastosSinComprobante(empresa, formatDateLocal(new Date(Date.now() - 90 * 86400000)), formatDateLocal(new Date()))).sinComprobante.length,
  movimientosSinConciliar: (empresa) => contarMovimientosSinConciliar(empresa, 90),
});

const orquestador = crearOrquestadorEstado({
  secciones: SECCIONES,
  conteos: conteosHolded,
  publicar: (tipo) => { publicarCambioCerebro(tipo); },
  hayNavegadoresConectados: () => contarSuscriptoresCerebro() > 0,
});

/**
 * Nombres de secciones que se pueden invalidar por separado. `invalidarEstadoCerebro()` sin argumentos
 * invalida todas (los conteos pesados de Holded siguen su propio ritmo).
 */
export type SeccionCerebro = "cashflow" | "holded" | "crm" | "correo" | "drive" | "conocimiento" | "usuarios" | "controlDiario" | "auditoria" | "conexiones";

/**
 * Marca secciones como desactualizadas y agenda su recálculo en segundo plano (coalescido: una ráfaga de
 * avisos produce como mucho una lectura más). Nunca bloquea; al terminar se publica «estado_actualizado».
 */
export function invalidarEstadoCerebro(secciones?: SeccionCerebro[]): void { orquestador.invalidar(secciones); }

/** Antigüedad de cada sección del panel y de los conteos pesados (para /health y para verificar en producción). */
export function obtenerDiagnosticoPanelCerebro() { return orquestador.diagnostico(); }

/** Arranque: deja el panel caliente antes de que llegue el primer visitante y lo mantiene fresco. */
export function iniciarMantenimientoEstadoCerebro(): () => void {
  void orquestador.precalentar().catch((error) => console.warn("[cerebro] Precalentamiento incompleto:", error instanceof Error ? error.message : error));
  return orquestador.iniciar();
}

/**
 * Devuelve el estado del panel al instante (lo último calculado). `forzar` solo lo usa el botón «actualizar»:
 * recalcula las secciones ligeras (~3 s). Los conteos pesados de Holded se muestran con su fecha real.
 */
export async function obtenerEstadoCerebro(forzar = false): Promise<EstadoCerebro> {
  const estado = await orquestador.obtener(forzar);
  const d = estado.datos as Record<string, unknown>;
  const usuarios = d.usuarios as Awaited<ReturnType<typeof obtenerUsuariosAutorizados>>;
  const controlDiario = d.controlDiario as ControlDiario | null;
  const conexiones = d.conexiones as ConexionEstado[];
  return {
    generadoEn: new Date().toISOString(),
    cacheadoEn: new Date(estado.obtenidoEn).toISOString(),
    cashflow: d.cashflow as EstadoCerebroDatos["cashflow"],
    holded: combinarHolded(d.holded as Record<Empresa, number>, estado.conteos),
    crm: d.crm as EstadoCerebroDatos["crm"],
    correo: d.correo as EstadoCerebroDatos["correo"],
    fiscal: await construirFiscal(),
    drive: d.drive as EstadoCerebroDatos["drive"],
    conocimiento: d.conocimiento as EstadoCerebroDatos["conocimiento"],
    accesos: construirAccesos(usuarios, controlDiario),
    controlDiario,
    auditoriaProgramada: d.auditoria as EstadoAuditoriaProgramadaFront,
    fuentes: estado.fuentes,
    conexiones,
    actualizacionParcial: estado.fuentes.some((f) => !f.ok) || estado.conteos.conservado,
    refrescando: estado.refrescando,
  };
}
