import type { gmail_v1 } from "googleapis";
import { hash, type AdjuntoAuto, type CorreoAuto } from "./model";
import { mapearConConcurrencia } from "../../utils/mapearConConcurrencia";
import { ETIQUETA_PROCESADO_AUTOMATICO } from "../client";

const header = (m: gmail_v1.Schema$Message, nombre: string) => m.payload?.headers?.find(h => h.name?.toLowerCase() === nombre.toLowerCase())?.value ?? "";
const decode = (s: string) => Buffer.from(s, "base64url");

/** Todas las partes textuales, también cuando Gmail guarda el cuerpo como attachmentId.
 * Se incluyen plain y HTML: escoger solo la primera parte puede perder información. */
export async function contenidoCompleto(gmail: gmail_v1.Gmail, m: gmail_v1.Schema$Message): Promise<{ cuerpo: string; adjuntos: AdjuntoAuto[] }> {
  if (!m.id || !m.payload) throw new Error("Mensaje Gmail incompleto.");
  const textos: string[] = [];
  const adjuntos: AdjuntoAuto[] = [];
  let bytes = 0;
  async function recorrer(p: gmail_v1.Schema$MessagePart): Promise<void> {
    if (p.parts?.length) { for (const sub of p.parts) await recorrer(sub); return; }
    if (!p.body) throw new Error("Parte MIME sin cuerpo; lectura incompleta.");
    if ((p.body.size ?? 0) > 25_000_000) throw new Error("Adjunto supera 25 MB; revisión manual.");
    let data = p.body.data ? decode(p.body.data) : Buffer.alloc(0);
    if (p.body.attachmentId) {
      const r = await gmail.users.messages.attachments.get({ userId: "me", messageId: m.id!, id: p.body.attachmentId });
      if (typeof r.data.data !== "string") throw new Error("No se pudo descargar una parte del correo.");
      data = decode(r.data.data);
    }
    bytes += data.length;
    if (bytes > 30_000_000) throw new Error("Mensaje demasiado grande para análisis completo; revisión manual.");
    if ((p.body.size ?? 0) > 0 && !data.length) throw new Error("Parte del correo vacía inesperadamente.");
    const mime = p.mimeType ?? "application/octet-stream";
    if (!p.filename && ["text/plain", "text/html"].includes(mime)) {
      textos.push(`[${mime}]\n${data.toString("utf8")}`);
    } else if (data.length) {
      // Ni las imágenes inline pequeñas se descartan por tamaño: la lectura decide si son decorativas.
      // attachmentId puede cambiar entre lecturas; partId identifica de forma
      // estable la misma parte MIME dentro del mismo mensaje.
      adjuntos.push({ id: p.partId ?? `parte:${adjuntos.length}`,
        nombre: p.filename || `inline-${p.partId ?? adjuntos.length}`, mime, data });
    }
  }
  await recorrer(m.payload);
  return { cuerpo: textos.join("\n\n"), adjuntos };
}

