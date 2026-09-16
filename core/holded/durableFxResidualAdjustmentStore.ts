import { actualizarFila, agregarFilaAtomica, eliminarFilas, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import { enteroAcotado } from "../utils/asyncTimeout";
import type {
  EstadoAjusteCambio,
  RegistroAjusteCambio,
  RepositorioAjustesCambio,
  ResultadoAjusteCambio,
} from "./durableFxResidualAdjustment";

const TAB_NAME = "_ajustes_cambio_holded_durables";
const HEADERS = [
  "clave", "proceso", "estado", "empresa", "purchaseId", "movementId", "sourceAccountId", "targetTreasuryId",
  "fecha", "montoCentimos", "huellaSolicitud", "paymentId", "creadoEn", "actualizadoEn", "verificadoEn",
];
const NUM_COLS = HEADERS.length;
const CLAVE_MUTEX = `holded-ajustes-cambio:${TAB_NAME}`;
const RETENCION_MS =
  enteroAcotado(process.env.WOBI_HOLDED_FX_ADJUSTMENT_LEDGER_RETENTION_DAYS, 365, 90, 1095) * 24 * 60 * 60 * 1000;
const PURGA_CADA_MS = 6 * 60 * 60 * 1000;
const ESTADOS = new Set<EstadoAjusteCambio>(["preparado", "aplicando", "verificado", "incierto"]);

interface RegistroConFila extends RegistroAjusteCambio { rowIndex: number; }

function desdeFila(rowIndex: number, valores: string[]): RegistroConFila | undefined {
  const estadoLeido = valores[2] as EstadoAjusteCambio;
  const empresa = valores[3] as RegistroAjusteCambio["empresa"];
  if (!valores[0] || !valores[4] || !valores[5] || !valores[6] || !valores[7] || !valores[10] || !ESTADOS.has(estadoLeido)) {
    return undefined;
  }
  if (!( ["WOBA", "EWORKS", "Footprint"] as string[]).includes(empresa)) return undefined;
  const montoCentimos = Number(valores[9]);
  // Defensa de integridad de la fila, no la regla de negocio (esa la aplica evaluarAjusteCambioResidual
  // / identidadAjusteCambio antes de llegar acá) — un techo amplio y fijo detecta corrupción de datos
  // sin tener que conocer el total de cada compra para recalcular su margen real.
  if (!Number.isFinite(montoCentimos) || montoCentimos <= 0 || montoCentimos > 100_00) return undefined;
  const paymentId = valores[11] || undefined;
  const estado = estadoLeido === "verificado" && !paymentId ? "incierto" : estadoLeido;
  const verificadoEn = Number(valores[14]);
  return {
    rowIndex,
    clave: valores[0],
    proceso: valores[1] || "ajuste_cambio_divisa_post_conciliacion",
    estado,
    empresa,
    purchaseId: valores[4],
    movementId: valores[5],
    sourceAccountId: valores[6],
    targetTreasuryId: valores[7],
    fecha: valores[8],
    montoCentimos,
    huellaSolicitud: valores[10],
    paymentId,
    creadoEn: Number(valores[12]) || 0,
    actualizadoEn: Number(valores[13]) || 0,
    verificadoEn: Number.isFinite(verificadoEn) && verificadoEn > 0 ? verificadoEn : undefined,
  };
}

function aFila(registro: RegistroAjusteCambio): (string | number)[] {
  return [
    registro.clave,
    registro.proceso,
    registro.estado,
    registro.empresa,
    registro.purchaseId,
    registro.movementId,
    registro.sourceAccountId,
    registro.targetTreasuryId,
    registro.fecha,
    registro.montoCentimos,
    registro.huellaSolicitud,
    registro.paymentId ?? "",
    registro.creadoEn,
    registro.actualizadoEn,
    registro.verificadoEn ?? "",
  ];
}

class StoreAjustesCambio implements RepositorioAjustesCambio {
  private registros = new Map<string, RegistroConFila>();
  private inicializado = false;
  private ultimaPurgaEn = 0;

  async reservar(registro: RegistroAjusteCambio) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const existente = this.registros.get(registro.clave);
      if (existente) return { registro: this.publico(existente), nuevo: false };
      const rowIndex = await agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, aFila(registro));
      const guardado = { ...registro, rowIndex };
      this.registros.set(registro.clave, guardado);
      return { registro: this.publico(guardado), nuevo: true };
    });
  }

  async obtener(clave: string) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const registro = this.registros.get(clave);
      return registro ? this.publico(registro) : undefined;
    });
  }

  async actualizarPreparado(clave: string, registro: RegistroAjusteCambio) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = this.registros.get(clave);
      if (!actual || actual.estado !== "preparado") return undefined;
      const siguiente: RegistroConFila = {
        ...actual,
        proceso: registro.proceso,
        sourceAccountId: registro.sourceAccountId,
        targetTreasuryId: registro.targetTreasuryId,
        fecha: registro.fecha,
        montoCentimos: registro.montoCentimos,
        huellaSolicitud: registro.huellaSolicitud,
        paymentId: undefined,
        actualizadoEn: Date.now(),
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
      return this.publico(siguiente);
    });
  }

  marcarAplicando(clave: string) {
    return this.cambiarEstado(clave, ["preparado"], "aplicando");
  }

  async marcarPreparado(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["aplicando"], "preparado");
  }

  async marcarIncierto(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["aplicando"], "incierto");
  }

  async marcarVerificado(clave: string, resultado: ResultadoAjusteCambio): Promise<void> {
    if (!resultado.paymentId.trim() || Math.abs(resultado.pendienteFinal) >= 0.005) {
      throw new Error("No se puede verificar un ajuste de cambio sin pago identificable y saldo final cero.");
    }
    await conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = this.registros.get(clave);
      if (!actual || actual.estado === "verificado") return;
      const ahora = Date.now();
      const siguiente: RegistroConFila = {
        ...actual,
        estado: "verificado",
        paymentId: resultado.paymentId,
        actualizadoEn: ahora,
        verificadoEn: ahora,
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
    });
  }

  async listarPendientes(): Promise<RegistroAjusteCambio[]> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      return [...this.registros.values()]
        .filter((r) => r.estado === "aplicando" || r.estado === "incierto")
        .map((r) => this.publico(r));
    });
  }

  /**
   * Ajustes ya verificados (pago confirmado en Holded) dentro de la ventana — usado por
   * revisarAjustesCambioRevertidos.ts para detectar si Carlos borró a mano un pago que Wobi ya dio
   * por hecho. Nunca incluye los purgados (más viejos que RETENCION_MS, ver recargarYPurgar).
   */
  async listarVerificadosRecientes(dias: number): Promise<RegistroAjusteCambio[]> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
      return [...this.registros.values()]
        .filter((r) => r.estado === "verificado" && r.verificadoEn && r.verificadoEn >= limite)
        .map((r) => this.publico(r));
    });
  }

  private async cambiarEstado(clave: string, permitidos: EstadoAjusteCambio[], estado: EstadoAjusteCambio) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = this.registros.get(clave);
      if (!actual || !permitidos.includes(actual.estado)) return undefined;
      const siguiente = { ...actual, estado, actualizadoEn: Date.now() };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
      return this.publico(siguiente);
    });
  }

  private async inicializarYPurgar(): Promise<void> {
    if (!this.inicializado || Date.now() - this.ultimaPurgaEn >= PURGA_CADA_MS) {
      await this.recargarYPurgar();
      this.inicializado = true;
    }
  }

  private async recargarYPurgar(): Promise<void> {
    const filas = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS))
      .map((f) => desdeFila(f.rowIndex, f.valores))
      .filter((f): f is RegistroConFila => Boolean(f));
    const ahora = Date.now();
    const eliminar = filas.filter((r) => r.estado === "verificado" && ahora - r.actualizadoEn > RETENCION_MS);
    if (eliminar.length) {
      await eliminarFilas(TAB_NAME, eliminar.map((r) => r.rowIndex), HEADERS);
      const restantes = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS))
        .map((f) => desdeFila(f.rowIndex, f.valores))
        .filter((f): f is RegistroConFila => Boolean(f));
      this.registros = new Map(restantes.map((r) => [r.clave, r]));
    } else {
      this.registros = new Map(filas.map((r) => [r.clave, r]));
    }
    this.ultimaPurgaEn = ahora;
  }

  private publico(registro: RegistroConFila): RegistroAjusteCambio {
    const { rowIndex: _rowIndex, ...publico } = registro;
    return { ...publico };
  }
}

export const durableFxResidualAdjustmentStore = new StoreAjustesCambio();
