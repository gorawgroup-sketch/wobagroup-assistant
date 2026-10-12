import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { descargarAdjunto, obtenerResumenCorreo, type AdjuntoCorreo, type CorreoResumen } from "../../gmail/client";
import { incrementarPendientesActivo, revertirIncrementoPendientesActivo, type IdentidadCorreoCola } from "../../gmail/colaRevisionStore";
import { resolverOCrearCarpeta, subirArchivoADrive } from "../../drive/client";
import { ROOT_FOLDERS } from "../../drive/rootFolders";
import { crearBorradorCorreo, actualizarMessageIdBorrador, obtenerBorradorCorreo, consumirBorradorCorreo } from "../../gmail/emailDraftStore";
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage, sendTelegramMessageWithButtons } from "../../telegram/client";
import type { TelegramCallbackQuery } from "../../telegram/types";
import { retirarPreguntaCaducada } from "../../telegram/preguntaCaducada";
import type { Empresa } from "../../holded/client";
import { actualizarDeclaracion, listarDeclaraciones, obtenerDeclaracion, type Declaracion } from "./declaracionStore";
import { RUTA_CARPETA_DECLARACIONES } from "./plantillas";
import { aplicarDeclaracion, proponerAplicacion } from "./aplicarDeclaracion";

/**
 * Paso B del flujo «declaración de gastos sin soporte» (Carlos, 12-10-2026): seguir la declaración enviada hasta que la
 * persona la devuelva firmada. (1) Cuando llega una respuesta en el hilo de una declaración «enviada» con un PDF o una
 * imagen, se le muestra a Carlos con botones «es la firmada / no lo es»; con su confirmación se guarda en Drive junto a la
 * original y la declaración pasa a «firmada» (paso C la aplica como soporte en Holded). (2) Si pasan N días sin respuesta,
 * se propone un recordatorio (borrador con botón). Nunca marca nada por su cuenta: cada paso visible lo decide Carlos.
 */
const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");
export const DIAS_RECORDATORIO_POR_DEFECTO = 5;

export function diasRecordatorio(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WOBI_DECLARACION_RECORDATORIO_DIAS);
  return Number.isFinite(n) && n >= 1 && n <= 60 ? n : DIAS_RECORDATORIO_POR_DEFECTO;
}

/** PDF o imagen con tamaño de documento real (no un icono de firma de correo). */
export function esAdjuntoCandidatoFirma(a: Pick<AdjuntoCorreo, "mimeType" | "size" | "filename">): boolean {
  const mime = (a.mimeType || "").toLowerCase();
  const porExtension = /\.(pdf|jpe?g|png|heic|heif|webp)$/i.test(a.filename || "");
  return (mime === "application/pdf" || mime.startsWith("image/") || porExtension) && a.size >= 10_000;
}

export function elegirAdjuntoFirma(adjuntos: readonly AdjuntoCorreo[]): AdjuntoCorreo | undefined {
  const candidatos = adjuntos.filter(esAdjuntoCandidatoFirma);
  // Un PDF manda sobre una imagen; entre iguales, el más grande (el documento completo frente a una miniatura).
  return candidatos.sort((x, y) => Number(y.mimeType === "application/pdf") - Number(x.mimeType === "application/pdf") || y.size - x.size)[0];
}

export async function declaracionEnviadaDelHilo(threadId: string): Promise<Declaracion | undefined> {
  if (!threadId) return undefined;
  return (await listarDeclaraciones({ estados: ["enviada"] })).find((d) => d.threadId === threadId);
}

/** Hilos con una declaración esperando firma: el flujo automático no debe leerlos como recibos. */
export async function hilosConDeclaracionEnviada(): Promise<string[]> {
  return (await listarDeclaraciones({ estados: ["enviada"] })).map((d) => d.threadId ?? "").filter(Boolean);
}

export function nombreArchivoFirmado(d: Pick<Declaracion, "nombreArchivo">, filename: string): string {
  const ext = (filename.match(/\.[a-z0-9]+$/i)?.[0] ?? ".pdf").toLowerCase();
  return `${d.nombreArchivo.replace(/\.docx$/i, "")} FIRMADO${ext}`;
}

/**
 * Respuesta recibida en el hilo de una declaración enviada. Devuelve true si el correo queda en manos de esta decisión
 * (hay un adjunto candidato y se publicó la pregunta); false si no hay adjunto útil (se avisa y sigue el flujo normal).
 */
