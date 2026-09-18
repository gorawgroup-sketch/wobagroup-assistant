import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import type { Empresa } from "../holded/client";
import {
  coincidenciaIdentidadGasto,
  type IdentidadGastoProcesado,
  type MotivoCoincidenciaIdentidad,
} from "./identidadGasto";

const TAB_NAME = "_gastos_por_correo";
const HEADERS = [
  "mensajeIdGmail",
  "attachmentId",
  "gastoId",
  "empresa",
  "creadoEn",
  "huellaContenido",
  "numeroDocumento",
  "proveedor",
  "monto",
  "moneda",
  "fecha",
  "concepto",
];
const NUM_COLS = HEADERS.length;
// 3 años — deliberadamente mucho más largo que el TTL de 24-48h de los "pendiente_*" normales: esto
// no es una pregunta esperando respuesta, es un registro permanente de "este correo YA se convirtió en
// este gasto", y necesita seguir siendo consultable mucho después de que cualquier propuesta/pendiente
// relacionada haya expirado — ver buscarGastoDesdeCorreo.
const TTL_MS = 3 * 365 * 24 * 60 * 60 * 1000;

export interface GastoPorCorreo {
  mensajeIdGmail: string;
  attachmentId?: string;
  gastoId: string;
  empresa: Empresa;
  creadoEn: number;
  identidad?: IdentidadGastoProcesado;
}

export interface CoincidenciaGastoProcesado {
  registro: GastoPorCorreo;
  motivo: MotivoCoincidenciaIdentidad;
}

function filaARegistro(valores: string[]): GastoPorCorreo | undefined {
  const [mensajeIdGmail, attachmentId, gastoId, empresa, creadoEnRaw, huellaContenido, numeroDocumento, proveedor, montoRaw, moneda, fecha, concepto] = valores;
  const creadoEn = Number(creadoEnRaw) || 0;
  if (!mensajeIdGmail || !gastoId || !(["WOBA", "EWORKS", "Footprint"] as string[]).includes(empresa)) return undefined;
  const monto = montoRaw !== "" ? Number(montoRaw) : undefined;
  const identidad: IdentidadGastoProcesado = {
    huellaContenido: huellaContenido || undefined,
    numeroDocumento: numeroDocumento || undefined,
    proveedor: proveedor || undefined,
    monto: monto !== undefined && Number.isFinite(monto) ? monto : undefined,
    moneda: moneda || undefined,
    fecha: fecha || undefined,
    concepto: concepto || undefined,
  };
  return {
    mensajeIdGmail,
    attachmentId: attachmentId || undefined,
    gastoId,
    empresa: empresa as Empresa,
    creadoEn,
    identidad,
  };
}

function registroAFila(registro: GastoPorCorreo): (string | number)[] {
  return [
    registro.mensajeIdGmail,
    registro.attachmentId ?? "",
    registro.gastoId,
    registro.empresa,
    registro.creadoEn,
    registro.identidad?.huellaContenido ?? "",
    registro.identidad?.numeroDocumento ?? "",
    registro.identidad?.proveedor ?? "",
    registro.identidad?.monto ?? "",
    registro.identidad?.moneda ?? "",
    registro.identidad?.fecha ?? "",
    registro.identidad?.concepto ?? "",
  ];
}

