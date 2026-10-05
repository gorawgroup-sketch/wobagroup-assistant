/**
 * Lo que Seguros entrega a Cerebro (sección `seguros` del estado agregado). Es el CONTRATO con el front: este archivo es
 * la única fuente de la forma de esos datos; el front los dibuja y no recalcula nada de seguros.
 *
 * Compatible hacia atrás: los campos que ya existían (`polizas`, `proximasARenovar`, `pagosSinConfirmar`, `porEmpresa`,
 * `totalPolizasActivas`, `linkRegistro`) conservan su forma. Cambia un significado, a propósito: `totalPolizasActivas`
 * ahora cuenta las pólizas VIGENTES (antes incluía las vencidas y las que están en hold: «9 activas» con 6 vigentes).
 * Se añaden `resumen`, `proximos`, `esperandoACarlos`, `memoria`, `documentos` y `vigilante`.
 *
 * Las partes lentas (memoria, documentos, última revisión) se leen de Sheets como mucho cada 5 minutos y se invalidan
 * cuando el vigilante o el especialista escriben: el panel se refresca cada minuto y no debe multiplicar las lecturas.
 */
import type { DocumentoPoliza } from "./documentosPolizaStore";
import { listarDocumentosPoliza } from "./documentosPolizaStore";
import { leerConocimiento, type EntradaConocimiento } from "./agente/conocimiento";
import { calcularAlertasSeguros } from "./alertas";
import { eventosProximos } from "./informeSemanal";
import type { PolizaConFila } from "./polizaRegistroSheet";
import { leerEstadoVigilante } from "./vigilante/estadoStore";
import { diasEntre } from "./vigilante/fechas";
import { CLAVE_ULTIMA_REVISION, parsearUltimaRevision, type UltimaRevisionVigilante } from "./vigilante/ultimaRevision";

export const EMPRESAS_SEGUROS = ["WOBA", "EWORKS", "Footprint"] as const;
export const HORIZONTE_PROXIMOS_DIAS = 400;
export const HORARIOS_VIGILANTE = ["08:35", "17:35"];
const TTL_COMPLEMENTOS_MS = 5 * 60_000;

export interface ComplementosSeguros {
  conocimiento: EntradaConocimiento[];
  documentos: DocumentoPoliza[];
  ultimaRevision: UltimaRevisionVigilante | null;
}

export async function leerComplementosReales(): Promise<ComplementosSeguros> {
  const [conocimiento, documentos, estado] = await Promise.all([leerConocimiento(), listarDocumentosPoliza(), leerEstadoVigilante()]);
  return { conocimiento, documentos, ultimaRevision: parsearUltimaRevision(estado.get(CLAVE_ULTIMA_REVISION)?.version) };
}

let memo: { leidoEn: number; datos: ComplementosSeguros } | null = null;
let enCurso: Promise<ComplementosSeguros> | null = null;

/** Complementos con caché de 5 minutos y una sola lectura en vuelo aunque lleguen varias a la vez. */
export async function leerComplementosSeguros(
  leer: () => Promise<ComplementosSeguros> = leerComplementosReales,
  ahora: () => number = Date.now
): Promise<ComplementosSeguros> {
  if (memo && ahora() - memo.leidoEn < TTL_COMPLEMENTOS_MS) return memo.datos;
  if (!enCurso) {
    enCurso = leer()
      .then((datos) => { memo = { leidoEn: ahora(), datos }; return datos; })
      .finally(() => { enCurso = null; });
  }
  return enCurso;
}

/** Descarta la caché: el vigilante, el especialista y el job la llaman cuando escriben memoria, documentos o última revisión. */
export function invalidarComplementosSeguros(): void {
  memo = null;
}

// ---------------------------------------------------------------------------------------------------------------

export interface PolizaVista {
  id: string; empresa: string; aseguradora: string; correduria: string; numeroPoliza: string; tipoCobertura: string; activoAsociado: string;
  capitalAsegurado: string; franquicia: string; prima: string; moneda: string; periodicidad: string; fechaInicioVigencia: string;
  fechaVencimiento: string; estado: string; estadoPago: string; notas: string; rutaDocumento: string; ultimaVerificacion: string;
}

export interface EstadoSeguros {
  polizas: PolizaVista[];
  proximasARenovar: ReturnType<typeof calcularAlertasSeguros>["proximasARenovar"];
  pagosSinConfirmar: ReturnType<typeof calcularAlertasSeguros>["pagosSinConfirmar"];
  porEmpresa: Record<string, { total: number; vigentes: number; pendientesConfirmar: number }>;
  /** Pólizas VIGENTES (cambio de significado: antes incluía vencidas y en hold). */
  totalPolizasActivas: number;
  linkRegistro: string;
  resumen: { vigentes: number; sinConfirmarPago: number; porConfirmarOEnHold: number; vencidas: number; noContratadas: number };
  /** Vencimientos y pagos anotados dentro de los próximos 400 días, del más cercano al más lejano. */
  proximos: Array<{ fecha: string; diasRestantes: number; tipo: "vencimiento" | "pago"; empresa: string; polizaId: string; texto: string }>;
  /** false si no se pudieron leer la memoria, los documentos y la última revisión: sus campos van a null (no son «cero»). */
  complementosDisponibles: boolean;
  esperandoACarlos: Array<{ id: string; texto: string; desde: string; diasEsperando: number }> | null;
  /** Lo que Wobi Seguros recuerda y sigue vigente: decisiones, reglas, contactos y hechos. */
  memoria: Array<{ id: string; tipo: string; texto: string; fuente: string; fecha: string }> | null;
  documentos: Array<{
    polizaId: string; empresa: string; nombre: string; tipo: string; fechaDocumento: string; vigencia: string; prima: string; capital: string; resumen: string; enlace: string;
  }> | null;
  vigilante: { ultimaRevision: UltimaRevisionVigilante | null; horarios: string[] };
}

