import { createHash } from "node:crypto";
import type { Empresa } from "./client";

export type EstadoConciliacionMovimiento = "preparada" | "conciliando" | "verificada" | "incierta";

export interface ResultadoConciliacionMovimiento {
  ok: boolean;
  statusFinal: string;
  montoEnlazado: number;
  pendienteEnCompra?: number;
}

export interface RegistroConciliacionMovimiento {
  clave: string;
  proceso: string;
  estado: EstadoConciliacionMovimiento;
  empresa: Empresa;
  accountId: string;
  movementId: string;
  documentId: string;
  fechaAproximada: string;
  huellaSolicitud: string;
  creadoEn: number;
  actualizadoEn: number;
  verificadoEn?: number;
}

export interface RepositorioConciliacionesMovimiento {
  reservar(registro: RegistroConciliacionMovimiento): Promise<{ registro: RegistroConciliacionMovimiento; nuevo: boolean }>;
  obtener(clave: string): Promise<RegistroConciliacionMovimiento | undefined>;
  actualizarPreparada(clave: string, registro: RegistroConciliacionMovimiento): Promise<RegistroConciliacionMovimiento | undefined>;
  marcarConciliando(clave: string): Promise<RegistroConciliacionMovimiento | undefined>;
  marcarPreparada(clave: string): Promise<void>;
  marcarVerificada(clave: string): Promise<void>;
  marcarIncierta(clave: string): Promise<void>;
  listarPendientes(): Promise<RegistroConciliacionMovimiento[]>;
}

export type InspeccionConciliacionMovimiento =
  | { estado: "libre"; resultado: ResultadoConciliacionMovimiento }
  | { estado: "no_encontrada" }
  | { estado: "verificada"; resultado: ResultadoConciliacionMovimiento };

export interface TransporteConciliacionMovimiento {
  inspeccionar(registro: RegistroConciliacionMovimiento): Promise<InspeccionConciliacionMovimiento>;
  conciliar(registro: RegistroConciliacionMovimiento): Promise<void>;
}

export class ConciliacionMovimientoInciertaError extends Error {
  constructor() {
    super(
      "Holded no confirmó si el movimiento quedó conciliado. Wobi bloqueó cualquier repetición automática y lo dejó pendiente de verificación."
    );
    this.name = "ConciliacionMovimientoInciertaError";
  }
}

export class ConflictoConciliacionMovimientoError extends ConciliacionMovimientoInciertaError {
  constructor() {
    super();
    this.message =
      "El mismo movimiento ya inició una conciliación con otro documento. Wobi bloqueó la nueva solicitud hasta verificar la anterior.";
    this.name = "ConflictoConciliacionMovimientoError";
  }
}

export class MovimientoYaConciliadoError extends Error {
  constructor() {
    super("El movimiento ya estaba conciliado antes de esta operación; Wobi no envió otro POST.");
    this.name = "MovimientoYaConciliadoError";
  }
}

function hash(valor: string): string {
  return createHash("sha256").update(valor).digest("hex");
}

