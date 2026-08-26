import { fetchResumenSemanas } from "../google/cashflowSheet";
import { listarPropuestasPendientes } from "../google/proposalSheet";
import { parseValorFormateado } from "../jobs/revisarHoldedVsCashflow";
import { loadCalendarioFiscal, calcularProximasAlertas } from "../fiscal/calendario";
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
import { mondayOf } from "../utils/isoWeek";
import { formatDateLocal } from "../utils/dateFormat";

const EMPRESAS_HOLDED: Empresa[] = ["WOBA", "EWORKS", "Footprint"];
const EMPRESAS_CASHFLOW: Array<"WOBA" | "EWORKS"> = ["WOBA", "EWORKS"];

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

async function construirCashflow() {
  const [semanas, propuestas] = await Promise.all([
    seguro("cashflow.semanas", fetchResumenSemanas, [] as Awaited<ReturnType<typeof fetchResumenSemanas>>),
    seguro("cashflow.propuestas", listarPropuestasPendientes, [] as Awaited<ReturnType<typeof listarPropuestasPendientes>>),
  ]);

  const conDatos = semanas.filter((s) => s.balanceFinal.trim() !== "");
  const ultima = conDatos[conDatos.length - 1];

  const balanceUltimaSemana = ultima
    ? {
        semana: ultima.semana,
        ingresos: parseValorFormateado(ultima.income),
        gastos: parseValorFormateado(ultima.projectExpenses) + parseValorFormateado(ultima.generalExpenses),
        balanceFinal: parseValorFormateado(ultima.balanceFinal),
      }
    : null;

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

  return {
    linkSheet: `https://docs.google.com/spreadsheets/d/${process.env.CASHFLOW_SHEET_ID ?? ""}/edit`,
    balanceUltimaSemana,
    pagosRecurrentes,
    propuestasPendientes,
    // No existe ningún store que persista "cuándo corrió por última vez
    // revisarHoldedVsCashflow" (a diferencia de Gmail, que sí tiene
    // _gmail_ultimo_check) — el cron solo escribe a console.log. Se deja
    // explícitamente null en vez de inventar un valor; instrumentarlo
    // sería agregar un store nuevo tipo lastCheckStore.ts, no reusar uno
    // existente.
    ultimaDeteccionHolded: null as string | null,
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

  return {
    proximasAlertas: alertas.map((a) => ({
      concepto: a.concepto,
      empresa: a.empresa,
      venceEn: formatDateLocal(a.fecha),
      diasRestantes: a.diasParaVencer,
    })),
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

  const todos = Object.entries(porRaiz)
    .flatMap(([folderId, archivos]) => archivos.map((a) => ({ ...a, empresa: empresasPorFolderId[folderId] })))
    .sort((a, b) => (b.createdTime > a.createdTime ? 1 : -1));

  const ultimo = todos[0];

  return {
    archivosSubidosUltimos7dias: todos.length,
    ultimoArchivo: ultimo ? { nombre: ultimo.name, empresa: ultimo.empresa, fecha: ultimo.createdTime } : null,
  };
}

async function construirConocimiento() {
  const [modo, capturas, correcciones] = await Promise.all([
    seguro("conocimiento.modo", async () => obtenerModoRetrieval(), { modo: "carga_completa" as const, tamanoTotalCaracteres: 0, umbralCaracteres: 0, documentos: 0 }),
    seguro("conocimiento.capturas", obtenerCapturasCrudas, []),
    seguro("conocimiento.correcciones", obtenerCorreccionesCrudas, []),
  ]);

  const ultimaCaptura = capturas.length > 0 ? capturas[capturas.length - 1].fecha : null;
  const ultimaCorreccion = correcciones.length > 0 ? correcciones[correcciones.length - 1].fecha : null;

  return {
    documentos: modo.documentos,
    modoActual: modo.modo,
    // No existe ningún concepto de "revisión" de una captura: capture.ts
    // documenta explícitamente que se integra sin paso de revisión ni
    // aprobación. No hay cola de pendientes que contar — se deja null en
    // vez de devolver 0, para no insinuar que existe un flujo de revisión.
    capturasSinRevisar: null as number | null,
    ultimaCaptura,
    ultimaCorreccion,
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

export interface EstadoCerebro {
  generadoEn: string;
  cashflow: Awaited<ReturnType<typeof construirCashflow>>;
  holded: Awaited<ReturnType<typeof construirHolded>>;
  crm: Awaited<ReturnType<typeof construirCrm>>;
  correo: Awaited<ReturnType<typeof construirCorreo>>;
  fiscal: Awaited<ReturnType<typeof construirFiscal>>;
  drive: Awaited<ReturnType<typeof construirDrive>>;
  conocimiento: Awaited<ReturnType<typeof construirConocimiento>>;
  accesos: Awaited<ReturnType<typeof construirAccesos>>;
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
export async function obtenerEstadoCerebro(): Promise<EstadoCerebro> {
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

  return {
    generadoEn: new Date().toISOString(),
    cashflow,
    holded,
    crm,
    correo,
    fiscal,
    drive,
    conocimiento,
    accesos,
  };
}