export class GmailAuto {
  private etiquetaProcesado?: Promise<string>;
  constructor(private readonly lectura: gmail_v1.Gmail, private readonly escritura: gmail_v1.Gmail,
    private readonly opciones: { concurrencia?: number; maxAntiguedadDias?: number; maxHilos?: number;
      sinLimiteAntiguedad?: boolean;
      progreso?: (completados: number, total: number) => void | Promise<void> } = {}) {}
  private async leerHilo(id: string, excluirEtiquetaId?: string): Promise<Array<CorreoAuto & { noLeido: boolean }>> {
    const r = await this.lectura.users.threads.get({ userId: "me", id, format: "full" });
    if (!r.data.messages) throw new Error("Hilo Gmail sin mensajes.");
    const leidos: Array<{ m: gmail_v1.Schema$Message; cuerpo: string; adjuntos: AdjuntoAuto[]; error?: string }> = [];
    for (const m of r.data.messages) {
      try { leidos.push({ m, ...await contenidoCompleto(this.lectura, m) }); }
      catch (error) { leidos.push({ m, cuerpo: "", adjuntos: [], error: error instanceof Error ? error.message : "Lectura incompleta" }); }
    }
    const contextoHilo = leidos.map(x => `Mensaje ${x.m.id}, de ${header(x.m, "From")}, fecha ${header(x.m, "Date")}:\n${x.cuerpo}`).join("\n\n");
    const errorHilo = leidos.find(x => x.error)?.error;
    return leidos.filter(({ m }) => !excluirEtiquetaId || !m.labelIds?.includes(excluirEtiquetaId))
      .map(({ m, cuerpo, adjuntos }) => {
      const recibidoEn = Number(m.internalDate);
      if (!Number.isFinite(recibidoEn) || !m.id) throw new Error("Mensaje sin fecha o identidad verificable.");
      return { id: m.id, threadId: id, de: header(m, "From"), asunto: header(m, "Subject"), fecha: header(m, "Date"),
        recibidoEn, cuerpo, contextoHilo, adjuntos, lecturaError: errorHilo,
        huella: hash(JSON.stringify([cuerpo, contextoHilo, errorHilo ?? "", adjuntos.map(a => [a.id, hash(a.data)])])),
        noLeido: m.labelIds?.includes("UNREAD") === true };
    });
  }
  async listar(): Promise<CorreoAuto[]> {
    const etiquetaProcesado = await this.buscarIdEtiquetaProcesado();
    const maxAntiguedadDias = Math.max(1, Math.min(30, this.opciones.maxAntiguedadDias ?? 7));
    const maxHilos = Math.max(1, Math.min(100, this.opciones.maxHilos ?? 25));
    const ids: string[] = [];
    let pageToken: string | undefined;
    const tokens = new Set<string>();
    do {
      const filtroAntiguedad = this.opciones.sinLimiteAntiguedad ? "" : ` newer_than:${maxAntiguedadDias}d`;
      const r = await this.lectura.users.threads.list({ userId: "me",
        q: `is:unread${filtroAntiguedad} -label:${ETIQUETA_PROCESADO_AUTOMATICO} -in:spam -in:trash`,
        maxResults: Math.min(100, maxHilos - ids.length), pageToken });
      if (!Array.isArray(r.data.threads) && r.data.resultSizeEstimate !== 0) throw new Error("Listado Gmail incompleto.");
      for (const t of r.data.threads ?? []) {
        if (!t.id) throw new Error("Hilo sin ID.");
        if (!ids.includes(t.id)) ids.push(t.id);
        if (ids.length >= maxHilos) break;
      }
      if (ids.length >= maxHilos) break;
      pageToken = r.data.nextPageToken ?? undefined;
      if (pageToken && tokens.has(pageToken)) throw new Error("Paginación Gmail repetida.");
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    const unicos = ids;
    let completados = 0;
    await this.opciones.progreso?.(0, unicos.length);
    const porHilo = await mapearConConcurrencia(unicos, this.opciones.concurrencia ?? 4, async id => {
      const correos = (await this.leerHilo(id, etiquetaProcesado)).filter(c => c.noLeido);
      completados++;
      await this.opciones.progreso?.(completados, unicos.length);
      return correos;
    });
    return porHilo.flat();
  }
  /** Recupera el mensaje original aunque ya esté leído, exclusivamente para terminar una operación durable existente. */
  async obtener(mensajeId: string, threadId: string): Promise<CorreoAuto | undefined> {
    return (await this.leerHilo(threadId)).find(c => c.id === mensajeId);
  }
  private async buscarIdEtiquetaProcesado(): Promise<string | undefined> {
    const r = await this.escritura.users.labels.list({ userId: "me" });
    return r.data.labels?.find(label => label.name === ETIQUETA_PROCESADO_AUTOMATICO)?.id ?? undefined;
  }
  private async idEtiquetaProcesado(): Promise<string> {
    return this.etiquetaProcesado ??= (async () => {
      const existente = await this.buscarIdEtiquetaProcesado();
      if (existente) return existente;
      try {
        const creada = await this.escritura.users.labels.create({ userId: "me", requestBody: {
          name: ETIQUETA_PROCESADO_AUTOMATICO, labelListVisibility: "labelShow",
          messageListVisibility: "show",
        } });
        if (creada.data.id) return creada.data.id;
      } catch {
        // Otra ejecución pudo crearla entre list y create; se verifica por lectura.
      }
      const recuperada = await this.buscarIdEtiquetaProcesado();
      if (!recuperada) throw new Error("Gmail no confirmó la etiqueta de procesado automático.");
      return recuperada;
    })();
  }
  async marcarResuelto(c: CorreoAuto): Promise<void> {
    const etiqueta = await this.idEtiquetaProcesado();
    await this.escritura.users.messages.modify({ userId: "me", id: c.id,
      // Se cambia solo este mensaje, nunca el hilo entero: una respuesta
      // nueva en la misma conversación debe conservar su propio UNREAD.
      requestBody: { addLabelIds: [etiqueta], removeLabelIds: ["UNREAD"] } });
    const r = await this.lectura.users.messages.get({ userId: "me", id: c.id, format: "minimal" });
    if (!r.data.id || r.data.labelIds?.includes("UNREAD") || !r.data.labelIds?.includes(etiqueta)) {
      throw new Error("Gmail no confirmó el mensaje como leído y procesado automáticamente.");
    }
  }
}
