import { agregarFila, actualizarFila, leerFilas } from "../google/sheetsKeyValueStore";

export type EstadoAuditoriaProgramada = "iniciada" | "estable" | "atencion" | "fallo";

export interface DetalleAuditoriaProgramada {
  nombre: string;
  estado: "ok" | "atencion" | "fallo" | "omitido";
  detalle?: string;
}

export interface EjecucionAuditoriaProgramada {
  ejecucionId: string;
  inicioEn: string;
  finEn?: string;
  estado: EstadoAuditoriaProgramada;
  resumen: string;
  detalles: DetalleAuditoriaProgramada[];
  rama?: string;
  commit?: string;
  actualizadoEn: string;
}

const TAB_NAME = "_auditoria_programada";
const HEADERS = [
  "ejecucionId",
  "inicioEn",
  "finEn",
  "estado",
  "resumen",
  "detallesJSON",
  "rama",
  "commit",
  "actualizadoEn",
];
const NUM_COLS = HEADERS.length;
const MAX_HISTORIAL = 20;

const ESTADOS = new Set<EstadoAuditoriaProgramada>(["iniciada", "estable", "atencion", "fallo"]);
const ESTADOS_DETALLE = new Set<DetalleAuditoriaProgramada["estado"]>(["ok", "atencion", "fallo", "omitido"]);

function textoAcotado(valor: unknown, maximo: number): string {
  return typeof valor === "string" ? valor.trim().slice(0, maximo) : "";
}

function fechaISO(valor: unknown): string | undefined {
  if (typeof valor !== "string" || !valor.trim()) return undefined;
  const fecha = new Date(valor);
  return Number.isFinite(fecha.getTime()) ? fecha.toISOString() : undefined;
}

export function normalizarDetallesAuditoria(valor: unknown): DetalleAuditoriaProgramada[] {
  if (!Array.isArray(valor)) return [];
  return valor.slice(0, 30).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const crudo = item as Record<string, unknown>;
    const nombre = textoAcotado(crudo.nombre, 120);
    const estado = crudo.estado;
    if (!nombre || typeof estado !== "string" || !ESTADOS_DETALLE.has(estado as DetalleAuditoriaProgramada["estado"])) {
      return [];
    }
    const detalle = textoAcotado(crudo.detalle, 600);
    return [{ nombre, estado: estado as DetalleAuditoriaProgramada["estado"], ...(detalle ? { detalle } : {}) }];
  });
}

function parsearDetallesJSON(valor: string): DetalleAuditoriaProgramada[] {
  if (!valor) return [];
  try {
    return normalizarDetallesAuditoria(JSON.parse(valor));
  } catch {
    return [];
  }
}

function filaAObjeto(valores: string[]): EjecucionAuditoriaProgramada | undefined {
  const ejecucionId = textoAcotado(valores[0], 120);
  const inicioEn = fechaISO(valores[1]);
  const estado = valores[3] as EstadoAuditoriaProgramada;
  const actualizadoEn = fechaISO(valores[8]);
  if (!ejecucionId || !inicioEn || !ESTADOS.has(estado) || !actualizadoEn) return undefined;

  return {
    ejecucionId,
    inicioEn,
    ...(fechaISO(valores[2]) ? { finEn: fechaISO(valores[2]) } : {}),
    estado,
    resumen: textoAcotado(valores[4], 2_000),
    detalles: parsearDetallesJSON(valores[5]),
    ...(textoAcotado(valores[6], 200) ? { rama: textoAcotado(valores[6], 200) } : {}),
    ...(textoAcotado(valores[7], 64) ? { commit: textoAcotado(valores[7], 64) } : {}),
    actualizadoEn,
  };
}

function objetoAFila(registro: EjecucionAuditoriaProgramada): (string | number)[] {
  return [
    registro.ejecucionId,
    registro.inicioEn,
    registro.finEn ?? "",
    registro.estado,
    registro.resumen,
    JSON.stringify(registro.detalles),
    registro.rama ?? "",
    registro.commit ?? "",
    registro.actualizadoEn,
  ];
}

