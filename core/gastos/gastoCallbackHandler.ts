import { unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { conMutex } from "../utils/asyncMutex";
import {
  answerCallbackQuery,
  editTelegramMessage,
  editTelegramMessageReplyMarkup,
  sendTelegramMessage,
  sendTelegramMessageSmart,
  sendTelegramMessageWithButtons,
} from "../telegram/client";
import type { InlineKeyboardButton } from "../telegram/types";
import {
  consumirPropuestaGasto,
  restaurarPropuestaGasto,
  obtenerPropuestaGasto,
  crearPropuestaGasto,
  actualizarMessageIdGasto,
  actualizarMontoPropuestaGasto,
  actualizarMonedaPropuestaGasto,
  actualizarFlagMovimientoBancarioGasto,
  actualizarMovimientosAmbiguosPropuestaGasto,
  actualizarSeleccionAccionesGasto,
  actualizarClasificacionPropuestaGasto,
  type PropuestaGasto,
} from "./gastoProposalSheet";
import {
  construirTecladoGasto,
  esAccionFinal,
  necesitaTexto,
  indiceCandidato,
  indiceMovimientoAmbiguo,
  etiquetaAccion,
  opcionesTecladoDesdePropuesta,
} from "./gastoTeclado";
import { guardarPendienteCorreccionGasto, type PendienteCorreccionGasto } from "./pendienteCorreccionGastoStore";
import {
  guardarPendienteAjusteMontoGasto,
  consumirPendienteAjusteMontoGasto,
  type PendienteAjusteMontoGasto,
} from "./pendienteAjusteMontoGastoStore";
import {
  guardarPendienteAccionGasto,
  consumirPendienteAccionGasto,
  type PendienteAccionGasto,
} from "./pendienteAccionGastoStore";
import { guardarPendienteSeleccionGasto, type PendienteSeleccionGasto } from "./pendienteSeleccionGastoStore";
import { registrarClasificacionAprendida } from "./clasificacionAprendidaSheet";
import { registrarAliasProveedor } from "./proveedorAliasSheet";
import { registrarAsignacionCuenta } from "../holded/asignacionCuentaLogSheet";
import { marcarGastoDesdeCorreoCompletado, registrarGastoDesdeCorreo } from "./gastoPorCorreoStore";
import {
  guardarResolucionContacto,
  consumirResolucionContacto,
  restaurarResolucionContacto,
  obtenerResolucionContacto,
  priorizarResolucionContacto,
  actualizarAlternativasResolucionContacto,
  actualizarMessageIdResolucionContacto,
  type AlternativaContacto,
  type ResolucionContactoPendiente,
} from "./contactoResolucionStore";
import {
  guardarConciliacionPendiente,
  consumirConciliacionPendiente,
  restaurarConciliacionPendiente,
  type ConciliacionPendiente,
} from "./conciliacionPendienteStore";
import {
  guardarConciliacionAmbiguaPendiente,
  consumirConciliacionAmbiguaPendiente,
  restaurarConciliacionAmbiguaPendiente,
  type ConciliacionAmbiguaPendiente,
} from "./conciliacionAmbiguaPendienteStore";
import {
  buscarContactoHolded,
  buscarContactosParecidos,
  buscarComprasPorMonto,
  verificarDuplicadoGastoEstricto,
  movimientoConciliadoComoCandidato,
  formatearCandidatosDuplicado,
  crearGastoHolded,
  crearContactoHolded,
  adjuntarComprobanteHolded,
  buscarMovimientoSimilar,
  buscarMovimientoAproximado,
  obtenerMonedasCuentasReales,
  reconciliarMovimiento,
  estaMovimientoYaConciliado,
  AdjuntoCompraInciertoError,
  ConciliacionMovimientoInciertaError,
  ContactosHoldedAmbiguosError,
  CreacionContactoInciertaError,
  CreacionCompraInciertaError,
  esArchivoLocalInexistente,
  compraTieneComprobante,
  combinarTagsGastoAprendidos,
  inferirCuentaGasto,
  ContactoNoEncontradoError,
  FechaBloqueadaError,
  PosibleDuplicadoGastoError,
  VerificacionDuplicadoFallidaError,
  type HoldedContact,
  type MovimientoBancarioCandidato,
  type PurchaseCandidato,
} from "../holded/write";
import { registrarMovimientoAmbiguoElegido, sugerirCandidatoAprendido } from "../holded/movimientoAmbiguoAprendidoSheet";
import { obtenerRolUsuario } from "../telegram/authorizedUsersSheet";
import { avanzarColaCorreoSiActivo } from "../jobs/revisarCorreoNuevo";
import { reDescargarAdjuntoSiFalta, regenerarComprobanteDesdeCuerpoSiFalta } from "../gmail/reDescargarAdjunto";
import { generarBorradorYOfrecer } from "../gmail/emailCallbackHandler";
import {
  obtenerBorradoresCorreoPorChat,
  seleccionarBorradorCorrelacionado,
  vincularBorradorACola,
} from "../gmail/emailDraftStore";
import {
  incrementarPendientesActivo,
  revertirIncrementoPendientesActivo,
  type IdentidadCorreoCola,
} from "../gmail/colaRevisionStore";
import { obtenerCuerpoCompletoCorreo } from "../gmail/client";
import { iniciarSeleccionEmpresaCaptura } from "../knowledge/capturaEmpresaCallbackHandler";
import { obtenerPendientesCapturaEmpresaPorChat } from "../knowledge/pendienteCapturaEmpresaStore";
import { askClaude, interpretarCorreccionGasto, type CorreccionGasto } from "../claude/client";
import type { Empresa } from "../holded/client";
import type { TelegramCallbackQuery } from "../telegram/types";
import type { LineaFactura } from "../documental/extractInvoiceData";
import { buscarMovimientosPorTipoCambio, describirMovimientoMultimoneda } from "./movimientoMultimoneda";
import { claveIdempotenciaGasto } from "./identidadGasto";
import { conciliacionRequiereRevision } from "../holded/durableBankReconciliation";
import { esProveedorNoIdentificado } from "../holded/duplicateSignals";

/**
 * Holded exige contact_id incluso cuando el operador decide avanzar sin un
 * contacto real. Estos contactos técnicos ya existen en cada empresa. El
 * nombre real extraído del comprobante permanece en la descripción y este
 * contacto nunca se aprende como alias.
 */
const CONTACTO_SIN_IDENTIFICAR_POR_EMPRESA: Record<Empresa, { id: string; name: string }> = {
  WOBA: { id: "6a96da7947b9d9c436035b7a", name: "PROVEEDOR SIN IDENTIFICAR" },
  EWORKS: { id: "6a96da80d133ca5bab0ec4e8", name: "PROVEEDOR SIN IDENTIFICAR" },
  Footprint: { id: "6a96da888467c6eb35096adc", name: "PROVEEDOR SIN IDENTIFICAR" },
};

async function answerCallbackQuerySafe(callbackQueryId: string, text?: string): Promise<void> {
  // Identificador interno de dispararDecisionFinal: no es un callback de Telegram.
  if (callbackQueryId.startsWith("seleccion_")) return;
  try {
    await answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    console.error("[gastoCallbackHandler] No se pudo responder el callback_query (no crítico):", error);
  }
}

async function limpiarArchivoLocal(rutaLocal: string): Promise<void> {
  await unlink(rutaLocal).catch(() => {}); // no crítico si ya no existe
}

/**
 * Resumen corto de una propuesta — respaldo para editTelegramMessageReplyMarkup cuando el registro
 * de botones del chat web ya no existe (ver textoSiFalta en webBotonesStore.ts/telegram/client.ts).
 * A propósito NO intenta reconstruir el mensaje original completo (desglose de IVA, confianza, etc.)
 * — esta función solo existe para que el chat web tenga ALGO razonable que mostrar junto a botones
 * que de otro modo quedarían huérfanos en silencio; el texto real que Telegram muestra no cambia.
 */
function resumenTextoPropuestaGasto(propuesta: PropuestaGasto): string {
  return `📄 ${propuesta.proveedor} — ${propuesta.monto.toFixed(2)} ${propuesta.moneda} (${propuesta.fecha}) — ${propuesta.concepto}`;
}

export interface DependenciasAccionLateralGasto {
  yaPublicada: () => Promise<boolean>;
  reservar: (identidad: Required<IdentidadCorreoCola>) => Promise<boolean>;
  publicar: (identidad?: Required<IdentidadCorreoCola>) => Promise<boolean>;
  compensar: (identidad: Required<IdentidadCorreoCola>) => Promise<boolean>;
}

/**
 * Publica una decisión lateral (borrador/captura) con una unidad propia de
 * la cola. El mutex y la consulta durable previa hacen que dos callbacks del
 * mismo botón converjan en una sola publicación y un solo incremento.
 */
export async function ejecutarAccionLateralGastoConReserva(
  clave: string,
  deColaCorreo: boolean,
  identidad: IdentidadCorreoCola | undefined,
  dependencias: DependenciasAccionLateralGasto
): Promise<boolean> {
  const threadId = identidad?.threadId?.trim();
  const mensajeId = identidad?.mensajeId?.trim();
  const identidadExacta = deColaCorreo && threadId && mensajeId ? { threadId, mensajeId } : undefined;
  if (deColaCorreo && !identidadExacta) {
    console.error("[gastoCallbackHandler] Se rechazó una acción lateral de cola sin identidad exacta.");
    return false;
  }

  return conMutex(`gasto:accion-lateral:${clave}`, async () => {
    if (await dependencias.yaPublicada()) return true;

    let reservada = false;
    try {
      if (identidadExacta) {
        reservada = await dependencias.reservar(identidadExacta);
        if (!reservada) {
          console.error("[gastoCallbackHandler] El correo dejó de ser el activo antes de reservar la acción lateral.");
          return false;
        }
      }

      const publicada = await dependencias.publicar(identidadExacta);
      if (publicada) return true;

      if (reservada && identidadExacta) {
        const compensada = await dependencias.compensar(identidadExacta);
        if (!compensada) {
          console.error("[gastoCallbackHandler] La acción lateral falló y la cola no confirmó la compensación de su reserva.");
        }
      }
      return false;
    } catch (error) {
      if (reservada && identidadExacta) {
        try {
          const compensada = await dependencias.compensar(identidadExacta);
          if (!compensada) {
            console.error("[gastoCallbackHandler] La cola no confirmó la compensación tras fallar la acción lateral.");
          }
        } catch (errorCompensando) {
          console.error("[gastoCallbackHandler] No se pudo compensar la reserva de la acción lateral fallida:", errorCompensando);
        }
      }
      throw error;
    }
  });
}

function identidadCorreoDePropuestaGasto(propuesta: PropuestaGasto): Required<IdentidadCorreoCola> | undefined {
  const threadId = propuesta.correoOrigen?.threadId?.trim();
  const mensajeId = propuesta.correoOrigen?.mensajeIdGmail?.trim();
  return threadId && mensajeId ? { threadId, mensajeId } : undefined;
}

export const TOLERANCIA_TOTAL_FISCAL_GASTO = 0.05;

export class DescuadreFiscalGastoError extends Error {
  constructor(
    public readonly totalFiscal: number,
    public readonly totalDocumento: number,
    public readonly moneda: string
  ) {
    super(
      `El total fiscal calculado (${totalFiscal.toFixed(2)} ${moneda}) difiere del total del documento ` +
        `(${totalDocumento.toFixed(2)} ${moneda}) por más de ${TOLERANCIA_TOTAL_FISCAL_GASTO.toFixed(2)}. ` +
        "No se creó ni se concilió el gasto; corrige las bases, impuestos o retenciones antes de reintentar."
    );
    this.name = "DescuadreFiscalGastoError";
  }
}

export class CuentaContableNoInferidaError extends Error {
  constructor(public readonly empresa: Empresa, public readonly proveedor: string) {
    super(
      `No pude inferir con el aprendizaje existente una cuenta contable segura para "${proveedor}" en ${empresa}. ` +
        "El gasto queda pendiente y no se usará la cuenta genérica de Holded."
    );
    this.name = "CuentaContableNoInferidaError";
  }
}

/**
 * Calcula y valida el total que Holded obtendrá de las líneas fiscales.
 * La validación ocurre antes de cualquier POST o conciliación: avisar después
 * de crear dejaba un documento contablemente incorrecto que ya no se podía
 * deshacer de forma segura desde el callback.
 */
export function validarTotalFiscalGasto(
  propuesta: Pick<PropuestaGasto, "monto" | "moneda" | "lineas">
): number {
  // Sin desglose fiscal, la única línea que se enviará usa el total del
  // documento como base a 0 %, de modo que no existe un descuadre que validar.
  if (propuesta.lineas.length === 0) return propuesta.monto;

  const totalFiscal = propuesta.lineas.reduce(
    (acc, linea) => acc + linea.base * (1 + linea.tipoIvaPct / 100 - (linea.retencionPct ?? 0) / 100),
    0
  );
  const diferencia = Math.abs(totalFiscal - propuesta.monto);
  // El epsilon evita que 0,05 binario se convierta accidentalmente en
  // 0,05000000000001. La regla funcional sigue siendo estrictamente > 0,05.
  if (diferencia - TOLERANCIA_TOTAL_FISCAL_GASTO > Number.EPSILON * 100) {
    throw new DescuadreFiscalGastoError(totalFiscal, propuesta.monto, propuesta.moneda);
  }
  return totalFiscal;
}

export interface CambiosClasificacionGasto {
  empresa: Empresa;
  concepto: string;
  /** Nombre corregido o contacto exacto elegido para consultar el aprendizaje. */
  proveedor?: string;
  /** Persona corregida/confirmada por el documento u operador. */
  personaAsociada?: string;
  contextoDeViaje?: boolean;
  reciboSimplificado?: boolean;
  /** Una corrección explícita siempre obliga a consultar de nuevo el aprendizaje. */
  forzarReinferencia?: boolean;
}

export interface DependenciasReinferenciaGasto {
  inferirCuenta: typeof inferirCuentaGasto;
  combinarTags: typeof combinarTagsGastoAprendidos;
}

const CATEGORIAS_CONTABLES_GASTO = new Set([
  "suscripcion", "alimentacion", "transporte", "taxi", "tren", "avion", "alquilercoche",
  "gasolina", "peaje", "barco", "parking", "hospedaje", "alojamiento", "coche",
]);

function esTagCategoriaContable(tag: string): boolean {
  const normalizado = tag.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return CATEGORIAS_CONTABLES_GASTO.has(normalizado);
}

/**
 * Construye la única propuesta que puede llegar a Holded después de una
 * corrección. Reutiliza el mismo aprendizaje del flujo uno a uno y falla
 * cerrado si no existe una cuenta segura; nunca cae en el default de Holded.
 */
export async function prepararPropuestaFinalGasto(
  propuesta: PropuestaGasto,
  cambios: CambiosClasificacionGasto,
  dependencias: DependenciasReinferenciaGasto = {
    inferirCuenta: inferirCuentaGasto,
    combinarTags: combinarTagsGastoAprendidos,
  }
): Promise<PropuestaGasto> {
  const concepto = cambios.concepto.trim() || propuesta.concepto;
  const proveedorAprendizaje = cambios.proveedor?.trim() || propuesta.proveedor;
  const cambioSemantico =
    cambios.forzarReinferencia === true ||
    cambios.empresa !== propuesta.empresa ||
    concepto.toLowerCase() !== propuesta.concepto.trim().toLowerCase() ||
    proveedorAprendizaje.toLowerCase() !== propuesta.proveedor.trim().toLowerCase() ||
    Boolean(cambios.personaAsociada);

  let cuentaId = propuesta.cuentaId;
  let tagsAprendidos = propuesta.cuentaTags ?? [];
  if (cambioSemantico || !cuentaId) {
    // Una categoría anterior pertenece a la clasificación que se acaba de
    // invalidar. Solo se conservan tags personales/no contables; la nueva
    // categoría debe venir del documento corregido o de la reinferencia.
    tagsAprendidos = cambioSemantico
      ? tagsAprendidos.filter((tag) => !esTagCategoriaContable(tag))
      : tagsAprendidos;
    const sugerencia = await dependencias.inferirCuenta(cambios.empresa, {
      proveedor: proveedorAprendizaje,
      concepto,
      personaAsociada: cambios.personaAsociada,
      contextoDeViaje: cambios.contextoDeViaje,
      reciboSimplificado: cambios.reciboSimplificado,
    });
    cuentaId = sugerencia?.accountId;
    tagsAprendidos = [...tagsAprendidos, ...(sugerencia?.tags ?? [])];
  }

  if (!cuentaId) {
    throw new CuentaContableNoInferidaError(cambios.empresa, proveedorAprendizaje);
  }

  const cuentaTags = dependencias.combinarTags(
    concepto,
    proveedorAprendizaje,
    cambios.personaAsociada,
    tagsAprendidos
  );
  return {
    ...propuesta,
    empresa: cambios.empresa,
    concepto,
    cuentaId,
    cuentaTags,
  };
}

async function reponerPropuestaParaReintento(
  propuesta: PropuestaGasto,
  mensaje: string,
  candidatoSeguimiento?: PurchaseCandidato
): Promise<void> {
  const restaurada = await restaurarPropuestaGasto({
    ...propuesta,
    candidatos: candidatoSeguimiento ? [candidatoSeguimiento] : propuesta.candidatos,
    seleccionAcciones: [],
  });
  const teclado = construirTecladoGasto(restaurada, opcionesTecladoDesdePropuesta(restaurada));
  try {
    await editTelegramMessage(restaurada.chatId, restaurada.messageId, mensaje, teclado);
  } catch (errorEdicion) {
    console.error("[gastoCallbackHandler] No se pudo reponer el teclado en el mensaje original; se enviara uno nuevo:", errorEdicion);
    const messageId = await sendTelegramMessageWithButtons(restaurada.chatId, mensaje, teclado);
    await actualizarMessageIdGasto(restaurada.id, messageId);
  }
}

async function reponerVerificacionCreacionIncierta(propuesta: PropuestaGasto, mensaje: string): Promise<void> {
  const restaurada = await restaurarPropuestaGasto({ ...propuesta, seleccionAcciones: [] });
  const teclado = [[{
    text: "🔎 Verificar estado sin repetir la creación",
    callback_data: `gasto_nuevo:${restaurada.id}`,
  }]];
  try {
    await editTelegramMessage(restaurada.chatId, restaurada.messageId, mensaje, teclado);
  } catch (errorEdicion) {
    console.error("[gastoCallbackHandler] No se pudo publicar la verificación incierta en el mensaje original; se enviara uno nuevo:", errorEdicion);
    const messageId = await sendTelegramMessageWithButtons(restaurada.chatId, mensaje, teclado);
    await actualizarMessageIdGasto(restaurada.id, messageId);
  }
}

/**
 * Ejecuta el cierre técnico en el único orden seguro: memoria durable,
 * avance/marcado READ de la identidad exacta y, al final, render de Telegram.
 * Si falla cualquiera de los dos primeros pasos, `recuperar` debe reponer la
 * misma entidad consumida con una acción de cierre únicamente; nunca repite
 * la creación, el adjunto ni la conciliación financiera ya confirmados.
 */
export async function finalizarGastoCorreoAntesDeRender(
  persistirCierre: () => Promise<unknown>,
  avanzarCorreo: () => Promise<boolean>,
  recuperar: (error: unknown) => Promise<void>,
  renderizar: () => Promise<unknown>
): Promise<boolean> {
  try {
    await persistirCierre();
    const avanceConfirmado = await avanzarCorreo();
    if (!avanceConfirmado) {
      throw new Error("La cola no confirmó el cierre; conserva el reintento durable aunque también haya programado un reintento técnico.");
    }
  } catch (error) {
    console.error("[gastoCallbackHandler] No se pudo cerrar durablemente el correo de gasto; se repone una acción de cierre:", error);
    try {
      await recuperar(error);
    } catch (errorRecuperacion) {
      console.error("[gastoCallbackHandler] Tampoco se pudo publicar la recuperación del cierre; el store durable conserva el intento cuando alcanzó a restaurarse:", errorRecuperacion);
    }
    return false;
  }

  try {
    await renderizar();
  } catch (error) {
    // La contabilidad y Gmail ya quedaron cerrados. Un fallo visual nunca
    // debe reabrir ni repetir una escritura financiera confirmada.
    console.error("[gastoCallbackHandler] El cierre terminó, pero no se pudo reflejar en Telegram (no crítico):", error);
  }
  return true;
}

export function botonesResolucionContacto(resolucion: ResolucionContactoPendiente): InlineKeyboardButton[][] {
  const botones: InlineKeyboardButton[][] = resolucion.alternativas.map((alternativa, indice) => [{
    text: `✅ ${alternativa.contactName}`,
    callback_data: `gasto_usarcontacto:${resolucion.id}:${indice}`,
  }]);
  const proveedorReal = !esProveedorNoIdentificado(resolucion.propuesta.proveedor);
  if (proveedorReal) {
    botones.push([{
      text: `🆕 Crear contacto nuevo: "${resolucion.propuesta.proveedor}"`,
      callback_data: `gasto_crearcontactonuevo:${resolucion.id}`,
    }]);
    botones.push([{
      text: "🆗 Crear sin contacto",
      callback_data: `gasto_crearsinproveedor:${resolucion.id}`,
    }]);
  }
  botones.push([{
    text: "✏️ Dar instrucciones específicas",
    callback_data: `gasto_contactoinstrucciones:${resolucion.id}`,
  }]);
  return botones;
}

export function textoResolucionContacto(resolucion: ResolucionContactoPendiente): string {
  const encabezado =
    `⚠️ No encontré exactamente el proveedor "${resolucion.propuesta.proveedor}" en los contactos de Holded ` +
    `(${resolucion.empresaFinal}).`;
  if (resolucion.alternativas.length === 0) {
    const opciones = esProveedorNoIdentificado(resolucion.propuesta.proveedor)
      ? "indicarme exactamente qué proveedor debo usar"
      : "crear el contacto real, avanzar sin contacto, o indicarme exactamente qué proveedor debo usar";
    return (
      `${encabezado}\n\nNo encontré una alternativa suficientemente parecida. Puedes ${opciones}. ` +
      `El gasto no se crea hasta que elijas.`
    );
  }
  const etiquetaMotivo = (a: AlternativaContacto) =>
    a.motivo === "nombre_parecido" ? "nombre parecido" : `mismo importe — ${a.detalle}`;
  return (
    `${encabezado}\n\nAlternativas encontradas:\n\n` +
    resolucion.alternativas.map((a, i) => `${i + 1}. ${a.contactName} (${etiquetaMotivo(a)})`).join("\n") +
    "\n\nElige una alternativa o una de las demás acciones."
  );
}

/** Repone el mismo id y deja el render de Telegram como best-effort. */
export async function reponerResolucionContactoTrasFallo(
  resolucion: ResolucionContactoPendiente,
  aviso: string,
  restaurar: (resolucion: ResolucionContactoPendiente) => Promise<ResolucionContactoPendiente> = restaurarResolucionContacto,
  renderizar: (
    resolucion: ResolucionContactoPendiente,
    aviso: string,
    botones: InlineKeyboardButton[][]
  ) => Promise<unknown> = (restaurada, texto, botones) =>
    editTelegramMessage(restaurada.chatId, restaurada.messageId, texto, botones)
): Promise<void> {
  const restaurada = await restaurar(resolucion);
  await renderizar(restaurada, aviso, botonesResolucionContacto(restaurada)).catch((error) =>
    console.error("[gastoCallbackHandler] La resolución se restauró, pero no se pudo repintar Telegram (no crítico):", error)
  );
}

/**
 * Adjunta el comprobante a un gasto de Holded y borra la copia local
 * temporal (solo si tuvo éxito).
 *
 * Pedido explícito de Carlos, tras un caso real: un gasto se creó en Holded
 * SIN su comprobante ("ENOENT: no such file or directory, open
 * '/app/tmp/uploads/...'") — "no hay gastos en la contabilidad que puedan
 * ser creados sin soporte, es ilegal". Causa raíz: la copia local del
 * adjunto no sobrevive un redeploy de Railway, pero la propuesta en Sheets
 * sí — así que un gasto que queda pendiente durante CUALQUIER redeploy
 * pierde su copia de trabajo, aunque el original siga intacto en Gmail. Si
 * el primer intento falla Y se sabe de qué mensaje/adjunto de Gmail vino
 * (origenAdjuntoGmail), se descarga de nuevo desde ahí antes de rendirse —
 * Gmail es la fuente durable, tmp/uploads solo una copia de trabajo. Si el
 * segundo intento también falla (o no hay origen de Gmail que reintentar,
 * ej. una foto subida por Telegram), se propaga el error tal cual, para que
 * el gasto que ya se creó quede claramente marcado como pendiente de
 * comprobante (ver revisarGastosSinComprobante.ts) en vez de darse por
 * cerrado sin serlo.
 */
async function adjuntarYLimpiar(
  propuesta: PropuestaGasto,
  purchaseId: string,
  empresaDestino: Empresa = propuesta.empresa
): Promise<void> {
  const adjuntar = (mimeType: string | undefined, nombreArchivo: string) =>
    adjuntarComprobanteHolded(empresaDestino, purchaseId, propuesta.rutaLocal, nombreArchivo, mimeType, {
      idempotencyKey: `gasto:${propuesta.id}:adjunto:${purchaseId}`,
      proceso: "comprobante_gasto_aprobado",
    });

  try {
    await adjuntar(propuesta.mimeType, propuesta.nombreArchivoOriginal);
  } catch (error) {
    // Solo reconstruimos tmp/uploads cuando realmente desapareció. Un error
    // de red o de Holded puede significar que el POST sí tuvo efecto y nunca
    // debe transformarse en una segunda subida.
    if (!esArchivoLocalInexistente(error)) throw error;
    // Primer respaldo: era un adjunto REAL de Gmail (tiene attachmentId) — se vuelve a descargar el
    // MISMO archivo, así que su mimeType/nombre originales siguen siendo correctos. Segundo respaldo
    // (hallazgo real de auditoría, caso MARNAPA/GDL Pastriva): era un PDF SINTÉTICO generado del
    // cuerpo del correo (nunca tuvo attachmentId que recuperar), o el primer respaldo también falló —
    // se regenera desde cero con el cuerpo fresco de Gmail. Solo se propaga el error si NINGUNA de las
    // dos vías logra reponer el archivo.
    const recuperado = await reDescargarAdjuntoSiFalta(propuesta.rutaLocal, {
      mensajeIdGmail: propuesta.origenAdjuntoGmail?.mensajeIdGmail,
      attachmentIdGmail: propuesta.origenAdjuntoGmail?.attachmentIdGmail,
      partId: propuesta.origenAdjuntoGmail?.partId,
    });
    if (recuperado) {
      await adjuntar(propuesta.mimeType, propuesta.nombreArchivoOriginal);
    } else if (propuesta.origenAdjuntoGmail) {
      // Hallazgo real de auditoría (caso real Holded Technologies/Footprint): este documento SÍ tuvo
      // un adjunto real en Gmail (origenAdjuntoGmail está seteado) — el respaldo de arriba solo falló
      // por un problema puntual (Gmail no respondió, el adjunto ya no existe, etc.), no porque nunca
      // hubo un adjunto que recuperar. Regenerar acá un PDF del CUERPO del correo sustituiría la
      // factura/ticket real por un documento que no lo es — nunca solo el hilo de correo, sin el
      // comprobante real — y el llamador (gastoCallbackHandler) ya sabe avisar con claridad que el
      // gasto quedó creado pero sin comprobante para subirlo a mano. El respaldo de "regenerar desde
      // el cuerpo" queda reservado EXCLUSIVAMENTE para cuando nunca hubo un adjunto real que recuperar
      // (rama de abajo).
      throw error;
    } else {
      const regenerado = await regenerarComprobanteDesdeCuerpoSiFalta(propuesta.rutaLocal, propuesta);
      if (!regenerado) throw error;
      // Hallazgo real de auditoría xhigh: el archivo regenerado es SIEMPRE un PDF nuevo — nunca hay
      // que reusar el mimeType/nombre del adjunto original (ej. "image/jpeg" de una foto real). Si se
      // reusaran, Holded terminaría guardando bytes de PDF etiquetados como imagen — un comprobante
      // corrupto en cualquier visor que confíe en el tipo declarado, sin ningún error visible.
      const nombreBase = propuesta.nombreArchivoOriginal.replace(/\.[^./]+$/, "");
      await adjuntar("application/pdf", `comprobante_${nombreBase}.pdf`);
    }
  }
  await limpiarArchivoLocal(propuesta.rutaLocal);
}

async function registrarCierreGastoDePropuesta(
  propuesta: PropuestaGasto,
  gastoId: string,
  empresa = propuesta.empresa
): Promise<void> {
  const mensajeIdGmail = propuesta.correoOrigen?.mensajeIdGmail;
  if (!mensajeIdGmail) return;
  const actualizados = await marcarGastoDesdeCorreoCompletado({ mensajeIdGmail, gastoId });
  if (actualizados > 0) return;
  await registrarGastoDesdeCorreo({
    mensajeIdGmail,
    attachmentId: propuesta.origenAdjuntoGmail?.partId,
    gastoId,
    empresa,
    completado: true,
    identidad: {
      huellaContenido: propuesta.huellaContenido,
      numeroDocumento: propuesta.numeroDocumento,
      proveedor: propuesta.proveedor,
      monto: propuesta.monto,
      moneda: propuesta.moneda,
      fecha: propuesta.fecha,
      concepto: propuesta.concepto,
    },
  });
}

async function registrarCierreGastoPendiente(
  pendiente: {
    mensajeIdGmail?: string;
    gastoId: string;
    empresa: Empresa;
    proveedor?: string;
    monto?: number;
    moneda?: string;
    fecha?: string;
    descripcionGasto: string;
  }
): Promise<void> {
  const mensajeIdGmail = pendiente.mensajeIdGmail?.trim();
  if (!mensajeIdGmail) throw new Error("La conciliación perdió el id de Gmail; no se cierra otro correo por accidente.");
  const actualizados = await marcarGastoDesdeCorreoCompletado({
    mensajeIdGmail,
    gastoId: pendiente.gastoId,
  });
  if (actualizados > 0) return;

  // Recuperación ante un fallo previo al guardar la memoria inicial. La
  // compra ya está confirmada y esta decisión es terminal; se crea una
  // referencia mínima para no perder la barrera contra duplicados.
  await registrarGastoDesdeCorreo({
    mensajeIdGmail,
    gastoId: pendiente.gastoId,
    empresa: pendiente.empresa,
    completado: true,
    identidad: {
      proveedor: pendiente.proveedor,
      monto: pendiente.monto,
      moneda: pendiente.moneda,
      fecha: pendiente.fecha,
      concepto: pendiente.descripcionGasto,
    },
  });
}

export type EstadoIntentoConciliacion =
  | "conciliada"
  | "esperando_eleccion"
  | "sin_candidato"
  | "fallida"
  | "incierta";

interface ResultadoIntentarConciliar {
  nota: string;
  /** Solo `conciliada` permite cerrar el correo automáticamente. Cualquier otro estado conserva
   * el mensaje UNREAD hasta que exista una decisión humana o una verificación terminal real. */
  estado: EstadoIntentoConciliacion;
}

export function gastoPermiteCerrarCorreo(
  comprobanteConfirmado: boolean,
  resultado: Pick<ResultadoIntentarConciliar, "estado">
): boolean {
  return comprobanteConfirmado && resultado.estado === "conciliada";
}

/**
 * Caso real reportado por Carlos: con varios movimientos parecidos, esto devolvía un texto muerto
 * ("revísalo a mano en Holded") sin ningún medio para responder — justo lo que pidió evitar siempre
 * ("cada vez que hagas una pregunta que requiera de mi respuesta, debes darme el medio para
 * dármela"). Ahora guarda los candidatos (conciliacionAmbiguaPendienteStore) y manda un botón "🔗
 * Conciliar con #N" por cada uno — reutiliza conciliarContraMovimientoEspecifico (mismo chequeo de
 * doble-conciliación) para ejecutar el elegido, sin repetir la búsqueda que volvería a toparse con
 * la misma ambigüedad.
 */
async function ofrecerEleccionMovimientosAmbiguos(
  empresa: Empresa,
  gastoId: string,
  descripcionGasto: string,
  chatId: number,
  candidatos: MovimientoBancarioCandidato[],
  deColaCorreo: boolean,
  esAproximado: boolean,
  proveedor?: string,
  mensajeIdGmail?: string,
  comprobanteConfirmado: boolean = true,
  threadIdGmail?: string
): Promise<ResultadoIntentarConciliar> {
  let pendienteGuardada: ConciliacionAmbiguaPendiente | undefined;
  try {
    // Hallazgo real de auditoría xhigh (efficiency): guardarConciliacionAmbiguaPendiente y
    // sugerirCandidatoAprendido son independientes entre sí (ninguna depende del resultado de la
    // otra — la primera solo necesita los datos ya recibidos como parámetros, no `pendiente.id`) así
    // que no hay razón para esperarlas una tras otra antes de mandarle el mensaje a Carlos.
    const [pendiente, indiceSugerido] = await Promise.all([
      guardarConciliacionAmbiguaPendiente({ empresa, gastoId, descripcionGasto, chatId, candidatos, deColaCorreo,
        esAproximado, proveedor, mensajeIdGmail, comprobanteConfirmado, threadIdGmail }),
      // Pedido explícito de Carlos ("que la práctica te vaya dando experticia"):
      // nunca decide sola (Carlos siempre elige con el botón, es dinero), solo
      // resalta con ⭐ la opción que ya coincidió con algo confirmado antes
      // para este proveedor — para que elegir sea más rápido, sin tener que
      // leer las descripciones bancarias crudas cada vez.
      proveedor
        ? sugerirCandidatoAprendido(proveedor, empresa, candidatos).catch((error) => {
            console.error("[gastoCallbackHandler] Error consultando sugerencia aprendida de conciliación (no crítico):", error);
            return undefined;
          })
        : Promise.resolve(undefined),
    ]);
    pendienteGuardada = pendiente;
    const filas: InlineKeyboardButton[][] = candidatos.map((_, i) => [
      {
        text: `${i === indiceSugerido ? "⭐ " : ""}🔗 Conciliar con #${i + 1}`,
        callback_data: `gasto_conciliar_elegir:${pendiente.id}:${i}`,
      },
    ]);
    filas.push([{ text: "❌ Ninguno, dejar así", callback_data: `gasto_conciliar_elegir_no:${pendiente.id}` }]);
    const notaSugerido = indiceSugerido !== undefined ? `\n\n⭐ La opción ${indiceSugerido + 1} coincide con conciliaciones anteriores de este proveedor.` : "";
    const hayTipoCambio = candidatos.some((c) => c.origenCoincidencia === "tipo_cambio");
    const detalleCandidatos = candidatos
      .map((m, i) => hayTipoCambio
        ? describirMovimientoMultimoneda(m, i)
        : `  ${i + 1}. "${m.descripcion || "(sin descripción)"}" — ${m.monto.toFixed(2)} ${m.moneda} (${m.fecha})`)
      .join("\n");
    await sendTelegramMessageWithButtons(
      chatId,
      `💳 Encontré ${candidatos.length} movimientos bancarios${hayTipoCambio ? " en otra moneda usando una tasa histórica de referencia" : esAproximado ? " parecidos (nombre y monto cercanos, no exactos)" : " sin conciliar parecidos"} para "${descripcionGasto}":\n` +
        detalleCandidatos +
        notaSugerido +
        `\n\n¿Con cuál concilio?${hayTipoCambio ? " No elegiré ninguno automáticamente porque la tasa real del banco puede incluir margen." : ""}`,
      filas
    );
    return {
      nota: `\n\n💳 Encontré ${candidatos.length} movimientos parecidos — te mandé aparte los botones para elegir con cuál conciliar (o descartarlo).`,
      estado: "esperando_eleccion",
    };
  } catch (error) {
    console.error("[gastoCallbackHandler] Error ofreciendo elección de movimientos ambiguos (no crítico):", error);
    // Si Sheets aceptó la pendiente pero Telegram no publicó sus botones,
    // no debe quedar una segunda decisión invisible compitiendo con la
    // recuperación visible que el llamador repone a continuación.
    if (pendienteGuardada) {
      await consumirConciliacionAmbiguaPendiente(pendienteGuardada.id).catch((errorLimpieza) =>
        console.error("[gastoCallbackHandler] No se pudo retirar la conciliación ambigua que no llegó a publicarse:", errorLimpieza)
      );
    }
    return { nota: `\n\n⚠️ Hay ${candidatos.length} movimientos bancarios parecidos, pero no pude guardar los botones para elegir. ` +
      `El correo seguirá sin leer; vuelve a intentar la conciliación.`, estado: "fallida" };
  }
}

/**
 * Tras crear/adjuntar un gasto con soporte real, intenta cerrar el círculo
 * conciliando el movimiento bancario correspondiente — solo si hay
 * exactamente un candidato sin conciliar con monto/fecha cercanos (nunca
 * adivina entre varios; si hay varios, ofrece elegir, ver
 * ofrecerEleccionMovimientosAmbiguos). Siempre relee el movimiento para
 * confirmar el estado real (ver reconciliarMovimiento) — el texto que
 * devuelve refleja lo que se pudo confirmar, nunca asume éxito. Nunca lanza:
 * un fallo aquí no debe tumbar el flujo principal de creación/adjunto, que
 * ya tuvo éxito.
 */
async function intentarConciliar(
  empresa: Empresa,
  monto: number,
  fecha: string,
  gastoId: string,
  chatId: number,
  descripcionGasto: string,
  moneda: string = "EUR",
  proveedor?: string,
  deColaCorreo: boolean = false,
  mensajeIdGmail?: string,
  comprobanteConfirmado: boolean = true,
  threadIdGmail?: string
): Promise<ResultadoIntentarConciliar> {
  try {
    const fechaBusqueda = fecha || new Date().toISOString().slice(0, 10);
    const candidatos = await buscarMovimientoSimilar(empresa, { monto, fecha: fechaBusqueda, moneda });

    let candidato: Awaited<ReturnType<typeof buscarMovimientoSimilar>>[number] | undefined;
    let esAproximado = false;

    if (candidatos.length === 1) {
      candidato = candidatos[0];
    } else if (candidatos.length > 1) {
      return await ofrecerEleccionMovimientosAmbiguos(empresa, gastoId, descripcionGasto, chatId, candidatos,
        deColaCorreo, false, proveedor, mensajeIdGmail, comprobanteConfirmado, threadIdGmail);
    } else if (proveedor) {
      // Mismo fallback que procesarGastoEntrante.ts (ver ese archivo para el
      // caso real que lo motivó): el match exacto puede no encontrar nada
      // cuando el equivalente en EUR de la factura es una estimación.
      const aproximados = await buscarMovimientoAproximado(empresa, { monto, fecha: fechaBusqueda, moneda, proveedor });
      if (aproximados.length === 1) {
        candidato = aproximados[0];
        esAproximado = true;
      } else if (aproximados.length > 1) {
        return await ofrecerEleccionMovimientosAmbiguos(empresa, gastoId, descripcionGasto, chatId, aproximados,
          deColaCorreo, true, proveedor, mensajeIdGmail, comprobanteConfirmado, threadIdGmail);
      }
    }

    if (!candidato) {
      // El gasto puede estar en USD y el cargo bancario en EUR (u otra moneda real de la misma
      // empresa). Después de que el usuario pide conciliar, se repite también la búsqueda por tipo
      // de cambio. Incluso con un único resultado se pide elegirlo explícitamente: la tasa del BCE
      // es una referencia, no prueba suficiente para una escritura financiera automática.
      const monedasReales = await obtenerMonedasCuentasReales(empresa);
      const porTipoCambio = await buscarMovimientosPorTipoCambio(
        empresa,
        { monto, moneda, fecha: fechaBusqueda, proveedor },
        monedasReales
      );
      if (porTipoCambio.length > 0) {
        return await ofrecerEleccionMovimientosAmbiguos(
          empresa,
          gastoId,
          descripcionGasto,
          chatId,
          porTipoCambio,
          deColaCorreo,
          true,
          proveedor,
          mensajeIdGmail,
          comprobanteConfirmado,
          threadIdGmail
        );
      }
      return { nota: `\n\n⚠️ No encontré un movimiento bancario libre que coincida. El correo seguirá sin leer ` +
        `para reintentar o resolverlo manualmente.`, estado: "sin_candidato" };
    }

    // Reutiliza conciliarContraMovimientoEspecifico en vez de repetir la llamada a
    // reconciliarMovimiento acá — hallazgo real de auditoría: esta rama llamaba a
    // reconciliarMovimiento DIRECTO, sin el chequeo de estaMovimientoYaConciliado que la otra ruta
    // (checkboxes "🔗 Conciliar con #N") sí tiene, una inconsistencia real entre dos caminos que
    // hacen la misma acción con dinero real.
    return await conciliarContraMovimientoEspecifico(empresa, candidato, gastoId, esAproximado);
  } catch (error) {
    console.error("[gastoCallbackHandler] Error intentando conciliar movimiento bancario:", error);
    return { nota: "\n\n⚠️ No pude completar ni verificar la conciliación. El correo seguirá sin leer para reintentarla.",
      estado: error instanceof ConciliacionMovimientoInciertaError ? "incierta" : "fallida" };
  }
}

/**
 * Concilia DIRECTO contra un movimiento ya identificado (accountId+movementId conocidos) — sin
 * buscar de nuevo. Pedido explícito de Carlos, tras un caso real: con varios movimientos ambiguos,
 * la única forma de elegir era responder en texto libre, incompatible con marcar los checks del
 * teclado al mismo tiempo — ahora Carlos elige CUÁL con un check (🔗 Conciliar con #N,
 * PropuestaGasto.movimientosAmbiguos), y esta función concilia justo contra ESE, sin repetir la
 * búsqueda (que volvería a toparse con la misma ambigüedad, ver intentarConciliar).
 */
async function conciliarContraMovimientoEspecifico(
  empresa: Empresa,
  movimiento: MovimientoBancarioCandidato,
  gastoId: string,
  /**
   * Hallazgo real de auditoría: cuando el candidato elegido venía del fallback aproximado
   * (buscarMovimientoAproximado — nombre y monto parecidos, NO exactos), esa advertencia se perdía
   * antes de llegar acá y el mensaje final sonaba tan seguro como un match exacto. Mismo texto que
   * ya usa intentarConciliar para su propio candidato único aproximado.
   */
  esAproximado: boolean = false,
  /**
   * Pedido explícito de Carlos ("que la práctica te vaya dando experticia") —
   * cuando se da (solo desde el camino de "🔗 Conciliar con #N" sobre una
   * ambigüedad REAL, ver gasto_conciliar_elegir), y la conciliación de
   * verdad tiene éxito, registra qué descripción de movimiento fue la
   * correcta para este proveedor (ver movimientoAmbiguoAprendidoSheet.ts) —
   * nunca decide nada, solo alimenta la sugerencia ⭐ de la próxima vez.
   */
  proveedorParaAprender?: string
): Promise<ResultadoIntentarConciliar> {
  const notaAprox = movimiento.origenCoincidencia === "tipo_cambio"
    ? ` — coincidencia MULTIMONEDA por tasa de referencia: ${describirMovimientoMultimoneda(movimiento)}; confírmalo en Holded`
    : esAproximado
      ? " — coincidencia APROXIMADA (nombre y monto parecidos, no exactos), confírmalo en Holded"
      : "";
  try {
    const yaConciliado = await estaMovimientoYaConciliado(empresa, movimiento.accountId, movimiento.movementId, movimiento.fecha);
    if (yaConciliado) {
      return { nota:
        `\n\n⚠️ Elegiste conciliar contra "${movimiento.descripcion || "sin descripción"}" (${movimiento.monto.toFixed(2)} ${movimiento.moneda}) ` +
        `pero ese movimiento ya quedó conciliado por otra vía mientras esperaba tu aprobación — revísalo a mano en Holded.`
      , estado: "fallida" };
    }

    const resultado = await reconciliarMovimiento(
      empresa,
      movimiento.accountId,
      movimiento.movementId,
      movimiento.fecha,
      gastoId,
      { permitirMonedaDistinta: movimiento.origenCoincidencia === "tipo_cambio" }
    );

    if (resultado.ok) {
      if (proveedorParaAprender && movimiento.descripcion) {
        await registrarMovimientoAmbiguoElegido(proveedorParaAprender, empresa, movimiento.descripcion).catch((error) =>
          console.error("[gastoCallbackHandler] Error registrando aprendizaje de conciliación ambigua (no crítico):", error)
        );
      }
      // Hallazgo real de auditoría (caso Salesmate/RapidOps, Footprint): el movimiento bancario puede
      // quedar marcado como conciliado por completo (esto de arriba) mientras la COMPRA misma, del
      // lado de Holded, queda con un saldo pendiente ficticio — comportamiento real de Holded al
      // aplicar el equivalente en EUR en vez del monto nativo para documentos en otra moneda. Nunca se
      // reporta éxito sin más cuando eso pasa — se avisa explícitamente para que se revise a mano.
      //
      // Pedido explícito de Carlos (2026-09-16): el ajuste ahora se aplica automáticamente (sin botón
      // de confirmación) cuando el residuo queda matemáticamente demostrado — "aplicado" avisa lo que
      // ya se pagó solo; "incierto" (Holded no confirmó tras el POST) sigue bloqueando cualquier
      // repetición automática, igual que el resto de las escrituras durables del proyecto.
      const notaPendiente = resultado.ajusteCambioDivisa?.estado === "aplicado"
        ? `\n\n✅ Detecté y regularicé automáticamente un residuo de cambio de divisa de ` +
          `${resultado.ajusteCambioDivisa.monto.toFixed(2)} EUR contra la cuenta contable ` +
          `"Main" EUR — no era una deuda real ni una conciliación parcial. ${resultado.ajusteCambioDivisa.motivo ?? ""}`
        : resultado.ajusteCambioDivisa?.estado === "incierto"
          ? `\n\n🟠 Detecté un residuo de cambio de divisa de ${resultado.ajusteCambioDivisa.monto.toFixed(2)} EUR y ` +
            `traté de regularizarlo automáticamente, pero Holded no confirmó el resultado. ` +
            `${resultado.ajusteCambioDivisa.motivo ?? ""} No repito el intento solo — revísalo en Holded ` +
            `(sección Pagos del documento) antes de que lo vuelva a intentar.`
          : resultado.ajusteCambioDivisa?.estado === "requiere_revision"
            ? `\n\n🟠 Detecté y demostré un residuo de cambio de divisa de ` +
              `${resultado.ajusteCambioDivisa.monto.toFixed(2)} EUR; no es una deuda real ni una conciliación parcial. ` +
              `${resultado.ajusteCambioDivisa.motivo ?? ""} Corrígelo a mano en Holded (sección Pagos del documento).`
            : resultado.pendienteEnCompra !== undefined
              ? `\n\n⚠️ OJO: el movimiento quedó conciliado por completo, pero la compra en Holded sigue mostrando ` +
                `${resultado.pendienteEnCompra.toFixed(2)} pendiente de pago. No cumple todas las pruebas para considerarlo ` +
                `un residuo automático de cambio; no se regularizó ni se modificó ninguna otra operación. Revísalo a mano ` +
                `en Holded (sección Pagos del documento).`
              : "";
      const notaMovimientoParcial = resultado.movimientoParcial
        ? `\n\n⚠️ La compra quedó pagada y el vínculo fue confirmado, pero el movimiento bancario continúa ` +
          `parcialmente conciliado${resultado.pendienteEnMovimiento !== undefined
            ? ` (${resultado.pendienteEnMovimiento.toFixed(2)} ${movimiento.moneda} todavía sin asignar)`
            : ""}. Revisa si el resto corresponde a otra partida.`
        : "";
      const requiereRevision = conciliacionRequiereRevision(resultado);
      return { nota:
        `\n\n💳 Movimiento bancario conciliado y enlazado al gasto (${movimiento.descripcion || "sin descripción"}, ` +
        `${movimiento.monto.toFixed(2)} ${movimiento.moneda}, enlazado por ${resultado.montoEnlazado.toFixed(2)} ${movimiento.moneda})${notaAprox}.${notaPendiente}${notaMovimientoParcial}`
      , estado: requiereRevision
          ? resultado.ajusteCambioDivisa?.estado === "incierto" ? "incierta" : "fallida"
          : "conciliada" };
    }
    return { nota:
      `\n\n⚠️ Elegiste conciliar contra "${movimiento.descripcion || "sin descripción"}" (${movimiento.monto.toFixed(2)} ${movimiento.moneda}) ` +
      `pero no pude confirmar que quedó conciliado Y enlazado al gasto (estado: ${resultado.statusFinal}, monto enlazado: ` +
      `${resultado.montoEnlazado.toFixed(2)} ${movimiento.moneda}) — revísalo a mano en Holded.`
    , estado: "fallida" };
  } catch (error) {
    console.error("[gastoCallbackHandler] Error conciliando contra el movimiento elegido:", error);
    if (error instanceof ConciliacionMovimientoInciertaError) {
      return { nota:
        `\n\n⏳ Holded no confirmó si concilió el movimiento "${movimiento.descripcion || "sin descripción"}". ` +
        "Wobi bloqueó toda repetición y lo verificará solo por lectura. No vuelvas a conciliarlo manualmente hasta comprobar su estado en Holded."
      , estado: "incierta" };
    }
    return { nota: `\n\n⚠️ El gasto se creó, pero hubo un error al conciliar contra "${movimiento.descripcion || "sin descripción"}" — ` +
      `el correo seguirá sin leer para reintentarlo.`, estado: "fallida" };
  }
}

/**
 * Manda el mensaje de seguimiento preguntando si conciliar el movimiento
 * bancario — solo se usa cuando NO se confirmó un movimiento coincidente
 * ANTES de crear el gasto (ver procesarGastoEntrante.ts): pedido explícito
 * de Carlos, quiere revisar el gasto recién creado en Holded antes de que
 * se intente conciliar, en vez de que ocurra en silencio. Guarda la
 * pregunta en conciliacionPendienteStore (Sheets, sobrevive un redeploy)
 * hasta que se responda con el botón.
 *
 * Devuelve true si la pregunta quedó guardada y enviada de verdad — el
 * llamador (ver deColaCorreo abajo) la usa para decidir si debe esperar la
 * respuesta antes de avanzar la cola de revisión de correo, o si el aviso
 * falló y hay que avanzar de una vez para no dejar la cola esperando una
 * pregunta que nunca llegó.
 */
async function preguntarSiConciliar(
  chatId: number,
  empresa: Empresa,
  monto: number,
  fecha: string,
  descripcionGasto: string,
  gastoId: string,
  moneda: string = "EUR",
  proveedor: string = "",
  deColaCorreo: boolean = false,
  mensajeIdGmail?: string,
  comprobanteConfirmado: boolean = true,
  mensajeFallbackId?: number,
  threadIdGmail?: string
): Promise<boolean> {
  let pendiente: Awaited<ReturnType<typeof guardarConciliacionPendiente>> | undefined;
  try {
    pendiente = await guardarConciliacionPendiente({
      empresa,
      monto,
      fecha,
      descripcionGasto,
      chatId,
      gastoId,
      moneda,
      proveedor,
      deColaCorreo,
      mensajeIdGmail,
      comprobanteConfirmado,
      threadIdGmail,
    });
    const texto = `¿Quieres que intente conciliar el movimiento bancario correspondiente a "${descripcionGasto}"?`;
    const botones = [[
      { text: "🔗 Sí, conciliar", callback_data: `gasto_conciliar_si:${pendiente.id}` },
      { text: "❌ No, dejar así", callback_data: `gasto_conciliar_no:${pendiente.id}` },
    ]];
    try {
      await sendTelegramMessageWithButtons(chatId, texto, botones);
    } catch (errorEnvio) {
      if (mensajeFallbackId == null) throw errorEnvio;
      await editTelegramMessage(chatId, mensajeFallbackId, texto, botones);
    }
    return true;
  } catch (error) {
    console.error("[gastoCallbackHandler] Error preguntando si conciliar (no crítico):", error);
    if (pendiente) await consumirConciliacionPendiente(pendiente.id).catch(() => undefined);
    return false;
  }
}

async function reponerPreguntaConciliacion(
  pendiente: ConciliacionPendiente,
  mensajeId: number | undefined,
  aviso: string
): Promise<void> {
  const restaurada = await restaurarConciliacionPendiente(pendiente);
  const botones = [[
    { text: "🔗 Sí, conciliar", callback_data: `gasto_conciliar_si:${restaurada.id}` },
    { text: "❌ No, dejar así", callback_data: `gasto_conciliar_no:${restaurada.id}` },
  ]];
  if (mensajeId != null) {
    try {
      await editTelegramMessage(restaurada.chatId, mensajeId, aviso, botones);
      return;
    } catch (error) {
      console.error("[gastoCallbackHandler] No se pudo reponer la pregunta de conciliación en el mensaje original; se enviará una nueva:", error);
    }
  }
  await sendTelegramMessageWithButtons(restaurada.chatId, aviso, botones);
}

async function reponerPreguntaConciliacionAmbigua(
  pendiente: ConciliacionAmbiguaPendiente,
  mensajeId: number | undefined,
  aviso: string
): Promise<void> {
  const restaurada = await restaurarConciliacionAmbiguaPendiente(pendiente);
  const botones = [
    ...restaurada.candidatos.map((c, i) => [{
      text: `${i + 1}. ${c.descripcion || "sin descripción"} — ${c.monto.toFixed(2)} ${c.moneda} (${c.fecha})`,
      callback_data: `gasto_conciliar_elegir:${restaurada.id}:${i}`,
    }]),
    [{ text: "❌ Ninguno / no conciliar", callback_data: `gasto_conciliar_elegir_no:${restaurada.id}` }],
  ];
  if (mensajeId != null) {
    try {
      await editTelegramMessage(restaurada.chatId, mensajeId, aviso, botones);
      return;
    } catch (error) {
      console.error("[gastoCallbackHandler] No se pudo reponer la conciliación ambigua en el mensaje original; se enviará una nueva:", error);
    }
  }
  await sendTelegramMessageWithButtons(restaurada.chatId, aviso, botones);
}

async function reponerSoloCierrePropuesta(
  propuesta: PropuestaGasto,
  mensaje: string
): Promise<void> {
  const restaurada = await restaurarPropuestaGasto({ ...propuesta, seleccionAcciones: [] });
  const botones = [[{
    text: "✅ Finalizar correo ya resuelto",
    callback_data: `gasto_cerrar_propuesta:${restaurada.id}`,
  }]];
  try {
    await editTelegramMessage(restaurada.chatId, restaurada.messageId, mensaje, botones);
  } catch (error) {
    console.error("[gastoCallbackHandler] No se pudo reponer el cierre en el mensaje original; se enviará uno nuevo:", error);
    const messageId = await sendTelegramMessageWithButtons(restaurada.chatId, mensaje, botones);
    await actualizarMessageIdGasto(restaurada.id, messageId);
  }
}

async function reponerSoloCierreCancelacion(
  propuesta: PropuestaGasto,
  mensaje: string
): Promise<void> {
  const restaurada = await restaurarPropuestaGasto({ ...propuesta, seleccionAcciones: [] });
  const botones = [[{
    text: "✅ Finalizar descarte del correo",
    callback_data: `gasto_cancelar:${restaurada.id}`,
  }]];
  try {
    await editTelegramMessage(restaurada.chatId, restaurada.messageId, mensaje, botones);
  } catch (error) {
    console.error("[gastoCallbackHandler] No se pudo reponer el cierre del descarte en el mensaje original; se enviará uno nuevo:", error);
    const messageId = await sendTelegramMessageWithButtons(restaurada.chatId, mensaje, botones);
    await actualizarMessageIdGasto(restaurada.id, messageId);
  }
}

async function reponerSoloCierreConciliacion(
  pendiente: ConciliacionPendiente,
  mensajeId: number | undefined,
  mensaje: string
): Promise<void> {
  const restaurada = await restaurarConciliacionPendiente(pendiente);
  const botones = [[{
    text: "✅ Finalizar correo ya resuelto",
    callback_data: `gasto_cerrar_conciliacion:${restaurada.id}`,
  }]];
  if (mensajeId != null) {
    try {
      await editTelegramMessage(restaurada.chatId, mensajeId, mensaje, botones);
      return;
    } catch (error) {
      console.error("[gastoCallbackHandler] No se pudo reponer el cierre de conciliación en el mensaje original; se enviará uno nuevo:", error);
    }
  }
  await sendTelegramMessageWithButtons(restaurada.chatId, mensaje, botones);
}

async function reponerSoloCierreConciliacionAmbigua(
  pendiente: ConciliacionAmbiguaPendiente,
  mensajeId: number | undefined,
  mensaje: string
): Promise<void> {
  const restaurada = await restaurarConciliacionAmbiguaPendiente(pendiente);
  const botones = [[{
    text: "✅ Finalizar correo ya resuelto",
    callback_data: `gasto_cerrar_ambigua:${restaurada.id}`,
  }]];
  if (mensajeId != null) {
    try {
      await editTelegramMessage(restaurada.chatId, mensajeId, mensaje, botones);
      return;
    } catch (error) {
      console.error("[gastoCallbackHandler] No se pudo reponer el cierre ambiguo en el mensaje original; se enviará uno nuevo:", error);
    }
  }
  await sendTelegramMessageWithButtons(restaurada.chatId, mensaje, botones);
}

/**
 * Maneja los botones de propuestas de gasto (gasto_adjuntar / gasto_nuevo /
 * gasto_nuevo_conciliar / gasto_corregir / gasto_cancelar / gasto_conciliar_si
 * / gasto_conciliar_no). Los únicos caminos que escriben algo real en
 * Holded son gasto_adjuntar, gasto_nuevo y gasto_nuevo_conciliar (y la
 * confirmación tras gasto_corregir) — nunca ocurre automáticamente.
 */
export async function handleGastoCallback(callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data;
  if (!data) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const [accion, propuestaId, extra] = data.split(":");

  if (accion === "gasto_cerrar_propuesta") {
    const propuesta = await consumirPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Este cierre ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id, "Finalizando correo...");
    await finalizarGastoCorreoAntesDeRender(
      () => {
        const gastoId = propuesta.candidatos[0]?.id;
        if (!gastoId) throw new Error("La recuperación perdió el id del gasto ya resuelto.");
        return registrarCierreGastoDePropuesta(propuesta, gastoId);
      },
      () => avanzarColaCorreoSiActivo(
        propuesta.chatId,
        { threadId: propuesta.correoOrigen?.threadId, mensajeId: propuesta.correoOrigen?.mensajeIdGmail },
        `gasto:${propuesta.id}:cierre`
      ),
      () => reponerSoloCierrePropuesta(
        propuesta,
        "⚠️ La compra, el soporte y la conciliación ya terminaron, pero no pude cerrar su registro técnico. " +
          "El correo sigue sin leer. Este botón solo reintenta el cierre; no repite ninguna operación financiera."
      ),
      () => editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        "✅ Gasto, soporte y conciliación confirmados. El correo quedó procesado.",
        []
      )
    );
    return;
  }

  if (accion === "gasto_cerrar_conciliacion") {
    const pendiente = await consumirConciliacionPendiente(propuestaId);
    if (!pendiente) {
      await answerCallbackQuerySafe(callback.id, "Este cierre ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id, "Finalizando correo...");
    await finalizarGastoCorreoAntesDeRender(
      () => registrarCierreGastoPendiente(pendiente),
      () => avanzarColaCorreoSiActivo(
        pendiente.chatId,
        { threadId: pendiente.threadIdGmail, mensajeId: pendiente.mensajeIdGmail },
        `gasto:conciliacion:${pendiente.id}:cierre`
      ),
      () => reponerSoloCierreConciliacion(
        pendiente,
        callback.message?.message_id,
        "⚠️ La decisión financiera ya terminó, pero no pude cerrar su registro técnico. El correo sigue sin leer. " +
          "Este botón solo reintenta el cierre."
      ),
      () => editTelegramMessage(
        pendiente.chatId,
        callback.message?.message_id ?? 0,
        `✅ “${pendiente.descripcionGasto}” quedó procesado y el correo fue cerrado.`,
        []
      )
    );
    return;
  }

  if (accion === "gasto_cerrar_ambigua") {
    const pendiente = await consumirConciliacionAmbiguaPendiente(propuestaId);
    if (!pendiente) {
      await answerCallbackQuerySafe(callback.id, "Este cierre ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id, "Finalizando correo...");
    await finalizarGastoCorreoAntesDeRender(
      () => registrarCierreGastoPendiente(pendiente),
      () => avanzarColaCorreoSiActivo(
        pendiente.chatId,
        { threadId: pendiente.threadIdGmail, mensajeId: pendiente.mensajeIdGmail },
        `gasto:conciliacion-ambigua:${pendiente.id}:cierre`
      ),
      () => reponerSoloCierreConciliacionAmbigua(
        pendiente,
        callback.message?.message_id,
        "⚠️ La decisión financiera ya terminó, pero no pude cerrar su registro técnico. El correo sigue sin leer. " +
          "Este botón solo reintenta el cierre."
      ),
      () => editTelegramMessage(
        pendiente.chatId,
        callback.message?.message_id ?? 0,
        `✅ “${pendiente.descripcionGasto}” quedó procesado y el correo fue cerrado.`,
        []
      )
    );
    return;
  }

  if (accion === "gasto_espera") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta espera ya no está disponible.");
      return;
    }
    const bloqueante = extra ? await obtenerPropuestaGasto(extra) : undefined;
    if (bloqueante) {
      await answerCallbackQuerySafe(callback.id, "La propuesta anterior todavía sigue pendiente.");
      await editTelegramMessage(
        propuesta.chatId,
        propuesta.messageId,
        `⏳ La propuesta anterior de ${bloqueante.proveedor} por ${bloqueante.monto.toFixed(2)} ${bloqueante.moneda} ` +
          `todavía no se ha resuelto. Este correo seguirá sin leer para evitar una creación duplicada.`,
        [
          [{ text: "🔎 Verificar y continuar", callback_data: `gasto_espera:${propuesta.id}:${bloqueante.id}` }],
          [{ text: "❌ Descartar este correo", callback_data: `gasto_cancelar:${propuesta.id}` }],
        ]
      );
      return;
    }

    await answerCallbackQuerySafe(callback.id, "La propuesta anterior ya se resolvió.");
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✅ La propuesta anterior ya se resolvió. Revisa esta operación antes de aprobarla:\n\n${resumenTextoPropuestaGasto(propuesta)}`,
      construirTecladoGasto(propuesta, opcionesTecladoDesdePropuesta(propuesta))
    );
    return;
  }

  if (accion === "gasto_cancelar") {
    const propuesta = await consumirPropuestaGasto(propuestaId);
    await answerCallbackQuerySafe(callback.id, "Cancelado.");
    if (propuesta) {
      await limpiarArchivoLocal(propuesta.rutaLocal);
      if (propuesta.deColaCorreo) {
        await finalizarGastoCorreoAntesDeRender(
          async () => undefined,
          () => avanzarColaCorreoSiActivo(
            propuesta.chatId,
            { threadId: propuesta.correoOrigen?.threadId, mensajeId: propuesta.correoOrigen?.mensajeIdGmail },
            `gasto:${propuesta.id}:cancelar`
          ),
          () => reponerSoloCierreCancelacion(
            propuesta,
            "⚠️ El descarte ya fue solicitado, pero no pude cerrar el correo. Sigue sin leer; este botón solo reintenta el cierre."
          ),
          () => editTelegramMessage(
            propuesta.chatId,
            propuesta.messageId,
            `❌ Cancelado — ${propuesta.proveedor} (${propuesta.monto} ${propuesta.moneda})`,
            []
          )
        );
      } else {
        await editTelegramMessage(
          propuesta.chatId,
          propuesta.messageId,
          `❌ Cancelado — ${propuesta.proveedor} (${propuesta.monto} ${propuesta.moneda})`,
          []
        ).catch((error) => console.error("[gastoCallbackHandler] No se pudo reflejar la cancelación ya aplicada (no crítico):", error));
      }
    }
    return;
  }

  if (accion === "gasto_corregir") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id);
    // La respuesta de texto ya tiene dueño durable antes de retirar el
    // teclado. Si Telegram o el proceso fallan después, el usuario no queda
    // con un mensaje sin botones y sin estado recuperable.
    await guardarPendienteCorreccionGasto(propuesta.chatId, propuesta.id);
    await editTelegramMessage(
      propuesta.chatId,
      propuesta.messageId,
      `✏️ Ok — dime la empresa y el concepto correctos (ej. "EWORKS, servicio de limpieza").`,
      []
    );
    return;
  }

  // Pedido explícito de Carlos, tras un caso real: una cuota de comunidad
  // se paga a medias con otra parte, así que el gasto a registrar es solo
  // la MITAD del importe real de la factura — no había ninguna forma de
  // ajustar el monto antes de crear el gasto. A diferencia de
  // "gasto_corregir" (que SÍ le quita los botones al mensaje original,
  // porque ahí la respuesta de texto libre reemplaza tanto empresa como
  // concepto), esto NO le toca los botones — solo LEE la propuesta
  // (obtenerPropuestaGasto, sin consumir) y actualiza el monto/líneas
  // guardados. "✅ Crear gasto en Holded" sigue arriba y funciona igual de
  // bien después: como crea el gasto releyendo la propuesta por su id en
  // el momento del click (consumirPropuestaGasto), automáticamente recoge
  // el monto ya corregido sin que haga falta reenviar nada.
  if (accion === "gasto_ajustarmonto") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id);
    await guardarPendienteAjusteMontoGasto(propuesta.chatId, propuesta.id);
    // Bug real de auditoría (2026-09-03): este botón (mensaje VIEJO, ya en
    // vuelo desde antes del teclado de selección) dejaba los DEMÁS botones
    // del mismo mensaje intactos — incluido "✏️ Corregir clasificación",
    // que SÍ crea el gasto de inmediato al responder. Si Carlos tocaba los
    // dos y luego respondía un monto, la respuesta podía caer en el
    // pendiente de corrección equivocado (server.ts revisa esa cola
    // primero) y crear el gasto con un concepto basura. Se quita el
    // teclado de este mensaje al usar cualquiera de sus botones — mismo
    // criterio que gasto_corregir, para que solo uno pueda usarse por
    // mensaje viejo.
    await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, []).catch((error) =>
      console.error("[gastoCallbackHandler] Error quitando el teclado del mensaje viejo (no crítico):", error)
    );
    await sendTelegramMessage(
      propuesta.chatId,
      `💰 Ok — dime el monto real a registrar para "${propuesta.proveedor}" (ej. "251.30", o "la mitad" de ` +
        `${propuesta.monto} ${propuesta.moneda}).`
    );
    return;
  }

  // Pedido explícito de Carlos, tras un caso real (INDUBUILDING LUARCA): una
  // factura por correo solo dejaba registrar el gasto, sin poder ADEMÁS
  // responder ese correo, guardarlo como conocimiento o dejar un
  // recordatorio — "puede ser 1 sola cosa... o pueden ser varias". Estas tres
  // ramas quedan para mensajes VIEJOS ya en vuelo con los botones standalone
  // de antes del teclado de selección — solo existían cuando
  // propuesta.correoOrigen venía seteado (ver construirTecladoGasto en
  // gastoTeclado.ts para el teclado nuevo, que ya no manda estos botones).
  if (accion === "gasto_responder") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta || !propuesta.correoOrigen) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id, "Redactando...");
    // Mismo criterio que gasto_ajustarmonto arriba — se quita el teclado del
    // mensaje viejo al usar cualquiera de sus botones, para que no queden
    // dos pendientes de texto libre vivos a la vez sobre la misma propuesta.
    const iniciada = await ejecutarResponderCorreo(propuesta);
    if (iniciada) {
      await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, []).catch((error) =>
        console.error("[gastoCallbackHandler] Error quitando el teclado del mensaje viejo (no crítico):", error)
      );
    }
    return;
  }

  if (accion === "gasto_guardarconocimiento") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta || !propuesta.correoOrigen) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id, "Leyendo el correo...");
    const iniciada = await ejecutarGuardarConocimiento(propuesta);
    if (iniciada) {
      await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, []).catch((error) =>
        console.error("[gastoCallbackHandler] Error quitando el teclado del mensaje viejo (no crítico):", error)
      );
    }
    return;
  }

  if (accion === "gasto_otrasacciones") {
    const propuesta = await obtenerPropuestaGasto(propuestaId);
    if (!propuesta || !propuesta.correoOrigen) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id);
    await guardarPendienteAccionGasto(propuesta.chatId, propuesta.id);
    await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, []).catch((error) =>
      console.error("[gastoCallbackHandler] Error quitando el teclado del mensaje viejo (no crítico):", error)
    );
    await sendTelegramMessage(
      propuesta.chatId,
      `✏️ Ok — dime qué más quieres hacer con el correo "${propuesta.correoOrigen.asunto}" de ${propuesta.correoOrigen.de} ` +
        `(ej. "prográmame un recordatorio para conciliar mañana", o combina varias cosas en el mismo mensaje).`
    );
    return;
  }

  if (accion === "gasto_toggle") {
    await handleGastoToggleCallback(callback, propuestaId, extra);
    return;
  }

  if (accion === "gasto_aprobar") {
    await handleGastoAprobarCallback(callback, propuestaId);
    return;
  }

  if (accion === "gasto_adjuntar" || accion === "gasto_nuevo" || accion === "gasto_nuevo_conciliar") {
    const propuesta = await consumirPropuestaGasto(propuestaId);
    if (!propuesta) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Procesando...");
    await editTelegramMessage(propuesta.chatId, propuesta.messageId, `🔄 Procesando "${propuesta.proveedor}"...`, []).catch(
      (error) => console.error("[gastoCallbackHandler] No se pudo mostrar el progreso (no crítico):", error)
    );

    let preguntaConciliacionPendiente = false;
    let cierreCorreoVerificado = false;
    let gastoIdProcesado: string | undefined;
    let mensajeCierreTerminal: string | undefined;
    let propuestaEnProceso = propuesta;
    try {
      // También protege el camino "adjuntar a existente": un desglose
      // inconsistente no puede terminar conciliando un gasto equivocado.
      validarTotalFiscalGasto(propuesta);
      if (accion === "gasto_adjuntar") {
        const indice = Number(extra);
        const candidato = propuesta.candidatos[indice];
        if (!candidato) {
          throw new Error(`No se encontró el candidato #${indice + 1}.`);
        }
        gastoIdProcesado = candidato.id;

        // El gasto candidato YA EXISTE en Holded desde antes — un fallo al
        // adjuntar el comprobante nunca debe verse como un error total (no
        // se creó ni se rompió nada), mismo criterio que crearGastoYReportar
        // aplica cuando el gasto se acaba de crear.
        let notaComprobante = "";
        let comprobanteConfirmado = true;
        try {
          await adjuntarYLimpiar(propuesta, candidato.id);
        } catch (error) {
          comprobanteConfirmado = false;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[gastoCallbackHandler] Gasto ${candidato.id} ya existía pero falló adjuntar el comprobante:`, message);
          notaComprobante = error instanceof AdjuntoCompraInciertoError
            ? `\n\n⏳ Holded no confirmó todavía el comprobante. Wobi bloqueó toda repetición y lo verificará solo por lectura. No lo subas manualmente hasta comprobar el estado (id ${candidato.id}).`
            : `\n\n⚠️ No pude adjuntar el comprobante (${message}). Súbelo a mano en Holded (id ${candidato.id}) si tienes el archivo.`;
        }

        if (!comprobanteConfirmado) {
          await reponerPropuestaParaReintento(
            propuesta,
            `⚠️ El gasto ya existe en Holded, pero el soporte todavía no está confirmado.${notaComprobante}\n\n` +
              `El correo seguirá sin leer. Usa “Reintentar/verificar soporte del gasto creado”; la operación durable ` +
              `primero comprobará Holded y nunca repetirá una subida incierta.`,
            { ...candidato, soportePendiente: true }
          );
          return;
        }

        await registrarClasificacionAprendida(propuesta.proveedor, propuesta.empresa, propuesta.concepto).catch(
          (error) => console.error("[gastoCallbackHandler] No se pudo guardar la clasificación aprendida (no crítico):", error)
        );
        if (propuesta.correoOrigen?.mensajeIdGmail) {
          await registrarGastoDesdeCorreo({
            mensajeIdGmail: propuesta.correoOrigen.mensajeIdGmail,
            attachmentId: propuesta.origenAdjuntoGmail?.partId,
            gastoId: candidato.id,
            empresa: propuesta.empresa,
            completado: false,
            identidad: {
              huellaContenido: propuesta.huellaContenido,
              numeroDocumento: propuesta.numeroDocumento,
              proveedor: propuesta.proveedor,
              monto: propuesta.monto,
              moneda: propuesta.moneda,
              fecha: propuesta.fecha,
              concepto: propuesta.concepto,
            },
          });
        }
        const resultadoConciliacion = await intentarConciliar(
          propuesta.empresa,
          propuesta.monto,
          propuesta.fecha,
          candidato.id,
          propuesta.chatId,
          `${candidato.contactName} — ${propuesta.monto} ${propuesta.moneda}`,
          propuesta.moneda,
          propuesta.proveedor,
          propuesta.deColaCorreo === true,
          propuesta.correoOrigen?.mensajeIdGmail,
          comprobanteConfirmado,
          propuesta.correoOrigen?.threadId
        );
        preguntaConciliacionPendiente = resultadoConciliacion.estado === "esperando_eleccion";
        cierreCorreoVerificado = gastoPermiteCerrarCorreo(comprobanteConfirmado, resultadoConciliacion);

        if (!cierreCorreoVerificado && !preguntaConciliacionPendiente) {
          await reponerPropuestaParaReintento(
            propuesta,
            `✅ El soporte del gasto ${candidato.id} quedó confirmado, pero la conciliación todavía no terminó.` +
              `${resultadoConciliacion.nota}\n\nEl correo seguirá sin leer. Usa “Retomar conciliación del gasto creado”; ` +
              `la operación durable primero verifica el estado y no repite una escritura incierta.`,
            { ...candidato, conciliacionPendiente: true }
          );
          return;
        }

        mensajeCierreTerminal =
          `✅ Gasto de ${candidato.contactName} (${candidato.total.toFixed(2)} €, ${candidato.fecha}) en Holded` +
          (notaComprobante ? "." : " — comprobante adjuntado.") +
          `${notaComprobante}${resultadoConciliacion.nota}`;
      } else {
        // gasto_nuevo_conciliar: procesarGastoEntrante ya confirmó un
        // movimiento bancario coincidente ANTES de proponer — suficiente
        // confianza para conciliar de una, sin pedir revisión previa.
        // gasto_nuevo: no había match confirmado — se crea nomás y se
        // pregunta DESPUÉS (preguntarSiConciliar), para que se revise en
        // Holded antes de conciliar.
        const conciliarInline = accion === "gasto_nuevo_conciliar";
        // "gasto_nuevo_conciliar:<id>:<indice>" — variante con índice, para conciliar contra un
        // candidato AMBIGUO específico que Carlos eligió con el check "🔗 Conciliar con #N" (ver
        // PropuestaGasto.movimientosAmbiguos) — sin esto, conciliarInline volvería a buscar en
        // genérico y toparía con la MISMA ambigüedad que ya se le pidió elegir.
        const indiceMovAmbiguo = extra !== undefined && extra !== "" ? Number(extra) : undefined;
        const movimientoObjetivo =
          indiceMovAmbiguo !== undefined && Number.isFinite(indiceMovAmbiguo)
            ? propuesta.movimientosAmbiguos?.[indiceMovAmbiguo]
            : undefined;
        propuestaEnProceso = await prepararPropuestaFinalGasto(propuesta, {
          empresa: propuesta.empresa,
          concepto: propuesta.concepto,
          forzarReinferencia: !propuesta.cuentaId,
        });
        const resultado = await crearGastoYReportar(
          propuestaEnProceso,
          propuestaEnProceso.empresa,
          propuestaEnProceso.concepto,
          undefined,
          conciliarInline,
          true,
          movimientoObjetivo
        );
        gastoIdProcesado = resultado.gastoId;
        if (!resultado.comprobanteConfirmado && resultado.soportePendiente) {
          await reponerPropuestaParaReintento(
            propuestaEnProceso,
            `${resultado.mensaje}\n\nEl correo seguirá sin leer y no se intentará conciliar hasta confirmar el soporte. ` +
              `Usa “Reintentar/verificar soporte del gasto creado”; la verificación durable evita duplicar la compra o el archivo.`,
            resultado.soportePendiente
          );
          return;
        }
        if (resultado.conciliacionPendiente) {
          await editTelegramMessage(propuesta.chatId, propuesta.messageId, resultado.mensaje, []).catch(
            (error) => console.error("[gastoCallbackHandler] No se pudo reflejar el gasto creado antes de preguntar la conciliación (no crítico):", error)
          );
          preguntaConciliacionPendiente = await preguntarSiConciliar(
            propuesta.chatId,
            resultado.conciliacionPendiente.empresa,
            resultado.conciliacionPendiente.monto,
            resultado.conciliacionPendiente.fecha,
            resultado.conciliacionPendiente.descripcionGasto,
            resultado.conciliacionPendiente.gastoId,
            resultado.conciliacionPendiente.moneda,
            resultado.conciliacionPendiente.proveedor,
            propuesta.deColaCorreo === true,
            propuesta.correoOrigen?.mensajeIdGmail,
            resultado.comprobanteConfirmado,
            propuesta.messageId,
            propuesta.correoOrigen?.threadId
          );
          if (!preguntaConciliacionPendiente) {
            const seguimiento = resultado.conciliacionPendiente;
            await reponerPropuestaParaReintento(
              propuestaEnProceso,
              `${resultado.mensaje}\n\n⚠️ No pude publicar la pregunta de conciliación. El correo seguirá sin leer. ` +
                `Usa “Retomar conciliación del gasto creado”; la compra y su soporte ya están protegidos contra duplicados.`,
              {
                id: seguimiento.gastoId,
                contactName: propuesta.proveedor,
                fecha: seguimiento.fecha,
                total: seguimiento.monto,
                descripcion: seguimiento.descripcionGasto,
                moneda: seguimiento.moneda,
                conciliacionPendiente: true,
              }
            );
            return;
          }
        } else if (resultado.esperandoEleccionConciliacion) {
          preguntaConciliacionPendiente = true;
          await editTelegramMessage(propuesta.chatId, propuesta.messageId, resultado.mensaje, []).catch(
            (error) => console.error("[gastoCallbackHandler] No se pudo reflejar la espera de conciliación ambigua (no crítico):", error)
          );
        }
        cierreCorreoVerificado = resultado.comprobanteConfirmado && resultado.estadoConciliacion === "conciliada";
        if (cierreCorreoVerificado) mensajeCierreTerminal = resultado.mensaje;
      }
    } catch (error) {
      if (error instanceof ContactoNoEncontradoError) {
        await manejarContactoNoEncontrado(
          propuestaEnProceso,
          propuestaEnProceso.empresa,
          propuestaEnProceso.concepto,
          propuestaEnProceso.chatId,
          propuestaEnProceso.messageId
        );
        return;
      }
      if (error instanceof FechaBloqueadaError) {
        await manejarFechaBloqueada(
          propuestaEnProceso,
          propuestaEnProceso.empresa,
          propuestaEnProceso.concepto,
          error,
          propuestaEnProceso.chatId,
          propuestaEnProceso.messageId
        );
        return;
      }
      if (error instanceof PosibleDuplicadoGastoError) {
        const propuestaConCandidatos = { ...propuestaEnProceso, candidatos: error.candidatos };
        await reponerPropuestaParaReintento(
          propuestaConCandidatos,
          `${mensajeDuplicadoDetectado(error.candidatos)}\n\nEl correo seguirá sin leer. Selecciona el gasto correcto para adjuntar el soporte o confirma que es uno nuevo.`
        );
        return;
      }
      if (error instanceof VerificacionDuplicadoFallidaError) {
        await reponerPropuestaParaReintento(
          propuestaEnProceso,
          `${mensajeVerificacionDuplicadoFallida(error)}\n\nEl correo seguirá sin leer; usa los botones para reintentar cuando Holded responda.`
        );
        return;
      }
      if (error instanceof CreacionCompraInciertaError) {
        await reponerVerificacionCreacionIncierta(
          propuestaEnProceso,
          `${mensajeCreacionCompraIncierta(propuestaEnProceso.proveedor)}\n\nEl correo seguirá sin leer. El único botón disponible verifica el ledger y Holded; nunca repite un POST incierto.`
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[gastoCallbackHandler] Error procesando gasto:", message);
      await reponerPropuestaParaReintento(
        propuestaEnProceso,
        `⚠️ Error procesando "${propuestaEnProceso.proveedor}"\n\n${message}\n\n` +
          `El correo sigue sin leer y la misma propuesta quedó disponible para reintentar sin reenviar el documento.`
      );
      // No avanza la cola en el error — mejor dejarlo "activo" (visible,
      // pendiente) que marcar leído un correo cuyo gasto en realidad nunca
      // se creó. Mismo criterio que documentCallbackHandler.ts.
      return;
    }
    // Si se acaba de mandar la pregunta "¿conciliar?" (preguntaConciliacionPendiente=true),
    // crear el gasto es solo el primer paso — falta la decisión de conciliar
    // o no, así que la cola espera esa respuesta (ver gasto_conciliar_si/no
    // abajo) en vez de avanzar aquí. Pedido explícito de Carlos: verificar
    // que "crear el gasto y luego conciliar" cuenta como los dos pasos que
    // hacen falta para dar el correo por resuelto, no solo el primero — bug
    // real encontrado al revisar el código: antes avanzaba apenas se creaba
    // el gasto, dejando la pregunta de conciliación desconectada de la cola.
    if (propuestaEnProceso.deColaCorreo && cierreCorreoVerificado && !preguntaConciliacionPendiente) {
      const gastoId = gastoIdProcesado;
      if (!gastoId) {
        await reponerSoloCierrePropuesta(
          propuestaEnProceso,
          "⚠️ La operación terminó, pero se perdió el identificador del gasto antes de cerrar el correo. " +
            "El correo sigue sin leer y no se repetirá ninguna operación financiera."
        );
        return;
      }
      await finalizarGastoCorreoAntesDeRender(
        () => registrarCierreGastoDePropuesta(propuestaEnProceso, gastoId),
        () => avanzarColaCorreoSiActivo(
          propuestaEnProceso.chatId,
          { threadId: propuestaEnProceso.correoOrigen?.threadId, mensajeId: propuestaEnProceso.correoOrigen?.mensajeIdGmail },
          `gasto:${propuestaEnProceso.id}:cierre`
        ),
        () => reponerSoloCierrePropuesta(
          { ...propuestaEnProceso, candidatos: [{
            id: gastoId,
            contactName: propuestaEnProceso.proveedor,
            fecha: propuestaEnProceso.fecha,
            total: propuestaEnProceso.monto,
            descripcion: propuestaEnProceso.concepto,
            moneda: propuestaEnProceso.moneda,
            conciliacionPendiente: true,
          }] },
          "⚠️ El gasto, el soporte y la conciliación ya terminaron, pero no pude cerrar su registro técnico. " +
            "El correo sigue sin leer. El botón disponible solo reintenta el cierre y no repite ninguna operación financiera."
        ),
        () => editTelegramMessage(
          propuestaEnProceso.chatId,
          propuestaEnProceso.messageId,
          mensajeCierreTerminal ?? `✅ Gasto ${gastoId} procesado, soportado y conciliado.`,
          []
        )
      );
    } else if (mensajeCierreTerminal) {
      // Fuera de la cola no hay Gmail que cerrar, pero el resultado visual
      // sigue siendo best-effort y nunca afecta el resultado financiero.
      await editTelegramMessage(propuestaEnProceso.chatId, propuestaEnProceso.messageId, mensajeCierreTerminal, []).catch(
        (error) => console.error("[gastoCallbackHandler] No se pudo reflejar el gasto terminal fuera de cola (no crítico):", error)
      );
    }
    return;
  }

  if (accion === "gasto_conciliar_si" || accion === "gasto_conciliar_no") {
    const pendiente = await consumirConciliacionPendiente(propuestaId);
    if (!pendiente) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible.");
      return;
    }

    if (!pendiente.comprobanteConfirmado) {
      try {
        pendiente.comprobanteConfirmado = await compraTieneComprobante(pendiente.empresa, pendiente.gastoId);
      } catch (error) {
        await reponerPreguntaConciliacion(
          pendiente,
          callback.message?.message_id,
          `⚠️ No pude verificar por lectura si el gasto tiene soporte. El correo sigue sin leer; vuelve a intentarlo cuando Holded responda.`
        );
        return;
      }
      if (!pendiente.comprobanteConfirmado) {
        await reponerPreguntaConciliacion(
          pendiente,
          callback.message?.message_id,
          `⚠️ Este gasto todavía no tiene comprobante en Holded. Adjunta el soporte y vuelve a pulsar una opción; ` +
            `Wobi lo verificará por lectura antes de cerrar el correo.`
        );
        return;
      }
    }

    if (accion === "gasto_conciliar_no") {
      await answerCallbackQuerySafe(callback.id, "Ok, no se concilia.");
      if (pendiente.deColaCorreo && pendiente.comprobanteConfirmado) {
        await finalizarGastoCorreoAntesDeRender(
          () => registrarCierreGastoPendiente(pendiente),
          () => avanzarColaCorreoSiActivo(
            pendiente.chatId,
            { threadId: pendiente.threadIdGmail, mensajeId: pendiente.mensajeIdGmail },
            `gasto:conciliacion:${pendiente.id}:cierre`
          ),
          () => reponerSoloCierreConciliacion(
            pendiente,
            callback.message?.message_id,
            "⚠️ La decisión de dejar el gasto sin conciliar ya quedó tomada, pero no pude cerrar su registro técnico. " +
              "El correo sigue sin leer. Este botón solo reintenta el cierre."
          ),
          () => sendTelegramMessage(pendiente.chatId, `Ok — "${pendiente.descripcionGasto}" queda sin conciliar.`)
        );
        return;
      } else if (!pendiente.comprobanteConfirmado) {
        await reponerPreguntaConciliacion(
          pendiente,
          callback.message?.message_id,
          `⚠️ No puedo cerrar este correo: el gasto todavía no tiene soporte confirmado. ` +
          `Adjunta o verifica el comprobante en Holded y luego vuelve a esta pregunta.`
        );
        return;
      }
      await sendTelegramMessage(pendiente.chatId, `Ok — "${pendiente.descripcionGasto}" queda sin conciliar.`).catch(
        (error) => console.error("[gastoCallbackHandler] No se pudo reflejar la decisión de no conciliar (no crítico):", error)
      );
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Conciliando...");
    const resultadoConciliacion = await intentarConciliar(
      pendiente.empresa,
      pendiente.monto,
      pendiente.fecha,
      pendiente.gastoId,
      pendiente.chatId,
      pendiente.descripcionGasto,
      pendiente.moneda,
      pendiente.proveedor,
      pendiente.deColaCorreo === true,
      pendiente.mensajeIdGmail,
      pendiente.comprobanteConfirmado,
      pendiente.threadIdGmail
    );
    // Si intentarConciliar mandó los botones de "🔗 Conciliar con #N" aparte (esperandoEleccion),
    // ese mensaje YA incluye la nota — no repetirla acá para no duplicar la pregunta.
    if (pendiente.deColaCorreo && gastoPermiteCerrarCorreo(pendiente.comprobanteConfirmado, resultadoConciliacion)) {
      await finalizarGastoCorreoAntesDeRender(
        () => registrarCierreGastoPendiente(pendiente),
        () => avanzarColaCorreoSiActivo(
          pendiente.chatId,
          { threadId: pendiente.threadIdGmail, mensajeId: pendiente.mensajeIdGmail },
          `gasto:conciliacion:${pendiente.id}:cierre`
        ),
        () => reponerSoloCierreConciliacion(
          pendiente,
          callback.message?.message_id,
          "⚠️ La conciliación ya quedó confirmada, pero no pude cerrar su registro técnico. " +
            "El correo sigue sin leer. Este botón solo reintenta el cierre; no vuelve a conciliar."
        ),
        () => sendTelegramMessage(
          pendiente.chatId,
          `"${pendiente.descripcionGasto}"${resultadoConciliacion.nota}`
        )
      );
      return;
    } else if (resultadoConciliacion.estado !== "esperando_eleccion" &&
      !gastoPermiteCerrarCorreo(pendiente.comprobanteConfirmado, resultadoConciliacion)) {
      // La pregunta consumida se repone con botones reales: el correo sigue UNREAD, pero el operador
      // no queda bloqueado sin una forma de reintentar o descartarlo explícitamente.
      await reponerPreguntaConciliacion(
        pendiente,
        callback.message?.message_id,
        `⚠️ La conciliación todavía no quedó confirmada. El correo seguirá sin leer. ` +
        `Puedes reintentar de forma idempotente o decidir dejarla sin conciliar.`
      );
    }
    if (resultadoConciliacion.estado !== "esperando_eleccion") {
      await sendTelegramMessage(
        pendiente.chatId,
        resultadoConciliacion.nota
          ? `"${pendiente.descripcionGasto}"${resultadoConciliacion.nota}`
          : `No encontré ningún movimiento bancario sin conciliar que coincida con "${pendiente.descripcionGasto}" — revísalo a mano en Holded si crees que ya debería estar.`
      ).catch((error) => console.error("[gastoCallbackHandler] No se pudo reflejar la conciliación en Telegram (no crítico):", error));
    }
    return;
  }

  // Respuesta a los botones que manda ofrecerEleccionMovimientosAmbiguos cuando intentarConciliar
  // encuentra varios movimientos parecidos — caso real reportado por Carlos, ver esa función.
  if (accion === "gasto_conciliar_elegir" || accion === "gasto_conciliar_elegir_no") {
    const pendiente = await consumirConciliacionAmbiguaPendiente(propuestaId);
    if (!pendiente) {
      await answerCallbackQuerySafe(callback.id, "Esta pregunta ya no está disponible.");
      return;
    }


    if (!pendiente.comprobanteConfirmado) {
      try {
        pendiente.comprobanteConfirmado = await compraTieneComprobante(pendiente.empresa, pendiente.gastoId);
      } catch (error) {
        await reponerPreguntaConciliacionAmbigua(
          pendiente,
          callback.message?.message_id,
          `⚠️ No pude verificar por lectura si el gasto tiene soporte. El correo sigue sin leer; vuelve a intentarlo cuando Holded responda.`
        );
        return;
      }
      if (!pendiente.comprobanteConfirmado) {
        await reponerPreguntaConciliacionAmbigua(
          pendiente,
          callback.message?.message_id,
          `⚠️ Este gasto todavía no tiene comprobante en Holded. Adjunta el soporte y vuelve a elegir; ` +
            `Wobi lo verificará antes de cerrar el correo.`
        );
        return;
      }
    }

    if (accion === "gasto_conciliar_elegir_no") {
      await answerCallbackQuerySafe(callback.id, "Ok, no se concilia.");
      if (pendiente.deColaCorreo && pendiente.comprobanteConfirmado) {
        await finalizarGastoCorreoAntesDeRender(
          () => registrarCierreGastoPendiente(pendiente),
          () => avanzarColaCorreoSiActivo(
            pendiente.chatId,
            { threadId: pendiente.threadIdGmail, mensajeId: pendiente.mensajeIdGmail },
            `gasto:conciliacion-ambigua:${pendiente.id}:cierre`
          ),
          () => reponerSoloCierreConciliacionAmbigua(
            pendiente,
            callback.message?.message_id,
            "⚠️ La decisión de dejar el gasto sin conciliar ya quedó tomada, pero no pude cerrar su registro técnico. " +
              "El correo sigue sin leer. Este botón solo reintenta el cierre."
          ),
          () => sendTelegramMessage(pendiente.chatId, `Ok — "${pendiente.descripcionGasto}" queda sin conciliar.`)
        );
        return;
      } else if (!pendiente.comprobanteConfirmado) {
        await reponerPreguntaConciliacionAmbigua(
          pendiente,
          callback.message?.message_id,
          `⚠️ El soporte del gasto todavía no está confirmado. El correo seguirá sin leer; ` +
            `verifica el comprobante antes de cerrar esta decisión.`
        );
        return;
      }
      await sendTelegramMessage(pendiente.chatId,
        `Ok — "${pendiente.descripcionGasto}" queda sin conciliar.`
      ).catch((error) => console.error("[gastoCallbackHandler] No se pudo reflejar la decisión ambigua (no crítico):", error));
      return;
    }

    const indice = Number(extra);
    const movimiento = pendiente.candidatos[indice];
    if (!movimiento) {
      await answerCallbackQuerySafe(callback.id, "Movimiento inválido.");
      await reponerPreguntaConciliacionAmbigua(
        pendiente,
        callback.message?.message_id,
        `⚠️ La opción elegida no era válida. La pregunta se conservó; selecciona uno de los movimientos listados.`
      );
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Conciliando...");
    const resultadoConciliacion = await conciliarContraMovimientoEspecifico(pendiente.empresa, movimiento,
      pendiente.gastoId, pendiente.esAproximado, pendiente.proveedor);
    if (pendiente.deColaCorreo && gastoPermiteCerrarCorreo(pendiente.comprobanteConfirmado, resultadoConciliacion)) {
      await finalizarGastoCorreoAntesDeRender(
        () => registrarCierreGastoPendiente(pendiente),
        () => avanzarColaCorreoSiActivo(
          pendiente.chatId,
          { threadId: pendiente.threadIdGmail, mensajeId: pendiente.mensajeIdGmail },
          `gasto:conciliacion-ambigua:${pendiente.id}:cierre`
        ),
        () => reponerSoloCierreConciliacionAmbigua(
          pendiente,
          callback.message?.message_id,
          "⚠️ La conciliación ya quedó confirmada, pero no pude cerrar su registro técnico. " +
            "El correo sigue sin leer. Este botón solo reintenta el cierre; no vuelve a conciliar."
        ),
        () => sendTelegramMessage(pendiente.chatId, `"${pendiente.descripcionGasto}"${resultadoConciliacion.nota}`)
      );
      return;
    } else if (!gastoPermiteCerrarCorreo(pendiente.comprobanteConfirmado, resultadoConciliacion)) {
      await reponerPreguntaConciliacionAmbigua(
        pendiente,
        callback.message?.message_id,
        `⚠️ La conciliación todavía no quedó confirmada. El correo seguirá sin leer; ` +
        `puedes verificar/reintentar una opción o dejarla sin conciliar.`
      );
    }
    await sendTelegramMessage(pendiente.chatId, `"${pendiente.descripcionGasto}"${resultadoConciliacion.nota}`).catch(
      (error) => console.error("[gastoCallbackHandler] No se pudo reflejar la conciliación ambigua (no crítico):", error)
    );
    return;
  }

  if (accion === "gasto_usarcontacto") {
    const resolucion = await consumirResolucionContacto(propuestaId);
    if (!resolucion) {
      await answerCallbackQuerySafe(callback.id, "Esta selección ya no está disponible.");
      return;
    }
    const alternativa = resolucion.alternativas[Number(extra)];
    if (!alternativa) {
      await answerCallbackQuerySafe(callback.id, "Alternativa inválida.");
      await reponerResolucionContactoTrasFallo(
        resolucion,
        "⚠️ La alternativa elegida no era válida. La selección se conservó; elige nuevamente."
      );
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Procesando...");
    await editTelegramMessage(resolucion.chatId, resolucion.messageId, `🔄 Procesando con "${alternativa.contactName}"...`, []).catch(
      (error) => console.error("[gastoCallbackHandler] No se pudo mostrar el procesamiento de contacto (no crítico):", error)
    );

    try {
      await procesarGastoConContactoResuelto(resolucion, { id: alternativa.contactId, name: alternativa.contactName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reponerResolucionContactoTrasFallo(
        resolucion,
        `⚠️ No pude completar la selección de proveedor (${message}). La acción quedó disponible para reintentar.`
      );
    }
    return;
  }

  if (accion === "gasto_crearsinproveedor") {
    const resolucion = await consumirResolucionContacto(propuestaId);
    if (!resolucion) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    if (esProveedorNoIdentificado(resolucion.propuesta.proveedor)) {
      await answerCallbackQuerySafe(callback.id, "Falta identificar el proveedor real.");
      await reponerResolucionContactoTrasFallo(
        resolucion,
        "⚠️ No creé el gasto: el comprobante no contiene un nombre de proveedor válido. " +
          "Usa “Dar instrucciones específicas” para indicarlo; el correo y la resolución siguen pendientes."
      );
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Procesando sin contacto real...");
    await editTelegramMessage(
      resolucion.chatId,
      resolucion.messageId,
      `🔄 Creando el gasto de "${resolucion.propuesta.proveedor}" sin contacto real...`,
      []
    ).catch((error) =>
      console.error("[gastoCallbackHandler] No se pudo mostrar el procesamiento sin contacto (no crítico):", error)
    );

    try {
      const placeholder = CONTACTO_SIN_IDENTIFICAR_POR_EMPRESA[resolucion.empresaFinal];
      await procesarGastoConContactoResuelto(resolucion, placeholder, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reponerResolucionContactoTrasFallo(
        resolucion,
        `⚠️ No pude completar el gasto sin contacto (${message}). La acción quedó disponible para reintentar.`
      );
    }
    return;
  }

  if (accion === "gasto_contactoinstrucciones") {
    // Si el chat tiene varias facturas pendientes, la siguiente instrucción
    // libre debe aplicarse exactamente a la del botón tocado.
    const resolucion = await priorizarResolucionContacto(propuestaId);
    if (!resolucion) {
      await answerCallbackQuerySafe(callback.id, "Esta selección ya no está disponible.");
      return;
    }
    await answerCallbackQuerySafe(callback.id, "Escribe tu instrucción en el chat.");
    await sendTelegramMessage(
      resolucion.chatId,
      `✏️ Indícame qué hacer con el proveedor "${resolucion.propuesta.proveedor}". Por ejemplo: ` +
        `“usa el contacto EPAYCO”, “búscalo como PAYCO” o “crea el contacto como EPAYCO SAS”. ` +
        `La factura ya está leída y la resolución sigue pendiente; no necesitas reenviarla.`
    );
    return;
  }

  if (accion === "gasto_crearcontactonuevo") {
    const resolucion = await consumirResolucionContacto(propuestaId);
    if (!resolucion) {
      await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
      return;
    }

    if (esProveedorNoIdentificado(resolucion.propuesta.proveedor)) {
      await answerCallbackQuerySafe(callback.id, "Falta identificar el proveedor real.");
      await reponerResolucionContactoTrasFallo(
        resolucion,
        "⚠️ No creé ningún contacto: el proveedor está vacío o es genérico. " +
          "Usa “Dar instrucciones específicas” para indicar el nombre real."
      );
      return;
    }

    await answerCallbackQuerySafe(callback.id, "Creando contacto...");
    await editTelegramMessage(
      resolucion.chatId,
      resolucion.messageId,
      `🔄 Creando el contacto "${resolucion.propuesta.proveedor}" en Holded...`,
      []
    ).catch((error) =>
      console.error("[gastoCallbackHandler] No se pudo mostrar la creación del contacto (no crítico):", error)
    );

    try {
      // Hallazgo real de auditoría: sin esto, dos propuestas del MISMO proveedor nuevo (ej. dos
      // facturas de "CAFÉ PINO" llegando cerca en el tiempo, ninguna con alias todavía) podían
      // procesarse casi al mismo tiempo y terminar en DOS POST /contacts para el mismo proveedor —
      // dos contactos reales y permanentes en Holded para la misma entidad. Mismo criterio que
      // claveMutexDuplicado (ver crearGastoYReportar): todo el ciclo verificar-y-crear va serializado
      // por clave (empresa+proveedor normalizado), y se vuelve a comprobar DENTRO del mutex si el
      // contacto ya existe (por alias recién aprendido o ya creado en Holded por la llamada anterior)
      // antes de crear uno nuevo — así la segunda llamada en cola reutiliza el contacto real que la
      // primera acaba de crear, en vez de duplicarlo.
      const claveMutexContacto = `crearContacto:${resolucion.empresaFinal}:${resolucion.propuesta.proveedor.trim().toLowerCase()}`;
      const contactoNuevo = await conMutex(claveMutexContacto, async () => {
        const existente = await buscarContactoHolded(
          resolucion.empresaFinal,
          resolucion.propuesta.proveedor,
          resolucion.propuesta.moneda
        );
        if (existente) {
          return { id: existente.id, name: existente.name ?? resolucion.propuesta.proveedor.trim() };
        }
        return crearContactoHolded(resolucion.empresaFinal, resolucion.propuesta.proveedor);
      });
      // aprenderAlias=true (default) a propósito, a diferencia del placeholder genérico — este contacto
      // es real y propio de este proveedor, así que la próxima factura del mismo debe resolver directo.
      await procesarGastoConContactoResuelto(resolucion, contactoNuevo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[gastoCallbackHandler] Error creando contacto nuevo en Holded:", message);
      const detalle =
        error instanceof ContactosHoldedAmbiguosError
          ? error.despuesDeEscritura
            ? `Holded devuelve ${error.cantidad} coincidencia(s) exacta(s) después del intento. Wobi bloqueó cualquier repetición; revisa cuál contacto quedó creado y vuelve a verificar desde estos botones.`
            : `Holded devuelve ${error.cantidad} coincidencia(s) exacta(s). Wobi no creó otro contacto; revisa los duplicados en Holded y vuelve a elegir.`
          : error instanceof CreacionContactoInciertaError
            ? "Holded no confirmó si creó el contacto. Wobi conservará esta acción y, al reintentar, verificará el proveedor antes de cualquier creación. No reenvíes el documento."
            : `No pude crear el contacto (${message}); el gasto NO se creó. La selección quedó disponible para reintentar sin reenviar el documento.`;
      await reponerResolucionContactoTrasFallo(
        resolucion,
        `⚠️ ${detalle}`
      );
    }
    return;
  }

  await answerCallbackQuerySafe(callback.id);
}

/**
 * Marca/desmarca un check del teclado de selección (ver gastoTeclado.ts) —
 * pedido explícito de Carlos, tras probar la primera versión con botones
 * que actuaban al toque: "al presionar una [alternativa] ya se elimina la
 * posibilidad de irse por otra... deberás dejar la posibilidad de activar
 * una o varias y luego aprobar". NUNCA ejecuta nada — solo actualiza
 * seleccionAcciones y repinta el MISMO mensaje (editTelegramMessageReplyMarkup,
 * nunca editTelegramMessage, para no tocar el texto original de la propuesta).
 */
async function handleGastoToggleCallback(callback: TelegramCallbackQuery, propuestaId: string, key: string | undefined): Promise<void> {
  if (!key) {
    await answerCallbackQuerySafe(callback.id);
    return;
  }

  const propuesta = await obtenerPropuestaGasto(propuestaId);
  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
    return;
  }

  const seleccion = new Set(propuesta.seleccionAcciones ?? []);
  if (esAccionFinal(key)) {
    // Grupo mutuamente excluyente (crear/crearconciliar/cancelar/nuevo/adjuntar_<i>)
    // — marcar uno desmarca cualquier otro del mismo grupo, como un radio button.
    if (seleccion.has(key)) {
      seleccion.delete(key);
    } else {
      for (const k of Array.from(seleccion)) if (esAccionFinal(k)) seleccion.delete(k);
      seleccion.add(key);
    }
  } else if (seleccion.has(key)) {
    seleccion.delete(key);
  } else {
    seleccion.add(key);
  }

  const nuevaSeleccion = Array.from(seleccion);
  await actualizarSeleccionAccionesGasto(propuesta.id, nuevaSeleccion);
  await answerCallbackQuerySafe(callback.id);

  const propuestaActualizada: PropuestaGasto = { ...propuesta, seleccionAcciones: nuevaSeleccion };
  const teclado = construirTecladoGasto(propuestaActualizada, opcionesTecladoDesdePropuesta(propuesta));
  await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, teclado, resumenTextoPropuestaGasto(propuestaActualizada)).catch((error) =>
    console.error("[gastoCallbackHandler] Error repintando el teclado de selección (no crítico):", error)
  );
}

/**
 * Pregunta a mostrar para cada acción que necesita texto libre — reutilizada
 * tanto por "▶️ Aprobar selección" (primera pregunta) como por
 * continuarConSeleccionGasto (preguntas siguientes en la misma cola).
 */
function preguntaParaAccion(key: string, propuesta: PropuestaGasto): string {
  switch (key) {
    case "corregir":
      return `✏️ Corregir clasificación — dime la empresa y el concepto correctos (ej. "EWORKS, servicio de limpieza").`;
    case "ajustarmonto":
      return (
        `💰 Ajustar monto — dime el monto real a registrar para "${propuesta.proveedor}" (ej. "251.30", o "la mitad" ` +
        `de ${propuesta.monto} ${propuesta.moneda}) — o, si la MONEDA es la que está mal (ej. "esto fue en euros, no ` +
        `dólares"), dímelo así también.`
      );
    case "otrasacciones":
      return (
        `✏️ Otras acciones — dime qué más quieres hacer con el correo "${propuesta.correoOrigen?.asunto ?? ""}" ` +
        `(ej. "prográmame un recordatorio para conciliar mañana", o combina varias cosas en el mismo mensaje).`
      );
    default:
      return `Dime lo que falta para "${etiquetaAccion(key)}".`;
  }
}

/**
 * "Dispara" una decisión final (crear/crear y conciliar/cancelar/adjuntar a
 * un candidato/crear nuevo) RECICLANDO tal cual el código ya existente y
 * auditado de gasto_nuevo/gasto_nuevo_conciliar/gasto_cancelar/gasto_adjuntar
 * — arma un callback_data equivalente y lo pasa por handleGastoCallback de
 * nuevo, en vez de reimplementar esa lógica (manejo de contacto no
 * encontrado, fecha bloqueada, pregunta de conciliar, avance de la cola de
 * correo...) por segunda vez. `from`/`id` son placeholders: handleGastoCallback
 * nunca los lee (solo lee `data`). answerCallbackQuerySafe reconoce estos ids
 * internos y no realiza una solicitud inválida a Telegram.
 */
async function dispararDecisionFinal(propuesta: PropuestaGasto, decisionKey: string): Promise<void> {
  const indice = indiceCandidato(decisionKey);
  // "crearconciliar_<i>" — conciliar contra un candidato AMBIGUO específico (ver
  // PropuestaGasto.movimientosAmbiguos) — reutiliza el mismo accion "gasto_nuevo_conciliar" con el
  // índice como "extra" (mismo mecanismo que "gasto_adjuntar:<id>:<indice>"), en vez de un accion
  // nuevo — el índice ausente sigue siendo el caso original (un solo match, ya confirmado antes).
  const indiceMovAmbiguo = indiceMovimientoAmbiguo(decisionKey);
  const data =
    decisionKey === "crear" || decisionKey === "nuevo"
      ? `gasto_nuevo:${propuesta.id}`
      : decisionKey === "crearconciliar"
        ? `gasto_nuevo_conciliar:${propuesta.id}`
        : indiceMovAmbiguo !== undefined
          ? `gasto_nuevo_conciliar:${propuesta.id}:${indiceMovAmbiguo}`
          : decisionKey === "cancelar"
            ? `gasto_cancelar:${propuesta.id}`
            : indice !== undefined
              ? `gasto_adjuntar:${propuesta.id}:${indice}`
              : undefined;
  if (!data) return;

  await handleGastoCallback({
    id: `seleccion_${propuesta.id}_${Date.now()}`,
    from: { id: propuesta.chatId, is_bot: false },
    data,
  });
}

/**
 * "▶️ Aprobar selección" — ejecuta TODO lo marcado en el teclado de
 * selección, junto. Pedido explícito de Carlos: "activar una o varias y
 * luego aprobar para que la inteligencia del sistema proceda". Orden fijo,
 * pensado para que una decisión final (Crear/Cancelar) siempre use los
 * datos YA corregidos/ajustados, nunca los originales:
 * 1) Side-actions sin texto (responder/guardarconocimiento) — se disparan
 *    ya mismo, no dependen de ningún otro campo de la propuesta.
 * 2) Side-actions con texto (corregir, ajustarmonto, otrasacciones) — se
 *    piden de a una, nunca todas juntas (ver pendienteSeleccionGastoStore.ts).
 * 3) Decisión final (crear/crear y conciliar/cancelar/adjuntar/nuevo) — se
 *    dispara AL FINAL, una vez vacía la cola de texto (o de inmediato si no
 *    había ninguna acción de texto marcada).
 */
async function handleGastoAprobarCallback(callback: TelegramCallbackQuery, propuestaId: string): Promise<void> {
  const propuesta = await obtenerPropuestaGasto(propuestaId);
  if (!propuesta) {
    await answerCallbackQuerySafe(callback.id, "Esta propuesta ya no está disponible.");
    return;
  }

  const seleccion = propuesta.seleccionAcciones ?? [];
  if (seleccion.length === 0) {
    // Hallazgo real de auditoría (caso real Carlos, pedido explícito de verificar que "Aprobar
    // selección" nunca reaccione sin nada marcado): esta validación SIEMPRE se cumplía — sin checks
    // marcados, nunca se crea ni concilia nada, acá se corta antes de tocar Holded. Pero el aviso
    // solo se mandaba como "toast" de Telegram (answerCallbackQuerySafe) — un widget que no existe en
    // el chat web, y que además siempre falla para un clic sintético del chat web (callback.id
    // "web:...", nunca un callback_query real de Telegram que se pueda "responder"). El resultado: al
    // tocar el botón sin marcar nada desde el chat web, no pasaba nada Y tampoco se veía ningún aviso
    // de por qué — parecía que el botón simplemente no hacía nada, sin explicación. Se manda también
    // como mensaje real (sendTelegramMessage, ya visible en Telegram Y en el chat web por el mismo
    // historial compartido) para que la explicación llegue sin importar desde qué canal se tocó.
    await answerCallbackQuerySafe(callback.id, "No marcaste ninguna acción todavía — marca al menos una y vuelve a aprobar.");
    await sendTelegramMessage(propuesta.chatId, "No marcaste ninguna acción todavía — marca al menos una casilla y vuelve a tocar \"▶️ Aprobar selección\".").catch((error) =>
      console.error("[gastoCallbackHandler] Error avisando que no había selección marcada (no crítico):", error)
    );
    return;
  }

  const colaTexto = ["corregir", "ajustarmonto", "otrasacciones"].filter((k) => necesitaTexto(k) && seleccion.includes(k));
  const decisionFinal = seleccion.find((k) => esAccionFinal(k));

  // Si la selección necesita una respuesta del usuario, ese siguiente
  // estado debe existir en Sheets antes de quitar el teclado actual.
  if (colaTexto.length > 0) {
    await guardarPendienteSeleccionGasto(propuesta.chatId, propuesta.id, colaTexto, decisionFinal);
  }

  await answerCallbackQuerySafe(callback.id, "Aplicando...");

  // Pedido explícito de Carlos, tras el aviso de que un doble-toque en este
  // botón podría disparar dos veces algo sin texto: el botón queda INACTIVO
  // de inmediato — se le quita el teclado (editTelegramMessageReplyMarkup,
  // nunca toca el texto original de la propuesta, así no hace falta guardarlo
  // para restaurarlo después) ANTES de cualquier otro await, así que un
  // segundo toque sobre el mismo mensaje ya no tiene ningún botón que
  // presionar — cierra la ventana de la condición de carrera en vez de solo
  // avisar de que existe. El aviso de "procesando" va en un mensaje NUEVO
  // (no reemplaza el texto de la propuesta, que Carlos puede querer seguir
  // viendo con su desglose completo).
  await sendTelegramMessage(propuesta.chatId, "🔄 Aplicando tu selección...").catch((error) =>
    console.error("[gastoCallbackHandler] Error avisando que se está procesando (no crítico):", error)
  );

  // Se limpia de inmediato — evita que una futura aprobación (ej. tras
  // decidir Crear más tarde, con el teclado ya repuesto) vuelva a disparar
  // responder/guardarconocimiento una SEGUNDA vez.
  await actualizarSeleccionAccionesGasto(propuesta.id, []).catch((error) =>
    console.error("[gastoCallbackHandler] Error limpiando la selección aplicada (no crítico):", error)
  );

  const resumen: string[] = [];

  // propuesta.correoOrigen: por el teclado real (construirTecladoGasto) estos
  // dos checks solo existen cuando hay correoOrigen — el guard es defensivo
  // (ej. un callback_data armado a mano) para no reportar "ya en camino"
  // cuando ejecutarResponderCorreo/ejecutarGuardarConocimiento en realidad
  // no hicieron nada (las dos ya no-opean en silencio sin correoOrigen).
  if (seleccion.includes("responder") && propuesta.correoOrigen) {
    const iniciada = await ejecutarResponderCorreo(propuesta).catch((error) => {
      console.error("[gastoCallbackHandler] Error ejecutando 'Responder correo' desde Aprobar selección:", error);
      return false;
    });
    resumen.push(iniciada
      ? "✉️ Responder correo — borrador pendiente de tu revisión."
      : "⚠️ Responder correo — no se pudo preparar; no quedó una acción huérfana.");
  }
  if (seleccion.includes("guardarconocimiento") && propuesta.correoOrigen) {
    const iniciada = await ejecutarGuardarConocimiento(propuesta).catch((error) => {
      console.error("[gastoCallbackHandler] Error ejecutando 'Guardar como conocimiento' desde Aprobar selección:", error);
      return false;
    });
    resumen.push(iniciada
      ? "🧠 Guardar como conocimiento — pendiente de confirmar empresa."
      : "⚠️ Guardar como conocimiento — no se pudo preparar; no quedó una acción huérfana.");
  }

  // Las acciones sin texto ya publicaron su propio estado durable y la cola
  // de texto, cuando existe, ya quedó guardada arriba. Recién ahora se
  // retiran los botones del mensaje anterior.
  await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, []).catch((error) =>
    console.error("[gastoCallbackHandler] Error quitando el teclado antes de aplicar (no crítico):", error)
  );

  if (colaTexto.length > 0) {
    const restantes = colaTexto.slice(1).map((k) => etiquetaAccion(k));
    await sendTelegramMessage(
      propuesta.chatId,
      [
        ...resumen,
        `Marcaste ${colaTexto.map((k) => etiquetaAccion(k)).join(", ")}${decisionFinal ? ` y "${etiquetaAccion(decisionFinal)}"` : ""} — voy preguntando de a una, en orden.`,
        preguntaParaAccion(colaTexto[0], propuesta),
        restantes.length > 0 ? `(Después te pregunto lo que falte para: ${restantes.join(", ")}.)` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return;
  }

  if (resumen.length > 0) {
    await sendTelegramMessage(propuesta.chatId, resumen.join("\n"));
  }

  if (decisionFinal) {
    // dispararDecisionFinal ya reemplaza el texto Y los botones del mensaje
    // original con el resultado final (vía consumirPropuestaGasto/editTelegramMessage
    // en gasto_nuevo/gasto_cancelar/etc.) — nunca hay que reponer el teclado acá.
    await dispararDecisionFinal(propuesta, decisionFinal);
    return;
  }

  // Nada quedó pendiente (ni cola de texto, ni decisión final) — la propuesta
  // sigue viva para que Carlos pueda marcar más acciones después (ej. decidir
  // "Crear" más tarde), así que se repone el teclado interactivo, ya sin
  // ningún check marcado.
  const propuestaFresca = await obtenerPropuestaGasto(propuesta.id);
  if (propuestaFresca) {
    const teclado = construirTecladoGasto(propuestaFresca, opcionesTecladoDesdePropuesta(propuestaFresca));
    await editTelegramMessageReplyMarkup(propuestaFresca.chatId, propuestaFresca.messageId, teclado, resumenTextoPropuestaGasto(propuestaFresca)).catch((error) =>
      console.error("[gastoCallbackHandler] Error reponiendo el teclado tras aplicar (no crítico):", error)
    );
  }
}

/**
 * Continúa la cola secuencial de texto libre tras "▶️ Aprobar selección"
 * (ver handleGastoAprobarCallback) — aplica UNA acción por mensaje, nunca
 * intenta repartir un solo texto entre varias preguntas distintas. Al
 * vaciarse la cola, dispara la decisión final marcada (si había una), ya
 * con las correcciones/ajustes aplicados.
 */
export async function continuarConSeleccionGasto(pendiente: PendienteSeleccionGasto, textoUsuario: string): Promise<void> {
  const propuesta = await obtenerPropuestaGasto(pendiente.propuestaId);
  if (!propuesta) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible.");
    return;
  }

  const [actual, ...resto] = pendiente.colaAcciones;
  if (!actual) return;

  const resultado =
    actual === "corregir"
      ? await aplicarTextoCorreccion(propuesta, textoUsuario)
      : actual === "ajustarmonto"
        ? await aplicarTextoAjusteMonto(propuesta, textoUsuario)
        : await aplicarTextoOtrasAcciones(propuesta, textoUsuario);

  if (!resultado.ok && resultado.reintentable) {
    await guardarPendienteSeleccionGasto(pendiente.chatId, pendiente.propuestaId, pendiente.colaAcciones, pendiente.decisionFinal);
    await sendTelegramMessage(pendiente.chatId, resultado.mensaje);
    return;
  }

  await sendTelegramMessage(pendiente.chatId, resultado.mensaje);

  if (!resultado.ok) {
    // No reintentable (ej. la propuesta ya no existe) — no tiene sentido
    // seguir pidiendo el resto de la cola ni disparar la decisión final.
    return;
  }

  if (resto.length > 0) {
    await guardarPendienteSeleccionGasto(pendiente.chatId, pendiente.propuestaId, resto, pendiente.decisionFinal);
    const propuestaFresca = (await obtenerPropuestaGasto(pendiente.propuestaId)) ?? propuesta;
    await sendTelegramMessage(pendiente.chatId, preguntaParaAccion(resto[0], propuestaFresca));
    return;
  }

  if (!pendiente.decisionFinal) {
    // Nada de decisión final — la propuesta original sigue viva (su teclado
    // quedó vacío desde "Aprobar selección", ver handleGastoAprobarCallback).
    // Caso real (2026-09-07): reponer el teclado en el mensaje ORIGINAL (ya
    // arriba en el chat, detrás de "🔄 Aplicando tu selección...", la
    // pregunta del ajuste, y esta misma respuesta) lo dejaba fuera de vista
    // — Carlos no vio que los botones habían vuelto y terminó escribiendo
    // "sí, créalo y concilia" en texto libre, que el asistente conversacional
    // no tenía forma de completar (esa escritura SIEMPRE requiere un botón
    // real, nunca se dispara por interpretación de texto — ver
    // conciliarMovimiento.ts). Ahora se manda un mensaje NUEVO, visible al
    // final del chat, con los mismos botones reales — y se repunta la
    // propuesta a ESE mensaje (actualizarMessageIdGasto) para que tocarlos
    // edite el mensaje correcto.
    const propuestaFinal = await obtenerPropuestaGasto(pendiente.propuestaId);
    if (propuestaFinal) {
      const teclado = construirTecladoGasto(propuestaFinal, opcionesTecladoDesdePropuesta(propuestaFinal));
      const messageId = await sendTelegramMessageWithButtons(
        propuestaFinal.chatId,
        `✅ Listo — apliqué todo lo que marcaste. "${propuestaFinal.proveedor}" (${propuestaFinal.monto.toFixed(2)} ${propuestaFinal.moneda}) sigue esperando tu decisión — toca una opción:`,
        teclado
      ).catch((error) => {
        console.error("[gastoCallbackHandler] Error reenviando el teclado tras la cola de selección:", error);
        return undefined;
      });
      if (messageId !== undefined) {
        await actualizarMessageIdGasto(propuestaFinal.id, messageId).catch((error) =>
          console.error("[gastoCallbackHandler] Error actualizando el messageId tras reenviar el teclado (no crítico):", error)
        );
      } else {
        // Hallazgo real de auditoría: si el reenvío con botones falla (ej. caída transitoria de
        // Telegram), esto se quedaba en silencio total — exactamente el mismo síntoma ("no veo nada
        // para aprobar") que este mismo cambio existe para eliminar, solo que disparado por otro
        // punto de fallo. Un aviso en texto plano, aunque sin botones, es mejor que nada.
        await sendTelegramMessage(
          propuestaFinal.chatId,
          `✅ Apliqué todo lo que marcaste, pero no pude reenviar los botones de "${propuestaFinal.proveedor}" (${propuestaFinal.monto.toFixed(2)} ${propuestaFinal.moneda}) — probablemente un fallo transitorio de Telegram. Dímelo en texto libre (ej. "créalo y concilia") y lo reintento.`
        ).catch(() => {});
      }
    } else {
      await sendTelegramMessage(pendiente.chatId, "✅ Listo — apliqué todo lo que marcaste.");
    }
    return;
  }

  const propuestaFresca = await obtenerPropuestaGasto(pendiente.propuestaId);
  if (!propuestaFresca) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible para la decisión final que habías marcado.");
    return;
  }
  await dispararDecisionFinal(propuestaFresca, pendiente.decisionFinal);
}

