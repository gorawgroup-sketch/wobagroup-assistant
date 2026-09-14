import { getSheetsClient } from "../google/sheetsClient";
import type { Empresa } from "../holded/client";
import { enteroAcotado } from "../utils/asyncTimeout";
import { CacheLectura } from "../utils/readCache";

export const ENCABEZADOS_PUENTE_VACACIONES = [
  "empresa",
  "nombre",
  "ano",
  "dias_asignados",
  "dias_solicitados_pendientes",
  "dias_aprobados",
  "dias_usados",
  "dias_restantes",
  "actualizado_en",
] as const;

const MAX_FILAS = 500;
const CACHE_TTL_MS = enteroAcotado(process.env.WOBI_RRHH_CACHE_TTL_MS, 30_000, 0, 300_000);
const cacheTabla = new CacheLectura<unknown[][]>("rrhh_vacaciones", CACHE_TTL_MS);

export type EstadoRegistroVacaciones =
  | "vigente"
  | "vencido"
  | "incompleto"
  | "no_encontrado"
  | "conflicto";

export interface RegistroVacacionesSeguro {
  empresa: Empresa;
  nombre: string;
  ano: number;
  estado: EstadoRegistroVacaciones;
  diasAsignados?: number;
  diasSolicitadosPendientes?: number;
  diasAprobados?: number;
  diasUsados?: number;
  diasRestantes?: number;
  actualizadoEn?: string;
  detalle?: string;
}

export interface ResultadoPuenteVacaciones {
  estado: "ok" | "no_configurado" | "error";
  registros: RegistroVacacionesSeguro[];
  detalle?: string;
}

function validarEncabezados(headers: readonly string[]): string | undefined {
  const esperados = [...ENCABEZADOS_PUENTE_VACACIONES];
  const ordenCorrecto = esperados.every((header, index) => headers[index] === header);
  const extras = headers.slice(esperados.length).some(Boolean);
  if (!ordenCorrecto || extras) {
    return "La hoja no conserva exactamente las columnas autorizadas y en el orden esperado. " +
      "El puente RRHH queda bloqueado por seguridad.";
  }
  return undefined;
}