export interface EntradaAuditoriaProgramada {
  ejecucionId: string;
  estado: EstadoAuditoriaProgramada;
  inicioEn?: string;
  finEn?: string;
  resumen?: string;
  detalles?: unknown;
  rama?: string;
  commit?: string;
}

/**
 * Inserta o actualiza UNA ejecución. El mismo id se usa al comenzar y al terminar,
 * de modo que el front puede mostrar "en curso" sin duplicar filas en el historial.
 */
export async function registrarEjecucionAuditoriaProgramada(
  entrada: EntradaAuditoriaProgramada
): Promise<EjecucionAuditoriaProgramada> {
  const ejecucionId = textoAcotado(entrada.ejecucionId, 120);
  if (!ejecucionId || !/^[a-zA-Z0-9._:-]+$/.test(ejecucionId)) {
    throw new Error("ejecucionId inválido.");
  }
  if (!ESTADOS.has(entrada.estado)) throw new Error("Estado de auditoría inválido.");

  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  const existente = filas.find((fila) => fila.valores[0] === ejecucionId);
  const previo = existente ? filaAObjeto(existente.valores) : undefined;
  const ahora = new Date().toISOString();
  const inicioEn = fechaISO(entrada.inicioEn) ?? previo?.inicioEn ?? ahora;
  const finSolicitado = fechaISO(entrada.finEn);
  const finEn = entrada.estado === "iniciada" ? undefined : finSolicitado ?? ahora;

  const registro: EjecucionAuditoriaProgramada = {
    ejecucionId,
    inicioEn,
    ...(finEn ? { finEn } : {}),
    estado: entrada.estado,
    resumen: textoAcotado(entrada.resumen, 2_000) || previo?.resumen || (entrada.estado === "iniciada" ? "Auditoría iniciada." : "Sin resumen."),
    detalles: entrada.detalles === undefined ? previo?.detalles ?? [] : normalizarDetallesAuditoria(entrada.detalles),
    ...(textoAcotado(entrada.rama, 200) || previo?.rama ? { rama: textoAcotado(entrada.rama, 200) || previo?.rama } : {}),
    ...(textoAcotado(entrada.commit, 64) || previo?.commit ? { commit: textoAcotado(entrada.commit, 64) || previo?.commit } : {}),
    actualizadoEn: ahora,
  };

  if (existente) {
    await actualizarFila(TAB_NAME, existente.rowIndex, NUM_COLS, objetoAFila(registro));
  } else {
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(registro));
  }
  return registro;
}

export async function obtenerHistorialAuditoriaProgramada(): Promise<EjecucionAuditoriaProgramada[]> {
  const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
  return filas
    .map((fila) => filaAObjeto(fila.valores))
    .filter((registro): registro is EjecucionAuditoriaProgramada => Boolean(registro))
    .sort((a, b) => b.inicioEn.localeCompare(a.inicioEn))
    .slice(0, MAX_HISTORIAL);
}

export interface EstadoAuditoriaProgramadaFront {
  nombre: string;
  descripcion: string;
  programacion: {
    activa: true;
    frecuencia: string;
    horaLocal: string;
    zonaHoraria: string;
    modo: string;
  };
  ultimaEjecucion: EjecucionAuditoriaProgramada | null;
  historial: EjecucionAuditoriaProgramada[];
}

export async function obtenerEstadoAuditoriaProgramada(): Promise<EstadoAuditoriaProgramadaFront> {
  const historial = await obtenerHistorialAuditoriaProgramada();
  return {
    nombre: "Auditoría técnica diaria de WOBI",
    descripcion:
      "Revisa código, pruebas, rutas de IA, costes, permisos, conexiones y memoria desde una copia limpia. No despliega ni ejecuta escrituras contables.",
    programacion: {
      activa: true,
      frecuencia: "Diaria",
      horaLocal: "09:00",
      zonaHoraria: "Europe/Lisbon",
      modo: "Codex con suscripción de ChatGPT · sin API de IA de pago",
    },
    ultimaEjecucion: historial[0] ?? null,
    historial,
  };
}
