import type { InlineKeyboardButton } from "../telegram/types";
import type { PropuestaGasto } from "./gastoProposalSheet";

/**
 * Pedido explícito de Carlos, tras probar la primera versión (botones que
 * actuaban al toque): "al presionar una [alternativa] ya se elimina la
 * posibilidad de irse por otra... deberás dejar la posibilidad de activar
 * una o varias y luego aprobar". Este teclado convierte cada acción en un
 * check ☐/✅ — tocarlo solo cambia gasto.seleccionAcciones (ver
 * actualizarSeleccionAccionesGasto) y se vuelve a pintar el MISMO mensaje
 * (editTelegramMessageReplyMarkup, nunca dispara la acción); solo
 * "▶️ Aprobar selección" (gasto_aprobar) ejecuta lo marcado, todo junto.
 *
 * Las claves usan "_" (nunca ":") como separador interno (ej. "adjuntar_0")
 * — el callback_data completo es "gasto_toggle:<propuestaId>:<key>" y se
 * parte con un simple data.split(":") en 3 partes; una clave con ":" adentro
 * rompería ese parseo.
 */
export type AccionGastoKey = string;

export interface OpcionesTecladoGasto {
  /** Cuántos candidatos de Holded ya existentes se ofrecen para adjuntar (modo "candidatos"), o undefined en modo "final" (crear nuevo directo). */
  numCandidatos?: number;
  /** Solo aplica en modo "final" (numCandidatos undefined): si ya se encontró un movimiento bancario real sin conciliar, aparece "Crear y conciliar" además de "Crear". */
  hayMovimientoBancario?: boolean;
}

/**
 * Acciones que son una decisión FINAL y mutuamente excluyente entre sí
 * (elegir una desmarca cualquier otra del mismo grupo) — todo lo que NO es
 * un "adjuntar_<i>"/"nuevo"/"crear"/"crearconciliar"/"cancelar" es una
 * acción lateral independiente, se puede combinar libremente con cualquier
 * otra lateral y con como mucho UNA final.
 */
export function esAccionFinal(key: AccionGastoKey): boolean {
  return key === "crear" || key === "crearconciliar" || key === "cancelar" || key === "nuevo" || key.startsWith("adjuntar_");
}

/** true para las que necesitan una respuesta de texto libre antes de poder aplicarse. */
export function necesitaTexto(key: AccionGastoKey): boolean {
  return key === "corregir" || key === "ajustarmonto" || key === "otrasacciones";
}

/** Índice del candidato para una clave "adjuntar_<i>" — undefined si la clave no es de ese tipo. */
export function indiceCandidato(key: AccionGastoKey): number | undefined {
  if (!key.startsWith("adjuntar_")) return undefined;
  const n = Number(key.slice("adjuntar_".length));
  return Number.isFinite(n) ? n : undefined;
}

/** Texto humano de cada acción — usado tanto en los botones como en los mensajes de progreso de "Aprobar selección". */
export function etiquetaAccion(key: AccionGastoKey): string {
  const indice = indiceCandidato(key);
  if (indice !== undefined) return `Es este (#${indice + 1})`;
  switch (key) {
    case "nuevo":
      return "Ninguno, crear nuevo";
    case "crear":
      return "Crear gasto en Holded";
    case "crearconciliar":
      return "Crear y conciliar";
    case "cancelar":
      return "Cancelar";
    case "corregir":
      return "Corregir clasificación";
    case "ajustarmonto":
      return "Ajustar monto";
    case "responder":
      return "Responder correo";
    case "guardarconocimiento":
      return "Guardar como conocimiento";
    case "otrasacciones":
      return "Otras acciones";
    default:
      return key;
  }
}

function icono(key: AccionGastoKey): string {
  if (indiceCandidato(key) !== undefined) return "✅";
  switch (key) {
    case "nuevo":
      return "❌";
    case "crear":
    case "crearconciliar":
      return "✅";
    case "cancelar":
      return "❌";
    case "corregir":
      return "✏️";
    case "ajustarmonto":
      return "💰";
    case "responder":
      return "✉️";
    case "guardarconocimiento":
      return "🧠";
    case "otrasacciones":
      return "✏️";
    default:
      return "";
  }
}

export function construirTecladoGasto(propuesta: PropuestaGasto, opciones: OpcionesTecladoGasto): InlineKeyboardButton[][] {
  const seleccion = new Set(propuesta.seleccionAcciones ?? []);
  const boton = (key: AccionGastoKey, labelOverride?: string): InlineKeyboardButton => {
    const marca = seleccion.has(key) ? "✅" : "☐";
    const etiqueta = labelOverride ?? etiquetaAccion(key);
    return { text: `${marca} ${icono(key)} ${etiqueta}`.replace(/\s+/g, " ").trim(), callback_data: `gasto_toggle:${propuesta.id}:${key}` };
  };

  const filas: InlineKeyboardButton[][] = [];
  const hayCandidatos = opciones.numCandidatos !== undefined && opciones.numCandidatos > 0;

  if (hayCandidatos) {
    for (let i = 0; i < (opciones.numCandidatos as number); i++) filas.push([boton(`adjuntar_${i}`)]);
    filas.push([boton("nuevo")]);
    filas.push([boton("ajustarmonto")]);
  } else {
    filas.push(opciones.hayMovimientoBancario ? [boton("crear", "Crear"), boton("crearconciliar")] : [boton("crear")]);
    filas.push([boton("corregir"), boton("ajustarmonto")]);
    filas.push([boton("cancelar")]);
  }

  if (propuesta.correoOrigen) {
    filas.push([boton("responder"), boton("guardarconocimiento")]);
    filas.push([boton("otrasacciones", "Otras acciones (recordatorio, instrucciones...)")]);
  }

  filas.push([{ text: "▶️ Aprobar selección", callback_data: `gasto_aprobar:${propuesta.id}` }]);

  return filas;
}
