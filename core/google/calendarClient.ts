import { google, calendar_v3 } from "googleapis";
import { loadServiceAccountCredentials } from "./serviceAccount";

/**
 * Pedido explícito de Carlos: "usa gsuite y tu calendario de google...
 * tienes tu propio mail de google, así que programas las actividades [y]
 * te aseguras de mandar los recordatorios necesarios" — para que las
 * acciones programadas (ver accionesProgramadasStore.ts) queden visibles
 * en un calendario real, no solo en una tabla interna.
 *
 * Organizador: el propio correo de Wobi (GMAIL_IMPERSONATE_EMAIL,
 * asistente@wobagroup.com — mismo que ya usa Gmail). Invitado: Carlos, para
 * que también le aparezca en SU calendario y reciba el recordatorio nativo
 * de Google como respaldo — pero el disparo real de la acción NUNCA depende
 * de esto (ver revisarAccionesProgramadas.ts, que revisa su propio store en
 * Sheets por su cuenta). Este cliente es deliberadamente "best effort": si
 * Calendar falla (ej. el scope todavía no está autorizado en Domain-Wide
 * Delegation — ver README de esta función), la acción se programa igual,
 * solo sin el evento visible.
 */

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

let client: calendar_v3.Calendar | null = null;

function getClient(): calendar_v3.Calendar {
  if (client) return client;

  const credentials = loadServiceAccountCredentials();
  const impersonate = process.env.GMAIL_IMPERSONATE_EMAIL;

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
    subject: impersonate,
  });

  client = google.calendar({ version: "v3", auth });
  return client;
}

export interface EventoRecordatorio {
  id: string;
  htmlLink?: string;
}

/**
 * Crea un evento en el calendario primario de Wobi como recordatorio visible
 * de una acción programada. Nunca lanza — si Calendar no está disponible o
 * el scope no está autorizado, devuelve null y quien llama sigue sin el
 * evento (la acción en sí ya quedó guardada en Sheets antes de llamar esto).
 */
export async function crearEventoRecordatorio(params: {
  resumen: string;
  descripcion: string;
  fechaHoraInicioISO: string;
  duracionMinutos?: number;
  invitados?: string[];
}): Promise<EventoRecordatorio | null> {
  try {
    const calendar = getClient();
    const inicio = new Date(params.fechaHoraInicioISO);
    const fin = new Date(inicio.getTime() + (params.duracionMinutos ?? 15) * 60_000);

    const resp = await calendar.events.insert({
      calendarId: "primary",
      sendUpdates: "all",
      requestBody: {
        summary: params.resumen,
        description: params.descripcion,
        start: { dateTime: inicio.toISOString() },
        end: { dateTime: fin.toISOString() },
        attendees: params.invitados?.map((email) => ({ email })),
        reminders: {
          useDefault: false,
          overrides: [
            { method: "popup", minutes: 30 },
            { method: "email", minutes: 60 },
          ],
        },
      },
    });

    if (!resp.data.id) return null;
    return { id: resp.data.id, htmlLink: resp.data.htmlLink ?? undefined };
  } catch (error) {
    console.error("[calendarClient] No se pudo crear el evento de recordatorio (no crítico):", error);
    return null;
  }
}

/** Borra el evento de recordatorio (al completar o cancelar la acción programada). Nunca lanza. */
export async function eliminarEventoRecordatorio(eventId: string): Promise<void> {
  try {
    const calendar = getClient();
    await calendar.events.delete({ calendarId: "primary", eventId, sendUpdates: "all" });
  } catch (error) {
    console.error("[calendarClient] No se pudo borrar el evento de recordatorio (no crítico):", error);
  }
}

/** Prueba mínima de acceso — para el panel de conexiones y para diagnosticar el 401 de Domain-Wide Delegation. */
export async function verificarConexionCalendar(): Promise<{ ok: boolean; detalle?: string }> {
  try {
    const calendar = getClient();
    await calendar.calendarList.list({ maxResults: 1 });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detalle: message };
  }
}
