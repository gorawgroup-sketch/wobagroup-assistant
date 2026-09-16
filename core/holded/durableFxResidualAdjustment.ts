import { createHash } from "node:crypto";
import type { Empresa } from "./client";
import { esRechazoDefinitivoSinCompra } from "./durablePurchase";

export type EstadoAjusteCambio = "preparado" | "aplicando" | "verificado" | "incierto";

export interface ResultadoAjusteCambio {
  paymentId: string;
  monto: number;
  pendienteFinal: number;
}

export interface RegistroAjusteCambio {
  clave: string;
  proceso: string;
  estado: EstadoAjusteCambio;
  empresa: Empresa;
  purchaseId: string;
  movementId: string;
  sourceAccountId: string;
  targetTreasuryId: string;
  fecha: string;
  montoCentimos: number;
  huellaSolicitud: string;
  paymentId?: string;
  creadoEn: number;
  actualizadoEn: number;
  verificadoEn?: number;
}

export interface RepositorioAjustesCambio {
  reservar(registro: RegistroAjusteCambio): Promise<{ registro: RegistroAjusteCambio; nuevo: boolean }>;
  obtener(clave: string): Promise<RegistroAjusteCambio | undefined>;
  actualizarPreparado(clave: string, registro: RegistroAjusteCambio): Promise<RegistroAjusteCambio | undefined>;
  marcarAplicando(clave: string): Promise<RegistroAjusteCambio | undefined>;
  marcarPreparado(clave: string): Promise<void>;
  marcarVerificado(clave: string, resultado: ResultadoAjusteCambio): Promise<void>;
  marcarIncierto(clave: string): Promise<void>;
  listarPendientes(): Promise<RegistroAjusteCambio[]>;
}

export interface TransporteAjusteCambio {
  inspeccionar(registro: RegistroAjusteCambio): Promise<ResultadoAjusteCambio | undefined>;
  aplicar(registro: RegistroAjusteCambio): Promise<void>;
}

export class AjusteCambioInciertoError extends Error {
  constructor() {
    super(
      "Holded no confirmó si aplicó el ajuste de cambio de divisa. Wobi bloqueó cualquier repetición automática para no registrar dos pagos."
    );
    this.name = "AjusteCambioInciertoError";
  }
}

export class ConflictoAjusteCambioError extends AjusteCambioInciertoError {
  constructor() {
    super();
    this.message =
      "La misma conciliación ya inició un ajuste de cambio con otros datos. Wobi bloqueó la nueva solicitud hasta verificar la anterior.";
    this.name = "ConflictoAjusteCambioError";
  }
}

function hash(valor: string): string {
  return createHash("sha256").update(valor).digest("hex");
}

