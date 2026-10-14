import { gastoDescartadoPorOperador } from "../gastos/gastoDescartadoPorOperadorStore";
import { buscarGastoDesdeCorreo } from "../gastos/gastoPorCorreoStore";
import { yaSeArchivoDesdeCorreo } from "../documental/documentoArchivadoPorCorreoStore";
import { listarMensajesDeHilo, obtenerResumenCorreo, type CorreoResumen } from "./client";

/**
 * La cola trabaja con el ÚLTIMO mensaje del hilo. Cuando ese último mensaje no trae adjuntos («Recibido. Muchas gracias»)
 * pero un mensaje anterior del mismo hilo trae un comprobante aún sin procesar, el correo a procesar es ESE mensaje: leer
 * el correo completo incluye sus adjuntos aunque no vengan en la última respuesta. Caso real (Carlos, 14-10-2026): hilo
 * «FACTURA PENDIENTE» de RODOAR, factura en el mensaje de las 11:57, acuse de recibo a las 17:49; la cola clasificaba el
 * acuse y nunca veía la factura. Solo lecturas; un fallo deja el comportamiento de siempre (el último mensaje).
 */
export interface CandidatoMensajeHilo { resumen: CorreoResumen; adjuntosPendientes: number }

/** Pura: el candidato más reciente con adjuntos pendientes; undefined si el último ya trae adjuntos o no hay pendientes. */
export function elegirMensajeConAdjuntosPendientes(ultimo: CorreoResumen, anteriores: CandidatoMensajeHilo[]): CorreoResumen | undefined {
  if (ultimo.adjuntos.length > 0) return undefined;
  const conPendientes = anteriores.filter((c) => c.adjuntosPendientes > 0 && c.resumen.id !== ultimo.id);
  if (!conPendientes.length) return undefined;
  conPendientes.sort((a, b) => Date.parse(b.resumen.fecha) - Date.parse(a.resumen.fecha));
  return conPendientes[0].resumen;
}

async function adjuntoPendiente(mensajeId: string, partId: string | undefined): Promise<boolean> {
  const [gasto, descartado, archivado] = await Promise.all([
    buscarGastoDesdeCorreo(mensajeId, partId),
    gastoDescartadoPorOperador(mensajeId, partId),
    yaSeArchivoDesdeCorreo(mensajeId, partId ?? ""),
  ]);
  return !gasto && !descartado && !archivado;
}

export async function mensajeDelHiloConAdjuntosPendientes(
  ultimo: CorreoResumen,
  deps: {
    listar: (threadId: string) => Promise<Array<{ id: string }>>;
    resumen: (id: string) => Promise<CorreoResumen>;
    pendiente: (mensajeId: string, partId: string | undefined) => Promise<boolean>;
  } = { listar: listarMensajesDeHilo, resumen: obtenerResumenCorreo, pendiente: adjuntoPendiente }
): Promise<CorreoResumen | undefined> {
  if (ultimo.adjuntos.length > 0) return undefined;
  const mensajes = (await deps.listar(ultimo.threadId)).filter((m) => m.id && m.id !== ultimo.id);
  if (!mensajes.length) return undefined;
  const candidatos: CandidatoMensajeHilo[] = [];
  for (const m of mensajes) {
    const resumen = await deps.resumen(m.id);
    if (!resumen.adjuntos.length) continue;
    let pendientes = 0;
    for (const a of resumen.adjuntos) if (await deps.pendiente(resumen.id, a.partId)) pendientes++;
    candidatos.push({ resumen, adjuntosPendientes: pendientes });
  }
  return elegirMensajeConAdjuntosPendientes(ultimo, candidatos);
}
