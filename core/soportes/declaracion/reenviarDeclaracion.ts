import { buscarMensajes, obtenerResumenCorreo } from "../../gmail/client";
import { actualizarMessageIdBorrador, consumirBorradorCorreo, crearBorradorCorreo, obtenerBorradorCorreo } from "../../gmail/emailDraftStore";
import type { Empresa } from "../../holded/client";
import { editTelegramMessage, sendTelegramMessageWithButtons } from "../../telegram/client";
import { actualizarDeclaracion, listarDeclaraciones, obtenerDeclaracion, type Declaracion } from "./declaracionStore";
import { textoCorreoDeclaracion } from "./generarDeclaracion";
import { fechaCorta, importe } from "./plantillaDeclaracion";

const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Reenvío de una declaración de gastos sin soporte ya generada, en el mismo hilo del correo anterior.
 * Caso que lo originó (12-10-2026): el correo a German salió sin el documento porque el almacén de borradores
 * no persistía las columnas del adjunto. Carlos pidió un correo nuevo con disculpa, el documento adjunto y las
 * instrucciones claras de qué hacer. Es genérico: cualquier declaración «generada» o «enviada», de cualquier
 * persona y empresa, y también sirve para volver a mandarla cuando la persona dice que no la recibió.
 * El envío real sigue siendo solo con el botón «Enviar así».
 */
export type MotivoReenvio = "sin_adjunto" | "no_recibida";

export interface EntradaReenvio {
  chatId: number;
  /** Id de la declaración; si falta, se busca la última pendiente de firma por correo, nombre o empresa. */
  declaracionId?: string;
  empresa?: Empresa;
  email?: string;
  /** Nombre (o parte) de la persona, tal como lo dice Carlos: «German», «Simon Talloen». */
  titular?: string;
  motivo: MotivoReenvio;
}

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/**
 * Elige sola la declaración pendiente (norma de resolución autónoma): por correo, por nombre (todas las palabras dadas
 * dentro del titular) o, si no se da nada y solo hay una pendiente, esa. Lanza con la lista cuando hay varias.
 * Caso real 12-10: Wobi llamó al reenvío con «German» y sin correo, y la herramienta falló en 0 ms pidiendo el correo.
 */
/** `estados`: por defecto las pendientes de firma (reenvío); `["firmada"]` para aplicar el paso C (aplicar_declaracion_firmada). */
export function seleccionarDeclaracionPendiente(pendientes: Declaracion[], criterio: { empresa?: string; email?: string; titular?: string }, estados: Declaracion["estado"][] = ["generada", "enviada"]): Declaracion {
  let candidatas = pendientes.filter((d) => estados.includes(d.estado));
  const queEstado = estados.length === 1 && estados[0] === "firmada" ? "firmada" : "pendiente de firma";
  if (criterio.empresa) candidatas = candidatas.filter((d) => d.empresa === criterio.empresa);
  const porNombre = (lista: Declaracion[]): Declaracion[] => {
    const palabras = normalizar(criterio.titular ?? "").split(/\s+/).filter(Boolean);
    return palabras.length ? lista.filter((d) => { const t = normalizar(d.titular); return palabras.every((p) => t.includes(p)); }) : lista;
  };
  if (criterio.email?.trim()) {
    const porCorreo = candidatas.filter((d) => d.email.toLowerCase() === criterio.email!.trim().toLowerCase());
    // Caso real 12-10: Carlos dijo «envíaselo a german@eworkstudio.com» y la declaración estaba registrada con otro correo.
    // El correo dado es el DESTINO que quiere Carlos, no un filtro: si no coincide con ninguna, se busca por nombre.
    candidatas = porCorreo.length ? porCorreo : porNombre(candidatas);
  } else candidatas = porNombre(candidatas);
  candidatas.sort((a, b) => b.creadoEn - a.creadoEn);
  const quien = criterio.email?.trim() || criterio.titular?.trim() || (criterio.empresa ? `la empresa ${criterio.empresa}` : "ninguna persona concreta");
  if (!candidatas.length) throw new Error(`No hay ninguna declaración ${queEstado} para ${quien}.`);
  const personas = new Set(candidatas.map((d) => `${d.titular} <${d.email}> (${d.empresa})`));
  if (personas.size > 1) throw new Error(`Hay varias declaraciones pendientes y «${quien}» no basta para distinguirlas: ${[...personas].join("; ")}. Indica el correo o el nombre completo.`);
  return candidatas[0];
}

