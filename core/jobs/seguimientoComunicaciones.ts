import { buscarGastoDesdeCorreo } from "../gastos/gastoPorCorreoStore";
import { gastoDescartadoPorOperador } from "../gastos/gastoDescartadoPorOperadorStore";
import { obtenerPropuestasGastoPorChat } from "../gastos/gastoProposalSheet";
import { getGmailClient, obtenerResumenCorreo } from "../gmail/client";
import { debeAvisar, esLaMismaPersona, seguirComunicacion, textoSeguimiento, type AdjuntoEntrante, type DepsSeguimiento, type MensajeEntrante } from "../comunicaciones/seguimiento";
import { listarComunicacionesRecientes } from "../comunicaciones/envioMasivoStore";
import { guardarEstadoSeguimiento, leerEstadoSeguimiento } from "../comunicaciones/seguimientoStore";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";

/**
 * Job (laborables 9:20 y 16:20): resume lo que han enviado o contestado las personas a las que se escribió con core/comunicaciones/ en los
 * últimos 14 días. Solo avisa si hay novedades (y, una vez a los 7 días, quiénes siguen sin escribir). Solo lectura: no procesa nada, eso lo hace
 * la revisión de correo de siempre; aquí se ve lo que llegó y qué hizo el sistema con ello.
 */
const DIAS_VIGILANCIA = 14;
const MAX_MENSAJES_POR_PERSONA = 25;

async function crearDeps(): Promise<DepsSeguimiento> {
  const superadmin = (await obtenerAdmins()).find((a) => a.rol === "superadmin")?.userId;
  const propuestas = superadmin ? await obtenerPropuestasGastoPorChat(superadmin) : [];
  return {
    entrantes: async (persona, desdeMs): Promise<MensajeEntrante[]> => {
      // Por la dirección a la que se escribió Y por el nombre (escriben desde otras direcciones); el filtro fino por nombre se hace al leer cada remitente.
      const primerNombre = persona.nombre.trim().split(/\s+/)[0] ?? "";
      const q = `in:anywhere after:${Math.floor(desdeMs / 1000)} -from:asistente@wobagroup.com (from:${persona.email}${primerNombre.length >= 3 ? ` OR from:${primerNombre}` : ""})`;
      const lista = await getGmailClient().users.messages.list({ userId: "me", q, maxResults: MAX_MENSAJES_POR_PERSONA * 2 });
      const salida: MensajeEntrante[] = [];
      for (const m of lista.data.messages ?? []) {
        if (!m.id) continue;
        const r = await obtenerResumenCorreo(m.id);
        if (!esLaMismaPersona(r.de, persona)) continue;
        if (salida.length >= MAX_MENSAJES_POR_PERSONA) break;
        const adjuntos: AdjuntoEntrante[] = [];
        for (const a of r.adjuntos) {
          const partId = a.partId ?? "";
          let estado: AdjuntoEntrante["estado"] = "sin_procesar";
          if (await buscarGastoDesdeCorreo(r.id, partId).catch(() => undefined)) estado = "gasto_creado";
          else if (propuestas.some((p) => p.correoOrigen?.mensajeIdGmail === r.id && (!partId || !p.origenAdjuntoGmail?.partId || p.origenAdjuntoGmail.partId === partId))) estado = "propuesta_pendiente";
          else if (await gastoDescartadoPorOperador(r.id, partId).catch(() => undefined)) estado = "descartado";
          adjuntos.push({ nombre: a.filename, partId, estado });
        }
        salida.push({ id: r.id, threadId: r.threadId, de: r.de, asunto: r.asunto, fecha: r.fecha, esRespuesta: r.threadId !== r.id, adjuntos });
      }
      return salida;
    },
  };
}

export interface ResultadoSeguimiento { comunicaciones: number; avisos: number; simulado: boolean }

export async function ejecutarSeguimientoComunicaciones(opciones: { simular?: boolean; ahora?: number } = {}): Promise<ResultadoSeguimiento> {
  const ahora = opciones.ahora ?? Date.now();
  const deps = await crearDeps();
  const admins = (await obtenerAdmins()).filter((a) => a.rol === "superadmin");
  let avisos = 0;
  const comunicaciones = await listarComunicacionesRecientes(DIAS_VIGILANCIA, ahora);
  for (const com of comunicaciones) {
    try {
      const estado = await leerEstadoSeguimiento(com.cabecera.id);
      const personas = await seguirComunicacion(com, estado.vistos, deps);
      const decision = debeAvisar(com, personas, estado.avisoSinRespuesta, ahora);
      if (!decision.avisar) continue;
      avisos++;
      if (opciones.simular) { console.log(textoSeguimiento(com, personas, { soloNovedades: !decision.porSinRespuesta, ahora })); continue; }
      const texto = textoSeguimiento(com, personas, { soloNovedades: !decision.porSinRespuesta, ahora });
      for (const a of admins) await sendTelegramMessage(a.userId, texto).catch((e) => console.error("[seguimientoComunicaciones] Error avisando a un superadmin:", e instanceof Error ? e.name : "Error"));
      const vistos = new Set(estado.vistos);
      for (const p of personas) for (const m of p.mensajes) vistos.add(m.id);
      await guardarEstadoSeguimiento(com.cabecera.id, { vistos, avisoSinRespuesta: estado.avisoSinRespuesta || decision.porSinRespuesta }, ahora);
    } catch (error) {
      // Un fallo de Gmail o de Sheets no es «sin novedades»: no se marca nada como visto y se reintenta en la siguiente pasada.
      console.error(`[seguimientoComunicaciones] No se pudo hacer el seguimiento de ${com.cabecera.id}:`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`[seguimientoComunicaciones] ${opciones.simular ? "SIMULACIÓN · " : ""}${comunicaciones.length} comunicación(es) vigiladas, ${avisos} aviso(s)`);
  return { comunicaciones: comunicaciones.length, avisos, simulado: Boolean(opciones.simular) };
}

/** Seguimiento completo (no solo novedades) de las comunicaciones recientes, para la herramienta del chat. */
export async function textoSeguimientoCompleto(filtro?: string, ahora = Date.now()): Promise<string> {
  const deps = await crearDeps();
  const todas = await listarComunicacionesRecientes(DIAS_VIGILANCIA, ahora);
  const f = (filtro ?? "").trim().toLowerCase();
  const elegidas = (f ? todas.filter((c) => c.cabecera.id === f || c.cabecera.asunto.toLowerCase().includes(f) || c.cabecera.descripcion.toLowerCase().includes(f)) : todas).sort((a, b) => b.cabecera.creadoEn - a.cabecera.creadoEn).slice(0, 3);
  if (elegidas.length === 0) return "No hay correos a una audiencia enviados en los últimos 14 días que seguir.";
  const textos: string[] = [];
  for (const com of elegidas) textos.push(textoSeguimiento(com, await seguirComunicacion(com, new Set(), deps), { ahora }));
  return textos.join("\n\n———\n\n");
}