export function identidadAjusteCambio(
  entrada: {
    empresa: Empresa;
    purchaseId: string;
    movementId: string;
    sourceAccountId: string;
    targetTreasuryId: string;
    fecha: string;
    monto: number;
  },
  proceso = "ajuste_cambio_divisa_post_conciliacion",
  ahora = Date.now()
): RegistroAjusteCambio {
  const purchaseId = entrada.purchaseId.trim();
  const movementId = entrada.movementId.trim();
  const sourceAccountId = entrada.sourceAccountId.trim();
  const targetTreasuryId = entrada.targetTreasuryId.trim();
  const fecha = entrada.fecha.trim();
  const montoCentimos = Math.round(entrada.monto * 100);
  if (!purchaseId || !movementId || !sourceAccountId || !targetTreasuryId) {
    throw new Error("El ajuste de cambio exige documento, movimiento y las dos cuentas de tesorería.");
  }
  if (sourceAccountId === targetTreasuryId) {
    throw new Error("El ajuste de cambio no puede registrarse en la misma cuenta extranjera conciliada.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error("La fecha del ajuste debe usar YYYY-MM-DD.");
  if (montoCentimos !== 1) {
    throw new Error("La regularización automática solo admite el residuo seguro de 0,01.");
  }

  const clave = hash(`wobi-holded-fx-residual-v1\0${entrada.empresa}\0${purchaseId}\0${movementId}`);
  return {
    clave,
    proceso,
    estado: "preparado",
    empresa: entrada.empresa,
    purchaseId,
    movementId,
    sourceAccountId,
    targetTreasuryId,
    fecha,
    montoCentimos,
    huellaSolicitud: hash(`${purchaseId}\0${movementId}\0${sourceAccountId}\0${targetTreasuryId}\0${fecha}\0${montoCentimos}`),
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
}

function resultadoGuardado(registro: RegistroAjusteCambio): ResultadoAjusteCambio {
  return {
    paymentId: registro.paymentId ?? `ajuste-${registro.clave.slice(0, 16)}`,
    monto: registro.montoCentimos / 100,
    pendienteFinal: 0,
  };
}

async function confirmar(
  registro: RegistroAjusteCambio,
  repositorio: RepositorioAjustesCambio,
  transporte: TransporteAjusteCambio
): Promise<ResultadoAjusteCambio | undefined> {
  const resultado = await transporte.inspeccionar(registro);
  if (resultado) await repositorio.marcarVerificado(registro.clave, resultado);
  return resultado;
}

/**
 * Frontera durable para el equivalente de “Añadir pago → Ajustar cambio de
 * divisa”. La consulta previa también reconoce un ajuste manual ya hecho.
 */
export async function ejecutarAjusteCambioDurable(
  inicial: RegistroAjusteCambio,
  repositorio: RepositorioAjustesCambio,
  transporte: TransporteAjusteCambio
): Promise<{ resultado: ResultadoAjusteCambio; reutilizado: boolean }> {
  let { registro } = await repositorio.reservar(inicial);

  if (registro.huellaSolicitud !== inicial.huellaSolicitud) {
    if (registro.estado !== "preparado") throw new ConflictoAjusteCambioError();
    const actualizado = await repositorio.actualizarPreparado(registro.clave, inicial);
    if (!actualizado) throw new ConflictoAjusteCambioError();
    registro = actualizado;
  }

  if (registro.estado === "verificado") {
    return { resultado: resultadoGuardado(registro), reutilizado: true };
  }

  if (registro.estado === "aplicando" || registro.estado === "incierto") {
    try {
      const resultado = await confirmar(registro, repositorio, transporte);
      if (resultado) return { resultado, reutilizado: true };
    } catch {
      // Una lectura fallida nunca habilita un segundo pago.
    }
    if (registro.estado === "aplicando") await repositorio.marcarIncierto(registro.clave).catch(() => undefined);
    throw new AjusteCambioInciertoError();
  }

  const existente = await transporte.inspeccionar(registro);
  if (existente) {
    await repositorio.marcarVerificado(registro.clave, existente);
    return { resultado: existente, reutilizado: true };
  }

  const aplicando = await repositorio.marcarAplicando(registro.clave);
  if (!aplicando) throw new AjusteCambioInciertoError();

  try {
    await transporte.aplicar(aplicando);
  } catch (error) {
    if (esRechazoDefinitivoSinCompra(error)) {
      await repositorio.marcarPreparado(aplicando.clave);
      throw error;
    }
    try {
      const resultado = await confirmar(aplicando, repositorio, transporte);
      if (resultado) return { resultado, reutilizado: true };
    } catch {
      // El POST pudo tener efecto y la relectura también fallar.
    }
    await repositorio.marcarIncierto(aplicando.clave).catch(() => undefined);
    throw new AjusteCambioInciertoError();
  }

  try {
    const resultado = await confirmar(aplicando, repositorio, transporte);
    if (resultado) return { resultado, reutilizado: false };
  } catch {
    // Holded respondió éxito; nunca repetir por un fallo posterior.
  }
  await repositorio.marcarIncierto(aplicando.clave).catch(() => undefined);
  throw new AjusteCambioInciertoError();
}

/** Recuperación de arranque: solo inspecciona; jamás crea pagos. */
export async function reconciliarAjustesCambioPendientes(
  repositorio: RepositorioAjustesCambio,
  inspeccionar: TransporteAjusteCambio["inspeccionar"]
): Promise<{ revisados: number; verificados: number; inciertos: number; errores: number }> {
  const pendientes = await repositorio.listarPendientes();
  let verificados = 0;
  let inciertos = 0;
  let errores = 0;
  for (const registro of pendientes) {
    try {
      const resultado = await inspeccionar(registro);
      if (resultado) {
        await repositorio.marcarVerificado(registro.clave, resultado);
        verificados++;
      } else {
        if (registro.estado === "aplicando") await repositorio.marcarIncierto(registro.clave);
        inciertos++;
      }
    } catch {
      errores++;
    }
  }
  return { revisados: pendientes.length, verificados, inciertos, errores };
}