interface ResultadoCrearGasto {
  gastoId: string;
  mensaje: string;
  /** Holded confirmó la presencia del soporte; si es false el correo debe seguir UNREAD. */
  comprobanteConfirmado: boolean;
  /** Estado terminal de la conciliación inline. Solo `conciliada` permite cerrar la cola. */
  estadoConciliacion?: EstadoIntentoConciliacion;
  /** Compra ya creada a la que todavía falta confirmar/adjuntar el soporte. */
  soportePendiente?: PurchaseCandidato;
  /** Presente solo cuando conciliarInline=false — el llamador debe preguntar con preguntarSiConciliar. */
  conciliacionPendiente?: {
    empresa: Empresa;
    monto: number;
    fecha: string;
    descripcionGasto: string;
    gastoId: string;
    moneda: string;
    proveedor: string;
  };
  /**
   * true cuando conciliarInline=true y la búsqueda encontró varios movimientos parecidos —
   * intentarConciliar ya mandó aparte los botones "🔗 Conciliar con #N" (ver
   * ofrecerEleccionMovimientosAmbiguos) y el llamador debe esperar esa respuesta antes de avanzar la
   * cola de correo, igual que con conciliacionPendiente.
   */
  esperandoEleccionConciliacion?: boolean;
}

/**
 * Crea el gasto en Holded (con el desglose de IVA de la propuesta), le
 * adjunta el comprobante, y devuelve el texto final para reportar — no
 * manda el mensaje él mismo, porque lo usan varios caminos distintos
 * (editar un mensaje existente vs. mandar uno nuevo tras una corrección).
 *
 * `conciliarInline` controla CUÁNDO se intenta conciliar el movimiento
 * bancario — pedido explícito de Carlos tras un caso real (factura de
 * Booking.com sin match de compra, pero sí había un cargo real en el
 * banco): si `procesarGastoEntrante` ya confirmó un movimiento coincidente
 * ANTES de proponer (candidato "gasto_nuevo_conciliar"), hay confianza
 * suficiente para conciliar de una, sin pedir revisión previa — se pasa
 * `conciliarInline=true`. Si no había match confirmado (el caso normal de
 * "gasto_nuevo"), se crea el gasto nomás y se devuelve
 * `conciliacionPendiente` para que el llamador pregunte DESPUÉS
 * (preguntarSiConciliar) — dando tiempo a revisar el gasto recién creado
 * en Holded antes de decidir, en vez de conciliar en silencio.
 *
 * Si no se pasa `contactoForzado` y no se encuentra el proveedor, lanza
 * ContactoNoEncontradoError en vez de devolver un texto de error — quien la
 * llame decide si ofrece alternativas (ver manejarContactoNoEncontrado) o
 * falla directo. Cuando SÍ se pasa `contactoForzado` (el usuario confirmó
 * una alternativa), se salta la búsqueda y además aprende el alias para que
 * la próxima factura de este proveedor resuelva directo — EXCEPTO cuando
 * `aprenderAlias=false` (usado para el contacto placeholder "PROVEEDOR SIN
 * IDENTIFICAR": aprenderlo como alias real dejaría CUALQUIER factura futura
 * de ese proveedor pegada al placeholder para siempre, incluso después de
 * crear el contacto real).
 */
