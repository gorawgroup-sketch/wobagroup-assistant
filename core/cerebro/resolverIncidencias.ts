import { conMutex } from "../utils/asyncMutex";
import { durablePurchaseEditStore } from "../holded/durablePurchaseEditStore";
import type { RegistroEdicionCompra } from "../holded/durablePurchaseEdit";
import type { Empresa } from "../holded/client";
import {
  huellaEstadoCompra,
  obtenerCompraHoldedPorId,
  reconciliarAdjuntosCompraAlArrancar,
  reconciliarContactosAlArrancar,
  reconciliarCreacionesCompraAlArrancar,
  reconciliarEdicionesCompraAlArrancar,
  reconciliarMovimientosAlArrancar,
  type CompraHoldedCruda,
} from "../holded/write";
import { reconciliarSubidasDriveAlArrancar } from "../drive/client";
import { reconciliarEnviosCorreoAlArrancar } from "../gmail/client";
import { conCoordinadorCorreo, hayCoordinacionDurable } from "../gmail/automatico/postgres";

/**
 * Pedido explícito de Carlos (Diagnóstico Diario): "cuando hay temas críticos podamos ir a
 * solucionarlos, o me digas exactamente qué debo hacer, o que con un botón vaya y lo solucione para
 * que lo deje en verde". Este módulo es el "botón": todo es determinista (0 llamadas de IA) y
 * conservador. Nunca escribe en Holded/Gmail/Drive: solo relee (las mismas rutinas de solo lectura que
 * ya se ejecutan en cada arranque) y, únicamente tras confirmación humana explícita, cierra en el
 * ledger interno las ediciones antiguas cuyo documento ya se revisó y está coherente.
 */

/** Error de negocio con status HTTP propio: su mensaje es seguro de mostrar tal cual al usuario. */
export class ErrorResolver extends Error {
  constructor(
    public readonly status: number,
    mensaje: string
  ) {
    super(mensaje);
    this.name = "ErrorResolver";
  }
}

export type IdRecomendacionVerificable =
  | "envios-correo-inciertos"
  | "subidas-drive-inciertas"
  | "compras-holded-inciertas"
  | "ediciones-holded-inciertas"
  | "adjuntos-holded-inciertos"
  | "conciliaciones-holded-inciertas"
  | "contactos-holded-inciertos";

export interface ResultadoVerificacion {
  revisadas: number;
  verificadas: number;
  inciertas: number;
  errores: number;
  /** Elementos que el reconciliador dejó para revisión manual (conciliaciones/contactos ambiguos). */
  pendientesRevision: number;
  mensaje: string;
}

type ResumenCrudo = Record<string, number>;

export interface HechosCompra {
  proveedor: string;
  fecha: string;
  total: string;
  moneda: string;
  numero: string;
  borrador: boolean;
  pagado: string;
  pendiente: string;
  cuentas: string[];
  etiquetas: string[];
  lineas: number;
  descripcion: string;
}

export interface CompraConEdicionesInciertas {
  empresa: Empresa;
  purchaseId: string;
  ediciones: number;
  primeraEn: number;
  ultimaEn: number;
  procesos: string[];
  existe: boolean;
  /** true si Holded responde 404: el documento ya no existe, así que las ediciones no pueden aplicarse ni verificarse. */
  eliminada: boolean;
  hechos?: HechosCompra;
  /** Huella del documento tal como se leyó: el cierre solo procede si sigue igual (evita cerrar algo que cambió después de revisarlo). */
  huella?: string;
  /** true si el documento actual supera las comprobaciones de coherencia. */
  coherente: boolean;
  /** true si puede cerrarse: existe y es coherente, o ya no existe en Holded. */
  cerrable: boolean;
  problemas: string[];
  avisos: string[];
  nota?: string;
}

export interface DetalleEdicionesInciertas {
  compras: CompraConEdicionesInciertas[];
  totalEdiciones: number;
  /** Compras con ediciones inciertas que no se muestran por el límite; aparecerán al cerrar las anteriores. */
  truncado: number;
}

