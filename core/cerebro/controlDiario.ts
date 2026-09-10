import {
  obtenerAnalisisCostosDiario,
  type AnalisisCostosDiario,
} from "../claude/costTracking";
import {
  diagnosticarMemoriaConversacional,
  type DiagnosticoMemoriaConversacional,
} from "../claude/conversationStore";
import { cargarConfiguracionPoliticaApi, type ModoPoliticaApi } from "../ai/policy";
import { durableSendStore, type ResumenLedgerEnviosCorreo } from "../gmail/durableSendStore";

export type EstadoControlDiario = "estable" | "atencion" | "critico";
export type PrioridadRecomendacion = "critica" | "alta" | "media" | "informativa";

export interface PoliticaControlDiario {
  modo: ModoPoliticaApi;
  killSwitch: boolean;
  limiteDiarioUSD: number;
  limiteMensualUSD: number;
  procesosPermitidos: number;
}

export interface RecomendacionControlDiario {
  id: string;
  prioridad: PrioridadRecomendacion;
  titulo: string;
  detalle: string;
  siguientePaso: string;
  modulo: "accesos" | "conocimiento" | "conexiones";
}

export interface ControlDiario {
  estado: EstadoControlDiario;
  resumen: string;
  generadoEn: string;
  costosDisponibles: boolean;
  costos: AnalisisCostosDiario | null;
  memoria: DiagnosticoMemoriaConversacional;
  politica: PoliticaControlDiario;
  enviosCorreo: ResumenLedgerEnviosCorreo | null;
  recomendaciones: RecomendacionControlDiario[];
}

export interface EntradaControlDiario {
  costos: AnalisisCostosDiario | null;
  memoria: DiagnosticoMemoriaConversacional;
  politica: PoliticaControlDiario;
  /** undefined mantiene compatibilidad de pruebas/llamadores; null significa fallo real de lectura. */
  enviosCorreo?: ResumenLedgerEnviosCorreo | null;
  generadoEn?: Date;
}

function nombreProceso(proceso: string): string {
  const nombres: Record<string, string> = {
    extraer_factura: "extracción de facturas",
    chat_conversacional: "chat conversacional",
    clasificar_correo: "clasificación de correo",
    extraer_gasto_correo: "extracción de gastos desde correo",
    autorrevision_codigo: "autorrevisión de código",
    sin_atribuir: "consumo todavía sin atribuir",
  };
  return nombres[proceso] ?? proceso.replaceAll("_", " ");
}

