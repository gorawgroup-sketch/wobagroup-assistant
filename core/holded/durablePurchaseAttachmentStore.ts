import { actualizarFila, agregarFila, eliminarFilas, leerFila, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import { enteroAcotado } from "../utils/asyncTimeout";
import type {
  EstadoAdjuntoCompra,
  RegistroAdjuntoCompra,
  RepositorioAdjuntosCompra,
  ResultadoAdjuntoCompra,
} from "./durablePurchaseAttachment";

const TAB_NAME = "_adjuntos_holded_durables";
const HEADERS = [
  "clave", "proceso", "estado", "empresa", "purchaseId", "contentHash", "fileName", "huellaSolicitud", "attachmentId", "creadoEn", "actualizadoEn", "verificadoEn",
];
const NUM_COLS = HEADERS.length;
const CLAVE_MUTEX = `holded-adjuntos:${TAB_NAME}`;
const RETENCION_MS =
  enteroAcotado(process.env.WOBI_HOLDED_ATTACHMENT_LEDGER_RETENTION_DAYS, 365, 90, 1095) * 24 * 60 * 60 * 1000;
const PURGA_CADA_MS = 6 * 60 * 60 * 1000;
const ESTADOS = new Set<EstadoAdjuntoCompra>(["preparado", "subiendo", "verificado", "incierto"]);

interface RegistroConFila extends RegistroAdjuntoCompra { rowIndex: number; }

export interface ResumenLedgerAdjuntosCompra {
  preparado: number;
  subiendo: number;
  verificado: number;
  incierto: number;
}

function desdeFila(rowIndex: number, valores: string[]): RegistroConFila | undefined {
  const estadoLeido = valores[2] as EstadoAdjuntoCompra;
  const empresa = valores[3] as RegistroAdjuntoCompra["empresa"];
  if (!valores[0] || !valores[4] || !valores[5] || !valores[6] || !valores[7] || !ESTADOS.has(estadoLeido)) return undefined;
  if (!(["WOBA", "EWORKS", "Footprint"] as string[]).includes(empresa)) return undefined;
  const attachmentId = valores[8] || undefined;
  const verificadoEn = Number(valores[11]);
  // Un terminal sin referencia de archivo no demuestra el efecto.
  const estado = estadoLeido === "verificado" && !attachmentId ? "incierto" : estadoLeido;
  return {
    rowIndex,
    clave: valores[0],
    proceso: valores[1] || "adjuntar_comprobante",
    estado,
    empresa,
    purchaseId: valores[4],
    contentHash: valores[5],
    fileName: valores[6],
    huellaSolicitud: valores[7],
    attachmentId,
    creadoEn: Number(valores[9]) || 0,
    actualizadoEn: Number(valores[10]) || 0,
    verificadoEn: Number.isFinite(verificadoEn) && verificadoEn > 0 ? verificadoEn : undefined,
  };
}

function aFila(registro: RegistroAdjuntoCompra): (string | number)[] {
  return [
    registro.clave,
    registro.proceso,
    registro.estado,
    registro.empresa,
    registro.purchaseId,
    registro.contentHash,
    registro.fileName,
    registro.huellaSolicitud,
    registro.attachmentId ?? "",
    registro.creadoEn,
    registro.actualizadoEn,
    registro.verificadoEn ?? "",
  ];
}

class StoreAdjuntosCompra implements RepositorioAdjuntosCompra {
  private registros = new Map<string, RegistroConFila>();
  private inicializado = false;
  private ultimaPurgaEn = 0;

  async reservar(registro: RegistroAdjuntoCompra) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const existente = this.registros.get(registro.clave);
      if (existente) return { registro: this.publico(existente), nuevo: false };
      const rowIndex = await agregarFila(TAB_NAME, NUM_COLS, HEADERS, aFila(registro));
      const guardado = { ...registro, rowIndex };
      this.registros.set(registro.clave, guardado);
      return { registro: this.publico(guardado), nuevo: true };
    });
  }

  async obtener(clave: string) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const registro = await this.refrescar(clave);
      return registro ? this.publico(registro) : undefined;
    });
  }

  async actualizarPreparado(clave: string, registro: RegistroAdjuntoCompra) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || actual.estado !== "preparado") return undefined;
      const siguiente: RegistroConFila = {
        ...actual,
        proceso: registro.proceso,
        empresa: registro.empresa,
        purchaseId: registro.purchaseId,
        contentHash: registro.contentHash,
        fileName: registro.fileName,
        huellaSolicitud: registro.huellaSolicitud,
        attachmentId: undefined,
        actualizadoEn: Date.now(),
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
      return this.publico(siguiente);
    });
  }

  marcarSubiendo(clave: string) {
    return this.cambiarEstado(clave, ["preparado"], "subiendo");
  }

  async marcarPreparado(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["subiendo"], "preparado");
  }

  async marcarIncierto(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["subiendo"], "incierto");
  }

  async marcarVerificado(clave: string, resultado: ResultadoAdjuntoCompra): Promise<void> {
    if (!resultado.attachmentId?.trim()) throw new Error("No se puede verificar un adjunto durable sin referencia de Holded.");
    await conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || actual.estado === "verificado") return;
      const ahora = Date.now();
      const siguiente: RegistroConFila = {
        ...actual,
        estado: "verificado",
        attachmentId: resultado.attachmentId,
        actualizadoEn: ahora,
        verificadoEn: ahora,
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
    });
  }

  async listarPendientes(): Promise<RegistroAdjuntoCompra[]> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      return [...this.registros.values()]
        .filter((r) => r.estado === "subiendo" || r.estado === "incierto")
        .map((r) => this.publico(r));
    });
  }

  async obtenerResumen(): Promise<ResumenLedgerAdjuntosCompra> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const resumen: ResumenLedgerAdjuntosCompra = { preparado: 0, subiendo: 0, verificado: 0, incierto: 0 };
      for (const registro of this.registros.values()) resumen[registro.estado]++;
      return resumen;
    });
  }

  private async cambiarEstado(clave: string, permitidos: EstadoAdjuntoCompra[], estado: EstadoAdjuntoCompra) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
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

  private async refrescar(clave: string): Promise<RegistroConFila | undefined> {
    const conocido = this.registros.get(clave);
    if (!conocido) return undefined;
    const fila = await leerFila(TAB_NAME, conocido.rowIndex, NUM_COLS, HEADERS);
    const actual = fila ? desdeFila(fila.rowIndex, fila.valores) : undefined;
    if (actual?.clave === clave) {
      this.registros.set(clave, actual);
      return actual;
    }
    await this.recargarYPurgar();
    return this.registros.get(clave);
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

  private publico(registro: RegistroConFila): RegistroAdjuntoCompra {
    const { rowIndex: _rowIndex, ...publico } = registro;
    return { ...publico };
  }
}

export const durablePurchaseAttachmentStore = new StoreAdjuntosCompra();