export interface ResultadoAceptacion {
  compras: Array<{ empresa: Empresa; purchaseId: string; cerradas: number; omitida?: string }>;
  cerradas: number;
  omitidas: number;
}

export interface DependenciasResolver {
  reconciliadores: Record<IdRecomendacionVerificable, () => Promise<ResumenCrudo>>;
  listarInciertas(): Promise<RegistroEdicionCompra[]>;
  leerCompra(empresa: Empresa, purchaseId: string): Promise<CompraHoldedCruda>;
  huellaActual(compra: CompraHoldedCruda): string;
  cerrar(clave: string): Promise<boolean>;
  /**
   * Serializa con la revisión automática de correo (mismo coordinador que el cron y los comandos), para
   * no tocar el ledger mientras una edición está en vuelo. Lanza ErrorResolver(409) si no consigue el
   * turno en pocos segundos.
   */
  conCoordinacion<T>(tarea: () => Promise<T>): Promise<T>;
}

const ESPERA_COORDINACION_MS = 3_000;

export function esTimeoutDeBloqueo(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === "55P03" || /lock timeout/i.test(typeof e?.message === "string" ? e.message : "");
}

async function conCoordinacionReal<T>(tarea: () => Promise<T>): Promise<T> {
  // Sin PostgreSQL no puede haber operaciones automáticas en vuelo: basta el mutex local del propio resolver.
  if (!hayCoordinacionDurable()) return tarea();
  let iniciada = false;
  try {
    return await conCoordinadorCorreo(
      () => {
        iniciada = true;
        return tarea();
      },
      { lockTimeoutMs: ESPERA_COORDINACION_MS }
    );
  } catch (error) {
    if (!iniciada && esTimeoutDeBloqueo(error)) {
      throw new ErrorResolver(409, "Hay una revisión de correo en curso. Espera a que termine (unos minutos) y vuelve a intentarlo.");
    }
    throw error;
  }
}

export function dependenciasReales(): DependenciasResolver {
  return {
    reconciliadores: {
      "envios-correo-inciertos": reconciliarEnviosCorreoAlArrancar,
      "subidas-drive-inciertas": reconciliarSubidasDriveAlArrancar,
      "compras-holded-inciertas": reconciliarCreacionesCompraAlArrancar,
      "ediciones-holded-inciertas": reconciliarEdicionesCompraAlArrancar,
      "adjuntos-holded-inciertos": reconciliarAdjuntosCompraAlArrancar,
      "conciliaciones-holded-inciertas": reconciliarMovimientosAlArrancar,
      "contactos-holded-inciertos": reconciliarContactosAlArrancar,
    },
    listarInciertas: async () => (await durablePurchaseEditStore.listarPendientes()).filter((r) => r.estado === "incierta"),
    leerCompra: obtenerCompraHoldedPorId,
    // Versión actual de la huella (cuentas-v2), sin exigir el total: es la que la reconciliación de
    // arranque (verificarEdicionRegistrada en write.ts) recalcula a partir de la marca del registro.
    huellaActual: (compra) => huellaEstadoCompra(compra, false, true),
    cerrar: (clave) => durablePurchaseEditStore.cerrarPorRevisionHumana(clave),
    conCoordinacion: conCoordinacionReal,
  };
}

const CLAVE_MUTEX = "control-diario-resolver";
/** Tope común de detalle y de cierre: el detalle relee cada compra en Holded y el cierre solo acepta lo que se mostró. */
const MAX_COMPRAS = 50;

export function esIdVerificable(id: string, deps: Pick<DependenciasResolver, "reconciliadores"> = dependenciasReales()): id is IdRecomendacionVerificable {
  return Object.prototype.hasOwnProperty.call(deps.reconciliadores, id);
}

