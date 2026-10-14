import type { Comunicacion } from "./envioMasivoStore";

/**
 * Seguimiento de lo que la gente contesta o envía tras un correo a una audiencia (pedido de Carlos, 2026-10-14: «haces el seguimiento y
 * tomamos decisiones en relación a lo que la gente envíe»). General — sirve para cualquier comunicación enviada con core/comunicaciones/, no solo
 * la de soportes: junta, por destinatario, los correos que ha mandado desde que se le escribió, qué hizo el sistema con cada adjunto y quién sigue
 * sin responder, y lo presenta como UN resumen para decidir. Solo lectura: no procesa, concilia ni responde nada.
 */
export interface AdjuntoEntrante { nombre: string; partId: string; estado: "gasto_creado" | "propuesta_pendiente" | "descartado" | "sin_procesar" }
export interface MensajeEntrante {
  id: string; threadId: string; de: string; asunto: string; fecha: string; esRespuesta: boolean;
  adjuntos: AdjuntoEntrante[];
}

export const MONEDAS = /\b(EUR|USD|COP|MXN|GBP|CAD|CHF|BRL|PEN|CLP|ARS|CRC|DOP|PAB|AUD|JPY|SEK|NOK|DKK|PLN|CZK|HUF|RON|AED|SGD|€|\$)\b|€|\$/i;

/** Heurística del formato pedido: el asunto lleva un valor con su moneda. (El detalle del gasto y la empresa no se pueden comprobar sin interpretar.) */
export function asuntoConValorYMoneda(asunto: string): boolean {
  const limpio = asunto.replace(/^(re|fwd?|rv):\s*/gi, "");
  return /\d/.test(limpio) && MONEDAS.test(limpio);
}

export interface SeguimientoPersona {
  nombre: string; email: string;
  mensajes: MensajeEntrante[];
  nuevos: MensajeEntrante[];
}

export interface DepsSeguimiento {
  entrantes(email: string, desdeMs: number): Promise<MensajeEntrante[]>;
}

export async function seguirComunicacion(com: Comunicacion, vistos: ReadonlySet<string>, deps: DepsSeguimiento): Promise<SeguimientoPersona[]> {
  const salida: SeguimientoPersona[] = [];
  for (const d of com.destinatarios) {
    const mensajes = (await deps.entrantes(d.email, com.cabecera.creadoEn)).sort((a, b) => Date.parse(a.fecha) - Date.parse(b.fecha));
    salida.push({ nombre: d.nombre, email: d.email, mensajes, nuevos: mensajes.filter((m) => !vistos.has(m.id)) });
  }
  return salida;
}

const ESTADO_ADJUNTO: Record<AdjuntoEntrante["estado"], string> = {
  gasto_creado: "✅ ya es un gasto en Holded", propuesta_pendiente: "🕓 propuesta pendiente de ti", descartado: "➖ descartado por ti", sin_procesar: "⏳ aún sin procesar",
};

const fechaCorta = (iso: string): string => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : iso; };

/** Texto del resumen. `soloNovedades` muestra el detalle solo de lo nuevo; el recuento y los que no han respondido van siempre. */
export function textoSeguimiento(com: Comunicacion, personas: SeguimientoPersona[], opciones: { soloNovedades?: boolean; ahora?: number } = {}): string {
  const ahora = opciones.ahora ?? Date.now();
  const dias = Math.floor((ahora - com.cabecera.creadoEn) / 86_400_000);
  const respondieron = personas.filter((p) => p.mensajes.length > 0);
  const sinRespuesta = personas.filter((p) => p.mensajes.length === 0);
  const lineas: string[] = [
    `📬 Seguimiento — «${com.cabecera.asunto}» (${com.cabecera.descripcion || "correo a una audiencia"})`,
    `Enviado hace ${dias === 0 ? "menos de un día" : `${dias} ${dias === 1 ? "día" : "días"}`} a ${personas.length} personas: ${respondieron.length} han escrito, ${sinRespuesta.length} no.`,
  ];
  for (const p of respondieron) {
    const detalle = opciones.soloNovedades ? p.nuevos : p.mensajes;
    if (detalle.length === 0) { lineas.push("", `• ${p.nombre}: ${p.mensajes.length} ${p.mensajes.length === 1 ? "correo" : "correos"} (ya vistos).`); continue; }
    lineas.push("", `• ${p.nombre} — ${p.mensajes.length} ${p.mensajes.length === 1 ? "correo" : "correos"}${opciones.soloNovedades ? `, ${p.nuevos.length} ${p.nuevos.length === 1 ? "nuevo" : "nuevos"}` : ""}:`);
    for (const m of detalle.slice(0, 8)) {
      const formato = m.esRespuesta ? " ↩️ respondió al hilo (no es el formato pedido)" : asuntoConValorYMoneda(m.asunto) ? "" : " ⚠️ asunto sin valor y moneda";
      lineas.push(`   – ${fechaCorta(m.fecha)} «${m.asunto || "(sin asunto)"}»${formato}`);
      for (const a of m.adjuntos.slice(0, 6)) lineas.push(`       📎 ${a.nombre}: ${ESTADO_ADJUNTO[a.estado]}`);
      if (m.adjuntos.length === 0) lineas.push("       (sin adjuntos)");
    }
    if (detalle.length > 8) lineas.push(`   … y ${detalle.length - 8} más.`);
  }
  if (sinRespuesta.length) lineas.push("", `Sin ningún correo todavía: ${sinRespuesta.map((p) => p.nombre).join(", ")}.`);
  lineas.push("", "Solo informo: no he respondido ni procesado nada por mi cuenta. Dime a quién recordarle algo o qué hacer con lo recibido.");
  return lineas.join("\n");
}

/** ¿Hay algo que contar? Novedades, o (una sola vez, pasados `diasSinRespuesta`) personas que siguen sin escribir. */
export function debeAvisar(com: Comunicacion, personas: SeguimientoPersona[], avisoSinRespuestaHecho: boolean, ahora: number, diasSinRespuesta = 7): { avisar: boolean; porSinRespuesta: boolean } {
  if (personas.some((p) => p.nuevos.length > 0)) return { avisar: true, porSinRespuesta: false };
  const transcurridos = (ahora - com.cabecera.creadoEn) / 86_400_000;
  if (!avisoSinRespuestaHecho && transcurridos >= diasSinRespuesta && personas.some((p) => p.mensajes.length === 0)) return { avisar: true, porSinRespuesta: true };
  return { avisar: false, porSinRespuesta: false };
}