/**
 * Texto compartido por los 3 llamadores de crearGastoYReportar para cuando
 * lanza PosibleDuplicadoGastoError — nunca dice "puedes reenviarlo" tal cual
 * (el mensaje genérico de error de más abajo) porque eso invitaría a repetir
 * justo la acción que causó el duplicado que se acaba de evitar. Hallazgo
 * real de auditoría: la versión anterior decía "dímelo explícitamente para
 * que lo cree de todas formas" — pero no hay ninguna herramienta conectada
 * que reconozca esa frase y fuerce la creación; era una promesa vacía. El
 * camino real que SÍ funciona: volver a mandar/reenviar el documento
 * original hace que procesarGastoEntrante arme una propuesta NUEVA, cuyos
 * candidatos ya van a incluir esta compra (porque ahora sí existe en
 * Holded) — con eso, el botón normal "🆕 Crear gasto nuevo" (que ya ofrece
 * candidatos.length > 0) queda disponible sin volver a bloquearse.
 */
export function mensajeDuplicadoDetectado(candidatos: PosibleDuplicadoGastoError["candidatos"]): string {
  const listado = formatearCandidatosDuplicado(candidatos);
  const hayMovimientoConciliado = candidatos.some((c) => c.movimientoConciliado);
  if (hayMovimientoConciliado) {
    return (
      `⛔ No creé el gasto — la comprobación final encontró un movimiento bancario YA CONCILIADO que podría ser esta misma operación:\n${listado}\n\n` +
      `Holded puede ocultar del endpoint de compras un documento convertido manualmente de factura a ticket, aunque el gasto y su conciliación sigan existiendo. ` +
      `Por eso no habilito una creación automática alternativa. Verifica el ticket en Holded; solo si es una operación realmente distinta debe registrarse manualmente o mediante una excepción expresamente revisada.`
    );
  }
  return (
    `⛔ No creé el gasto — encontré en Holded ${candidatos.length === 1 ? "una compra" : candidatos.length + " compras"} que podría(n) ` +
    `ser este mismo, y que no te había mostrado antes:\n${listado}\n\n` +
    `Si es el mismo, descarta esta propuesta — no hace falta hacer nada más. Si de verdad es un gasto NUEVO y distinto (no el mismo importe ` +
    `repetido), vuelve a mandarme el documento/correo original — te armo una propuesta nueva que ya tiene en cuenta esta compra y te deja elegir ` +
    `"🆕 Crear gasto nuevo" sin que se vuelva a bloquear.`
  );
}