/**
 * Hallazgo real de auditoría (caso real Carlos, 2026-09-10 — gasto de Avianca/AEROVÍAS DEL CONTINENTE
 * AMERICANO, y antes el de Larrauri/JRJ 9 2015 SL): un correo con adjunto ya procesado como gasto real
 * volvía a generar una propuesta de "Factura detectada" NUEVA minutos/horas después — el mismo
 * mensajeIdGmail se reprocesaba una segunda vez. buscarGastoSimilar (búsqueda en Holded por
 * proveedor/monto/fecha) es la defensa existente contra crear un DUPLICADO, pero depende de que el
 * texto de proveedor coincida (ya reforzado con un fallback por monto+fecha) y de que la búsqueda de
 * Holded encuentre el documento — verificado en vivo que el propio endpoint de Holded puede tardar en
 * indexar un documento recién creado para búsquedas por fecha, así que ninguna búsqueda contra Holded
 * puede ser 100% confiable en los primeros minutos. Este store es la defensa COMPLEMENTARIA, propia
 * (no depende de Holded en absoluto): un registro directo de "este mensajeIdGmail (+ adjunto puntual,
 * si aplica) YA se convirtió en este gasto", consultado ANTES de siquiera intentar extraer/proponer un
 * gasto nuevo desde un correo (ver revisarCorreoNuevo.ts) — si ya existe, se salta por completo en vez
 * de generar una propuesta redundante, sin importar qué tan bien o mal haya salido la búsqueda en
 * Holded esa vez.
 *
 * `attachmentId` (opcional): un correo con VARIOS adjuntos reales y distintos (caso real ya
 * documentado en revisarCorreoNuevo.ts: "un correo con 2 adjuntos distintos... eran documentos reales
 * distintos, cada uno con su propia decisión") necesita que este registro distinga CUÁL adjunto ya se
 * resolvió — sin esto, si el correo se reprocesa mientras un adjunto ya tiene gasto pero OTRO sigue
 * genuinamente pendiente de que Carlos decida, un chequeo que solo mirara mensajeIdGmail saltaría
 * TAMBIÉN el adjunto real y sin resolver por error. undefined cuando el gasto se detectó en el CUERPO
 * del correo (sin adjunto real que distinguir — ahí mensajeIdGmail solo ya identifica la cosa completa).
 */
export async function registrarGastoDesdeCorreo(datos: {
  mensajeIdGmail: string;
  attachmentId?: string;
  gastoId: string;
  empresa: Empresa;
  identidad?: IdentidadGastoProcesado;
}): Promise<void> {
  if (!datos.mensajeIdGmail || !datos.gastoId) return;
  // Hallazgo real de auditoría: sin esta purga, esta tabla solo crece — la creación de gastos desde
  // correo es la vía PRINCIPAL de este sistema, así que en algún momento superaría el tope duro de
  // lectura de leerFilas (A2:col10000, ver sheetsKeyValueStore.ts) mientras las escrituras siguen sin
  // límite — las entradas MÁS RECIENTES quedarían invisibles para buscarGastoDesdeCorreo para siempre,
  // justo lo opuesto de lo que se espera de una defensa que debe seguir activa. Mismo patrón ya
  // establecido en el resto de los stores de este proyecto (conciliacionPendienteStore.ts,
  // emailDraftStore.ts, escalacionDesarrolloStore.ts): purgar vencidas ANTES de escribir, en vez de
  // depender de un job externo aparte que alguien tendría que acordarse de programar.
  await purgarVencidos().catch((error) => console.error("[gastoPorCorreoStore] Error purgando registros vencidos (no crítico):", error));
  const registro: GastoPorCorreo = {
    mensajeIdGmail: datos.mensajeIdGmail,
    attachmentId: datos.attachmentId,
    gastoId: datos.gastoId,
    empresa: datos.empresa,
    creadoEn: Date.now(),
    identidad: datos.identidad,
  };
  const existentes = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const mismaResolucion = existentes.find(
    (fila) =>
      fila.valores[0] === datos.mensajeIdGmail &&
      (fila.valores[1] ?? "") === (datos.attachmentId ?? "") &&
      fila.valores[2] === datos.gastoId
  );
  if (mismaResolucion) {
    const anterior = filaARegistro(mismaResolucion.valores);
    await actualizarFila(TAB_NAME, mismaResolucion.rowIndex, NUM_COLS, registroAFila({
      ...registro,
      creadoEn: anterior?.creadoEn || registro.creadoEn,
    }));
    return;
  }
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, registroAFila(registro));
}