export async function proponerFirmaRecibida(p: { chatId: number; declaracion: Declaracion; correo: CorreoResumen; deColaCorreo: boolean }): Promise<boolean> {
  const adjunto = elegirAdjuntoFirma(p.correo.adjuntos);
  if (!adjunto) {
    await sendTelegramMessage(p.chatId,
      `📝 ${p.declaracion.titular} respondió al correo de su declaración de gastos sin soporte, pero sin un documento adjunto (${p.correo.extracto.slice(0, 200)}). ` +
      `La declaración sigue «enviada»; si te manda el documento firmado en otro correo, lo detectaré en ese hilo.`).catch(() => undefined);
    return false;
  }
  const identidad: IdentidadCorreoCola = { threadId: p.correo.threadId, mensajeId: p.correo.id };
  let reservado = false;
  if (p.deColaCorreo) {
    reservado = await incrementarPendientesActivo(p.chatId, identidad);
    if (!reservado) throw new Error("el correo ya no coincide con el activo; no se publica la pregunta de la firma");
  }
  try {
    await actualizarDeclaracion(p.declaracion.id, { firmaCandidata: { mensajeId: p.correo.id, filename: adjunto.filename, mimeType: adjunto.mimeType, size: adjunto.size, recibidaEn: Date.now() } });
    await sendTelegramMessageWithButtons(p.chatId,
      `📝 ${p.declaracion.titular} (${p.declaracion.empresa}) respondió a su declaración de gastos sin soporte con el adjunto «${adjunto.filename}» (${Math.round(adjunto.size / 1024)} KB).\n` +
      `¿Es la declaración firmada? Si confirmas, la guardo en Drive junto a la original y queda lista para ponerla como soporte de sus ${p.declaracion.cargos.length} cargo(s).`,
      [[{ text: "✅ Sí, es la firmada: guardar", callback_data: `decl_firmada:${p.declaracion.id}` }], [{ text: "❌ No es la firma", callback_data: `decl_nofirma:${p.declaracion.id}` }]]);
    return true;
  } catch (error) {
    if (reservado) await revertirIncrementoPendientesActivo(p.chatId, identidad).catch(() => undefined);
    throw error;
  }
}

/** revisarCorreoNuevo importa este módulo (punto de conexión): se carga en diferido para no cerrar el ciclo en el arranque. */
async function avanzarCola(chatId: number, identidad: IdentidadCorreoCola, clave: string): Promise<void> {
  const { avanzarColaCorreoSiActivo } = await import("../../jobs/revisarCorreoNuevo");
  await avanzarCola(chatId, identidad, clave);
}

async function responder(id: string, texto?: string): Promise<void> {
  try { await answerCallbackQuery(id, texto); } catch (error) { console.error("[declaracion] No se pudo responder el callback (no crítico):", error instanceof Error ? error.message : error); }
}

