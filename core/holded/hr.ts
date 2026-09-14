import { holdedGet, type Empresa } from "./client";

const MAX_PERSONAS_POR_CONSULTA = 5;
const MAX_NOMBRE = 160;

interface EmpleadoHoldedRaw {
  id?: unknown;
  full_name?: unknown;
  name?: unknown;
  last_name?: unknown;
  time_off_policy_id?: unknown;
  [key: string]: unknown;
}

interface ContratoHoldedRaw {
  vacationDays?: unknown;
  [key: string]: unknown;
}

export type EstadoVacacionesEmpleado =
  | "encontrado"
  | "ambiguo"
  | "no_encontrado"
  | "no_disponible";

export interface VacacionesEmpleadoSeguro {
  consulta: string;
  estado: EstadoVacacionesEmpleado;
  nombre?: string;
  candidatos?: string[];
  politicaAusenciasConfigurada?: boolean;
  diasAnualesContrato?: number | null;
  detalle?: string;
}

export interface ConsultaVacacionesHoldedSegura {
  empresa: Empresa;
  resultados: VacacionesEmpleadoSeguro[];
  /** Limitación conocida de la API pública; impide inventar el saldo restante. */
  saldoExactoDisponible: false;
}

function textoSeguro(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_NOMBRE) : "";
}

function nombreEmpleado(empleado: EmpleadoHoldedRaw): string {
  const completo = textoSeguro(empleado.full_name);
  if (completo) return completo;
  return [textoSeguro(empleado.name), textoSeguro(empleado.last_name)].filter(Boolean).join(" ");
}

function normalizarNombre(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/\s+/g, " ")
    .trim();
}

function extraerEmpleados(data: unknown): EmpleadoHoldedRaw[] {
  if (Array.isArray(data)) return data.filter((item): item is EmpleadoHoldedRaw => !!item && typeof item === "object");
  if (!data || typeof data !== "object") return [];
  const envoltorio = data as { items?: unknown; data?: unknown };
  const lista = Array.isArray(envoltorio.items)
    ? envoltorio.items
    : Array.isArray(envoltorio.data)
      ? envoltorio.data
      : [];
  return lista.filter((item): item is EmpleadoHoldedRaw => !!item && typeof item === "object");
}

function seleccionarCoincidencia(
  consulta: string,
  empleados: EmpleadoHoldedRaw[]
): { empleado?: EmpleadoHoldedRaw; candidatos?: string[] } {
  const validos = empleados.filter((empleado) => textoSeguro(empleado.id) && nombreEmpleado(empleado));
  if (validos.length === 0) return {};

  const buscado = normalizarNombre(consulta);
  const exactos = validos.filter((empleado) => normalizarNombre(nombreEmpleado(empleado)) === buscado);
  if (exactos.length === 1) return { empleado: exactos[0] };

  const posibles = exactos.length > 1 ? exactos : validos;
  if (posibles.length === 1) return { empleado: posibles[0] };

  return {
    candidatos: Array.from(new Set(posibles.map(nombreEmpleado))).sort((a, b) => a.localeCompare(b, "es")),
  };
}

async function consultarPersona(empresa: Empresa, consulta: string): Promise<VacacionesEmpleadoSeguro> {
  try {
    // Búsqueda en servidor: no descarga el directorio completo ni filtra solo
    // la primera página. La coincidencia final sigue siendo estricta para no
    // elegir por error a un homónimo (caso real: hay dos "Carlos").
    const encontrados = extraerEmpleados(
      await holdedGet(empresa, "/employees", { search: consulta, limit: "200" })
    );
    const seleccion = seleccionarCoincidencia(consulta, encontrados);

    if (seleccion.candidatos) {
      return {
        consulta,
        estado: "ambiguo",
        candidatos: seleccion.candidatos,
        detalle:
          "Hay más de una persona posible. Wobi debe preguntar directamente a quien hizo la solicitud " +
          "por el nombre completo; nunca debe adivinar ni trasladar esa aclaración a otra persona.",
      };
    }

    const empleado = seleccion.empleado;
    if (!empleado) {
      return { consulta, estado: "no_encontrado", detalle: "No encontré una coincidencia activa en Holded." };
    }

    const id = textoSeguro(empleado.id);
    let perfil: EmpleadoHoldedRaw = empleado;
    try {
      perfil = await holdedGet<EmpleadoHoldedRaw>(empresa, `/employees/${encodeURIComponent(id)}`);
    } catch {
      // El resultado de búsqueda basta para identificar a la persona. No se
      // propaga el error ni el cuerpo de Holded porque podría contener PII.
    }

    let diasAnualesContrato: number | null = null;
    try {
      const contrato = await holdedGet<ContratoHoldedRaw>(
        empresa,
        `/employees/${encodeURIComponent(id)}/contract`
      );
      if (typeof contrato.vacationDays === "number" && Number.isFinite(contrato.vacationDays)) {
        diasAnualesContrato = contrato.vacationDays;
      }
    } catch {
      // Un contrato ausente no invalida la identificación del empleado. La
      // salida debe declarar el dato como no disponible, nunca inferirlo.
    }

    return {
      consulta,
      estado: "encontrado",
      nombre: nombreEmpleado(perfil) || nombreEmpleado(empleado),
      politicaAusenciasConfigurada: Boolean(textoSeguro(perfil.time_off_policy_id)),
      diasAnualesContrato,
      detalle:
        "La API pública de Holded identifica el perfil y, cuando existe, la asignación anual del contrato; " +
        "no expone solicitudes, aprobaciones, días usados ni saldo restante.",
    };
  } catch {
    return {
      consulta,
      estado: "no_disponible",
      detalle:
        "No pude consultar RRHH con la credencial de esta empresa. Hay que revisar el permiso team:employees.read.",
    };
  }
}

/**
 * Consulta RRHH de mínima exposición. Deliberadamente NO devuelve el objeto
 * original del empleado/contrato: podría incluir salario, documento, cuenta
 * bancaria, dirección, fecha de nacimiento u otros datos personales.
 */
export async function consultarVacacionesHoldedSeguras(
  empresa: Empresa,
  personas: readonly string[]
): Promise<ConsultaVacacionesHoldedSegura> {
  const unicas = Array.from(
    new Set(personas.map((p) => p.trim().slice(0, MAX_NOMBRE)).filter(Boolean))
  ).slice(0, MAX_PERSONAS_POR_CONSULTA);

  const resultados = await Promise.all(unicas.map((persona) => consultarPersona(empresa, persona)));
  return { empresa, resultados, saldoExactoDisponible: false };
}
