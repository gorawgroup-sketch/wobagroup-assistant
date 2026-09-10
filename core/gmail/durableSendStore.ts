import { conMutex } from "../utils/asyncMutex";
import { enteroAcotado } from "../utils/asyncTimeout";
import { actualizarFila, agregarFila, eliminarFilas, leerFila, leerFilas } from "../google/sheetsKeyValueStore";
import type {
  EstadoEnvioCorreo,
  RegistroEnvioCorreo,
  RepositorioEnviosCorreo,
  ResultadoEnvioCorreo,
} from "./durableSend";

const TAB_NAME = "_envios_correo_durables";
const HEADERS = [
  "clave", "proceso", "estado", "messageIdRfc", "gmailMessageId", "gmailThreadId", "creadoEn", "actualizadoEn", "verificadoEn",
];
const NUM_COLS = HEADERS.length;
const CLAVE_MUTEX = `gmail-envios:${TAB_NAME}`;
const RETENCION_MS = enteroAcotado(process.env.WOBI_EMAIL_LEDGER_RETENTION_DAYS, 180, 30, 365) * 24 * 60 * 60 * 1000;
const PURGA_CADA_MS = 6 * 60 * 60 * 1000;
const ESTADOS = new Set<EstadoEnvioCorreo>(["preparado", "enviando", "verificado", "incierto"]);

interface RegistroConFila extends RegistroEnvioCorreo { rowIndex: number; }

export interface ResumenLedgerEnviosCorreo {
  preparado: number;
  enviando: number;
  verificado: number;
  incierto: number;
}

function desdeFila(rowIndex: number, valores: string[]): RegistroConFila | undefined {
  const estado = valores[2] as EstadoEnvioCorreo;
  if (!valores[0] || !valores[3] || !ESTADOS.has(estado)) return undefined;
  const verificadoEn = Number(valores[8]);
  return {
    rowIndex,
    clave: valores[0],
    proceso: valores[1] || "correo",
    estado,
    messageIdRfc: valores[3],
    gmailMessageId: valores[4] || undefined,
    gmailThreadId: valores[5] || undefined,
    creadoEn: Number(valores[6]) || 0,
    actualizadoEn: Number(valores[7]) || 0,
    verificadoEn: Number.isFinite(verificadoEn) && verificadoEn > 0 ? verificadoEn : undefined,
  };
}

function aFila(registro: RegistroEnvioCorreo): (string | number)[] {
  return [
    registro.clave,
    registro.proceso,
    registro.estado,
    registro.messageIdRfc,
    registro.gmailMessageId ?? "",
    registro.gmailThreadId ?? "",
    registro.creadoEn,
    registro.actualizadoEn,
    registro.verificadoEn ?? "",
  ];
}

class StoreEnviosCorreo implements RepositorioEnviosCorreo {
  private registros = new Map<string, RegistroConFila>();
  private inicializado = false;
  private ultimaPurgaEn = 0;

  async reservar(registro: RegistroEnvioCorreo) {
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

  marcarEnviando(clave: string) {
    return this.cambiarEstado(clave, ["preparado"], "enviando");
  }

  async marcarPreparado(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["enviando"], "preparado");
  }

  async marcarIncierto(clave: string): Promise<void> {
    await this.cambiarEstado(clave, ["enviando"], "incierto");
  }

  async marcarVerificado(clave: string, resultado: ResultadoEnvioCorreo): Promise<void> {
    await conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const actual = await this.refrescar(clave);
      if (!actual || actual.estado === "verificado") return;
      const ahora = Date.now();
      const siguiente: RegistroConFila = {
        ...actual,
        estado: "verificado",
        gmailMessageId: resultado.id || actual.gmailMessageId,
        gmailThreadId: resultado.threadId || actual.gmailThreadId,
        actualizadoEn: ahora,
        verificadoEn: ahora,
      };
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      this.registros.set(clave, siguiente);
    });
  }

  async listarPendientes(): Promise<RegistroEnvioCorreo[]> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      return [...this.registros.values()]
        .filter((r) => r.estado === "enviando" || r.estado === "incierto")
        .map((r) => this.publico(r));
    });
  }

  async obtenerResumen(): Promise<ResumenLedgerEnviosCorreo> {
    return conMutex(CLAVE_MUTEX, async () => {
      await this.inicializarYPurgar();
      const resumen: ResumenLedgerEnviosCorreo = { preparado: 0, enviando: 0, verificado: 0, incierto: 0 };
      for (const registro of this.registros.values()) resumen[registro.estado]++;
      return resumen;
    });
  }

  private async cambiarEstado(
    clave: string,
    permitidos: EstadoEnvioCorreo[],
    estado: EstadoEnvioCorreo
  ): Promise<RegistroEnvioCorreo | undefined> {
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

  private publico(registro: RegistroConFila): RegistroEnvioCorreo {
    const { rowIndex: _rowIndex, ...publico } = registro;
    return { ...publico };
  }
}

export const durableSendStore = new StoreEnviosCorreo();