export function identidadConciliacionMovimiento(
  empresa: Empresa,
  accountId: string,
  movementId: string,
  documentId: string,
  fechaAproximada: string,
  proceso: string,
  ahora = Date.now()
): RegistroConciliacionMovimiento {
  const cuenta = accountId.trim();
  const movimiento = movementId.trim();
  const documento = documentId.trim();
  const fecha = fechaAproximada.trim();
  if (!cuenta || cuenta.length > 200) throw new Error("El id de la cuenta bancaria es obligatorio.");
  if (!movimiento || movimiento.length > 200) throw new Error("El id del movimiento bancario es obligatorio.");
  if (!documento || documento.length > 200) throw new Error("El id del documento a conciliar es obligatorio.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error("La fecha de conciliación debe usar YYYY-MM-DD.");

  const clave = hash(`wobi-holded-bank-reconciliation-v1\0${empresa}\0${cuenta}\0${movimiento}`);
  return {
    clave,
    proceso,
    estado: "preparada",
    empresa,
    accountId: cuenta,
    movementId: movimiento,
    documentId: documento,
    fechaAproximada: fecha,
    huellaSolicitud: hash(`${cuenta}\0${movimiento}\0${documento}`),
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
}

function codigoHttp(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const valor = e.response?.status ?? e.status ?? e.code;
  const numero = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(numero) ? numero : undefined;
}

/** 422 es ambiguo: Holded lo usa cuando el par ya fue conciliado. 423 también implica una actualización concurrente. */
export function esRechazoDefinitivoConciliacion(error: unknown): boolean {
  const codigo = codigoHttp(error);
  return codigo !== undefined && codigo >= 400 && codigo < 500 && ![408, 409, 422, 423, 425, 429].includes(codigo);
}

async function confirmar(
  registro: RegistroConciliacionMovimiento,
  repositorio: RepositorioConciliacionesMovimiento,
  transporte: TransporteConciliacionMovimiento
): Promise<ResultadoConciliacionMovimiento | undefined> {
  const inspeccion = await transporte.inspeccionar(registro);
  if (inspeccion.estado !== "verificada") return undefined;
  await repositorio.marcarVerificada(registro.clave);
  return inspeccion.resultado;
}

export async function ejecutarConciliacionMovimientoDurable(
  inicial: RegistroConciliacionMovimiento,
  repositorio: RepositorioConciliacionesMovimiento,
  transporte: TransporteConciliacionMovimiento
): Promise<{ resultado: ResultadoConciliacionMovimiento; reutilizada: boolean }> {
  let { registro } = await repositorio.reservar(inicial);

  if (registro.huellaSolicitud !== inicial.huellaSolicitud) {
    if (registro.estado !== "preparada") throw new ConflictoConciliacionMovimientoError();
    const actualizado = await repositorio.actualizarPreparada(registro.clave, inicial);
    if (!actualizado) throw new ConflictoConciliacionMovimientoError();
    registro = actualizado;
  }

  if (registro.estado === "verificada") {
    try {
      const inspeccion = await transporte.inspeccionar(registro);
      if (inspeccion.estado === "verificada") return { resultado: inspeccion.resultado, reutilizada: true };
    } catch {
      // Un fallo de lectura nunca autoriza repetir una conciliación ya verificada.
    }
    throw new ConciliacionMovimientoInciertaError();
  }

  if (registro.estado === "conciliando" || registro.estado === "incierta") {
    try {
      const resultado = await confirmar(registro, repositorio, transporte);
      if (resultado) return { resultado, reutilizada: true };
    } catch {
      // El POST pudo haber tenido efecto; solo se permite seguir consultando.
    }
    if (registro.estado === "conciliando") await repositorio.marcarIncierta(registro.clave).catch(() => undefined);
    throw new ConciliacionMovimientoInciertaError();
  }

  const inicialInspeccion = await transporte.inspeccionar(registro);
  if (inicialInspeccion.estado === "verificada") throw new MovimientoYaConciliadoError();
  if (inicialInspeccion.estado === "no_encontrada") {
    throw new Error("El movimiento bancario ya no aparece en Holded; Wobi no intentó conciliarlo.");
  }

  const conciliando = await repositorio.marcarConciliando(registro.clave);
  if (!conciliando) throw new ConciliacionMovimientoInciertaError();

  try {
    await transporte.conciliar(conciliando);
  } catch (error) {
    if (esRechazoDefinitivoConciliacion(error)) {
      await repositorio.marcarPreparada(conciliando.clave);
      throw error;
    }
    try {
      const resultado = await confirmar(conciliando, repositorio, transporte);
      if (resultado) return { resultado, reutilizada: true };
    } catch {
      // Se conserva la salida segura aunque también falle la relectura.
    }
    await repositorio.marcarIncierta(conciliando.clave).catch(() => undefined);
    throw new ConciliacionMovimientoInciertaError();
  }

  try {
    const resultado = await confirmar(conciliando, repositorio, transporte);
    if (resultado) return { resultado, reutilizada: false };
  } catch {
    // El POST respondió éxito; una lectura fallida jamás permite repetirlo.
  }
  await repositorio.marcarIncierta(conciliando.clave).catch(() => undefined);
  throw new ConciliacionMovimientoInciertaError();
}

/** Reconciliación de solo lectura; nunca ejecuta el POST /reconcile. */
export async function reconciliarConciliacionesMovimientoPendientes(
  repositorio: RepositorioConciliacionesMovimiento,
  inspeccionar: TransporteConciliacionMovimiento["inspeccionar"]
): Promise<{ revisadas: number; verificadas: number; inciertas: number; errores: number }> {
  const pendientes = await repositorio.listarPendientes();
  let verificadas = 0;
  let inciertas = 0;
  let errores = 0;
  for (const registro of pendientes) {
    try {
      const inspeccion = await inspeccionar(registro);
      if (inspeccion.estado === "verificada") {
        await repositorio.marcarVerificada(registro.clave);
        verificadas++;
      } else {
        if (registro.estado === "conciliando") await repositorio.marcarIncierta(registro.clave);
        inciertas++;
      }
    } catch {
      errores++;
    }
  }
  return { revisadas: pendientes.length, verificadas, inciertas, errores };
}