function vista(p: PolizaConFila): PolizaVista {
  return {
    id: p.id, empresa: p.empresa, aseguradora: p.aseguradora, correduria: p.correduria, numeroPoliza: p.numeroPoliza, tipoCobertura: p.tipoCobertura,
    activoAsociado: p.activoAsociado, capitalAsegurado: p.capitalAsegurado, franquicia: p.franquicia, prima: p.prima, moneda: p.moneda,
    periodicidad: p.periodicidad, fechaInicioVigencia: p.fechaInicioVigencia, fechaVencimiento: p.fechaVencimiento, estado: p.estado,
    estadoPago: p.estadoPago, notas: p.notas, rutaDocumento: p.rutaDocumento, ultimaVerificacion: p.ultimaVerificacion,
  };
}

/** Puro: sin lecturas. `complementos` null = no se pudieron leer. */
export function construirEstadoSeguros(polizas: PolizaConFila[], complementos: ComplementosSeguros | null, hoy: Date, linkRegistro: string): EstadoSeguros {
  const hoyIso = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
  const { proximasARenovar, pagosSinConfirmar } = calcularAlertasSeguros(polizas, hoy);

  const porEmpresa = Object.fromEntries(
    EMPRESAS_SEGUROS.map((empresa) => {
      const deEsta = polizas.filter((p) => p.empresa === empresa);
      return [empresa, {
        total: deEsta.length,
        vigentes: deEsta.filter((p) => p.estado === "vigente").length,
        pendientesConfirmar: deEsta.filter((p) => p.estadoPago === "pendiente" || p.estadoPago === "sin_confirmar").length,
      }];
    })
  );
  const vigentes = polizas.filter((p) => p.estado === "vigente").length;

  const vigentesMemoria = complementos?.conocimiento.filter((e) => e.vigente) ?? null;
  return {
    polizas: polizas.map(vista),
    proximasARenovar,
    pagosSinConfirmar,
    porEmpresa,
    totalPolizasActivas: vigentes,
    linkRegistro,
    resumen: {
      vigentes,
      sinConfirmarPago: pagosSinConfirmar.length,
      porConfirmarOEnHold: polizas.filter((p) => p.estado === "pendiente_confirmacion").length,
      vencidas: polizas.filter((p) => p.estado === "vencida").length,
      noContratadas: polizas.filter((p) => p.estado === "no_contratada").length,
    },
    proximos: eventosProximos(polizas, hoyIso, HORIZONTE_PROXIMOS_DIAS).map((e) => ({
      fecha: e.fecha, diasRestantes: diasEntre(hoyIso, e.fecha), tipo: e.tipo, empresa: e.empresa, polizaId: e.polizaId, texto: e.texto,
    })),
    complementosDisponibles: complementos != null,
    esperandoACarlos: vigentesMemoria
      ? vigentesMemoria.filter((e) => e.tipo === "pendiente_carlos").map((e) => ({ id: e.id, texto: e.texto, desde: e.fecha, diasEsperando: Math.max(0, diasEntre(e.fecha, hoyIso)) }))
      : null,
    memoria: vigentesMemoria
      ? vigentesMemoria.filter((e) => e.tipo !== "pendiente_carlos").map((e) => ({ id: e.id, tipo: e.tipo, texto: e.texto, fuente: e.fuente, fecha: e.fecha }))
      : null,
    documentos: complementos
      ? complementos.documentos.map((d) => ({
          polizaId: d.polizaId, empresa: d.empresa, nombre: d.nombreArchivo, tipo: d.tipoDocumento, fechaDocumento: d.fechaDocumento,
          vigencia: `${d.vigenciaInicio || "?"} → ${d.vigenciaFin || "?"}`, prima: d.prima, capital: d.capitalAsegurado, resumen: d.resumen, enlace: d.enlaceDrive,
        }))
      : null,
    vigilante: { ultimaRevision: complementos?.ultimaRevision ?? null, horarios: HORARIOS_VIGILANTE },
  };
}

/** Forma vacía para cuando falla la lectura del registro (la sección se marca como fuente fallida, no como ceros). */
export const ESTADO_SEGUROS_VACIO: EstadoSeguros = {
  polizas: [], proximasARenovar: [], pagosSinConfirmar: [], porEmpresa: {}, totalPolizasActivas: 0, linkRegistro: "",
  resumen: { vigentes: 0, sinConfirmarPago: 0, porConfirmarOEnHold: 0, vencidas: 0, noContratadas: 0 }, proximos: [],
  complementosDisponibles: false, esperandoACarlos: null, memoria: null, documentos: null, vigilante: { ultimaRevision: null, horarios: HORARIOS_VIGILANTE },
};
