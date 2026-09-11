import {
  buscarFragmentosRelevantes,
  normalizarConocimiento,
  obtenerIndiceDocumentos,
  puntuarTextoConocimiento,
} from "../knowledge/loader";
import { obtenerCorreccionesCrudas } from "../knowledge/correctionsStore";
import { obtenerCapturasCrudas } from "../knowledge/capturaSheet";
import type { ToolDefinition } from "./types";

export type AmbitoConocimiento = "general" | "correo" | "documental" | "contabilidad";

export interface OpcionesConsultaConocimiento {
  ambito?: AmbitoConocimiento;
  maxCaracteres?: number;
}

interface RegistroRelevante {
  fecha: string;
  render: string;
  puntaje: number;
}

const CONSULTA_CONTABLE =
  /\b(contabl|cuenta|factur|gasto|ingreso|iva|impuesto|proveedor|concili|holded|asiento|ticket|recibo|pago|cobro|profesional|servicio)\w*/i;

function limitePorAmbito(ambito: AmbitoConocimiento): number {
  switch (ambito) {
    case "documental":
      return 14_000;
    case "correo":
      return 16_000;
    case "contabilidad":
    case "general":
    default:
      return 24_000;
  }
}

function acotarLimite(valor: number): number {
  return Math.max(8_000, Math.min(40_000, Math.floor(valor)));
}

function tomarDentroDePresupuesto(registros: RegistroRelevante[], maxCaracteres: number): string {
  const ordenados = [...registros].sort(
    (a, b) => b.puntaje - a.puntaje || b.fecha.localeCompare(a.fecha)
  );
  const positivos = ordenados.filter((registro) => registro.puntaje > 0);
  // Si la búsqueda no coincide literalmente, se conservan las dos entradas más recientes como red de
  // seguridad. La memoria completa permanece en Sheets y puede consultarse de nuevo con otra pregunta.
  const candidatos = positivos.length > 0 ? positivos : ordenados.slice(0, 2);
  const seleccionados: string[] = [];
  let usados = 0;

  for (const registro of candidatos) {
    if (usados >= maxCaracteres) break;
    const disponible = maxCaracteres - usados;
    if (disponible < 200) break;
    const render = registro.render.slice(0, disponible);
    seleccionados.push(render);
    usados += render.length + 6;
  }

  return seleccionados.join("\n\n---\n\n");
}

async function cargarCorreccionesRelevantes(consulta: string, maxCaracteres: number): Promise<string> {
  try {
    const filas = await obtenerCorreccionesCrudas();
    return tomarDentroDePresupuesto(
      filas.map((fila) => {
        const fecha = fila.fecha.slice(0, 10);
        const contexto = fila.contextoPrevio ? ` (antes se asumía: ${fila.contextoPrevio})` : "";
        const render = `- [${fecha}] ${fila.correccion}${contexto}`;
        return {
          fecha,
          render,
          puntaje: puntuarTextoConocimiento(`${fila.correccion} ${fila.contextoPrevio}`, consulta),
        };
      }),
      maxCaracteres
    );
  } catch (error) {
    console.error("[knowledgeBase] Error leyendo correcciones:", error);
    return "";
  }
}

async function cargarCapturasRelevantes(consulta: string, maxCaracteres: number): Promise<string> {
  try {
    const filas = await obtenerCapturasCrudas();
    return tomarDentroDePresupuesto(
      filas.map((fila) => {
        const fecha = fila.fecha.slice(0, 10);
        const empresas = fila.empresas || "sin especificar";
        const autor = fila.autor ? ` — ${fila.autor}` : "";
        const render = `### Captura del ${fecha} — Empresa(s): ${empresas}${autor}\n${fila.texto}`;
        return {
          fecha,
          render,
          puntaje: puntuarTextoConocimiento(`${fila.empresas} ${fila.autor} ${fila.texto}`, consulta),
        };
      }),
      maxCaracteres
    );
  } catch (error) {
    console.error("[knowledgeBase] Error leyendo capturas:", error);
    return "";
  }
}

function incluirPGC(consulta: string, ambito: AmbitoConocimiento): boolean {
  if (ambito === "contabilidad") return true;
  if (ambito === "correo" || ambito === "documental") return false;
  return CONSULTA_CONTABLE.test(normalizarConocimiento(consulta));
}

/**
 * Consulta compacta y trazable. No elimina ni resume las fuentes almacenadas: selecciona para cada llamada
 * únicamente correcciones, capturas y fragmentos relevantes, con un presupuesto duro de caracteres.
 */