/** Mismo criterio de mensaje que mensajeDuplicadoDetectado, pero para cuando la verificación misma falló (ver VerificacionDuplicadoFallidaError) — nunca decir "puedes reenviarlo" acá tampoco, ya que Holded pudo haber creado el gasto o no según dónde falló exactamente. */
function mensajeVerificacionDuplicadoFallida(error: VerificacionDuplicadoFallidaError): string {
  return (
    `⚠️ No pude confirmar que este gasto no esté ya duplicado en Holded (${error.message}) — por seguridad, NO lo creé. ` +
    `Revisa en Holded a mano si ya existe, y si Holded parece estar bien, vuelve a intentar en un momento.`
  );
}

function mensajeCreacionCompraIncierta(proveedor: string): string {
  return (
    `⚠️ Holded no confirmó si creó el gasto de "${proveedor}". Por seguridad Wobi NO repetirá la creación: ` +
    `la está verificando mediante su marcador interno y la mostrará como incidencia hasta resolverla. ` +
    `No reenvíes el documento ni lo registres otra vez sin comprobar antes si ya aparece en Holded.`
  );
}

async function crearGastoYReportar(
  propuesta: PropuestaGasto,
  empresaFinal: PropuestaGasto["empresa"],
  conceptoFinal: string,
  contactoForzado?: { id: string; name: string },
  conciliarInline: boolean = false,
  aprenderAlias: boolean = true,
  /**
   * Movimiento bancario ESPECÍFICO ya elegido por Carlos (ver PropuestaGasto.movimientosAmbiguos /
   * gastoTeclado.ts "🔗 Conciliar con #N") — cuando se da, se concilia DIRECTO contra ese movimiento
   * (mismo id de cuenta/movimiento), sin volver a buscar. Sin esto, conciliarInline volvería a
   * buscar en genérico (intentarConciliar) y toparía con la MISMA ambigüedad que ya se resolvió.
   */
  movimientoObjetivo?: MovimientoBancarioCandidato
): Promise<ResultadoCrearGasto> {
  // Bloqueo previo a cualquier escritura financiera. Si el desglose no
  // reproduce el total del documento, tampoco se permite llegar al camino
  // de conciliación inline.
  validarTotalFiscalGasto(propuesta);

  const propuestaFinal = await prepararPropuestaFinalGasto(propuesta, {
    empresa: empresaFinal,
    concepto: conceptoFinal || propuesta.concepto,
    forzarReinferencia:
      empresaFinal !== propuesta.empresa ||
      (conceptoFinal || propuesta.concepto).trim().toLowerCase() !== propuesta.concepto.trim().toLowerCase() ||
      !propuesta.cuentaId,
  });
  // A partir de aquí no debe sobrevivir ninguna lectura de la propuesta
  // previa a la corrección: creación, soporte, aprendizaje, conciliación e
  // idempotencia trabajan todos sobre la misma propuesta final.
  propuesta = propuestaFinal;
  const cuentaIdFinal = propuestaFinal.cuentaId!;
  const tagsFinales = propuestaFinal.cuentaTags ?? [];

  const contacto = contactoForzado ?? (await buscarContactoHolded(empresaFinal, propuestaFinal.proveedor, propuestaFinal.moneda));
  if (!contacto) {
    throw new ContactoNoEncontradoError(propuestaFinal.proveedor, empresaFinal);
  }

  // Con el contacto placeholder, el nombre real del proveedor NUNCA debe
  // perderse — va al frente de la descripción del gasto (visible en Holded)
  // aunque el contacto en sí sea genérico.
  const descripcionFinal =
    !aprenderAlias && contactoForzado
      ? `[Proveedor real: ${propuestaFinal.proveedor}] ${propuestaFinal.concepto}`
      : propuestaFinal.concepto;

  const lineas =
    propuestaFinal.lineas.length > 0
      ? propuestaFinal.lineas
      : [
          {
            concepto: descripcionFinal,
            base: propuestaFinal.monto,
            tipoIvaPct: 0,
            tratamientoFiscal: "inversion_sujeto_pasivo" as const,
          },
        ];

  // Pedido explícito de Carlos, tras un caso real (recibo de Uber sin
  // ningún folio/número visible): "recuerda que si no lo identificas en el
  // anexo lo rellenas con 00000" — crearGastoHolded ya rellena el campo
  // con ese placeholder cuando no hay número real, pero nunca en silencio:
  // se avisa acá para que quede claro que es un relleno, no un número real
  // leído del documento.
  const notaNumeroDocumento = !propuesta.numeroDocumento
    ? `\n\n📄 No identifiqué un número de documento en el comprobante — quedó como "00000" en Holded. Corrígelo a mano si el documento sí trae uno.`
    : "";

  // Pedido explícito de Carlos, tras un caso real (Booking.com — Hospedaje
  // Hotel Plaza Diana, Footprint, 204,65€): un gasto ya creado y ya
  // conciliado se volvió a crear como duplicado sin ninguna advertencia.
  // buscarGastoSimilar ya corrió una vez al procesar el correo original
  // (procesarGastoEntrante.ts), pero la propuesta puede quedar pendiente de
  // aprobación hasta 7 días (TTL_MS real de crearPropuestaGasto — el "hasta
  // 24h" de una versión anterior de este comentario subestimaba la ventana
  // real) — se vuelve a comprobar acá, justo antes de escribir en Holded,
  // contra el estado REAL más actual, no el que había cuando se armó la
  // propuesta. Solo bloquea si aparece un candidato NUEVO que Carlos no vio
  // ya en la propuesta original (ver PosibleDuplicadoGastoError) — así que
  // aprobar "🆕 Crear gasto nuevo" con candidatos ya mostrados y descartados
  // nunca vuelve a bloquearse por la misma decisión que ya tomó.
  //
  // Todo el bloque (verificar + crear) va dentro de conMutex, con la MISMA
  // clave para cualquier gasto del mismo proveedor+monto+empresa — hallazgo
  // real de auditoría: sin esto, dos aprobaciones casi simultáneas del mismo
  // gasto (dos propuestas para el mismo correo reenviado, o un doble-tap del
  // botón) podían pasar AMBAS la verificación antes de que cualquiera de las
  // dos terminara de escribir en Holded — el mismo tipo de carrera
  // verificar-y-luego-actuar que conMutex ya cierra para las escrituras de
  // Sheets en esta misma sesión, aplicado acá por el mismo motivo.
  //
  // La verificación en sí ahora falla CERRADO: si buscarGastoSimilar mismo
  // da error (Holded caído, rate limit), NUNCA se crea el gasto a ciegas —
  // se avisa explícito y hay que reintentar. Antes fallaba abierto (creaba
  // igual), justo el "pasar en silencio" que este fix existe para eliminar.
  const claveMutexDuplicado = `${empresaFinal}:${propuesta.proveedor.trim().toLowerCase()}:${propuesta.monto.toFixed(2)}`;
  const fechaBusqueda = propuesta.fecha || new Date().toISOString().slice(0, 10);

  const gasto = await conMutex(claveMutexDuplicado, async () => {
    let candidatosJustoAntes: PurchaseCandidato[];
    try {
      const verificacion = await verificarDuplicadoGastoEstricto(empresaFinal, {
        proveedor: propuesta.proveedor,
        monto: propuesta.monto,
        fecha: fechaBusqueda,
        moneda: propuesta.moneda,
        numeroDocumento: propuesta.numeroDocumento,
      });
      candidatosJustoAntes = [
        ...verificacion.compras,
        ...verificacion.movimientosConciliados.map(movimientoConciliadoComoCandidato),
      ];
    } catch (error) {
      throw new VerificacionDuplicadoFallidaError(error);
    }
    const idsYaVistos = new Set(propuesta.candidatos.map((c) => c.id));
    const candidatosNuevos = candidatosJustoAntes.filter((c) => !idsYaVistos.has(c.id));
    if (candidatosNuevos.length > 0) {
      throw new PosibleDuplicadoGastoError(candidatosNuevos);
    }

    return crearGastoHolded(
      empresaFinal,
      {
        contactId: contacto.id,
        fecha: fechaBusqueda,
        descripcion: descripcionFinal,
        lineas,
        cuentaId: cuentaIdFinal,
        tags: tagsFinales,
        moneda: propuesta.moneda,
        numeroDocumento: propuesta.numeroDocumento,
      },
      {
        idempotencyKey: claveIdempotenciaGasto({
          empresa: empresaFinal,
          contactId: contacto.id,
          propuestaId: propuesta.id,
          numeroDocumento: propuesta.numeroDocumento,
          huellaContenido: propuesta.huellaContenido,
          fecha: propuesta.fecha,
          monto: propuesta.monto,
          moneda: propuesta.moneda,
        }),
        proceso: "gasto_aprobado",
      }
    );
  });

  // A partir de acá el gasto YA EXISTE en Holded — un fallo en cualquier
  // paso siguiente (adjuntar comprobante, aprendizaje) NUNCA debe lanzar
  // hacia arriba ni hacer parecer que no se creó nada. Bug real encontrado
  // en vivo: adjuntarYLimpiar lanzaba (archivo local no encontrado) y el
  // catch de más arriba mostraba "Error procesando..." con "puedes
  // reenviarlo" — pero el gasto YA estaba creado en Holded (confirmado en
  // Holded mismo), así que reenviar el documento habría creado un
  // DUPLICADO. Ahora se captura acá y se reporta con claridad qué sí y qué
  // no se logró, y el flujo sigue hasta la pregunta de conciliación.
  let notaComprobante = "";
  let comprobanteConfirmado = true;
  try {
    await adjuntarYLimpiar(propuesta, gasto.id, empresaFinal);
  } catch (error) {
    comprobanteConfirmado = false;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[gastoCallbackHandler] Gasto ${gasto.id} creado pero falló adjuntar el comprobante:`, message);
    notaComprobante = error instanceof AdjuntoCompraInciertoError
      ? `\n\n⏳ El gasto YA está creado en Holded (id ${gasto.id}), pero Holded no confirmó todavía el comprobante. ` +
        "Wobi bloqueó toda repetición y lo verificará solo por lectura; no lo subas manualmente ni reenvíes el documento hasta comprobar el estado."
      : `\n\n⚠️ No pude adjuntar el comprobante (${message}). El gasto YA está creado en Holded (id ${gasto.id}) — ` +
        `sube el comprobante a mano ahí, no reenvíes el documento o se duplicaría el gasto.`;
  }

  // Pedido explícito de Carlos ("que la práctica te vaya dando experticia"):
  // propuesta.cuentaId, cuando viene dado, siempre viene de inferirCuentaGasto
  // (nunca hay hoy un camino donde el usuario la fuerce explícita antes de
  // crear) — se registra para que revisarCorreccionesCuentaContable.ts
  // pueda detectar más adelante si Carlos la corrigió a mano en Holded.
  //
  // Hallazgo real de auditoría xhigh: inferirCuentaGasto se llamó para
  // `propuesta.empresa` (la empresa detectada originalmente, en
  // procesarGastoEntrante.ts) — si Carlos corrige la clasificación a OTRA
  // empresa (ej. "EWORKS, servicio de limpieza" vía "✏️ Corregir
  // clasificación", ver parsearCorreccionClasificacion), `empresaFinal`
  // difiere de `propuesta.empresa` y propuesta.cuentaId queda siendo la
  // cuenta de un plan de cuentas AJENO — no tiene sentido en la empresa
  // real donde se está creando el gasto. Registrar esa asignación de todas
  // formas contaminaría cuentaCorregidaAprendidaSheet.ts la semana
  // siguiente: si Holded ignora en silencio ese id ajeno y el gasto cae en
  // la cuenta genérica por defecto, revisarCorreccionesCuentaContable.ts lo
  // vería como "Carlos corrigió a la cuenta genérica" y el tier 0 aplicaría
  // esa cuenta genérica con máxima confianza a este proveedor en la empresa
  // correcta desde entonces — exactamente el tipo de mala categorización
  // que este sistema de aprendizaje existe para evitar. Solo se registra
  // cuando la cuenta sugerida de verdad corresponde a la empresa final.
  //
  // Hallazgo real de auditoría xhigh (efficiency): estas 3 escrituras de
  // aprendizaje son independientes entre sí (tablas distintas) y cada una ya
  // se protege con su propio .catch "no crítico" — no hay ninguna razón para
  // esperarlas una tras otra antes de responder a Carlos. Promise.all las
  // corre en paralelo (nunca puede rechazar, cada promesa ya se atrapa a sí
  // misma) — el tiempo total pasa de la SUMA de las 3 escrituras a Sheets al
  // MÁXIMO de las 3.
  await Promise.all([
    registrarClasificacionAprendida(propuesta.proveedor, empresaFinal, conceptoFinal || propuesta.concepto).catch(
      (error) => console.error("[gastoCallbackHandler] No se pudo guardar la clasificación aprendida (no crítico):", error)
    ),
    // Hallazgo real de auditoría (caso Avianca/Larrauri, 2026-09-10): registro directo de "este correo
    // ya se convirtió en este gasto" — ver gastoPorCorreoStore.ts para el bug real que esto cierra
    // (el mismo correo reprocesado generaba una propuesta duplicada, a veces sin que buscarGastoSimilar
    // la atrapara a tiempo por depender de la propia búsqueda de Holded). Para un origen Gmail esta
    // escritura sí es parte del cierre durable: si falla, el callback conserva la misma propuesta y
    // el idempotency key de Holded permite reintentar sin crear otra compra.
    propuesta.correoOrigen?.mensajeIdGmail
      ? registrarGastoDesdeCorreo({
          mensajeIdGmail: propuesta.correoOrigen.mensajeIdGmail,
          // Distingue CUÁL adjunto de un correo con varios ya se resolvió — ver el comentario de
          // gastoPorCorreoStore.ts sobre por qué esto no puede ser solo por mensajeIdGmail. Usa partId
          // (estable entre lecturas), no attachmentIdGmail — ver AdjuntoCorreo.partId en gmail/client.ts.
          attachmentId: propuesta.origenAdjuntoGmail?.partId,
          gastoId: gasto.id,
          empresa: empresaFinal,
          completado: false,
          identidad: {
            huellaContenido: propuesta.huellaContenido,
            numeroDocumento: propuesta.numeroDocumento,
            proveedor: propuesta.proveedor,
            monto: propuesta.monto,
            moneda: propuesta.moneda,
            fecha: propuesta.fecha,
            concepto: propuesta.concepto,
          },
        })
      : Promise.resolve(),
    contactoForzado && aprenderAlias
      ? registrarAliasProveedor(
          empresaFinal,
          propuesta.proveedor,
          contactoForzado.id,
          contactoForzado.name,
          propuesta.moneda
        ).catch((error) => console.error("[gastoCallbackHandler] No se pudo guardar el alias de proveedor (no crítico):", error))
      : Promise.resolve(),
    cuentaIdFinal
      ? registrarAsignacionCuenta({ gastoId: gasto.id, empresa: empresaFinal, proveedor: propuesta.proveedor, cuentaIdAsignada: cuentaIdFinal }).catch(
          (error) => console.error("[gastoCallbackHandler] No se pudo registrar la asignación de cuenta (no crítico):", error)
        )
      : Promise.resolve(),
  ]);

  const nombreContacto = contacto.name ?? propuesta.proveedor;
  // Bug real encontrado en vivo (2026-09-07): el mismo contacto placeholder ("PROVEEDOR SIN
  // IDENTIFICAR") se reutiliza en TODOS los gastos sin proveedor identificado de una empresa — Carlos,
  // al querer corregir el proveedor de UN gasto puntual desde Holded, renombró este contacto compartido
  // directamente (dos veces seguidas: a "Aeropuerto de panama" primero, luego a "Kyriad Creteil") en vez
  // de crear un contacto nuevo y separado — sin darse cuenta, eso cambió el nombre mostrado en TODOS los
  // demás gastos (pasados y futuros) que usan el mismo placeholder, generando confusión real ("¿por qué
  // dice Aeropuerto de Panamá si esto es un hotel en Francia?"). El aviso original ("corrige el contacto
  // a mano en Holded") no dejaba claro que renombrarlo ahí lo afecta a TODOS — ahora se dice explícito.
  const notaPlaceholder =
    !aprenderAlias && contactoForzado
      ? `\n\n⚠️ Se usó el contacto genérico "${nombreContacto}" porque "${propuesta.proveedor}" no está en Holded — ` +
        `el nombre real quedó en la descripción del gasto, nunca se pierde. Para corregirlo: NUNCA renombres este ` +
        `contacto genérico directamente en Holded — es el MISMO contacto compartido por todos los gastos sin ` +
        `proveedor identificado, así que renombrarlo cambia el nombre mostrado en todos los demás (pasados y ` +
        `futuros), no solo en este. En su lugar, crea un contacto NUEVO y separado con el nombre real del ` +
        `proveedor en Holded, y avísame por chat para reasignar SOLO este gasto a ese contacto nuevo.`
      : "";
  const baseMensaje =
    `✅ Gasto creado en Holded (id ${gasto.id}, contacto ${nombreContacto}, como borrador)` +
    (notaComprobante ? "." : " y comprobante adjuntado.") +
    notaComprobante +
    notaPlaceholder +
    notaNumeroDocumento;

  if (!comprobanteConfirmado) {
    return {
      gastoId: gasto.id,
      mensaje: baseMensaje,
      comprobanteConfirmado: false,
      soportePendiente: {
        id: gasto.id,
        contactName: nombreContacto,
        fecha: propuesta.fecha,
        total: propuesta.monto,
        descripcion: conceptoFinal || propuesta.concepto,
        documentNumber: propuesta.numeroDocumento,
        moneda: propuesta.moneda,
        soportePendiente: true,
      },
    };
  }

  const datosConciliacionPendiente = {
    empresa: empresaFinal,
    monto: propuesta.monto,
    fecha: propuesta.fecha,
    descripcionGasto: `${nombreContacto} — ${propuesta.monto} ${propuesta.moneda}`,
    gastoId: gasto.id,
    moneda: propuesta.moneda,
    proveedor: propuesta.proveedor,
  };

  if (conciliarInline) {
    if (movimientoObjetivo) {
      // Hallazgo real de auditoría xhigh: esta es la MISMA clase de ambigüedad
      // real que gasto_conciliar_elegir aprende de (movimientoObjetivo viene
      // de PropuestaGasto.movimientosAmbiguos, resuelta por Carlos vía el
      // teclado "🔗 Conciliar con #N" ANTES de crear el gasto) — faltaba
      // pasar propuesta.proveedor acá, así que este camino (posiblemente el
      // más común, ya que resuelve la ambigüedad en el mismo tap que crea el
      // gasto) nunca alimentaba movimientoAmbiguoAprendidoSheet.ts.
      const resultadoConciliacion = await conciliarContraMovimientoEspecifico(
        empresaFinal,
        movimientoObjetivo,
        gasto.id,
        movimientoObjetivo.origenCoincidencia === "tipo_cambio" || movimientoObjetivo.origenCoincidencia === "aproximada",
        propuesta.proveedor
      );
      return { gastoId: gasto.id, mensaje: `${baseMensaje}${resultadoConciliacion.nota}`, comprobanteConfirmado,
        estadoConciliacion: resultadoConciliacion.estado,
        conciliacionPendiente: resultadoConciliacion.estado === "conciliada" ||
          resultadoConciliacion.estado === "esperando_eleccion" ? undefined : datosConciliacionPendiente };
    }
    // propuesta.proveedor (el texto real leído de la factura/correo, ej.
    // "Uber"), NO nombreContacto — bug real encontrado en auditoría:
    // nombreContacto puede ser el contacto genérico "PROVEEDOR SIN
    // IDENTIFICAR" (cuando no se encontró en Holded), que nunca va a
    // aparecer en la descripción de ningún movimiento bancario real, así
    // que la búsqueda aproximada nunca encontraba nada aunque el nombre
    // real (que sí se conocía) hubiera hecho match.
    const resultadoConciliacion = await intentarConciliar(
      empresaFinal,
      propuesta.monto,
      propuesta.fecha,
      gasto.id,
      propuesta.chatId,
      `${nombreContacto} — ${propuesta.monto} ${propuesta.moneda}`,
      propuesta.moneda,
      propuesta.proveedor,
      propuesta.deColaCorreo === true,
      propuesta.correoOrigen?.mensajeIdGmail,
      comprobanteConfirmado,
      propuesta.correoOrigen?.threadId
    );
    return { gastoId: gasto.id, mensaje: `${baseMensaje}${resultadoConciliacion.nota}`, comprobanteConfirmado,
      estadoConciliacion: resultadoConciliacion.estado,
      esperandoEleccionConciliacion: resultadoConciliacion.estado === "esperando_eleccion",
      conciliacionPendiente: resultadoConciliacion.estado === "conciliada" ||
        resultadoConciliacion.estado === "esperando_eleccion" ? undefined : datosConciliacionPendiente };
  }

  return {
    gastoId: gasto.id,
    mensaje: baseMensaje,
    comprobanteConfirmado,
    conciliacionPendiente: datosConciliacionPendiente,
  };
}

/**
 * Reúne alternativas cuando no se encontró el proveedor por nombre: contactos
 * con nombre parecido, y proveedores con una factura ya registrada del MISMO
 * importe (resolviendo cada uno a su contact_id real). Deduplica por
 * contactId y se queda con hasta 5. Nunca decide sola cuál usar.
 */
export function nombreProveedorParaBusqueda(nombre: string): string {
  const limpio = nombre
    .replace(/\s*[([{]\s*(?:pasarela|procesador|plataforma)\s+de\s+pagos?\s*[)\]}]\s*/giu, " ")
    .replace(/\s*[([{]\s*payment\s+(?:gateway|processor|platform)\s*[)\]}]\s*/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return limpio.length >= 3 ? limpio : nombre.trim();
}

export async function construirAlternativasContacto(
  propuesta: PropuestaGasto,
  empresaFinal: PropuestaGasto["empresa"]
): Promise<AlternativaContacto[]> {
  const proveedorBusqueda = nombreProveedorParaBusqueda(propuesta.proveedor);
  const [porNombre, porMonto] = await Promise.all([
    buscarContactosParecidos(empresaFinal, proveedorBusqueda, 5, propuesta.concepto),
    buscarComprasPorMonto(empresaFinal, propuesta.monto, propuesta.fecha, 15),
  ]);

  const alternativas: AlternativaContacto[] = [];
  const vistos = new Set<string>();

  for (const c of porNombre) {
    if (typeof c.id !== "string" || typeof c.name !== "string" || vistos.has(c.id)) continue;
    vistos.add(c.id);
    alternativas.push({ contactId: c.id, contactName: c.name, motivo: "nombre_parecido" });
  }

  for (const compra of porMonto) {
    if (vistos.size >= 5) break;
    let contacto: HoldedContact | undefined;
    try {
      contacto = await buscarContactoHolded(empresaFinal, compra.contactName);
    } catch (error) {
      console.error("[gastoCallbackHandler] Error resolviendo contacto de alternativa por importe:", error);
      continue;
    }
    if (!contacto || typeof contacto.id !== "string" || vistos.has(contacto.id)) continue;
    vistos.add(contacto.id);
    alternativas.push({
      contactId: contacto.id,
      contactName: contacto.name ?? compra.contactName,
      motivo: "mismo_importe",
      detalle: `factura del ${compra.fecha} por ${compra.total.toFixed(2)} €`,
    });
  }

  return alternativas.slice(0, 5);
}

/**
 * Recalcula y repinta una resolución ya publicada sin consumirla ni volver
 * a leer Gmail. Se usa para recuperar mensajes creados antes de una mejora
 * del buscador, conservando el mismo identificador y sus callbacks.
 */
export async function refrescarResolucionContacto(id: string): Promise<ResolucionContactoPendiente | undefined> {
  const actual = await obtenerResolucionContacto(id);
  if (!actual) return undefined;
  const alternativas = await construirAlternativasContacto(actual.propuesta, actual.empresaFinal);
  const actualizada = await actualizarAlternativasResolucionContacto(id, alternativas);
  if (!actualizada) return undefined;
  await editTelegramMessage(
    actualizada.chatId,
    actualizada.messageId,
    textoResolucionContacto(actualizada),
    botonesResolucionContacto(actualizada)
  );
  return actualizada;
}

/**
 * Cuando crearGastoYReportar lanza FechaBloqueadaError (Holded rechaza la
 * fecha por un periodo contable cerrado), en vez de mostrar el JSON crudo
 * del error, ofrece reintentar con la fecha de hoy — la propuesta original
 * ya se consumió (se borra ANTES de intentar crear, ver el flujo principal),
 * así que se crea una nueva con la misma info pero fecha=hoy, y un botón
 * que dispara gasto_nuevo sobre esa propuesta nueva. Si `messageId` viene
 * indefinido (ej. tras una corrección por texto libre), manda un mensaje
 * nuevo con los botones en vez de editar.
 */
async function manejarFechaBloqueada(
  propuesta: PropuestaGasto,
  empresaFinal: PropuestaGasto["empresa"],
  conceptoFinal: string,
  error: FechaBloqueadaError,
  chatId: number,
  messageId: number | undefined
): Promise<void> {
  const fechaHoy = new Date().toISOString().slice(0, 10);

  const { id: _idViejo, creadoEn: _creadoEnViejo, ...datosBase } = propuesta;
  const nuevaPropuesta = await crearPropuestaGasto({
    ...datosBase,
    empresa: empresaFinal,
    concepto: conceptoFinal || propuesta.concepto,
    fecha: fechaHoy,
  });

  const texto =
    `⚠️ No pude crear el gasto de "${propuesta.proveedor}" — Holded dice que la fecha ${propuesta.fecha} ` +
    `corresponde a un periodo contable ya cerrado/bloqueado.\n\n¿Lo registro con la fecha de hoy (${fechaHoy}) en su lugar?`;

  const botones = [
    [{ text: `✅ Sí, usar ${fechaHoy}`, callback_data: `gasto_nuevo:${nuevaPropuesta.id}` }],
    [{ text: "❌ Cancelar", callback_data: `gasto_cancelar:${nuevaPropuesta.id}` }],
  ];

  if (messageId != null) {
    try {
      await editTelegramMessage(chatId, messageId, texto, botones);
      await actualizarMessageIdGasto(nuevaPropuesta.id, messageId);
      return;
    } catch (error) {
      console.error("[gastoCallbackHandler] No se pudo publicar la fecha alternativa en el mensaje original; se enviará uno nuevo:", error);
    }
  }
  const mensajeIdFinal = await sendTelegramMessageWithButtons(chatId, texto, botones);
  await actualizarMessageIdGasto(nuevaPropuesta.id, mensajeIdFinal);
}

/**
 * Crea el gasto usando un contacto YA resuelto (alternativa elegida por
 * botón, o el propio proveedor una vez que se confirma que ya existe en
 * Holded) — mismo camino tanto si viene de gasto_usarcontacto (botón) como
 * de reintentar_contacto_pendiente (el usuario escribió "ya lo creé" en el
 * chat, ver core/tools/reintentarContactoPendiente.ts). Extraído para no
 * duplicar el manejo de FechaBloqueadaError/conciliación entre los dos
 * caminos.
 */
export async function procesarGastoConContactoResuelto(
  resolucion: ResolucionContactoPendiente,
  contacto: { id: string; name: string },
  aprenderAlias: boolean = true
): Promise<void> {
  const propuestaCorregidaBase: PropuestaGasto = {
    ...resolucion.propuesta,
    empresa: resolucion.empresaFinal,
    concepto: resolucion.conceptoFinal || resolucion.propuesta.concepto,
  };
  let propuestaFinal = propuestaCorregidaBase;
  try {
    // El placeholder solo satisface el contact_id obligatorio de Holded. La
    // cuenta, categoría y tags deben seguir saliendo del proveedor real del
    // comprobante y de los aprendizajes existentes, nunca del contacto
    // técnico compartido.
    const proveedorParaInferencia = aprenderAlias ? contacto.name : resolucion.propuesta.proveedor;
    propuestaFinal = await prepararPropuestaFinalGasto(propuestaCorregidaBase, {
      empresa: resolucion.empresaFinal,
      concepto: resolucion.conceptoFinal || resolucion.propuesta.concepto,
      proveedor: proveedorParaInferencia,
      forzarReinferencia: true,
    });
    const resultado = await crearGastoYReportar(
      propuestaFinal,
      propuestaFinal.empresa,
      propuestaFinal.concepto,
      contacto,
      false,
      aprenderAlias
    );
    if (!resultado.comprobanteConfirmado && resultado.soportePendiente) {
      await reponerPropuestaParaReintento(
        propuestaFinal,
        `${resultado.mensaje}\n\nEl correo seguirá sin leer y no se intentará conciliar hasta confirmar el soporte. ` +
          `Usa “Reintentar/verificar soporte del gasto creado”.`,
        resultado.soportePendiente
      );
      return;
    }
    const cierreTerminal = resultado.comprobanteConfirmado && resultado.estadoConciliacion === "conciliada";
    if (!cierreTerminal) {
      await editTelegramMessage(resolucion.chatId, resolucion.messageId, resultado.mensaje, []).catch(
        (error) => console.error("[gastoCallbackHandler] No se pudo reflejar el gasto con contacto resuelto (no crítico):", error)
      );
    }
    let preguntaConciliacionPendiente = false;
    if (resultado.conciliacionPendiente) {
      preguntaConciliacionPendiente = await preguntarSiConciliar(
        resolucion.chatId,
        resultado.conciliacionPendiente.empresa,
        resultado.conciliacionPendiente.monto,
        resultado.conciliacionPendiente.fecha,
        resultado.conciliacionPendiente.descripcionGasto,
        resultado.conciliacionPendiente.gastoId,
        resultado.conciliacionPendiente.moneda,
        resultado.conciliacionPendiente.proveedor,
        resolucion.propuesta.deColaCorreo === true,
        resolucion.propuesta.correoOrigen?.mensajeIdGmail,
        resultado.comprobanteConfirmado,
        resolucion.messageId,
        resolucion.propuesta.correoOrigen?.threadId
      );
      if (!preguntaConciliacionPendiente) {
        const seguimiento = resultado.conciliacionPendiente;
        await reponerPropuestaParaReintento(
          propuestaFinal,
          `${resultado.mensaje}\n\n⚠️ No pude publicar la pregunta de conciliación. El correo seguirá sin leer.`,
          { id: seguimiento.gastoId, contactName: contacto.name, fecha: seguimiento.fecha,
            total: seguimiento.monto, descripcion: seguimiento.descripcionGasto,
            moneda: seguimiento.moneda, conciliacionPendiente: true }
        );
        return;
      }
    }
    if (resolucion.propuesta.deColaCorreo && !preguntaConciliacionPendiente && cierreTerminal) {
      await finalizarGastoCorreoAntesDeRender(
        () => registrarCierreGastoDePropuesta(propuestaFinal, resultado.gastoId, resolucion.empresaFinal),
        () => avanzarColaCorreoSiActivo(
          resolucion.chatId,
          { threadId: resolucion.propuesta.correoOrigen?.threadId,
            mensajeId: resolucion.propuesta.correoOrigen?.mensajeIdGmail },
          `gasto:${propuestaFinal.id}:contacto-cierre`
        ),
        () => reponerSoloCierrePropuesta(
          { ...propuestaFinal, candidatos: [{ id: resultado.gastoId, contactName: contacto.name,
            fecha: propuestaFinal.fecha, total: propuestaFinal.monto, descripcion: propuestaFinal.concepto,
            moneda: propuestaFinal.moneda, conciliacionPendiente: true }] },
          "⚠️ El gasto corregido ya terminó, pero no pude cerrar su registro técnico. " +
            "El correo sigue sin leer y el botón disponible no repite ninguna operación financiera."
        ),
        () => editTelegramMessage(resolucion.chatId, resolucion.messageId, resultado.mensaje, [])
      );
    } else if (!resolucion.propuesta.deColaCorreo && cierreTerminal) {
      await editTelegramMessage(resolucion.chatId, resolucion.messageId, resultado.mensaje, []).catch(
        (error) => console.error("[gastoCallbackHandler] No se pudo reflejar el cierre con contacto resuelto (no crítico):", error)
      );
    }
  } catch (error) {
    if (error instanceof FechaBloqueadaError) {
      await manejarFechaBloqueada(
        propuestaFinal,
        propuestaFinal.empresa,
        propuestaFinal.concepto,
        error,
        resolucion.chatId,
        resolucion.messageId
      );
      return;
    }
    if (error instanceof PosibleDuplicadoGastoError) {
      await reponerPropuestaParaReintento(
        { ...propuestaFinal, candidatos: error.candidatos },
        `${mensajeDuplicadoDetectado(error.candidatos)}\n\nEl correo seguirá sin leer; elige el gasto correcto o confirma uno nuevo.`
      );
      return;
    }
    if (error instanceof VerificacionDuplicadoFallidaError) {
      await reponerPropuestaParaReintento(
        propuestaFinal,
        `${mensajeVerificacionDuplicadoFallida(error)}\n\nEl correo seguirá sin leer y la propuesta queda disponible para reintentar.`
      );
      return;
    }
    if (error instanceof CreacionCompraInciertaError) {
      await reponerVerificacionCreacionIncierta(
        propuestaFinal,
        `${mensajeCreacionCompraIncierta(resolucion.propuesta.proveedor)}\n\n` +
          `El correo seguirá sin leer; verifica el estado sin repetir la creación.`
      );
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[gastoCallbackHandler] Error procesando gasto con contacto resuelto:", message);
    await reponerPropuestaParaReintento(
      propuestaFinal,
      `⚠️ Error procesando "${resolucion.propuesta.proveedor}"\n\n${message}\n\n` +
        `El correo sigue sin leer y la propuesta quedó disponible para reintentar sin reenviar el documento.`
    );
    // No avanza la cola en el error — mismo criterio que arriba.
  }
}

/**
 * Cuando crearGastoYReportar lanza ContactoNoEncontradoError, en vez de solo
 * decir "no lo encontré" busca alternativas (nombre parecido, mismo importe
 * ya registrado) y las ofrece por botones — el usuario confirma cuál es, o
 * "ninguna" para crear el contacto a mano en Holded. Si no hay alternativas,
 * cae al mensaje de error de siempre. Si `messageId` viene indefinido (no
 * hay un mensaje previo editable, ej. tras una corrección por texto libre),
 * manda uno nuevo con los botones en vez de editar.
 */
async function manejarContactoNoEncontrado(
  propuesta: PropuestaGasto,
  empresaFinal: PropuestaGasto["empresa"],
  conceptoFinal: string,
  chatId: number,
  messageId: number | undefined
): Promise<void> {
  const alternativas = await construirAlternativasContacto(propuesta, empresaFinal).catch((error) => {
    console.error("[gastoCallbackHandler] Error buscando alternativas de contacto:", error);
    return [] as AlternativaContacto[];
  });

  if (alternativas.length === 0) {
    // Pedido explícito de Carlos: si respondes en este mismo chat (ej. "ya
    // lo creé") en vez de reenviar la factura, el asistente debe reconocer
    // la pregunta pendiente y reintentar — antes esto no quedaba guardado
    // en ningún lado, así que una respuesta en texto libre no tenía cómo
    // conectarse con esta propuesta. Se guarda igual que el caso CON
    // alternativas (mismo store), solo que con alternativas=[] — el aviso
    // de que hay una resolución de contacto pendiente (buildSystemPromptDinamico)
    // y la tool reintentar_contacto_pendiente (core/tools/) hacen el resto.
    const resolucion = await guardarResolucionContacto({
      propuesta,
      empresaFinal,
      conceptoFinal,
      alternativas: [],
      chatId,
      messageId: messageId ?? 0,
    });

    const textoFinal = textoResolucionContacto(resolucion);
    const botones = botonesResolucionContacto(resolucion);

    if (messageId != null) {
      await editTelegramMessage(chatId, messageId, textoFinal, botones);
    } else {
      const nuevoMessageId = await sendTelegramMessageWithButtons(chatId, textoFinal, botones);
      await actualizarMessageIdResolucionContacto(resolucion.id, nuevoMessageId).catch((error) =>
        console.error("[gastoCallbackHandler] Error actualizando messageId de la resolución pendiente:", error)
      );
    }
    return;
  }

  const mensajeIdFinal = messageId ?? (await sendTelegramMessageWithButtons(
    chatId,
    `⚠️ No encontré exactamente el proveedor "${propuesta.proveedor}" en Holded. Buscando alternativas...`,
    []
  ));

  const resolucion = await guardarResolucionContacto({
    propuesta,
    empresaFinal,
    conceptoFinal,
    alternativas,
    chatId,
    messageId: mensajeIdFinal,
  });

  await editTelegramMessage(
    chatId,
    mensajeIdFinal,
    textoResolucionContacto(resolucion),
    botonesResolucionContacto(resolucion)
  );
}

/**
 * Interpreta "empresa, concepto" de texto libre — usado tanto por la
 * corrección clásica (continuarConCorreccionGasto, que crea el gasto de
 * inmediato) como por la nueva "Corregir clasificación" del teclado de
 * selección (aplicarTextoCorreccion, que solo actualiza campos). Bug real
 * encontrado al extraer esta función a un solo lugar: el chequeo original
 * solo reconocía "WOBA"/"EWORKS" — escribir "Footprint, concepto..." se
 * ignoraba en silencio y la empresa quedaba sin corregir, sin ningún aviso.
 */
function parsearCorreccionClasificacion(
  texto: string,
  empresaActual: PropuestaGasto["empresa"]
): { empresa: PropuestaGasto["empresa"]; concepto: string } {
  const [empresaRaw, ...resto] = texto.split(",");
  const empresaTexto = empresaRaw.trim().toUpperCase();
  const empresa: PropuestaGasto["empresa"] =
    empresaTexto === "WOBA"
      ? "WOBA"
      : empresaTexto === "EWORKS"
        ? "EWORKS"
        : empresaTexto === "FOOTPRINT"
          ? "Footprint"
          : empresaActual;
  const concepto = resto.join(",").trim() || texto.trim();
  return { empresa, concepto };
}

/**
 * Continúa el flujo cuando el usuario responde con la corrección tras
 * pulsar "✏️ Corregir clasificación".
 */
export async function continuarConCorreccionGasto(pendiente: PendienteCorreccionGasto, textoUsuario: string): Promise<void> {
  // La corrección termina creando/escribiendo un gasto en Holded — mismo
  // filtro de rol que los botones de escritura (esAccionSensible en
  // server.ts), necesario aquí también porque este camino se dispara por
  // texto libre, no por un callback_data que ese filtro pueda interceptar.
  const rol = await obtenerRolUsuario(pendiente.chatId);
  if (rol !== "superadmin") {
    await sendTelegramMessage(pendiente.chatId, "Corregir y crear el gasto requiere aprobación del superadministrador.");
    return;
  }

  const propuesta = await consumirPropuestaGasto(pendiente.propuestaId);
  if (!propuesta) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible.");
    return;
  }

  const { empresa: empresaFinal, concepto: conceptoFinal } = parsearCorreccionClasificacion(textoUsuario, propuesta.empresa);
  const propuestaCorregidaBase: PropuestaGasto = {
    ...propuesta,
    empresa: empresaFinal,
    concepto: conceptoFinal || propuesta.concepto,
  };
  let propuestaCorregida = propuestaCorregidaBase;

  await sendTelegramMessage(pendiente.chatId, `🔄 Procesando "${propuesta.proveedor}" con la corrección...`).catch(
    (error) => console.error("[gastoCallbackHandler] No se pudo mostrar el progreso de la corrección (no crítico):", error)
  );

  try {
    propuestaCorregida = await prepararPropuestaFinalGasto(propuestaCorregidaBase, {
      empresa: empresaFinal,
      concepto: conceptoFinal || propuesta.concepto,
      forzarReinferencia: true,
    });
    const resultado = await crearGastoYReportar(
      propuestaCorregida,
      propuestaCorregida.empresa,
      propuestaCorregida.concepto
    );
    if (!resultado.comprobanteConfirmado && resultado.soportePendiente) {
      await reponerPropuestaParaReintento(
        propuestaCorregida,
        `${resultado.mensaje}\n\nEl correo seguirá sin leer y no se intentará conciliar hasta confirmar el soporte. ` +
          `Usa “Reintentar/verificar soporte del gasto creado”.`,
        resultado.soportePendiente
      );
      return;
    }
    const cierreTerminal = resultado.comprobanteConfirmado && resultado.estadoConciliacion === "conciliada";
    if (!cierreTerminal) {
      await sendTelegramMessage(propuesta.chatId, resultado.mensaje).catch(
        (error) => console.error("[gastoCallbackHandler] No se pudo reflejar el gasto corregido (no crítico):", error)
      );
    }
    let preguntaConciliacionPendiente = false;
    if (resultado.conciliacionPendiente) {
      preguntaConciliacionPendiente = await preguntarSiConciliar(
        propuesta.chatId,
        resultado.conciliacionPendiente.empresa,
        resultado.conciliacionPendiente.monto,
        resultado.conciliacionPendiente.fecha,
        resultado.conciliacionPendiente.descripcionGasto,
        resultado.conciliacionPendiente.gastoId,
        resultado.conciliacionPendiente.moneda,
        resultado.conciliacionPendiente.proveedor,
        propuesta.deColaCorreo === true,
        propuesta.correoOrigen?.mensajeIdGmail,
        resultado.comprobanteConfirmado,
        propuesta.messageId,
        propuesta.correoOrigen?.threadId
      );
      if (!preguntaConciliacionPendiente) {
        const seguimiento = resultado.conciliacionPendiente;
        await reponerPropuestaParaReintento(
          propuestaCorregida,
          `${resultado.mensaje}\n\n⚠️ No pude publicar la pregunta de conciliación. El correo seguirá sin leer.`,
          { id: seguimiento.gastoId, contactName: propuesta.proveedor, fecha: seguimiento.fecha,
            total: seguimiento.monto, descripcion: seguimiento.descripcionGasto,
            moneda: seguimiento.moneda, conciliacionPendiente: true }
        );
        return;
      }
    }
    if (propuesta.deColaCorreo && !preguntaConciliacionPendiente && cierreTerminal) {
      await finalizarGastoCorreoAntesDeRender(
        () => registrarCierreGastoDePropuesta(propuestaCorregida, resultado.gastoId, empresaFinal),
        () => avanzarColaCorreoSiActivo(
          propuesta.chatId,
          { threadId: propuesta.correoOrigen?.threadId, mensajeId: propuesta.correoOrigen?.mensajeIdGmail },
          `gasto:${propuestaCorregida.id}:correccion-cierre`
        ),
        () => reponerSoloCierrePropuesta(
          { ...propuestaCorregida, candidatos: [{ id: resultado.gastoId,
            contactName: propuestaCorregida.proveedor, fecha: propuestaCorregida.fecha,
            total: propuestaCorregida.monto, descripcion: propuestaCorregida.concepto,
            moneda: propuestaCorregida.moneda, conciliacionPendiente: true }] },
          "⚠️ El gasto corregido ya terminó, pero no pude cerrar su registro técnico. " +
            "El correo sigue sin leer y el botón disponible no repite ninguna operación financiera."
        ),
        () => sendTelegramMessage(propuesta.chatId, resultado.mensaje)
      );
    } else if (!propuesta.deColaCorreo && cierreTerminal) {
      await sendTelegramMessage(propuesta.chatId, resultado.mensaje).catch(
        (error) => console.error("[gastoCallbackHandler] No se pudo reflejar el cierre corregido (no crítico):", error)
      );
    }
  } catch (error) {
    if (error instanceof ContactoNoEncontradoError) {
      await manejarContactoNoEncontrado(propuestaCorregida, empresaFinal, conceptoFinal, propuesta.chatId, undefined);
      return;
    }
    if (error instanceof FechaBloqueadaError) {
      await manejarFechaBloqueada(propuestaCorregida, empresaFinal, conceptoFinal, error, propuesta.chatId, undefined);
      return;
    }
    if (error instanceof PosibleDuplicadoGastoError) {
      await reponerPropuestaParaReintento(
        { ...propuestaCorregida, candidatos: error.candidatos },
        `${mensajeDuplicadoDetectado(error.candidatos)}\n\nEl correo seguirá sin leer; elige el gasto correcto o confirma uno nuevo.`
      );
      return;
    }
    if (error instanceof VerificacionDuplicadoFallidaError) {
      await reponerPropuestaParaReintento(
        propuestaCorregida,
        `${mensajeVerificacionDuplicadoFallida(error)}\n\nEl correo seguirá sin leer y la propuesta queda disponible para reintentar.`
      );
      return;
    }
    if (error instanceof CreacionCompraInciertaError) {
      await reponerVerificacionCreacionIncierta(
        propuestaCorregida,
        `${mensajeCreacionCompraIncierta(propuesta.proveedor)}\n\nEl correo seguirá sin leer; verifica el estado sin repetir la creación.`
      );
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[gastoCallbackHandler] Error procesando corrección de gasto:", message);
    await reponerPropuestaParaReintento(
      propuestaCorregida,
      `⚠️ Error: ${message}\n\nEl correo sigue sin leer y la propuesta quedó disponible para reintentar sin reenviar el documento.`
    );
    // No avanza la cola en el error — mismo criterio que arriba.
  }
}

/**
 * Convierte un número escrito en texto libre (formato ES "1.234,56" o
 * normal "1234.56"/"251.30") a un valor real — si trae los dos separadores,
 * el que aparece AL FINAL es el decimal de verdad (el otro es de miles).
 * undefined si el texto no es un número reconocible — nunca adivina.
 */
function parsearNumeroLibre(texto: string): number | undefined {
  const limpio = texto.trim();
  if (!/^-?[\d.,]+$/.test(limpio)) return undefined;

  const tieneComa = limpio.includes(",");
  const tienePunto = limpio.includes(".");

  let normalizado: string;
  if (tieneComa && tienePunto) {
    normalizado =
      limpio.lastIndexOf(",") > limpio.lastIndexOf(".")
        ? limpio.replace(/\./g, "").replace(",", ".")
        : limpio.replace(/,/g, "");
  } else if (tieneComa) {
    // Bug real encontrado en auditoría: con MÁS de una coma (ej. "1,234,567",
    // agrupación de miles al estilo US sin decimales) reemplazar solo la
    // PRIMERA coma dejaba una coma suelta que rompía el parseo — un número
    // válido se rechazaba como si no lo fuera. Con una sola coma, es
    // decimal (criterio ES); con varias, son separadores de miles.
    const comas = (limpio.match(/,/g) ?? []).length;
    normalizado = comas === 1 ? limpio.replace(",", ".") : limpio.replace(/,/g, "");
  } else {
    normalizado = limpio;
  }

  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : undefined;
}

/**
 * Interpreta la respuesta a "💰 Ajustar monto" (ver handleGastoCallback) —
 * NUNCA calcula un monto por su cuenta a partir de suposiciones: solo
 * entiende una fracción explícita ("la mitad", "50%") aplicada al monto
 * ORIGINAL de la propuesta, o un monto nuevo escrito literal. Si el texto
 * no encaja en ninguno de los dos, no adivina — vuelve a preguntar.
 */
function interpretarNuevoMonto(texto: string, montoOriginal: number): number | undefined {
  const limpio = texto.trim().toLowerCase();

  // Bug real encontrado en auditoría: sin el guard de montoOriginal > 0,
  // una propuesta degenerada (monto 0 o negativo) podía devolver 0/negativo
  // como "nuevo monto" sin que interpretarNuevoMonto lo rechazara — a
  // diferencia del camino de número literal, que sí exige > 0. El "50%"
  // literal se quitó (redundante — el regex de porcentaje de abajo ya lo
  // cubre exactamente igual).
  if (/^(la\s+)?mitad$/.test(limpio)) return montoOriginal > 0 ? montoOriginal / 2 : undefined;

  const porcentaje = limpio.match(/^(\d+([.,]\d+)?)\s*%$/);
  if (porcentaje) {
    const pct = parsearNumeroLibre(porcentaje[1]);
    return pct !== undefined && pct > 0 && montoOriginal > 0 ? montoOriginal * (pct / 100) : undefined;
  }

  // Un número literal se toma como el monto NUEVO absoluto, no como
  // fracción del original.
  const numero = parsearNumeroLibre(limpio);
  return numero !== undefined && numero > 0 ? numero : undefined;
}

interface ResultadoAplicarTexto {
  ok: boolean;
  /** Solo cuando ok=false: si true, la MISMA pregunta se puede repetir (texto no entendido); si false, no tiene sentido reintentar (ej. la propuesta ya no existe). */
  reintentable?: boolean;
  mensaje: string;
}

// Bug real encontrado en auditoría: con propuesta.monto <= 0, un factor de
// reserva de "1" dejaba las líneas SIN escalar (base ~0) mientras la
// columna monto sí se sobrescribía al nuevo valor — Holded crea el gasto
// a partir de las líneas, no de monto, así que el gasto real habría
// quedado en 0€ aunque Telegram reportara el monto correcto. Si no hay
// línea previa con base real, se reemplaza todo por una línea limpia.
function reescalarLineas(propuesta: PropuestaGasto, nuevoMonto: number): LineaFactura[] {
  return propuesta.monto > 0 && propuesta.lineas.length > 0
    ? propuesta.lineas.map((l) => ({ ...l, base: (l.base * nuevoMonto) / propuesta.monto }))
    : [
        {
          concepto: propuesta.concepto,
          base: nuevoMonto,
          tipoIvaPct: 0,
          tratamientoFiscal: "inversion_sujeto_pasivo",
        },
      ];
}

async function aplicarNuevoMonto(propuesta: PropuestaGasto, nuevoMonto: number): Promise<ResultadoAplicarTexto> {
  const actualizado = await actualizarMontoPropuestaGasto(propuesta.id, nuevoMonto, reescalarLineas(propuesta, nuevoMonto));
  if (!actualizado) {
    return { ok: false, reintentable: false, mensaje: "Esa propuesta ya no está disponible." };
  }

  return {
    ok: true,
    mensaje: `💰 Monto ajustado — ${propuesta.proveedor}: ${propuesta.monto.toFixed(2)} ${propuesta.moneda} → ${nuevoMonto.toFixed(2)} ${propuesta.moneda}.`,
  };
}

/**
 * Pedido explícito de Carlos, tras un caso real: el correo de Kelly reportó un gasto de Uber Eats
 * como "$12.71" pero el cargo real había sido en euros — el NÚMERO estaba bien, la MONEDA no. Tras
 * corregir moneda/monto, vuelve a buscar un movimiento bancario real en la moneda ya corregida (antes
 * no se encontraba nada porque se buscaba en la moneda equivocada) — exacto y luego aproximado, mismo
 * criterio que procesarGastoEntrante.ts — y, si el resultado cambia, refresca los botones del mensaje
 * original para que "Crear y conciliar" aparezca si ahora corresponde. Solo distingue "Crear y
 * conciliar" con confianza cuando hay UN match, nunca con varios ambiguos — mismo criterio que
 * procesarGastoEntrante.ts (candidatosMovAmbiguos), hallazgo real de auditoría: un único match
 * verdadero no es lo mismo que "encontré algo", y ofrecer el botón con varios candidatos posibles
 * prometería una conciliación que después se rechaza sola al intentarla.
 *
 * Si la propuesta ya tenía candidatos de Holded (documento ya cargado que podría corresponder,
 * encontrados con el monto/moneda ANTERIOR), esos candidatos no se vuelven a buscar acá — hallazgo
 * real de auditoría: buscarGastoSimilar no filtra por moneda (compara solo el número), así que
 * mientras el NÚMERO no cambie los candidatos siguen siendo válidos; si sí cambia, se avisa
 * explícitamente que conviene revisarlos de nuevo en vez de fingir que ya se hizo.
 */
async function aplicarCorreccionMoneda(propuesta: PropuestaGasto, monedaCorrecta: string, montoFinal: number): Promise<ResultadoAplicarTexto> {
  // Hallazgo real de auditoría: a diferencia de la detección original (procesarGastoEntrante.ts,
  // que valida contra monedasReales antes de aceptar una moneda), esta corrección por IA no tenía
  // ninguna validación — un código de moneda mal inferido por el modelo se escribía directo. Mismo
  // criterio de respaldo que procesarGastoEntrante.ts: si la consulta falla, asume solo EUR en vez
  // de saltarse la validación.
  const monedasReales = await obtenerMonedasCuentasReales(propuesta.empresa).catch((error) => {
    console.error("[gastoCallbackHandler] Error consultando monedas reales de la empresa (asume solo EUR):", error);
    return new Set(["EUR"]);
  });
  if (!monedasReales.has(monedaCorrecta)) {
    const monedasTxt = Array.from(monedasReales).sort().join(", ");
    return {
      ok: false,
      reintentable: true,
      mensaje:
        `Entendí que la moneda correcta sería ${monedaCorrecta}, pero ${propuesta.empresa} no tiene ninguna cuenta ` +
        `real en esa moneda (sí tiene: ${monedasTxt}) — ¿cuál es la moneda real? Dime el nombre o el código (ej. "euros").`,
    };
  }

  const cambioMonto = montoFinal !== propuesta.monto;
  const nuevasLineas = reescalarLineas(propuesta, montoFinal);
  const actualizado = await actualizarMonedaPropuestaGasto(propuesta.id, monedaCorrecta, montoFinal, nuevasLineas);
  if (!actualizado) {
    return { ok: false, reintentable: false, mensaje: "Esa propuesta ya no está disponible." };
  }

  let notaMovimiento = "";
  if (propuesta.candidatos.length === 0) {
    let movimientoEncontrado = false;
    let movimientosAmbiguosNuevos: MovimientoBancarioCandidato[] = [];
    try {
      const candidatosMov = await buscarMovimientoSimilar(propuesta.empresa, { monto: montoFinal, fecha: propuesta.fecha, moneda: monedaCorrecta });
      if (candidatosMov.length === 1) {
        movimientoEncontrado = true;
      } else if (candidatosMov.length > 1) {
        movimientosAmbiguosNuevos = candidatosMov;
      } else if (propuesta.proveedor) {
        const aproximados = await buscarMovimientoAproximado(propuesta.empresa, {
          monto: montoFinal,
          fecha: propuesta.fecha,
          moneda: monedaCorrecta,
          proveedor: propuesta.proveedor,
        });
        if (aproximados.length > 0) movimientoEncontrado = true;
      }
    } catch (error) {
      console.error("[gastoCallbackHandler] Error buscando movimiento tras corregir moneda (no crítico):", error);
    }

    // Hallazgo real de auditoría: hayMovimientoBancario y movimientosAmbiguos son mutuamente
    // excluyentes por diseño (ver gastoTeclado.ts) — sin actualizar AMBOS acá, una corrección de
    // moneda podía dejar movimientosAmbiguos VIEJO (de la moneda anterior) guardado mientras
    // hayMovimientoBancario pasaba a true, violando esa exclusión y sin ninguna forma de mostrar los
    // checks de un hallazgo ambiguo NUEVO en esta misma moneda corregida.
    await actualizarFlagMovimientoBancarioGasto(propuesta.id, movimientoEncontrado).catch((error) =>
      console.error("[gastoCallbackHandler] Error actualizando el flag de movimiento bancario (no crítico):", error)
    );
    await actualizarMovimientosAmbiguosPropuestaGasto(propuesta.id, movimientosAmbiguosNuevos).catch((error) =>
      console.error("[gastoCallbackHandler] Error actualizando los movimientos ambiguos (no crítico):", error)
    );
    try {
      const propuestaActualizada: PropuestaGasto = {
        ...propuesta,
        moneda: monedaCorrecta,
        monto: montoFinal,
        hayMovimientoBancario: movimientoEncontrado,
        movimientosAmbiguos: movimientosAmbiguosNuevos,
      };
      const botones = construirTecladoGasto(propuestaActualizada, opcionesTecladoDesdePropuesta(propuestaActualizada));
      await editTelegramMessageReplyMarkup(propuesta.chatId, propuesta.messageId, botones, resumenTextoPropuestaGasto(propuestaActualizada));
    } catch (error) {
      console.error("[gastoCallbackHandler] Error actualizando los botones tras corregir moneda (no crítico):", error);
    }

    notaMovimiento = movimientoEncontrado
      ? ` Ahora que la moneda es correcta, SÍ encontré un movimiento bancario real sin conciliar que coincide — usa "✅ Crear y conciliar" en el mensaje original.`
      : movimientosAmbiguosNuevos.length > 0
        ? ` Encontré ${movimientosAmbiguosNuevos.length} movimientos bancarios parecidos en ${monedaCorrecta} — marca "🔗 Conciliar con #N" en el mensaje original (ya actualizado) y aprueba tu selección.`
        : ` Seguí sin encontrar un movimiento bancario en ${monedaCorrecta} que coincida — revísalo a mano en Holded si ya salió del banco.`;
  } else if (cambioMonto) {
    notaMovimiento = ` Ojo: esta propuesta ya tenía candidatos de Holded encontrados con el monto anterior — revísalos de nuevo arriba, podrían ya no ser los correctos con el monto corregido.`;
  }

  return {
    ok: true,
    mensaje: `💱 Moneda corregida — ${propuesta.proveedor}: ${propuesta.monto.toFixed(2)} ${propuesta.moneda} → ${montoFinal.toFixed(2)} ${monedaCorrecta}.${notaMovimiento}`,
  };
}

/**
 * Núcleo de "💰 Ajustar monto", sin enviar ningún mensaje por sí solo —
 * usado tanto por el botón standalone (continuarConAjusteMonto, abajo) como
 * por la cola secuencial de "▶️ Aprobar selección" (continuarConSeleccionGasto).
 * El parser rápido/determinista (interpretarNuevoMonto) va primero — cubre los
 * casos comunes sin ningún costo de IA. Solo si no lo entiende, se intenta con
 * Claude (interpretarCorreccionGasto), que además de un monto nuevo puede
 * reconocer una corrección de MONEDA — pedido explícito de Carlos, tras un
 * caso real donde el parser rígido nunca entendió "12.71 Euros, en lugar de
 * dólares, la moneda estaba equivocada" como lo que era, y solo insistía en
 * pedir "un número".
 */
async function aplicarTextoAjusteMonto(propuesta: PropuestaGasto, textoUsuario: string): Promise<ResultadoAplicarTexto> {
  const nuevoMontoRapido = interpretarNuevoMonto(textoUsuario, propuesta.monto);
  if (nuevoMontoRapido !== undefined) {
    return aplicarNuevoMonto(propuesta, nuevoMontoRapido);
  }

  let correccion: CorreccionGasto;
  try {
    correccion = await interpretarCorreccionGasto({
      textoUsuario,
      montoOriginal: propuesta.monto,
      monedaOriginal: propuesta.moneda,
    });
  } catch (error) {
    console.error("[gastoCallbackHandler] Error interpretando corrección de gasto con IA (no crítico, se pide de nuevo):", error);
    correccion = { tipo: "no_entendido" };
  }

  if (correccion.tipo === "monto_nuevo") return aplicarNuevoMonto(propuesta, correccion.monto);
  if (correccion.tipo === "fraccion") {
    // Hallazgo real de auditoría: interpretarNuevoMonto (el parser rápido) exige montoOriginal > 0
    // antes de aplicar una fracción — esta misma protección faltaba acá, así que una propuesta
    // degenerada (monto <= 0) podía terminar con un monto 0/negativo escrito sin ningún aviso.
    if (propuesta.monto <= 0) {
      return {
        ok: false,
        reintentable: true,
        mensaje: `El monto actual de la propuesta no es válido (${propuesta.monto}) — no puedo calcular una fracción de eso. Dime el monto real como un número absoluto (ej. "251.30").`,
      };
    }
    return aplicarNuevoMonto(propuesta, propuesta.monto * correccion.fraccion);
  }
  if (correccion.tipo === "moneda_incorrecta") {
    return aplicarCorreccionMoneda(propuesta, correccion.monedaCorrecta, correccion.monto ?? propuesta.monto);
  }

  return {
    ok: false,
    reintentable: true,
    mensaje:
      `No entendí "${textoUsuario}" — dime un número (ej. "251.30"), "la mitad", o si la MONEDA era ` +
      `la equivocada (ej. "en realidad fue en euros, no dólares").`,
  };
}

export async function continuarConAjusteMonto(pendiente: PendienteAjusteMontoGasto, textoUsuario: string): Promise<void> {
  const propuesta = await obtenerPropuestaGasto(pendiente.propuestaId);
  if (!propuesta) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible.");
    return;
  }

  const resultado = await aplicarTextoAjusteMonto(propuesta, textoUsuario);
  if (!resultado.ok && resultado.reintentable) {
    // Se reinserta para poder reintentar — mismo criterio que
    // pendienteMontoStore.ts para errores de formato del texto.
    await guardarPendienteAjusteMontoGasto(pendiente.chatId, pendiente.propuestaId);
    await sendTelegramMessage(pendiente.chatId, resultado.mensaje);
    return;
  }

  await sendTelegramMessage(
    pendiente.chatId,
    resultado.ok
      ? `${resultado.mensaje} Los botones de la propuesta original arriba ya usan este monto — usa "✅ Crear gasto en Holded" ` +
        `cuando quieras, o "💰 Ajustar monto" de nuevo si hace falta corregirlo otra vez.`
      : resultado.mensaje
  );
}

/**
 * Continúa el flujo tras pulsar "✏️ Otras acciones" en una propuesta de
 * gasto que vino de un correo (ver gasto_otrasacciones arriba). Mismo
 * camino seguro que continuarConOrientacion (emailCallbackHandler.ts):
 * pasa por askClaude con su registro de tools ya existente (proponer envío
 * de correo, proponer evento/recordatorio...), nunca ejecuta nada fuera de
 * eso — así "responde el correo Y prográmame un recordatorio" en un solo
 * mensaje puede resolver las dos cosas en la misma llamada. A diferencia de
 * continuarConOrientacion, NUNCA llama avanzarColaCorreoSiActivo — esto es
 * una side-action sobre una propuesta de gasto todavía pendiente, no una
 * decisión que resuelva el correo activo de la cola (eso lo hace
 * gasto_nuevo/gasto_cancelar, que sí avanzan cuando deColaCorreo).
 */
/** Núcleo de "✏️ Otras acciones" — ver continuarConAccionGasto/continuarConSeleccionGasto (reutilizado por los dos). */
async function aplicarTextoOtrasAcciones(propuesta: PropuestaGasto, textoUsuario: string): Promise<ResultadoAplicarTexto> {
  if (!propuesta.correoOrigen) {
    return { ok: false, reintentable: false, mensaje: "Esa propuesta ya no está disponible." };
  }

  const instruccion =
    `El usuario dio instrucciones adicionales sobre un correo del que se detectó una factura/gasto. ` +
    `Correo — De: ${propuesta.correoOrigen.de}. Asunto: ${propuesta.correoOrigen.asunto}. ` +
    `Factura/gasto detectado: ${propuesta.proveedor}, ${propuesta.monto} ${propuesta.moneda}, ${propuesta.fecha}, ` +
    `concepto: ${propuesta.concepto} (el registro del gasto en Holded ya se maneja aparte, con sus propios botones — ` +
    `no hace falta que tú lo registres). Instrucción del usuario: ${textoUsuario}. Si es para responder el correo, ` +
    `usa el threadId "${propuesta.correoOrigen.threadId}" y el message_id_header "${propuesta.correoOrigen.messageIdHeader}" ` +
    `para que quede enhebrado como una respuesta real. Investiga y ejecuta lo que corresponda con las herramientas ` +
    `disponibles, y reporta el resultado.`;

  if (!propuesta.deColaCorreo) {
    const respuesta = await askClaude(instruccion, propuesta.chatId, undefined, "accion_gasto");
    return { ok: true, mensaje: respuesta };
  }

  const identidad = identidadCorreoDePropuestaGasto(propuesta);
  if (!identidad) {
    return {
      ok: false,
      reintentable: true,
      mensaje:
        "⚠️ Este correo pertenece a la cola, pero no conserva threadId y mensajeId de Gmail completos. " +
        "No ejecuté la acción para evitar que un borrador quede asociado al correo equivocado.",
    };
  }

  let respuesta = "";
  const huellaInstruccion = createHash("sha256").update(textoUsuario.trim().toLowerCase()).digest("hex").slice(0, 16);
  const unidadColaId = `${propuesta.id}:otras-acciones:${huellaInstruccion}`;
  try {
    const publicada = await ejecutarAccionLateralGastoConReserva(
      unidadColaId,
      true,
      identidad,
      {
        yaPublicada: async () => {
          const borradores = await obtenerBorradoresCorreoPorChat(propuesta.chatId);
          return borradores.some((borrador) =>
            borrador.deColaCorreo === true &&
            borrador.correoThreadId === identidad.threadId &&
            borrador.correoMensajeId === identidad.mensajeId &&
            borrador.unidadColaId === unidadColaId
          );
        },
        reservar: (identidadExacta) => incrementarPendientesActivo(propuesta.chatId, identidadExacta),
        publicar: async (identidadExacta) => {
          const antes = await obtenerBorradoresCorreoPorChat(propuesta.chatId);
          const idsAnteriores = new Set(antes.map((borrador) => borrador.id));
          respuesta = await askClaude(instruccion, propuesta.chatId, undefined, "accion_gasto");
          const despues = await obtenerBorradoresCorreoPorChat(propuesta.chatId);
          const nuevos = despues.filter((borrador) => !idsAnteriores.has(borrador.id));
          const borradorNuevo = seleccionarBorradorCorrelacionado(nuevos, {
            threadId: propuesta.correoOrigen?.threadId,
          });

          // Una instrucción puede ser solo un recordatorio u otra acción sin
          // correo. En ese caso la reserva lateral se compensa y la propuesta
          // de gasto conserva su unidad original de la cola.
          if (!borradorNuevo) return false;
          const vinculado = await vincularBorradorACola(borradorNuevo.id, identidadExacta!, unidadColaId);
          return Boolean(vinculado);
        },
        compensar: (identidadExacta) => revertirIncrementoPendientesActivo(propuesta.chatId, identidadExacta),
      }
    );

    if (!respuesta && publicada) {
      respuesta =
        "✉️ Ya existe un borrador pendiente para este mismo correo. Conserva la unidad exacta de la cola " +
        "hasta que lo envíes o lo canceles.";
    }
    return { ok: true, mensaje: respuesta || "✅ La acción adicional quedó procesada." };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[gastoCallbackHandler] Error ejecutando otras acciones del gasto:", error);
    return {
      ok: false,
      reintentable: true,
      mensaje:
        `⚠️ No pude dejar la acción adicional en un estado durable (${mensaje}). ` +
        "El correo sigue sin leer y puedes reintentarlo.",
    };
  }
}

/**
 * Continúa el flujo tras pulsar "✏️ Otras acciones" en una propuesta de
 * gasto que vino de un correo (ver gasto_otrasacciones arriba). Mismo
 * camino seguro que continuarConOrientacion (emailCallbackHandler.ts):
 * pasa por askClaude con su registro de tools ya existente (proponer envío
 * de correo, proponer evento/recordatorio...), nunca ejecuta nada fuera de
 * eso — así "responde el correo Y prográmame un recordatorio" en un solo
 * mensaje puede resolver las dos cosas en la misma llamada. A diferencia de
 * continuarConOrientacion, NUNCA llama avanzarColaCorreoSiActivo — esto es
 * una side-action sobre una propuesta de gasto todavía pendiente, no una
 * decisión que resuelva el correo activo de la cola (eso lo hace
 * gasto_nuevo/gasto_cancelar, que sí avanzan cuando deColaCorreo).
 */
export async function continuarConAccionGasto(pendiente: PendienteAccionGasto, textoUsuario: string): Promise<void> {
  const propuesta = await obtenerPropuestaGasto(pendiente.propuestaId);
  if (!propuesta || !propuesta.correoOrigen) {
    await sendTelegramMessage(pendiente.chatId, "Esa propuesta ya no está disponible.");
    return;
  }

  await sendTelegramMessage(pendiente.chatId, "🔄 Procesando tu instrucción — esto puede tardar uno o dos minutos...").catch(
    (error) => console.error("[gastoCallbackHandler] No se pudo mostrar 'Procesando...' (no crítico):", error)
  );

  const resultado = await aplicarTextoOtrasAcciones(propuesta, textoUsuario);
  if (!resultado.ok && resultado.reintentable) {
    await guardarPendienteAccionGasto(pendiente.chatId, pendiente.propuestaId);
  }
  await sendTelegramMessageSmart(pendiente.chatId, resultado.mensaje, undefined, `✅ ${propuesta.correoOrigen.asunto} (${propuesta.correoOrigen.de})`);
}

/**
 * Núcleo de "✏️ Corregir clasificación" en su forma NO consumidora (teclado
 * de selección) — a diferencia de continuarConCorreccionGasto (el botón
 * standalone viejo, que crea el gasto de inmediato), esto SOLO actualiza
 * empresa/concepto y deja la propuesta viva.
 */
async function aplicarTextoCorreccion(propuesta: PropuestaGasto, textoUsuario: string): Promise<ResultadoAplicarTexto> {
  const { empresa, concepto } = parsearCorreccionClasificacion(textoUsuario, propuesta.empresa);
  let propuestaFinal: PropuestaGasto;
  try {
    propuestaFinal = await prepararPropuestaFinalGasto(propuesta, {
      empresa,
      concepto,
      forzarReinferencia: true,
    });
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    return { ok: false, reintentable: true, mensaje: `⚠️ ${mensaje}` };
  }
  const actualizado = await actualizarClasificacionPropuestaGasto(
    propuesta.id,
    propuestaFinal.empresa,
    propuestaFinal.concepto,
    propuestaFinal.cuentaId,
    propuestaFinal.cuentaTags
  );
  if (!actualizado) {
    return { ok: false, reintentable: false, mensaje: "Esa propuesta ya no está disponible." };
  }
  return {
    ok: true,
    mensaje:
      `✏️ Clasificación corregida — empresa: ${propuestaFinal.empresa}, concepto: ${propuestaFinal.concepto}. ` +
      `Cuenta y tags se recalcularon con el aprendizaje existente.`,
  };
}

/**
 * "✉️ Responder correo" y "🧠 Guardar como conocimiento" extraídos a
 * funciones reutilizables — las usan tanto los botones standalone
 * (gasto_responder/gasto_guardarconocimiento) como "▶️ Aprobar selección"
 * (handleGastoAprobarCallback). Ninguna necesita texto del usuario, así que
 * se disparan de inmediato al aprobar, sin entrar en la cola secuencial.
 */
async function ejecutarResponderCorreo(propuesta: PropuestaGasto): Promise<boolean> {
  if (!propuesta.correoOrigen) return false;
  const identidad = propuesta.deColaCorreo === true ? identidadCorreoDePropuestaGasto(propuesta) : undefined;
  const contexto =
    `Factura/gasto detectado en este correo: ${propuesta.proveedor}, ${propuesta.monto} ${propuesta.moneda}, ` +
    `${propuesta.fecha}, concepto: ${propuesta.concepto}.`;
  let iniciada = false;
  try {
    iniciada = await ejecutarAccionLateralGastoConReserva(
      `${propuesta.id}:responder`,
      propuesta.deColaCorreo === true,
      identidad,
      {
        yaPublicada: async () => {
          const borradores = await obtenerBorradoresCorreoPorChat(propuesta.chatId);
          return borradores.some((borrador) =>
            identidad
              ? borrador.deColaCorreo === true &&
                borrador.correoThreadId === identidad.threadId &&
                borrador.correoMensajeId === identidad.mensajeId
              : borrador.threadId === propuesta.correoOrigen?.threadId &&
                borrador.messageIdHeader === propuesta.correoOrigen?.messageIdHeader
          );
        },
        reservar: (identidadExacta) => incrementarPendientesActivo(propuesta.chatId, identidadExacta),
        publicar: (identidadExacta) => generarBorradorYOfrecer(
          propuesta.chatId,
          propuesta.correoOrigen!.de,
          propuesta.correoOrigen!.asunto,
          propuesta.correoOrigen!.threadId,
          propuesta.correoOrigen!.messageIdHeader,
          contexto,
          identidadExacta
        ),
        compensar: (identidadExacta) => revertirIncrementoPendientesActivo(propuesta.chatId, identidadExacta),
      }
    );
  } catch (error) {
    console.error("[gastoCallbackHandler] Error preparando el borrador lateral del gasto:", error);
  }
  if (!iniciada) {
    await sendTelegramMessage(
      propuesta.chatId,
      `⚠️ No pude dejar preparado el borrador para "${propuesta.correoOrigen.asunto}". El gasto puede continuar, pero la respuesta no quedó pendiente.`
    ).catch(() => {});
  }
  return iniciada;
}

async function ejecutarGuardarConocimiento(propuesta: PropuestaGasto): Promise<boolean> {
  if (!propuesta.correoOrigen) return false;
  try {
    const cuerpo = propuesta.correoOrigen.mensajeIdGmail
      ? await obtenerCuerpoCompletoCorreo(propuesta.correoOrigen.mensajeIdGmail)
      : "(no se pudo releer el cuerpo completo — sin id de mensaje de Gmail)";
    const contenido = [`De: ${propuesta.correoOrigen.de}`, `Asunto: ${propuesta.correoOrigen.asunto}`, "", cuerpo].join("\n");
    const identidad = propuesta.deColaCorreo === true ? identidadCorreoDePropuestaGasto(propuesta) : undefined;
    const iniciada = await ejecutarAccionLateralGastoConReserva(
      `${propuesta.id}:guardar-conocimiento`,
      propuesta.deColaCorreo === true,
      identidad,
      {
        yaPublicada: async () => {
          if (!identidad) return false;
          const capturas = await obtenerPendientesCapturaEmpresaPorChat(propuesta.chatId);
          return capturas.some((captura) =>
            captura.deColaCorreo === true &&
            captura.threadId === identidad.threadId &&
            captura.mensajeId === identidad.mensajeId
          );
        },
        reservar: (identidadExacta) => incrementarPendientesActivo(propuesta.chatId, identidadExacta),
        publicar: async (identidadExacta) => {
          await iniciarSeleccionEmpresaCaptura(
            propuesta.chatId,
            contenido,
            propuesta.correoOrigen!.de,
            undefined,
            Boolean(identidadExacta),
            identidadExacta
          );
          return true;
        },
        compensar: (identidadExacta) => revertirIncrementoPendientesActivo(propuesta.chatId, identidadExacta),
      }
    );
    if (!iniciada) {
      await sendTelegramMessage(
        propuesta.chatId,
        `⚠️ No pude preparar "${propuesta.correoOrigen.asunto}" para guardarlo como conocimiento. El gasto puede continuar, pero la captura no quedó pendiente.`
      ).catch(() => {});
    }
    return iniciada;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[gastoCallbackHandler] Error preparando la captura del correo de un gasto:", message);
    await sendTelegramMessage(propuesta.chatId, `⚠️ No pude leer "${propuesta.correoOrigen.asunto}" para guardarlo como conocimiento.`);
    return false;
  }
}