export async function handleDeclaracionCallback(callback: TelegramCallbackQuery): Promise<void> {
  const [accion, id] = (callback.data ?? "").split(":");
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  if (!chatId || !id || !["decl_firmada", "decl_nofirma", "decl_aplicar", "decl_noaplicar"].includes(accion)) { await responder(callback.id, "Acción no válida."); return; }
  const d = await obtenerDeclaracion(id);

  // Paso C: aplicar la declaración firmada como soporte en Holded (botón explícito de Carlos).
  if (accion === "decl_aplicar" || accion === "decl_noaplicar") {
    if (!d || d.estado !== "firmada") { await retirarPreguntaCaducada(callback, d?.estado === "aplicada" ? "Esta declaración ya se aplicó." : "Esta declaración no está en estado firmada."); return; }
    if (accion === "decl_noaplicar") {
      await responder(callback.id, "Ok, queda firmada sin aplicar.");
      if (messageId) await editTelegramMessage(chatId, messageId, `⏸️ La declaración firmada de ${d.titular} queda guardada sin aplicar como soporte. Cuando quieras, pide «aplica la declaración firmada de ${d.titular}».`, []).catch(() => undefined);
      return;
    }
    await responder(callback.id, "Aplicando como soporte...");
    if (messageId) await editTelegramMessage(chatId, messageId, `🔄 Aplicando la declaración firmada de ${d.titular} como soporte en Holded…`, []).catch(() => undefined);
    try {
      const r = await aplicarDeclaracion(chatId, d);
      const texto = `✅ Declaración de ${d.titular}: ${r.adjuntados} gasto(s) existentes con la declaración adjunta; ${r.propuestos} gasto(s) nuevos propuestos arriba con sus botones` +
        (r.fallos.length ? `; ${r.fallos.length} con fallo:\n  • ${r.fallos.join("\n  • ")}` : ".");
      if (messageId) await editTelegramMessage(chatId, messageId, texto, []).catch(() => sendTelegramMessage(chatId, texto).catch(() => undefined));
      else await sendTelegramMessage(chatId, texto).catch(() => undefined);
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      console.error("[declaracion] No se pudo aplicar la declaración firmada:", detalle);
      await sendTelegramMessage(chatId, `⚠️ No pude aplicar la declaración de ${d.titular} (${detalle}). No se dejó nada a medias sin registrar; pide «aplica la declaración firmada de ${d.titular}» para reintentar.`).catch(() => undefined);
    }
    return;
  }
  if (!d || !d.firmaCandidata || d.estado !== "enviada") { await retirarPreguntaCaducada(callback, "Esta pregunta ya fue resuelta."); return; }
  const identidad: IdentidadCorreoCola = { threadId: d.threadId ?? "", mensajeId: d.firmaCandidata.mensajeId };

  if (accion === "decl_nofirma") {
    await responder(callback.id, "Ok.");
    await actualizarDeclaracion(d.id, { firmaCandidata: undefined, nota: `${d.nota ? `${d.nota} ` : ""}[${new Date().toISOString().slice(0, 10)}: adjunto «${d.firmaCandidata.filename}» descartado como firma]` });
    await avanzarCola(chatId, identidad, `declaracion:${d.id}:nofirma:${d.firmaCandidata.mensajeId}`).catch((e) => console.error("[declaracion] No se pudo avanzar la cola tras «no es la firma»:", e instanceof Error ? e.message : e));
    if (messageId) await editTelegramMessage(chatId, messageId, `Ok — el adjunto «${d.firmaCandidata.filename}» no es la declaración firmada de ${d.titular}. La declaración sigue «enviada»; si hace falta, pídele el documento de nuevo.`, []).catch(() => undefined);
    return;
  }

  await responder(callback.id, "Guardando la declaración firmada...");
  try {
    // El attachmentId de Gmail cambia en cada lectura: se relee el mensaje y se elige el mismo archivo por nombre y tamaño.
    const correo = await obtenerResumenCorreo(d.firmaCandidata.mensajeId);
    const adjunto = correo.adjuntos.find((a) => a.filename === d.firmaCandidata!.filename && a.size === d.firmaCandidata!.size) ?? elegirAdjuntoFirma(correo.adjuntos);
    if (!adjunto) throw new Error(`Gmail ya no devuelve el adjunto «${d.firmaCandidata.filename}» en ese correo.`);
    const bytes = await descargarAdjunto(correo.id, adjunto.attachmentId);
    const nombre = nombreArchivoFirmado(d, adjunto.filename);
    await mkdir(UPLOADS_DIR, { recursive: true });
    const rutaLocal = join(UPLOADS_DIR, `${Date.now()}_firmada_${d.id}${nombre.slice(nombre.lastIndexOf("."))}`);
    await writeFile(rutaLocal, bytes);
    let subido: { fileId: string; webViewLink: string };
    try {
      const carpeta = await resolverOCrearCarpeta(ROOT_FOLDERS[d.empresa as Empresa], RUTA_CARPETA_DECLARACIONES);
      subido = await subirArchivoADrive(rutaLocal, nombre, adjunto.mimeType, carpeta.folderId, `declaracion-firmada:${d.id}:${correo.id}`, "declaracion_firmada");
    } finally {
      await unlink(rutaLocal).catch(() => undefined);
    }
    await actualizarDeclaracion(d.id, { estado: "firmada", firmadaEn: Date.now(), archivoFirmadoDriveId: subido.fileId, firmaCandidata: undefined });
    await avanzarCola(chatId, identidad, `declaracion:${d.id}:firmada`).catch((e) => console.error("[declaracion] Firma guardada, pero no se pudo avanzar la cola:", e instanceof Error ? e.message : e));
    const texto = `✅ Declaración firmada de ${d.titular} (${d.empresa}) guardada en Drive: ${subido.webViewLink}\n` +
      `Cargos que cubre: ${d.cargos.length} (${d.cargos.map((c) => `${c.lugar} ${c.valor.toFixed(2)}`).join(", ")}).`;
    if (messageId) await editTelegramMessage(chatId, messageId, texto, []).catch(() => sendTelegramMessage(chatId, texto).catch(() => undefined));
    else await sendTelegramMessage(chatId, texto).catch(() => undefined);
    // Paso C: proponer de inmediato aplicarla como soporte (con botón).
    const firmada = await obtenerDeclaracion(d.id);
    if (firmada) await proponerAplicacion(chatId, firmada).catch((e) => console.error("[declaracion] No se pudo proponer la aplicación como soporte:", e instanceof Error ? e.message : e));
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    console.error("[declaracion] No se pudo guardar la declaración firmada:", detalle);
    await sendTelegramMessage(chatId, `⚠️ No pude guardar la declaración firmada de ${d.titular} (${detalle}). La pregunta sigue viva: vuelve a pulsar «Sí, es la firmada» cuando quieras reintentar.`).catch(() => undefined);
  }
}

