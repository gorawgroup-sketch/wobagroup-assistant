import { leerFilas, agregarFila, eliminarFila } from "../google/sheetsKeyValueStore";
import type { Empresa } from "../holded/client";

const TAB_NAME = "_gastos_por_correo";
const HEADERS = ["mensajeIdGmail", "attachmentId", "gastoId", "empresa", "creadoEn"];
const NUM_COLS = HEADERS.length;
// 90 días — deliberadamente mucho más largo que el TTL de 24-48h de los "pendiente_*" normales: esto
// no es una pregunta esperando respuesta, es un registro permanente de "este correo YA se convirtió en
// este gasto", y necesita seguir siendo consultable mucho después de que cualquier propuesta/pendiente
// relacionada haya expirado — ver buscarGastoDesdeCorreo.
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface GastoPorCorreo {
  mensajeIdGmail: string;
  attachmentId?: string;
  gastoId: string;
  empresa: Empresa;
  creadoEn: number;
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
  await agregarFila(TAB_NAME, NUM_COLS, HEADERS, [datos.mensajeIdGmail, datos.attachmentId ?? "", datos.gastoId, datos.empresa, Date.now()]);
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
    const [id, attachmentIdFila, gastoId, empresa, creadoEnRaw] = fila.valores;
    if (id !== mensajeIdGmail || !gastoId) continue;
    if ((attachmentIdFila ?? "") !== attachmentBuscado) continue;
    const creadoEn = Number(creadoEnRaw) || 0;
    if (ahora - creadoEn > TTL_MS) continue;
    if (!masReciente || creadoEn > masReciente.creadoEn) {
      masReciente = { mensajeIdGmail: id, attachmentId: attachmentIdFila || undefined, gastoId, empresa: empresa as Empresa, creadoEn };
    }
  }
  return masReciente;
}