async function purgarVencidos(): Promise<void> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  const vencidas = filas.filter((f) => {
    const creadoEn = Number(f.valores[4]) || 0;
    return ahora - creadoEn > TTL_MS;
  });
  // De atrás hacia adelante — eliminarFila desplaza filas hacia arriba, borrar de la última a la
  // primera evita invalidar los índices ya calculados (mismo criterio que el resto del proyecto).
  vencidas.sort((a, b) => b.rowIndex - a.rowIndex);
  for (const fila of vencidas) {
    await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  }
}

/**
 * El gasto ya registrado para este mensajeIdGmail (+ attachmentId puntual, si se da), si lo hay y
 * sigue dentro de la ventana — undefined si no hay ninguno o venció. Pasar `attachmentId` cuando se
 * está verificando UN adjunto en concreto (para no saltarse otros adjuntos reales y distintos del
 * mismo correo, ver comentario de arriba); omitirlo para el caso de gasto detectado en el cuerpo.
 */
export async function buscarGastoDesdeCorreo(mensajeIdGmail: string, attachmentId?: string): Promise<GastoPorCorreo | undefined> {
  if (!mensajeIdGmail) return undefined;
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  const attachmentBuscado = attachmentId ?? "";

  let masReciente: GastoPorCorreo | undefined;
  for (const fila of filas) {
    const registro = filaARegistro(fila.valores);
    if (!registro || registro.mensajeIdGmail !== mensajeIdGmail) continue;
    if ((registro.attachmentId ?? "") !== attachmentBuscado) continue;
    if (ahora - registro.creadoEn > TTL_MS) continue;
    if (!masReciente || registro.creadoEn > masReciente.creadoEn) {
      masReciente = registro;
    }
  }
  return masReciente;
}

/**
 * Elimina exclusivamente una referencia correo/adjunto/id que se demostró
 * inválida. No borra otros adjuntos del mismo mensaje ni otros gastos del
 * mismo proveedor. Se usa solo tras un 404 real de Holded sobre un registro
 * reciente, para que el correo pueda volver a descargar y leer SU PDF en vez
 * de quedar bloqueado para siempre por un id fantasma.
 */
export async function eliminarGastoDesdeCorreo(
  mensajeIdGmail: string,
  attachmentId: string | undefined,
  gastoId: string
): Promise<number> {
  if (!mensajeIdGmail || !gastoId) return 0;
  const attachmentBuscado = attachmentId ?? "";
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const coincidentes = filas
    .filter(
      (fila) =>
        fila.valores[0] === mensajeIdGmail &&
        (fila.valores[1] ?? "") === attachmentBuscado &&
        fila.valores[2] === gastoId
    )
    .sort((a, b) => b.rowIndex - a.rowIndex);
  for (const fila of coincidentes) {
    await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
  }
  return coincidentes.length;
}

/**
 * Detecta el mismo comprobante aunque llegue reenviado en otro mensaje de
 * Gmail. Esta consulta no depende de que Holded siga listando el documento
 * como /purchases (los tickets pueden desaparecer de esa vista).
 */
export async function buscarGastoProcesadoPorIdentidad(
  empresa: Empresa,
  identidad: IdentidadGastoProcesado
): Promise<CoincidenciaGastoProcesado | undefined> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const ahora = Date.now();
  let mejor: CoincidenciaGastoProcesado | undefined;
  for (const fila of filas) {
    const registro = filaARegistro(fila.valores);
    if (!registro || registro.empresa !== empresa || ahora - registro.creadoEn > TTL_MS || !registro.identidad) continue;
    const motivo = coincidenciaIdentidadGasto(identidad, registro.identidad);
    if (!motivo) continue;
    if (!mejor || motivo === "mismo_archivo" || registro.creadoEn > mejor.registro.creadoEn) {
      mejor = { registro, motivo };
    }
    if (motivo === "mismo_archivo") break;
  }
  return mejor;
}