function normalizar(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function texto(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function numeroNoNegativo(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  const raw = texto(value, 32);
  if (!raw) return undefined;
  const normalizado = /^\d+(?:,\d+)?$/.test(raw) ? raw.replace(",", ".") : raw;
  const parsed = Number(normalizado);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function empresaValida(value: unknown): Empresa | undefined {
  const raw = texto(value);
  return raw === "WOBA" || raw === "EWORKS" || raw === "Footprint" ? raw : undefined;
}

function extraerFila(
  fila: unknown[],
  indices: Map<string, number>,
  ahoraMs: number,
  maxAgeMs: number
): RegistroVacacionesSeguro | undefined {
  const valor = (nombre: string) => fila[indices.get(nombre) ?? -1];
  const empresa = empresaValida(valor("empresa"));
  const nombre = texto(valor("nombre"));
  const ano = numeroNoNegativo(valor("ano"));
  if (!empresa || !nombre || ano === undefined || !Number.isInteger(ano)) return undefined;

  const base = { empresa, nombre, ano };
  const diasAsignados = numeroNoNegativo(valor("dias_asignados"));
  const diasSolicitadosPendientes = numeroNoNegativo(valor("dias_solicitados_pendientes"));
  const diasAprobados = numeroNoNegativo(valor("dias_aprobados"));
  const diasUsados = numeroNoNegativo(valor("dias_usados"));
  const diasRestantes = numeroNoNegativo(valor("dias_restantes"));
  const actualizadoRaw = texto(valor("actualizado_en"), 64);
  const actualizadoMs = Date.parse(actualizadoRaw);

  if (
    diasAsignados === undefined ||
    diasSolicitadosPendientes === undefined ||
    diasAprobados === undefined ||
    diasUsados === undefined ||
    diasRestantes === undefined ||
    !Number.isFinite(actualizadoMs) ||
    actualizadoMs > ahoraMs + 5 * 60_000
  ) {
    return {
      ...base,
      estado: "incompleto",
      detalle: "El registro no tiene todos los saldos numéricos o una fecha de actualización válida.",
    };
  }

  const datos = {
    ...base,
    diasAsignados,
    diasSolicitadosPendientes,
    diasAprobados,
    diasUsados,
    diasRestantes,
    actualizadoEn: new Date(actualizadoMs).toISOString(),
  };

  if (ahoraMs - actualizadoMs > maxAgeMs) {
    return {
      ...datos,
      estado: "vencido",
      detalle: "La copia de Holded superó la antigüedad permitida; no debe usarse para responder una cifra.",
    };
  }

  return { ...datos, estado: "vigente" };
}

/**
 * Interpreta únicamente la tabla mínima acordada. Una columna adicional hace
 * fallar todo el puente: así una futura exportación con salario, NIF, email o
 * cualquier otro dato de RRHH nunca entra accidentalmente al modelo.
 */
export function interpretarTablaVacaciones(
  valores: readonly (readonly unknown[])[],
  opciones: { ahora?: Date; maxAgeHours?: number } = {}
): { estado: "ok" | "error"; registros: RegistroVacacionesSeguro[]; detalle?: string } {
  if (valores.length === 0) return { estado: "error", registros: [], detalle: "La hoja no tiene encabezados." };
  if (valores.length > MAX_FILAS + 1) {
    return { estado: "error", registros: [], detalle: `La hoja supera el límite de ${MAX_FILAS} registros.` };
  }

  const headers = valores[0].map((value) => normalizar(texto(value)));
  const errorEncabezados = validarEncabezados(headers);
  if (errorEncabezados) {
    return {
      estado: "error",
      registros: [],
      detalle: errorEncabezados,
    };
  }

  const indices = new Map(ENCABEZADOS_PUENTE_VACACIONES.map((header, index) => [header, index]));

  const ahoraMs = (opciones.ahora ?? new Date()).getTime();
  const maxAgeHours = opciones.maxAgeHours ?? enteroAcotado(
    process.env.WOBI_RRHH_MAX_AGE_HOURS,
    24,
    1,
    168
  );
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const registros = valores
    .slice(1)
    .map((fila) => extraerFila([...fila], indices, ahoraMs, maxAgeMs))
    .filter((fila): fila is RegistroVacacionesSeguro => fila !== undefined);
  return { estado: "ok", registros };
}

async function cargarTabla(): Promise<unknown[][]> {
  const spreadsheetId = process.env.HOLDED_RRHH_VACACIONES_SHEET_ID?.trim();
  if (!spreadsheetId) throw new Error("PUENTE_NO_CONFIGURADO");
  const sheets = getSheetsClient();
  // Primero se lee SOLO la cabecera hasta Z. Si alguien añadió una columna
  // sensible, se bloquea antes de descargar una sola celda de esa columna.
  const cabeceraResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Vacaciones!A1:Z1",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const cabecera = ((cabeceraResponse.data.values ?? [])[0] ?? []) as unknown[];
  const headers = cabecera.map((value) => normalizar(texto(value)));
  const errorEncabezados = validarEncabezados(headers);
  if (errorEncabezados) throw new Error("ESQUEMA_RRHH_NO_AUTORIZADO");

  // La lectura de datos termina físicamente en I: aunque otra persona haya
  // agregado información fuera del esquema, Wobi nunca la descarga.
  const datosResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Vacaciones!A2:I501",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  return [cabecera.slice(0, ENCABEZADOS_PUENTE_VACACIONES.length), ...((datosResponse.data.values ?? []) as unknown[][])];
}

export function invalidarCacheVacaciones(): void {
  cacheTabla.invalidar();
}

export async function consultarPuenteVacaciones(
  empresa: Empresa,
  nombres: readonly string[],
  ano = new Date().getFullYear()
): Promise<ResultadoPuenteVacaciones> {
  if (!process.env.HOLDED_RRHH_VACACIONES_SHEET_ID?.trim()) {
    return {
      estado: "no_configurado",
      registros: [],
      detalle: "El puente restringido de vacaciones todavía no está configurado.",
    };
  }

  try {
    const tabla = (await cacheTabla.obtener(cargarTabla)).datos;
    const interpretada = interpretarTablaVacaciones(tabla);
    if (interpretada.estado === "error") return interpretada;

    const registros: RegistroVacacionesSeguro[] = [];
    for (const nombreSolicitado of nombres) {
      const coincidencias = interpretada.registros.filter(
        (fila) => fila.empresa === empresa && fila.ano === ano && normalizar(fila.nombre) === normalizar(nombreSolicitado)
      );
      if (coincidencias.length === 0) {
        registros.push({
          empresa,
          nombre: nombreSolicitado,
          ano,
          estado: "no_encontrado",
          detalle: "No hay una copia autorizada de vacaciones para esta persona y periodo.",
        });
      } else if (coincidencias.length > 1) {
        registros.push({
          empresa,
          nombre: nombreSolicitado,
          ano,
          estado: "conflicto",
          detalle: "Hay registros duplicados para esta persona y periodo. No se puede elegir uno por intuición.",
        });
      } else {
        registros.push(coincidencias[0]);
      }
    }
    return { estado: "ok", registros };
  } catch {
    return {
      estado: "error",
      registros: [],
      detalle: "No se pudo leer el puente restringido de RRHH. No debe responderse ninguna cifra.",
    };
  }
}