/** Declaraciones enviadas hace ≥ N días sin firma ni recordatorio reciente. Lógica pura. */
export function declaracionesConRecordatorioVencido(lista: readonly Declaracion[], ahora: number, dias: number): Declaracion[] {
  const limite = dias * 24 * 3_600_000;
  return lista.filter((d) => d.estado === "enviada" && d.enviadoEn && ahora - d.enviadoEn >= limite && (!d.recordatorioEn || ahora - d.recordatorioEn >= limite) && !d.firmaCandidata);
}

export function textoRecordatorio(d: Declaracion): string {
  const nombre = d.titular.trim().split(/\s+/)[0] || d.titular;
  return [`Hola ${nombre},`, "", `Te escribimos para recordarte la declaración de gastos sin soporte que te enviamos el ${new Date(d.enviadoEn ?? d.creadoEn).toLocaleDateString("es-ES")} (${d.cargos.length} cargo(s)). ` +
    "Cuando puedas, fírmala y devuélvenosla respondiendo a este correo (vale una foto o un PDF del documento firmado).", "", "Gracias."].join("\n");
}

/** Trabajo diario: propone (con botón) un recordatorio por cada declaración vencida. */
export async function recordatoriosDeclaraciones(ahora = Date.now()): Promise<number> {
  const vencidas = declaracionesConRecordatorioVencido(await listarDeclaraciones({ estados: ["enviada"] }), ahora, diasRecordatorio());
  let propuestos = 0;
  for (const d of vencidas) {
    try {
      const borrador = await crearBorradorCorreo({ chatId: d.chatId, messageId: 0, to: d.email, subject: `Re: ${d.empresa} · Declaración de gastos sin soporte para tu firma`, cuerpo: textoRecordatorio(d), threadId: d.threadId });
      const texto = [`⏰ ${d.titular} (${d.empresa}) no ha devuelto firmada su declaración de gastos sin soporte (enviada hace ${Math.floor((ahora - (d.enviadoEn ?? d.creadoEn)) / 86_400_000)} días). Borrador de recordatorio:`, "", textoRecordatorio(d)].join("\n");
      let messageId = 0;
      try {
        messageId = await sendTelegramMessageWithButtons(d.chatId, texto, [
          [{ text: "📤 Enviar así", callback_data: `draft_enviar:${borrador.id}` }, { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borrador.id}` }],
          [{ text: "❌ No enviar", callback_data: `draft_cancelar:${borrador.id}` }],
        ]);
        await actualizarMessageIdBorrador(borrador.id, messageId);
        const confirmado = await obtenerBorradorCorreo(borrador.id);
        if (!confirmado || confirmado.messageId !== messageId) throw new Error("El recordatorio se mostró, pero su entrega no quedó confirmada.");
      } catch (error) {
        await consumirBorradorCorreo(borrador.id).catch(() => undefined);
        throw error;
      }
      await actualizarDeclaracion(d.id, { recordatorioEn: ahora });
      propuestos++;
    } catch (error) {
      console.error(`[declaracion] No se pudo proponer el recordatorio de ${d.titular}:`, error instanceof Error ? error.message : error);
    }
  }
  if (vencidas.length) console.log("[declaracion] recordatorios", JSON.stringify({ vencidas: vencidas.length, propuestos }));
  return propuestos;
}
