import { actualizarFila, agregarFila, eliminarFilas, leerFila, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import { enteroAcotado } from "../utils/asyncTimeout";
import type {
  EstadoCreacionCompra,
  RegistroCreacionCompra,
  RepositorioCreacionesCompra,
  ResultadoCreacionCompra,
} from "./durablePurchase";

const TAB_NAME = "_compras_holded_durables";
const HEADERS = [
  "clave", "proceso", "estado", "marcador", "empresa", "contactId", "fecha", "huellaSolicitud", "holdedPurchaseId", "creadoEn", "actualizadoEn", "verificadoEn",
];
const NUM_COLS = HEADERS.length;
const CLAVE_MUTEX = `holded-compras:${TAB_NAME}`;
const RETENCION_MS = enteroAcotado(process.env.WOBI_HOLDED_PURCHASE_LEDGER_RETENTION_DAYS, 365, 90, 1095) * 24 * 60 * 60 * 1000;
const PURGA_CADA_MS = 6 * 60 * 60 * 1000;
const ESTADOS = new Set<EstadoCreacionCompra>(["preparada", "creando", "verificada", "incierta"]);

interface RegistroConFila extends RegistroCreacionCompra { rowIndex: number; }

export interface ResumenLedgerCreacionesCompra {
  preparada: number;
  creando: number;
  verificada: number;
  incierta: number;
}

function desdeFila(rowIndex: number, valores: string[]): RegistroConFila | undefined {
  const estadoLeido = valores[2] as EstadoCreacionCompra;
  const empresa = valores[4] as RegistroCreacionCompra["empresa"];
  if (!valores[0] || !valores[3] || !valores[5] || !valores[6] || !valores[7] || !ESTADOS.has(estadoLeido)) return undefined;
  if (!(["WOBA", "EWORKS", "Footprint"] as string[]).includes(empresa)) return undefined;
  const verificadoEn = Number(valores[11]);
  const holdedPurchaseId = valores[8] || undefined;
  // Una fila terminal sin id no prueba ningún efecto. Se trata como incierta
  // para que el control diario la eleve y la reconciliación pueda repararla.
  const estado = estadoLeido === "verificada" && !holdedPurchaseId ? "incierta" : estadoLeido;
  return {
    rowIndex,
    clave: valores[0],
    proceso: valores[1] || "crear_gasto",
    estado,
    marcador: valores[3],
    empresa,
    contactId: valores[5],
    fecha: valores[6],
    huellaSolicitud: valores[7],
    holdedPurchaseId,
    creadoEn: Number(valores[9]) || 0,
    actualizadoEn: Number(valores[10]) || 0,
    verificadoEn: Number.isFinite(verificadoEn) && verificadoEn > 0 ? verificadoEn : undefined,
  };
}

function aFila(registro: RegistroCreacionCompra): (string | number)[] {
  return [
    registro.clave,
    registro.proceso,
    registro.estado,
    registro.marcador,
    registro.empresa,
    registro.contactId,
    registro.fecha,
    registro.huellaSolicitud,
    registro.holdedPurchaseId ?? "",
    registro.creadoEn,
    registro.actualizadoEn,
    registro.verificadoEn ?? "",
  ];
}

class StoreCreacionesCompra implements RepositorioCreacionesCompra {
  private registros = new Map<string, RegistroConFila>();
  private inicializado = false;
  private ultimaPurgaEn = 0;

  async reservar(registro: RegistroCreacionCompra) {
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

  async actualizarPreparada(clave: string, registro: RegistroCreacionCompra) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || actual.estado !== "preparada") return undefined;
      const siguiente: RegistroConFila = {
        ...actual,
        proceso: registro.proceso,
        marcador: registro.marcador,
        empresa: registro.empresa,
        contactId: registro.contactId,
        fecha: registro.fecha,
        huellaSolicitud: registro.huellaSolicitud,
        actualizadoEn: Date.now(),
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
      return this.publico(siguiente);
    });
  }

  marcarCreando(clave: string) {
    return this.cambiarEstado(clave, ["preparada"], "creando");
  }

  async marcarPreparada(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["creando"], "preparada");
  }

  async marcarIncierta(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["creando"], "incierta");
  }

  async marcarVerificada(clave: string, resultado: ResultadoCreacionCompra): Promise<void> {
    if (!resultado.id?.trim()) throw new Error("No se puede verificar una compra durable sin id de Holded.");
    await conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || actual.estado === "verificada") return;
      const ahora = Date.now();
      const siguiente: RegistroConFila = {
        ...actual,
        estado: "verificada",
        holdedPurchaseId: resultado.id || actual.holdedPurchaseId,
        actualizadoEn: ahora,
        verificadoEn: ahora,
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
    });
  }

  async listarPendientes(): Promise<RegistroCreacionCompra[]> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      return [...this.registros.values()]
        .filter((r) => r.estado === "creando" || r.estado === "incierta")
        .map((r) => this.publico(r));
    });
  }

  async obtenerResumen(): Promise<ResumenLedgerCreacionesCompra> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const resumen: ResumenLedgerCreacionesCompra = { preparada: 0, creando: 0, verificada: 0, incierta: 0 };
      for (const registro of this.registros.values()) resumen[registro.estado]++;
      return resumen;
    });
  }

  private async cambiarEstado(clave: string, permitidos: EstadoCreacionCompra[], estado: EstadoCreacionCompra) {
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
    const eliminar = filas.filter((r) => r.estado === "verificada" && ahora - r.actualizadoEn > RETENCION_MS);
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

  private publico(registro: RegistroConFila): RegistroCreacionCompra {
    const { rowIndex: _rowIndex, ...publico } = registro;
    return { ...publico };
  }
}

export const durablePurchaseStore = new StoreCreacionesCompra();
