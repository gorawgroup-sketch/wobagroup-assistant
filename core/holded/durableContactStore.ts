import { actualizarFila, agregarFila, eliminarFilas, leerFila, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import { enteroAcotado } from "../utils/asyncTimeout";
import type {
  EstadoCreacionContacto,
  RegistroCreacionContacto,
  RepositorioCreacionesContacto,
  ResultadoCreacionContacto,
} from "./durableContact";

const TAB_NAME = "_contactos_holded_durables";
const HEADERS = [
  "clave", "proceso", "estado", "empresa", "nombre", "nombreNormalizado", "codigoFiscal", "codigoFiscalNormalizado", "huellaSolicitud", "holdedContactId", "creadoEn", "actualizadoEn", "verificadoEn",
];
const NUM_COLS = HEADERS.length;
const CLAVE_MUTEX = `holded-contactos:${TAB_NAME}`;
const RETENCION_MS =
  enteroAcotado(process.env.WOBI_HOLDED_CONTACT_LEDGER_RETENTION_DAYS, 365, 90, 1095) * 24 * 60 * 60 * 1000;
const PURGA_CADA_MS = 6 * 60 * 60 * 1000;
const ESTADOS = new Set<EstadoCreacionContacto>(["preparada", "creando", "verificada", "incierta"]);

interface RegistroConFila extends RegistroCreacionContacto { rowIndex: number; }

export interface ResumenLedgerCreacionesContacto {
  preparada: number;
  creando: number;
  verificada: number;
  incierta: number;
}

function desdeFila(rowIndex: number, valores: string[]): RegistroConFila | undefined {
  const estadoLeido = valores[2] as EstadoCreacionContacto;
  const empresa = valores[3] as RegistroCreacionContacto["empresa"];
  if (!valores[0] || !valores[4] || !valores[5] || !valores[8] || !ESTADOS.has(estadoLeido)) return undefined;
  if (!(["WOBA", "EWORKS", "Footprint"] as string[]).includes(empresa)) return undefined;
  const holdedContactId = valores[9] || undefined;
  const estado = estadoLeido === "verificada" && !holdedContactId ? "incierta" : estadoLeido;
  const verificadoEn = Number(valores[12]);
  return {
    rowIndex,
    clave: valores[0],
    proceso: valores[1] || "crear_contacto_proveedor",
    estado,
    empresa,
    nombre: valores[4],
    nombreNormalizado: valores[5],
    codigoFiscal: valores[6] || undefined,
    codigoFiscalNormalizado: valores[7] || undefined,
    huellaSolicitud: valores[8],
    holdedContactId,
    creadoEn: Number(valores[10]) || 0,
    actualizadoEn: Number(valores[11]) || 0,
    verificadoEn: Number.isFinite(verificadoEn) && verificadoEn > 0 ? verificadoEn : undefined,
  };
}

function aFila(registro: RegistroCreacionContacto): (string | number)[] {
  return [
    registro.clave,
    registro.proceso,
    registro.estado,
    registro.empresa,
    registro.nombre,
    registro.nombreNormalizado,
    registro.codigoFiscal ?? "",
    registro.codigoFiscalNormalizado ?? "",
    registro.huellaSolicitud,
    registro.holdedContactId ?? "",
    registro.creadoEn,
    registro.actualizadoEn,
    registro.verificadoEn ?? "",
  ];
}

class StoreCreacionesContacto implements RepositorioCreacionesContacto {
  private registros = new Map<string, RegistroConFila>();
  private inicializado = false;
  private ultimaPurgaEn = 0;

  async reservar(registro: RegistroCreacionContacto) {
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

  marcarCreando(clave: string) {
    return this.cambiarEstado(clave, ["preparada"], "creando");
  }

  async marcarPreparada(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["creando"], "preparada");
  }

  async marcarIncierta(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["creando"], "incierta");
  }

  async marcarVerificada(clave: string, resultado: ResultadoCreacionContacto): Promise<void> {
    if (!resultado.id?.trim()) throw new Error("No se puede verificar un contacto durable sin id de Holded.");
    await conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || actual.estado === "verificada") return;
      const ahora = Date.now();
      const siguiente: RegistroConFila = {
        ...actual,
        estado: "verificada",
        holdedContactId: resultado.id,
        actualizadoEn: ahora,
        verificadoEn: ahora,
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
    });
  }

  async listarPendientes(): Promise<RegistroCreacionContacto[]> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      return [...this.registros.values()]
        .filter((r) => r.estado === "creando" || r.estado === "incierta")
        .map((r) => this.publico(r));
    });
  }

  async obtenerResumen(): Promise<ResumenLedgerCreacionesContacto> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const resumen: ResumenLedgerCreacionesContacto = { preparada: 0, creando: 0, verificada: 0, incierta: 0 };
      for (const registro of this.registros.values()) resumen[registro.estado]++;
      return resumen;
    });
  }

  private async cambiarEstado(
    clave: string,
    permitidos: EstadoCreacionContacto[],
    estado: EstadoCreacionContacto
  ) {
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

  private publico(registro: RegistroConFila): RegistroCreacionContacto {
    const { rowIndex: _rowIndex, ...publico } = registro;
    return { ...publico };
  }
}

export const durableContactStore = new StoreCreacionesContacto();
