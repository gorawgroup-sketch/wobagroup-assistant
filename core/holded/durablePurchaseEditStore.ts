import { actualizarFila, agregarFila, eliminarFilas, leerFila, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import { enteroAcotado } from "../utils/asyncTimeout";
import type {
  EstadoEdicionCompra,
  RegistroEdicionCompra,
  RepositorioEdicionesCompra,
} from "./durablePurchaseEdit";

const TAB_NAME = "_ediciones_holded_durables";
const HEADERS = [
  "clave", "proceso", "estado", "empresa", "purchaseId", "huellaSolicitud", "huellaEsperada", "verificarTotal", "creadoEn", "actualizadoEn", "verificadoEn",
];
const NUM_COLS = HEADERS.length;
const CLAVE_MUTEX = `holded-ediciones:${TAB_NAME}`;
const RETENCION_MS =
  enteroAcotado(process.env.WOBI_HOLDED_EDIT_LEDGER_RETENTION_DAYS, 365, 90, 1095) * 24 * 60 * 60 * 1000;
const PURGA_CADA_MS = 6 * 60 * 60 * 1000;
const ESTADOS = new Set<EstadoEdicionCompra>(["preparada", "editando", "verificada", "incierta"]);

interface RegistroConFila extends RegistroEdicionCompra { rowIndex: number; }

export interface ResumenLedgerEdicionesCompra {
  preparada: number;
  editando: number;
  verificada: number;
  incierta: number;
}

function desdeFila(rowIndex: number, valores: string[]): RegistroConFila | undefined {
  const estado = valores[2] as EstadoEdicionCompra;
  const empresa = valores[3] as RegistroEdicionCompra["empresa"];
  if (!valores[0] || !valores[4] || !valores[5] || !ESTADOS.has(estado)) return undefined;
  if (!( ["WOBA", "EWORKS", "Footprint"] as string[]).includes(empresa)) return undefined;
  const verificadoEn = Number(valores[10]);
  return {
    rowIndex,
    clave: valores[0],
    proceso: valores[1] || "editar_compra",
    estado,
    empresa,
    purchaseId: valores[4],
    huellaSolicitud: valores[5],
    huellaEsperada: valores[6] || undefined,
    verificarTotal: valores[7] === "1" || valores[7] === "true",
    creadoEn: Number(valores[8]) || 0,
    actualizadoEn: Number(valores[9]) || 0,
    verificadoEn: Number.isFinite(verificadoEn) && verificadoEn > 0 ? verificadoEn : undefined,
  };
}

function aFila(registro: RegistroEdicionCompra): (string | number)[] {
  return [
    registro.clave,
    registro.proceso,
    registro.estado,
    registro.empresa,
    registro.purchaseId,
    registro.huellaSolicitud,
    registro.huellaEsperada ?? "",
    registro.verificarTotal ? 1 : 0,
    registro.creadoEn,
    registro.actualizadoEn,
    registro.verificadoEn ?? "",
  ];
}

class StoreEdicionesCompra implements RepositorioEdicionesCompra {
  private registros = new Map<string, RegistroConFila>();
  private inicializado = false;
  private ultimaPurgaEn = 0;

  async reservar(registro: RegistroEdicionCompra) {
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

  async actualizarPreparada(clave: string, registro: RegistroEdicionCompra) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || actual.estado !== "preparada") return undefined;
      const siguiente: RegistroConFila = {
        ...actual,
        proceso: registro.proceso,
        empresa: registro.empresa,
        purchaseId: registro.purchaseId,
        huellaSolicitud: registro.huellaSolicitud,
        huellaEsperada: undefined,
        verificarTotal: undefined,
        actualizadoEn: Date.now(),
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
      return this.publico(siguiente);
    });
  }

  async marcarEditando(clave: string, huellaEsperada: string, verificarTotal: boolean) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || actual.estado !== "preparada") return undefined;
      const siguiente: RegistroConFila = {
        ...actual,
        estado: "editando",
        huellaEsperada,
        verificarTotal,
        actualizadoEn: Date.now(),
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
      return this.publico(siguiente);
    });
  }

  async marcarPreparada(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["editando"], "preparada", true);
  }

  async marcarIncierta(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["editando"], "incierta");
  }

  async marcarVerificada(clave: string): Promise<void> {
    await conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || actual.estado === "verificada") return;
      const ahora = Date.now();
      const siguiente: RegistroConFila = {
        ...actual,
        estado: "verificada",
        actualizadoEn: ahora,
        verificadoEn: ahora,
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
    });
  }

  async listarPendientes(): Promise<RegistroEdicionCompra[]> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      return [...this.registros.values()]
        .filter((r) => r.estado === "editando" || r.estado === "incierta")
        .map((r) => this.publico(r));
    });
  }

  async obtenerResumen(): Promise<ResumenLedgerEdicionesCompra> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const resumen: ResumenLedgerEdicionesCompra = { preparada: 0, editando: 0, verificada: 0, incierta: 0 };
      for (const registro of this.registros.values()) resumen[registro.estado]++;
      return resumen;
    });
  }

  private async cambiarEstado(
    clave: string,
    permitidos: EstadoEdicionCompra[],
    estado: EstadoEdicionCompra,
    limpiarEsperado = false
  ) {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || !permitidos.includes(actual.estado)) return undefined;
      const siguiente: RegistroConFila = {
        ...actual,
        estado,
        ...(limpiarEsperado ? { huellaEsperada: undefined, verificarTotal: undefined } : {}),
        actualizadoEn: Date.now(),
      };
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

  private publico(registro: RegistroConFila): RegistroEdicionCompra {
    const { rowIndex: _rowIndex, ...publico } = registro;
    return { ...publico };
  }
}

export const durablePurchaseEditStore = new StoreEdicionesCompra();
