import type Anthropic from "@anthropic-ai/sdk";
import { enteroAcotado } from "../utils/asyncTimeout";

export interface PresupuestoSolicitudIA {
  maxLlamadasPorEjecucion: number;
  maxCaracteresEntrada: number;
}

const PRESUPUESTOS_POR_PROCESO: Record<string, PresupuestoSolicitudIA> = {
  clasificar_documento: { maxLlamadasPorEjecucion: 6, maxCaracteresEntrada: 160_000 },
  clasificar_correo: { maxLlamadasPorEjecucion: 4, maxCaracteresEntrada: 160_000 },
  extraer_factura: { maxLlamadasPorEjecucion: 4, maxCaracteresEntrada: 220_000 },
  extraer_gasto_correo: { maxLlamadasPorEjecucion: 4, maxCaracteresEntrada: 180_000 },
  transcribir_captura: { maxLlamadasPorEjecucion: 3, maxCaracteresEntrada: 220_000 },
  chat_conversacional: { maxLlamadasPorEjecucion: 24, maxCaracteresEntrada: 900_000 },
};

const PRESUPUESTO_DEFECTO: PresupuestoSolicitudIA = {
  maxLlamadasPorEjecucion: 24,
  maxCaracteresEntrada: 900_000,
};

function sufijoVariable(proceso: string): string {
  return proceso.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function obtenerPresupuestoSolicitudIA(
  proceso: string,
  env: NodeJS.ProcessEnv = process.env
): PresupuestoSolicitudIA {
  const base = PRESUPUESTOS_POR_PROCESO[proceso] ?? PRESUPUESTO_DEFECTO;
  const sufijo = sufijoVariable(proceso);
  return {
    maxLlamadasPorEjecucion: enteroAcotado(
      env[`WOBI_AI_MAX_CALLS_${sufijo}`] ?? env.WOBI_AI_MAX_CALLS_PER_EXECUTION,
      base.maxLlamadasPorEjecucion,
      1,
      64
    ),
    maxCaracteresEntrada: enteroAcotado(
      env[`WOBI_AI_MAX_INPUT_CHARS_${sufijo}`] ?? env.WOBI_AI_MAX_INPUT_CHARS,
      base.maxCaracteresEntrada,
      20_000,
      5_000_000
    ),
  };
}

function contarCaracteres(valor: unknown): number {
  if (typeof valor === "string") {
    return valor.length;
  }
  if (typeof valor !== "object" || valor === null) return 0;
  if (Array.isArray(valor)) return valor.reduce((total, item) => total + contarCaracteres(item), 0);

  const registro = valor as Record<string, unknown>;
  const contieneBase64 = registro.type === "base64" && typeof registro.data === "string";
  return Object.entries(registro).reduce(
    // PDFs e imágenes base64 se tarifican según sus propias reglas multimodales. Contar la expansión
    // base64 como texto daría falsos positivos; solo se omite `data` dentro de una fuente base64 real.
    (total, [clave, contenido]) => total + (contieneBase64 && clave === "data" ? 0 : contarCaracteres(contenido)),
    0
  );
}

/** Cuenta únicamente volumen, nunca registra ni devuelve el contenido. */
export function contarCaracteresEntradaIA(
  params: Anthropic.MessageCreateParamsNonStreaming
): number {
  return contarCaracteres({
    system: params.system,
    tools: params.tools,
    messages: params.messages,
  });
}

export class PresupuestoSolicitudIAExcedidoError extends Error {
  constructor(
    public readonly proceso: string,
    public readonly tipo: "llamadas" | "contexto",
    public readonly observado: number,
    public readonly limite: number
  ) {
    super(
      tipo === "llamadas"
        ? `La ejecución de "${proceso}" intentó superar ${limite} llamadas de IA.`
        : `La entrada de "${proceso}" supera el presupuesto seguro de contexto (${observado}/${limite} caracteres).`
    );
    this.name = "PresupuestoSolicitudIAExcedidoError";
  }
}

export function validarPresupuestoSolicitudIA(
  proceso: string,
  llamadaNumero: number,
  params: Anthropic.MessageCreateParamsNonStreaming,
  env: NodeJS.ProcessEnv = process.env
): { caracteresEntrada: number; presupuesto: PresupuestoSolicitudIA } {
  const presupuesto = obtenerPresupuestoSolicitudIA(proceso, env);
  if (llamadaNumero > presupuesto.maxLlamadasPorEjecucion) {
    throw new PresupuestoSolicitudIAExcedidoError(
      proceso,
      "llamadas",
      llamadaNumero,
      presupuesto.maxLlamadasPorEjecucion
    );
  }

  const caracteresEntrada = contarCaracteresEntradaIA(params);
  if (caracteresEntrada > presupuesto.maxCaracteresEntrada) {
    throw new PresupuestoSolicitudIAExcedidoError(
      proceso,
      "contexto",
      caracteresEntrada,
      presupuesto.maxCaracteresEntrada
    );
  }

  return { caracteresEntrada, presupuesto };
}