export interface ResultadoReenvio { declaracion: Declaracion; borradorId: string; messageId: number; enElHilo: boolean; destino: string }

export function textoCorreoReenvioDeclaracion(d: { titular: string; empresa: Empresa; cargos: Declaracion["cargos"]; nombreArchivo: string; motivo: MotivoReenvio }): { asunto: string; cuerpo: string } {
  const nombre = d.titular.trim().split(/\s+/)[0] || d.titular;
  const total = d.cargos.reduce((s, c) => s + c.valor, 0);
  const lineas = d.cargos.map((c) => `• ${fechaCorta(c.fecha)} · ${c.lugar} · ${importe(c.valor)}`).join("\n");
  const { asunto } = textoCorreoDeclaracion({ titular: d.titular, empresa: d.empresa as Empresa, cargos: d.cargos });
  const disculpa = d.motivo === "sin_adjunto"
    ? "Te pedimos disculpas: en el correo anterior olvidamos adjuntar la declaración. Aquí va."
    : "Te volvemos a enviar la declaración por si el correo anterior no te llegó.";
  return {
    asunto,
    cuerpo: [
      `Hola ${nombre},`,
      "",
      disculpa,
      "",
      `Adjunto encontrarás el documento «${d.nombreArchivo}» con la relación de los cargos de tu tarjeta de los que no conservas comprobante:`,
      lineas,
      `Total: ${importe(total)}`,
      "",
      "Qué tienes que hacer:",
      "1. Descarga el documento adjunto y revisa que los datos sean correctos.",
      "2. Fírmalo: puedes imprimirlo y firmarlo a mano, o firmarlo digitalmente en tu ordenador o móvil.",
      "3. Respóndenos a este mismo correo con el documento firmado (vale una foto nítida o un PDF).",
      "",
      "Con el documento firmado esos gastos quedan justificados en contabilidad y no te pediremos nada más sobre ellos. Si algún dato no cuadra, dínoslo respondiendo a este correo.",
      "",
      "Gracias y perdona las molestias.",
    ].join("\n"),
  };
}

/** Localiza el correo ya enviado a la persona con el asunto de la declaración para responder en su mismo hilo. */
export async function localizarHiloEnviado(d: Declaracion): Promise<{ threadId: string; messageIdHeader: string } | undefined> {
  const { asunto } = textoCorreoDeclaracion({ titular: d.titular, empresa: d.empresa as Empresa, cargos: d.cargos });
  const ids = await buscarMensajes(`in:sent to:${d.email} subject:"${asunto}"`, 3);
  for (const id of ids) {
    const resumen = await obtenerResumenCorreo(id);
    if (d.threadId && resumen.threadId !== d.threadId) continue;
    if (resumen.threadId && resumen.messageIdHeader) return { threadId: resumen.threadId, messageIdHeader: resumen.messageIdHeader };
  }
  return undefined;
}