export async function consultarBaseConocimiento(
  input: Record<string, unknown>,
  opciones: OpcionesConsultaConocimiento = {}
): Promise<string> {
  const consulta = typeof input.consulta === "string" ? input.consulta.trim() : "";
  if (!consulta) return "Indica una consulta específica para buscar en la base de conocimiento.";

  const ambito = opciones.ambito ?? "general";
  const maxTotal = acotarLimite(opciones.maxCaracteres ?? limitePorAmbito(ambito));
  const maxCorrecciones = Math.floor(maxTotal * 0.2);
  const maxCapturas = Math.floor(maxTotal * 0.2);
  const maxDocumentos = maxTotal - maxCorrecciones - maxCapturas - 500;

  const [correcciones, capturas] = await Promise.all([
    cargarCorreccionesRelevantes(consulta, maxCorrecciones),
    cargarCapturasRelevantes(consulta, maxCapturas),
  ]);
  const fragmentos = buscarFragmentosRelevantes(consulta, {
    incluirPGC: incluirPGC(consulta, ambito),
    maxCaracteres: maxDocumentos,
    maxFragmentos: 5,
  });

  const partes: string[] = [];
  if (correcciones) {
    partes.push(`## ⚠️ Correcciones relevantes — prioritarias sobre otras fuentes\n\n${correcciones}`);
  }
  if (capturas) {
    partes.push(`## 📌 Conocimiento capturado relevante\n\n${capturas}`);
  }
  if (fragmentos.length > 0) {
    partes.push(
      fragmentos
        .map(
          (fragmento) =>
            `<!-- Fuente: docs/${fragmento.nombre}; sección: ${fragmento.seccion} -->\n${fragmento.contenido}`
        )
        .join("\n\n---\n\n")
    );
  }

  if (partes.length === 0) {
    const indice = obtenerIndiceDocumentos();
    const listado = indice
      .filter((doc) => incluirPGC(consulta, ambito) || !doc.nombre.startsWith("PGC_"))
      .slice(0, 30)
      .map((doc) => `- ${doc.nombre}: ${doc.resumen}`)
      .join("\n");
    return (
      "No encontré fragmentos claramente relevantes. Documentos disponibles; vuelve a consultar con " +
      `entidades, fechas o términos más concretos:\n${listado}`
    ).slice(0, maxTotal);
  }

  const aviso =
    "\n\n[Resultado recuperado de forma selectiva. Las fuentes completas siguen conservadas; consulta de nuevo " +
    "con otro aspecto concreto si hace falta ampliar.]";
  const cuerpo = partes.join("\n\n===\n\n");
  const acotada =
    cuerpo.length + aviso.length <= maxTotal
      ? cuerpo + aviso
      : cuerpo.slice(0, Math.max(0, maxTotal - aviso.length - 24)).trimEnd() + "\n\n[…contenido acotado…]" + aviso;
  console.log(
    "[knowledgeBase] retrieval",
    JSON.stringify({
      ambito,
      incluirPGC: incluirPGC(consulta, ambito),
      maxCaracteres: maxTotal,
      caracteres: acotada.length,
      fragmentos: fragmentos.length,
    })
  );
  return acotada;
}

/** Evita que un mismo flujo acumule consultas ilimitadas dentro del historial de tool-use. */
export function crearConsultorConocimiento(
  opciones: OpcionesConsultaConocimiento & { maxConsultas?: number } = {}
): (input: Record<string, unknown>) => Promise<string> {
  let realizadas = 0;
  const maxConsultas = Math.max(1, opciones.maxConsultas ?? 2);
  return async (input) => {
    if (realizadas >= maxConsultas) {
      return "Ya se alcanzó el límite de consultas de conocimiento de esta ejecución. Usa las fuentes recuperadas y reporta la decisión; si siguen faltando datos, indica la ambigüedad.";
    }
    realizadas += 1;
    return consultarBaseConocimiento(input, opciones);
  };
}

export const knowledgeBaseTool: ToolDefinition = {
  name: "consultar_base_conocimiento",
  seguraParaModoRapido: true,
  description:
    "Consulta de forma selectiva el conocimiento interno del grupo (WOBA/BAE, Footprint, eWorks), " +
    "incluidas correcciones prioritarias, capturas, procesos y referencias contables. Devuelve fragmentos " +
    "con su fuente; formula una consulta específica y vuelve a consultar otro aspecto solo si es necesario. " +
    "No la uses para saludos o small talk.",
  input_schema: {
    type: "object",
    properties: {
      consulta: {
        type: "string",
        description:
          "Pregunta específica con las entidades y el dato buscado; por ejemplo: 'cuenta contable para " +
          "servicios profesionales independientes' o 'domiciliación de Adobe en WOBA'.",
      },
    },
    required: ["consulta"],
  },
  handler: async (input) => consultarBaseConocimiento(input),
};
