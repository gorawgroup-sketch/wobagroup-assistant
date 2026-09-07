/**
 * Filtro de "esto sí se puede auto-arreglar" para la autorrevisión nocturna
 * de código (ver core/jobs/autorrevisionCodigo.ts). Diseño confirmado
 * explícitamente por Carlos tras el incidente real de marcar un correo
 * ajeno como leído durante una prueba en vivo: cualquier cosa que toque
 * dinero, seguridad/acceso, o comunicación externa NUNCA se propone como
 * arreglo automático — siempre se escala a revisión manual.
 *
 * LISTA BLANCA, no lista negra — a propósito, tras un hallazgo real de
 * auditoría: una primera versión de este archivo intentaba enumerar
 * palabras clave PELIGROSAS (holded, correo, cerebro, etc.) y aun así se le
 * escaparon varios archivos reales de dinero/seguridad/comunicación
 * (core/telegram/client.ts — el propio canal de envío; adminNotify.ts —
 * quién obtiene acceso; callbackHandler.ts — el único punto que dispara
 * escritura en cashflow; gestionarContactoAutorespuesta.ts — la lista de
 * contactos con respuesta automática; core/reportes/* — reportes
 * contables; e incluso los propios archivos de este sistema de
 * autorrepación). Con una lista NEGRA, un archivo nuevo que nadie
 * clasificó todavía queda "seguro" por defecto — exactamente al revés de
 * lo que Carlos pidió ("nunca... sin importar cuán segura parezca,
 * siempre se escala"). Con esta lista BLANCA, un archivo nuevo o no
 * vetado queda EXCLUIDO por defecto — el único riesgo de un error de
 * clasificación es cubrir de menos, nunca de más.
 *
 * Deliberadamente angosta para empezar: solo core/utils/ (verificado sin
 * ninguna importación de Sheets/Gmail/Holded/Telegram/GitHub/Anthropic —
 * son solo funciones puras de formato/cálculo). Ampliar esta lista más
 * adelante requiere vetar a mano cada carpeta/archivo nuevo (confirmar que
 * no toca dinero, acceso, ni el envío de nada hacia afuera) antes de
 * agregarlo acá — nunca a partir de una palabra clave.
 */
const PREFIJOS_SEGUROS = ["core/utils/"];

export function esRutaSegura(ruta: string): boolean {
  return PREFIJOS_SEGUROS.some((prefijo) => ruta.startsWith(prefijo));
}
