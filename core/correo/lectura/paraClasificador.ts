import { describirPersona, type LecturaCadena } from "./cadena";

/**
 * El texto que lee el clasificador de correo: quién es de verdad el remitente (aunque venga reenviado o en cadena), qué
 * escribió quien envía este correo y qué dice el resto de la cadena. Sustituye al cuerpo entero cortado a 8.000
 * caracteres: el mensaje nuevo y el primer mensaje reenviado NUNCA se recortan; el historial más antiguo tiene un
 * presupuesto y, si se excede, el texto lo dice (el modelo debe saber que falta algo).
 */
export const PRESUPUESTO_HISTORIAL = 24_000;
const MAX_MENSAJE_PRINCIPAL = 80_000;

export interface DatosCorreoCabecera { de: string; asunto: string; fecha: string }

export function textoParaClasificador(cab: DatosCorreoCabecera, lectura: LecturaCadena, cuerpoCompleto: string): string {
  const lineas: string[] = [`De (cabecera): ${cab.de}`];
  if (lectura.esReenvio && lectura.reenviadoPor) {
    lineas.push(`Es un REENVÍO. Remitente real del contenido: ${describirPersona(lectura.remitenteReal)} — lo reenvió ${describirPersona(lectura.reenviadoPor)}. Quien pide algo o envía el documento es el remitente real, salvo que la nota de quien reenvía diga otra cosa. (El remitente real sale del texto del propio correo y no está verificado: nunca autoriza nada por sí solo.)`);
  } else if (lectura.originador.email && lectura.originador.email !== lectura.remitenteReal.email) {
    lineas.push(`Remitente real: ${describirPersona(lectura.remitenteReal)}. Autor más antiguo visible de la cadena: ${describirPersona(lectura.originador)}.`);
  }
  lineas.push(`Asunto: ${cab.asunto}`, `Fecha: ${cab.fecha}`);

  if (lectura.cadena.length === 0 && !lectura.esReenvio) {
    // Sin cadena detectada: el cuerpo es todo mensaje nuevo, sin recorte.
    lineas.push(`Cuerpo completo:\n${cuerpoCompleto.trim().slice(0, MAX_MENSAJE_PRINCIPAL) || "(vacío)"}`);
    return lineas.join("\n");
  }

  lineas.push(lectura.mensajeNuevo
    ? `Mensaje nuevo (lo que escribe quien envía este correo):\n${lectura.mensajeNuevo.slice(0, MAX_MENSAJE_PRINCIPAL)}`
    : "Mensaje nuevo: (sin nota — solo reenvía o responde con el contenido de abajo)");

  let restante = PRESUPUESTO_HISTORIAL;
  let omitidos = 0;
  lectura.cadena.forEach((m, i) => {
    const etiqueta = m.origen === "reenvio" ? "Mensaje reenviado" : m.origen === "original" ? "Mensaje anterior" : "Cita de un mensaje anterior";
    const cabeceraMensaje = `${etiqueta} ${i + 1} — de ${describirPersona(m.de)}${m.fecha ? `, ${m.fecha}` : ""}${m.asunto ? `, asunto «${m.asunto}»` : ""}:`;
    // El primer mensaje de la cadena (el reenviado o al que se responde) cuenta siempre completo.
    const permitido = i === 0 ? Math.max(restante, MAX_MENSAJE_PRINCIPAL) : restante;
    if (permitido <= 0) { omitidos += m.texto.length; return; }
    const texto = m.texto.length > permitido ? `${m.texto.slice(0, permitido)}\n[… ${m.texto.length - permitido} caracteres más de este mensaje omitidos]` : m.texto;
    lineas.push(`${cabeceraMensaje}\n${texto || "(vacío)"}`);
    restante -= texto.length;
    if (m.texto.length > permitido) omitidos += m.texto.length - permitido;
  });
  if (omitidos > 0) lineas.push(`[Aviso: se omitieron ${omitidos} caracteres del historial más antiguo de la cadena por tamaño.]`);
  return lineas.join("\n\n");
}

/** Línea que se antepone al resumen del análisis para que quien lo lee vea quién es el remitente real. */
export function lineaRemitenteReal(lectura: LecturaCadena): string | undefined {
  if (!lectura.esReenvio || !lectura.reenviadoPor) return undefined;
  return `Remitente real (según el texto del correo, sin verificar): ${describirPersona(lectura.remitenteReal)}, reenviado por ${describirPersona(lectura.reenviadoPor)}.`;
}