/** Lista de destinatarios: el registrado primero y, sin repetir, los que indique Carlos (coma o punto y coma). */
export function destinosReenvio(registrado: string, indicados?: string): string[] {
  const lista = [registrado.trim()];
  for (const c of (indicados ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    if (!lista.some((x) => x.toLowerCase() === c.toLowerCase())) lista.push(c);
  }
  return lista;
}

export async function elegirDeclaracionAReenviar(e: Pick<EntradaReenvio, "declaracionId" | "empresa" | "email" | "titular">): Promise<Declaracion> {
  if (e.declaracionId) {
    const d = await obtenerDeclaracion(e.declaracionId);
    if (!d) throw new Error(`No existe la declaración ${e.declaracionId}.`);
    return d;
  }
  const pendientes = await listarDeclaraciones({ estados: ["generada", "enviada"] });
  return seleccionarDeclaracionPendiente(pendientes, { empresa: e.empresa, email: e.email, titular: e.titular });
}

export async function reenviarDeclaracion(e: EntradaReenvio): Promise<ResultadoReenvio> {
  const declaracion = await elegirDeclaracionAReenviar(e);
  if (declaracion.estado === "firmada" || declaracion.estado === "aplicada") {
    throw new Error(`La declaración de ${declaracion.titular} ya está ${declaracion.estado}; no hay nada que reenviar.`);
  }
  // Destino: el correo registrado de la persona SIEMPRE va (ahí vive el hilo y desde ahí contesta); si Carlos indica otra
  // dirección, se añade como destinatario adicional (Carlos 12-10: «deja los 2 mails como destino»). No se sustituye.
  const destinos = destinosReenvio(declaracion.email, e.email);
  const destino = destinos.join(", ");
  const adicionales = destinos.slice(1);
  const hilo = await localizarHiloEnviado(declaracion);
  const { asunto, cuerpo } = textoCorreoReenvioDeclaracion({ titular: declaracion.titular, empresa: declaracion.empresa as Empresa, cargos: declaracion.cargos, nombreArchivo: declaracion.nombreArchivo, motivo: e.motivo });
  const borrador = await crearBorradorCorreo({
    chatId: e.chatId, messageId: 0, to: destino, subject: asunto, cuerpo, threadId: hilo?.threadId, messageIdHeader: hilo?.messageIdHeader,
    adjuntosDrive: [{ fileId: declaracion.driveFileId, nombre: declaracion.nombreArchivo, mimeType: MIME_DOCX }], declaracionId: declaracion.id,
  });
  const texto = [
    `✉️ Reenvío de la declaración de gastos sin soporte de ${declaracion.titular} (${declaracion.empresa}) a ${destino}${adicionales.length ? ` (se añade ${adicionales.join(", ")} al registrado)` : ""}, ${hilo ? "como respuesta en el hilo del correo anterior" : "en un correo nuevo (no encontré el correo anterior en Enviados)"}, con el documento adjunto: ${declaracion.nombreArchivo}`,
    `Asunto: ${asunto}`, "", cuerpo,
  ].join("\n");
  let messageId = 0;
  try {
    messageId = await sendTelegramMessageWithButtons(e.chatId, texto, [
      [{ text: "📤 Enviar así", callback_data: `draft_enviar:${borrador.id}` }, { text: "✏️ Editar antes de enviar", callback_data: `draft_editar:${borrador.id}` }],
      [{ text: "❌ No enviar", callback_data: `draft_cancelar:${borrador.id}` }],
    ]);
    await actualizarMessageIdBorrador(borrador.id, messageId);
    const confirmado = await obtenerBorradorCorreo(borrador.id);
    if (!confirmado || confirmado.messageId !== messageId) throw new Error("El borrador se mostró, pero su entrega no quedó confirmada en el estado durable.");
    if (!confirmado.adjuntosDrive?.length || confirmado.declaracionId !== declaracion.id) {
      throw new Error("El borrador quedó guardado sin el adjunto o sin la declaración: no se ofrece el envío para no repetir un correo sin documento.");
    }
  } catch (error) {
    await consumirBorradorCorreo(borrador.id).catch(() => undefined);
    if (messageId > 0) {
      await editTelegramMessage(e.chatId, messageId, "⚠️ Este borrador no quedó guardado de forma segura (faltaba el adjunto o la declaración) y sus botones fueron desactivados. Vuelve a pedir el reenvío.", []).catch(() => undefined);
    }
    throw error;
  }
  return { declaracion, borradorId: borrador.id, messageId, enElHilo: Boolean(hilo), destino };
}