export function generarControlDiario(entrada: EntradaControlDiario): ControlDiario {
  const recomendaciones: RecomendacionControlDiario[] = [];
  const { costos, memoria, politica } = entrada;

  if (entrada.enviosCorreo === null) {
    recomendaciones.push({
      id: "ledger-correo-no-disponible",
      prioridad: "critica",
      titulo: "No se pudo comprobar la continuidad del correo",
      detalle: "El control diario no pudo leer el ledger durable de envíos; no se asume que esté vacío.",
      siguientePaso: "Revisar permisos de Google Sheets y la pestaña _envios_correo_durables antes de reenviar correos.",
      modulo: "conexiones",
    });
  } else if (entrada.enviosCorreo && entrada.enviosCorreo.incierto > 0) {
    recomendaciones.push({
      id: "envios-correo-inciertos",
      prioridad: "critica",
      titulo: "Hay envíos de correo con resultado incierto",
      detalle: `${entrada.enviosCorreo.incierto} envío(s) no pudieron confirmarse contra la carpeta Enviados.`,
      siguientePaso: "Comprobar esos correos en Gmail antes de autorizar cualquier envío equivalente nuevo.",
      modulo: "conexiones",
    });
  }

  if (!costos) {
    recomendaciones.push({
      id: "costos-no-disponibles",
      prioridad: "critica",
      titulo: "No se pudo leer la telemetría de costes",
      detalle: "El panel no puede confirmar llamadas, gasto ni anomalías. Nunca se representa este fallo como coste cero.",
      siguientePaso: "Revisar permisos de Google Sheets y la pestaña _costos_ia.",
      modulo: "conexiones",
    });
  }

  if (!memoria.ok) {
    recomendaciones.push({
      id: "memoria-no-integra",
      prioridad: "critica",
      titulo: "La memoria requiere revisión",
      detalle: memoria.filasCorruptas > 0
        ? `${memoria.filasCorruptas} fila(s) de memoria no tienen una estructura válida.`
        : "No fue posible confirmar la integridad de la memoria persistente.",
      siguientePaso: "Comprobar permisos y reparar únicamente las filas afectadas antes de purgar información.",
      modulo: "conocimiento",
    });
  }

  if (costos?.ejecucionesConMuchasLlamadasAyer) {
    recomendaciones.push({
      id: "posibles-repeticiones",
      prioridad: "critica",
      titulo: "Hay ejecuciones con demasiadas llamadas",
      detalle: `${costos.ejecucionesConMuchasLlamadasAyer} ejecución(es) superaron 12 llamadas en un mismo proceso.`,
      siguientePaso: "Revisar la ejecución y detener la ruta con el kill switch si continúa creciendo.",
      modulo: "accesos",
    });
  }

  if (costos?.esAnomaliaAyer) {
    recomendaciones.push({
      id: "gasto-anomalo",
      prioridad: "alta",
      titulo: "El gasto de ayer fue anómalo",
      detalle: `La API consumió $${costos.ayer.gastoRealApiUSD.toFixed(2)} frente a una media previa de $${costos.promedio7DiasPreviosUSD.toFixed(2)} al día.`,
      siguientePaso: "Revisar primero los procesos que concentran el gasto antes de modificar modelos o calidad.",
      modulo: "accesos",
    });
  }

  if (politica.modo === "observe") {
    recomendaciones.push({
      id: "politica-observe",
      prioridad: politica.limiteDiarioUSD <= 0 || politica.limiteMensualUSD <= 0 ? "alta" : "media",
      titulo: "La API continúa en modo observación",
      detalle:
        politica.limiteDiarioUSD <= 0 || politica.limiteMensualUSD <= 0
          ? "La configuración todavía no tiene un techo diario y mensual efectivo."
          : "Se registra el consumo, pero todavía no se bloquean procesos fuera de una lista explícita.",
      siguientePaso: "Definir límites validados y pasar a allowlist después del periodo de comparación.",
      modulo: "accesos",
    });
  }

  if (
    costos &&
    politica.limiteMensualUSD > 0 &&
    costos.proyeccionMensualUSD >= politica.limiteMensualUSD * 0.7
  ) {
    recomendaciones.push({
      id: "proyeccion-presupuesto",
      prioridad: costos.proyeccionMensualUSD >= politica.limiteMensualUSD ? "alta" : "media",
      titulo: "La proyección mensual se acerca al límite",
      detalle: `Proyección actual: $${costos.proyeccionMensualUSD.toFixed(2)} de un límite de $${politica.limiteMensualUSD.toFixed(2)}.`,
      siguientePaso: "Priorizar filtros deterministas en el proceso más costoso y conservar las rutas críticas.",
      modulo: "accesos",
    });
  }

  const procesoPrincipal = costos?.porProcesoAyer[0];
  if (
    procesoPrincipal &&
    costos.ayer.gastoRealApiUSD > 0 &&
    procesoPrincipal.gastoRealApiUSD / costos.ayer.gastoRealApiUSD >= 0.4
  ) {
    const porcentaje = Math.round(
      (procesoPrincipal.gastoRealApiUSD / costos.ayer.gastoRealApiUSD) * 100
    );
    recomendaciones.push({
      id: "proceso-principal",
      prioridad: "media",
      titulo: `Optimizar ${nombreProceso(procesoPrincipal.proceso)}`,
      detalle: `Concentró el ${porcentaje}% del gasto de ayer ($${procesoPrincipal.gastoRealApiUSD.toFixed(2)}).`,
      siguientePaso: "Medir contexto, caché y llamadas por caso; aplicar cambios únicamente con casos de prueba equivalentes.",
      modulo: "accesos",
    });
  }

  const hayCritica = recomendaciones.some((r) => r.prioridad === "critica");
  const hayAtencion = recomendaciones.some((r) => r.prioridad === "alta" || r.prioridad === "media");
  const estado: EstadoControlDiario = hayCritica ? "critico" : hayAtencion ? "atencion" : "estable";
  const resumen =
    estado === "critico"
      ? "Hay una incidencia que requiere intervención antes de confiar en el control automático."
      : estado === "atencion"
        ? `${recomendaciones.length} recomendación(es) priorizada(s) para controlar coste y estabilidad.`
        : "Costes, memoria y política de uso están dentro de los controles configurados.";

  return {
    estado,
    resumen,
    generadoEn: (entrada.generadoEn ?? new Date()).toISOString(),
    costosDisponibles: costos !== null,
    costos,
    memoria,
    politica,
    enviosCorreo: entrada.enviosCorreo ?? null,
    recomendaciones,
  };
}

export async function construirControlDiario(referencia: Date = new Date()): Promise<ControlDiario> {
  const [costos, memoria, enviosCorreo] = await Promise.all([
    obtenerAnalisisCostosDiario(referencia)
      .catch((error) => {
        console.error("[controlDiario] No se pudo leer la telemetría de costes:", error instanceof Error ? error.name : "Error");
        return null;
      }),
    diagnosticarMemoriaConversacional(),
    durableSendStore.obtenerResumen().catch((error) => {
      console.error("[controlDiario] No se pudo leer el ledger de correo:", error instanceof Error ? error.name : "Error");
      return null;
    }),
  ]);
  const config = cargarConfiguracionPoliticaApi();

  return generarControlDiario({
    costos,
    memoria,
    politica: {
      modo: config.modo,
      killSwitch: config.killSwitch,
      limiteDiarioUSD: config.limiteDiarioUSD,
      limiteMensualUSD: config.limiteMensualUSD,
      procesosPermitidos: config.procesosPermitidos.size,
    },
    enviosCorreo,
    generadoEn: referencia,
  });
}
