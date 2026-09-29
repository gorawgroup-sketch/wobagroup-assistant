/**
 * ¿La respuesta del chat es una copia de un mensaje automático del sistema?
 *
 * Caso real (Carlos, 2026-09-28 20:13): recibió «🔄 Revisando el siguiente correo...» con la propuesta
 * completa de un ticket de Board Riders dentro, SIN botones y sin que existiera ninguna propuesta
 * registrada. No lo envió el flujo de gastos: los avisos automáticos se guardan en el historial como
 * turnos del asistente (ver registrarMensajeSaliente), y el modelo respondió a un texto de Carlos
 * copiando literalmente sus dos últimos «mensajes». La prueba está en el propio mensaje: contenía la
 * línea de título recortado con «…» que solo existe en el historial, nunca en Telegram.
 *
 * Una propuesta solo es real si la emite el flujo que la registra y le pone botones. Un texto del
 * modelo con esa forma es una imitación: parece una decisión pendiente y no se puede pulsar nada.
 */
export const MARCA_MENSAJE_SISTEMA =
  "[Aviso automático del sistema, ya mostrado al usuario con sus botones. No lo repitas ni lo reescribas: si el usuario pide esa acción, usa la herramienta correspondiente.]";

export function quitarMarcaSistema(texto: string): string {
  return texto.startsWith(MARCA_MENSAJE_SISTEMA) ? texto.slice(MARCA_MENSAJE_SISTEMA.length).trimStart() : texto;
}

const FIRMAS_DE_PROGRESO = [
  /^🔄\s*Revisando el siguiente correo/u,
  /^🔄\s*Revisando correo nuevo/u,
  /^🔄\s*Aplicando (tu selección|")/u,
];
const normalizar = (s: string) => s.replace(/\s+/g, " ").trim();

export interface Imitacion { imita: boolean; motivo?: "progreso" | "propuesta_de_gasto" | "propuesta_de_edicion" | "copia_literal" }

export function respuestaImitaMensajeSistema(respuesta: string, mensajesSistemaRecientes: string[] = []): Imitacion {
  const texto = respuesta.trim();
  if (!texto) return { imita: false };
  if (FIRMAS_DE_PROGRESO.some((r) => r.test(texto))) return { imita: true, motivo: "progreso" };
  // La plantilla completa, no una mención suelta: explicar «la propuesta decía…» sigue siendo legítimo.
  if (/Propuesta para crear un gasto nuevo:/.test(texto) && /^Empresa:/m.test(texto) && /^Importe:/m.test(texto)) {
    return { imita: true, motivo: "propuesta_de_gasto" };
  }
  if (/Propuesta de edición en Holded/.test(texto) && /^Cambiar:/m.test(texto)) return { imita: true, motivo: "propuesta_de_edicion" };
  const plano = normalizar(texto);
  for (const mensaje of mensajesSistemaRecientes) {
    const original = normalizar(quitarMarcaSistema(mensaje));
    if (original.length < 160) continue;
    // Basta un tramo largo idéntico: el modelo suele copiar el cuerpo y cambiar el encabezado.
    for (let i = 0; i + 160 <= original.length; i += 80) {
      if (plano.includes(original.slice(i, i + 160))) return { imita: true, motivo: "copia_literal" };
    }
  }
  return { imita: false };
}