function n(valor: unknown, ...alternativas: string[]): number {
  const crudo = valor as Record<string, unknown>;
  for (const clave of alternativas) {
    const v = crudo?.[clave];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

/** Vuelve a comprobar (solo lectura) los elementos inciertos de un ledger y resume el resultado en lenguaje claro. */
export async function verificarIncidencia(
  id: string,
  deps: DependenciasResolver = dependenciasReales()
): Promise<ResultadoVerificacion> {
  if (!esIdVerificable(id, deps)) {
    throw new ErrorResolver(400, "Esta recomendación no admite verificación automática.");
  }
  return deps.conCoordinacion(() =>
    conMutex(CLAVE_MUTEX, async () => {
      const crudo = await deps.reconciliadores[id]();
      const revisadas = n(crudo, "revisadas", "revisados");
      const verificadas = n(crudo, "verificadas", "verificados");
      const liberadas = n(crudo, "liberadas", "liberados");
      const inciertas = n(crudo, "inciertas", "inciertos");
      const errores = n(crudo, "errores");
      const pendientesRevision = n(crudo, "revisiones", "ambiguas", "ambiguos");
      const sinResolver = inciertas + errores + pendientesRevision;
      let mensaje: string;
      if (revisadas === 0) {
        mensaje = "No había ningún elemento pendiente de verificar en este momento.";
      } else if (sinResolver === 0) {
        mensaje =
          `Verificados ${verificadas} de ${revisadas}: todo coincide con el sistema real` +
          (liberadas > 0 ? ` (${liberadas} más se liberaron porque nunca llegaron a ejecutarse).` : ".");
      } else {
        const partes: string[] = [];
        if (inciertas > 0) partes.push(`${inciertas} siguen sin poder confirmarse`);
        if (pendientesRevision > 0) partes.push(`${pendientesRevision} requieren revisión manual`);
        if (errores > 0) partes.push(`${errores} dieron error de lectura`);
        mensaje =
          `Verificados ${verificadas} de ${revisadas}` +
          (liberadas > 0 ? ` (y ${liberadas} liberados)` : "") +
          `. ${partes.join(", ")}. Sigue los pasos indicados en la recomendación.`;
      }
      return { revisadas, verificadas, inciertas, errores, pendientesRevision, mensaje };
    })
  );
}

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : valor == null ? "" : String(valor);
}

/** Holded devuelve importes como texto en formato español ("5,40", "3.380,67"). null = no se puede leer. */
function importe(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  const crudo = texto(valor);
  if (!crudo) return null;
  const parsed = Number(crudo.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluarCoherenciaCompra(compra: CompraHoldedCruda): { problemas: string[]; avisos: string[]; hechos: HechosCompra } {
  const lineas = Array.isArray(compra.lines) ? compra.lines : [];
  // Una línea nula o que no es un objeto cuenta como línea sin cuenta contable (nunca rompe la lectura).
  const cuentas = lineas.map((l) => (l && typeof l === "object" ? texto(l.account) : "")).filter(Boolean);
  const sinCuenta = lineas.length - cuentas.length;
  const etiquetas = Array.isArray(compra.tags) ? (compra.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
  const total = importe(compra.total);
  const pendiente = importe(compra.payments_pending) ?? 0;
  const numero = texto(compra.document_number);
  const moneda = texto(compra.currency).toUpperCase();

  const problemas: string[] = [];
  if (!texto(compra.contact_id)) problemas.push("La compra no tiene proveedor asignado.");
  if (lineas.length === 0) problemas.push("La compra no tiene líneas.");
  if (lineas.length > 0 && sinCuenta > 0) problemas.push(`${sinCuenta} línea(s) sin cuenta contable.`);
  if (total === null) problemas.push("No se puede leer el total de la compra.");

  const avisos: string[] = [];
  if (total !== null && !(total > 0)) avisos.push("El total es cero o negativo (comprueba que sea lo esperado, p. ej. un abono).");
  if (pendiente > 0) avisos.push(`Pendiente de pago: ${texto(compra.payments_pending)}.`);
  if (compra.draft === true) avisos.push("Está en borrador (pendiente de convertir a ticket).");
  if (!numero || numero === "00000") avisos.push("Sin número de documento real.");
  if (etiquetas.length === 0) avisos.push("Sin etiquetas de categoría.");
  if (moneda && moneda !== "EUR") avisos.push(`Moneda distinta de EUR (${moneda}): comprueba el importe.`);

  return {
    problemas,
    avisos,
    hechos: {
      proveedor: texto(compra["contact_name"]),
      fecha: texto(compra.date).slice(0, 10),
      total: texto(compra.total),
      moneda,
      numero,
      borrador: compra.draft === true,
      pagado: texto(compra["payments_total"]),
      pendiente: texto(compra.payments_pending),
      cuentas: [...new Set(cuentas)],
      etiquetas,
      lineas: lineas.length,
      descripcion: texto(compra.description).slice(0, 140),
    },
  };
}

function agruparPorCompra(inciertas: RegistroEdicionCompra[]): Map<string, RegistroEdicionCompra[]> {
  const grupos = new Map<string, RegistroEdicionCompra[]>();
  for (const registro of inciertas) {
    const clave = `${registro.empresa}\0${registro.purchaseId}`;
    grupos.set(clave, [...(grupos.get(clave) ?? []), registro]);
  }
  return grupos;
}

function notaDeReedicion(registros: RegistroEdicionCompra[]): string | undefined {
  if (registros.length < 3) return undefined;
  const porProceso = new Map<string, number>();
  for (const r of registros) porProceso.set(r.proceso, (porProceso.get(r.proceso) ?? 0) + 1);
  const [proceso, veces] = [...porProceso.entries()].sort((a, b) => b[1] - a[1])[0];
  return (
    `Esta compra se reeditó ${registros.length} veces (${veces} por «${proceso}»). Al haberse reeditado varias veces, ` +
    "las huellas de las ediciones anteriores ya no pueden coincidir con el documento actual, aunque el documento esté bien. " +
    "Cerrarlas no evita que el flujo automático vuelva a reeditarla más adelante; si reaparece, hay que corregir la causa en ese flujo."
  );
}

function esNoEncontrada(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

/** Huella con la que se compara el estado de una compra entre que se revisa y se cierra. */
const HUELLA_ELIMINADA = "eliminada";

type LecturaCompra =
  | { tipo: "existe"; compra: CompraHoldedCruda; huella: string }
  | { tipo: "eliminada"; huella: string }
  | { tipo: "error"; detalle: string };

async function leerEstadoCompra(deps: DependenciasResolver, empresa: Empresa, purchaseId: string): Promise<LecturaCompra> {
  try {
    const compra = await deps.leerCompra(empresa, purchaseId);
    return { tipo: "existe", compra, huella: deps.huellaActual(compra) };
  } catch (error) {
    if (esNoEncontrada(error)) return { tipo: "eliminada", huella: HUELLA_ELIMINADA };
    return { tipo: "error", detalle: error instanceof Error ? error.message.slice(0, 160) : "error desconocido" };
  }
}

/** Estado real, en Holded, de cada compra que tiene ediciones inciertas — solo lectura. */
export async function detalleEdicionesInciertas(
  deps: DependenciasResolver = dependenciasReales(),
  concurrencia = 3
): Promise<DetalleEdicionesInciertas> {
  const inciertas = await deps.listarInciertas();
  const todas = [...agruparPorCompra(inciertas).values()].sort(
    (a, b) => Math.max(...b.map((r) => r.actualizadoEn)) - Math.max(...a.map((r) => r.actualizadoEn))
  );
  const grupos = todas.slice(0, MAX_COMPRAS);
  const compras: CompraConEdicionesInciertas[] = [];

  for (let i = 0; i < grupos.length; i += concurrencia) {
    const lote = grupos.slice(i, i + concurrencia);
    compras.push(
      ...(await Promise.all(
        lote.map(async (registros): Promise<CompraConEdicionesInciertas> => {
          const { empresa, purchaseId } = registros[0];
          const base = {
            empresa,
            purchaseId,
            ediciones: registros.length,
            primeraEn: Math.min(...registros.map((r) => r.creadoEn)),
            ultimaEn: Math.max(...registros.map((r) => r.actualizadoEn)),
            procesos: [...new Set(registros.map((r) => r.proceso))],
            nota: notaDeReedicion(registros),
          };
          const lectura = await leerEstadoCompra(deps, empresa, purchaseId);
          if (lectura.tipo === "eliminada") {
            return {
              ...base,
              existe: false,
              eliminada: true,
              huella: lectura.huella,
              coherente: false,
              cerrable: true,
              problemas: [],
              avisos: ["La compra ya no existe en Holded: sus ediciones no pueden aplicarse ni verificarse. Se pueden cerrar."],
            };
          }
          if (lectura.tipo === "error") {
            return {
              ...base,
              existe: false,
              eliminada: false,
              coherente: false,
              cerrable: false,
              avisos: [],
              problemas: [`No se pudo leer la compra en Holded: ${lectura.detalle}`],
            };
          }
          const { problemas, avisos, hechos } = evaluarCoherenciaCompra(lectura.compra);
          const coherente = problemas.length === 0;
          return { ...base, existe: true, eliminada: false, hechos, huella: lectura.huella, coherente, cerrable: coherente, problemas, avisos };
        })
      ))
    );
  }

  return { compras, totalEdiciones: inciertas.length, truncado: Math.max(0, todas.length - grupos.length) };
}

export interface SolicitudCompra {
  empresa: string;
  purchaseId: string;
  /** Huella que devolvió el detalle: si el documento cambió desde entonces, no se cierra. */
  huella: string;
}

export interface RespuestaResolver {
  status: number;
  cuerpo: { resultado?: unknown; error?: string };
}

/**
 * Validación y despacho de POST /api/cerebro/control-diario/resolver, separados de Express para poder
 * probarlos sin servidor: la ruta solo autentica (key maestra) y refresca el panel si status === 200.
 */
export async function ejecutarSolicitudResolver(
  body: unknown,
  deps: DependenciasResolver = dependenciasReales()
): Promise<RespuestaResolver> {
  const datos = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const id = typeof datos.id === "string" ? datos.id : "";
  const accion = typeof datos.accion === "string" ? datos.accion : "";
  if (!id || !accion) return { status: 400, cuerpo: { error: "Faltan 'id' y 'accion'." } };

  try {
    if (accion === "verificar") {
      return { status: 200, cuerpo: { resultado: await verificarIncidencia(id, deps) } };
    }
    if (accion === "aceptar") {
      if (id !== "ediciones-holded-inciertas") {
        throw new ErrorResolver(400, "Esta recomendación no admite aceptar el estado actual.");
      }
      if (datos.confirmar !== true) {
        throw new ErrorResolver(400, "Falta la confirmación explícita ('confirmar': true).");
      }
      const compras = (Array.isArray(datos.compras) ? datos.compras : []).filter(
        (c): c is SolicitudCompra =>
          typeof (c as { empresa?: unknown })?.empresa === "string" &&
          typeof (c as { purchaseId?: unknown })?.purchaseId === "string" &&
          typeof (c as { huella?: unknown })?.huella === "string"
      );
      return { status: 200, cuerpo: { resultado: await aceptarEstadoActualEdiciones(compras, deps) } };
    }
    return { status: 400, cuerpo: { error: "Acción no reconocida." } };
  } catch (error) {
    if (error instanceof ErrorResolver) return { status: error.status, cuerpo: { error: error.message } };
    console.error("[controlDiario] Error resolviendo una incidencia:", error instanceof Error ? error.message : String(error));
    return { status: 500, cuerpo: { error: "No se pudo completar la acción. Revisa los registros del servidor." } };
  }
}

/**
 * Cierra las ediciones inciertas de las compras indicadas, SOLO si al releerlas ahora (a) el documento
 * es idéntico al que se mostró para revisar (misma huella) y (b) sigue existiendo y es coherente, o ya no
 * existe en Holded. Lo que no cumple queda abierto y se informa por qué. Requiere que quien llama ya
 * haya obtenido confirmación humana (el endpoint exige la key maestra y `confirmar: true`). Nunca
 * escribe en Holded: solo marca en el ledger interno que una persona revisó el caso.
 */
export async function aceptarEstadoActualEdiciones(
  solicitud: SolicitudCompra[],
  deps: DependenciasResolver = dependenciasReales()
): Promise<ResultadoAceptacion> {
  if (!Array.isArray(solicitud) || solicitud.length === 0) throw new ErrorResolver(400, "Indica al menos una compra.");
  if (solicitud.length > MAX_COMPRAS) {
    throw new ErrorResolver(400, `Máximo ${MAX_COMPRAS} compras por confirmación.`);
  }
  return deps.conCoordinacion(() =>
    conMutex(CLAVE_MUTEX, async () => {
      const grupos = agruparPorCompra(await deps.listarInciertas());
      const vistos = new Set<string>();
      const resultado: ResultadoAceptacion = { compras: [], cerradas: 0, omitidas: 0 };
      const omitir = (empresa: Empresa, purchaseId: string, cerradas: number, motivo: string) => {
        resultado.compras.push({ empresa, purchaseId, cerradas, omitida: motivo });
        resultado.omitidas++;
      };

      for (const pedida of solicitud) {
        const clave = `${pedida.empresa}\0${pedida.purchaseId}`;
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        const registros = grupos.get(clave);
        // Solo se cierra lo que HOY está incierto en el ledger: un id inventado o ya resuelto no hace nada.
        if (!registros) {
          omitir(pedida.empresa as Empresa, pedida.purchaseId, 0, "No tiene ediciones inciertas (ya estaba resuelta).");
          continue;
        }
        const { empresa, purchaseId } = registros[0];
        try {
          const lectura = await leerEstadoCompra(deps, empresa, purchaseId);
          if (lectura.tipo === "error") {
            omitir(empresa, purchaseId, 0, `No se pudo releer la compra en Holded (${lectura.detalle}); no se cierra nada.`);
            continue;
          }
          if (lectura.huella !== pedida.huella) {
            omitir(empresa, purchaseId, 0, "La compra cambió desde que la revisaste; vuelve a revisarla antes de cerrarla.");
            continue;
          }
          if (lectura.tipo === "existe") {
            const { problemas } = evaluarCoherenciaCompra(lectura.compra);
            if (problemas.length > 0) {
              omitir(empresa, purchaseId, 0, `Requiere corrección antes de cerrar: ${problemas.join(" ")}`);
              continue;
            }
          }
          let cerradas = 0;
          try {
            for (const registro of registros) {
              if (await deps.cerrar(registro.clave)) cerradas++;
            }
          } catch (error) {
            // Un fallo de escritura del ledger (p. ej. cuota de Sheets) no debe abortar el resto de compras.
            console.error("[controlDiario] No se pudo cerrar un registro de edición:", error instanceof Error ? error.message : String(error));
            resultado.cerradas += cerradas;
            omitir(empresa, purchaseId, cerradas, "No se pudo actualizar el registro interno (error temporal de la hoja); vuelve a intentarlo.");
            continue;
          }
          resultado.compras.push({ empresa, purchaseId, cerradas });
          resultado.cerradas += cerradas;
          console.log(
            `[controlDiario] Revisión humana: ${cerradas} edición(es) incierta(s) de la compra ${purchaseId} (${empresa}) cerradas` +
              (lectura.tipo === "eliminada" ? " (la compra ya no existe en Holded)." : " tras comprobar que el documento actual es coherente.")
          );
        } catch (error) {
          console.error("[controlDiario] Error inesperado cerrando una compra:", error instanceof Error ? error.message : String(error));
          omitir(empresa, purchaseId, 0, "Error inesperado al procesar esta compra; no se cerró nada.");
        }
      }
      return resultado;
    })
  );
}
