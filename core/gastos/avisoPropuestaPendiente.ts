import { actualizarFila, agregarFilaAtomica, eliminarFila, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";

/**
 * Freno del aviso «ya tiene una propuesta pendiente para este mismo correo» (procesarGastoEntrante.ts).
 *
 * Cada vez que un correo con una propuesta ya pendiente se vuelve a procesar —otro adjunto del mismo correo, un reintento, un
 * reinicio por despliegue, un toque en «Sí, siguiente»— ese aviso REENVÍA la propuesta con sus botones. Sin freno, un correo
 * con muchos adjuntos (el de Booking.com del 07-10 traía 58 imágenes) llenaba el chat con el mismo mensaje decenas de veces.
 * Aquí se permite UN aviso por propuesta cada VENTANA_AVISO_MS; el resto se omite sin ruido (la decisión sigue pendiente y
 * visible en el aviso ya enviado). El registro es durable (Sheets) y se carga una sola vez en memoria, así que sobrevive a los
 * despliegues y no gasta lecturas en una avalancha.
 */
export const VENTANA_AVISO_MS = 10 * 60_000;
const TAB_NAME = "_avisos_propuesta_pendiente";
const HEADERS = ["propuestaId", "ultimoAviso"];
const NUM_COLS = HEADERS.length;
const CONSERVAR_MS = 24 * 60 * 60_000;

export interface AlmacenAvisos {
  cargar(): Promise<Map<string, { fila: number; ultimo: number }>>;
  guardar(propuestaId: string, ultimo: number, fila?: number): Promise<number>;
  purgar(filas: number[]): Promise<void>;
}

const almacenReal: AlmacenAvisos = {
  async cargar() {
    const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
    return new Map(filas.map((f) => [f.valores[0], { fila: f.rowIndex, ultimo: Number(f.valores[1]) || 0 }]));
  },
  async guardar(propuestaId, ultimo, fila) {
    if (fila) { await actualizarFila(TAB_NAME, fila, NUM_COLS, [propuestaId, ultimo]); return fila; }
    return agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, [propuestaId, ultimo]);
  },
  async purgar(filas) {
    for (const f of [...filas].sort((a, b) => b - a)) await eliminarFila(TAB_NAME, f, HEADERS);
  },
};

export class FrenoAvisoPropuesta {
  private memoria?: Map<string, { fila: number; ultimo: number }>;
  private cargando?: Promise<Map<string, { fila: number; ultimo: number }>>;
  /** Cada instancia tiene su propia cola: 58 llamadas simultáneas deben dejar pasar exactamente una. */
  private readonly clave = `aviso-propuesta-pendiente:${Math.random().toString(36).slice(2)}`;

  constructor(private readonly almacen: AlmacenAvisos = almacenReal, private readonly ahora: () => number = Date.now) {}

  private async estado() {
    if (this.memoria) return this.memoria;
    this.cargando ??= this.almacen.cargar().then((m) => (this.memoria = m));
    return this.cargando;
  }

  /** true = enviar el aviso (y queda registrado); false = ya se avisó hace poco, omitir. */
  puedeAvisar(propuestaId: string): Promise<boolean> {
    return conMutex(this.clave, async () => {
      let mapa: Map<string, { fila: number; ultimo: number }> | undefined;
      let lecturaFallida = false;
      try {
        mapa = await this.estado();
      } catch (error) {
        console.error("[avisoPropuestaPendiente] No se pudo leer el registro de avisos; se envía el aviso:", error instanceof Error ? error.message : error);
        lecturaFallida = true;
      }
      // Sin poder leer el registro no se puede afirmar nada: se avisa (el comportamiento de siempre), nunca se calla de más.
      if (lecturaFallida || !mapa) return true;

      const ahora = this.ahora();
      const previo = mapa.get(propuestaId);
      if (previo && ahora - previo.ultimo < VENTANA_AVISO_MS) return false;
      mapa.set(propuestaId, { fila: previo?.fila ?? 0, ultimo: ahora });
      try {
        const fila = await this.almacen.guardar(propuestaId, ahora, previo?.fila || undefined);
        mapa.set(propuestaId, { fila, ultimo: ahora });
        const vencidas = [...mapa.entries()].filter(([id, v]) => id !== propuestaId && v.fila && ahora - v.ultimo > CONSERVAR_MS);
        if (vencidas.length) {
          await this.almacen.purgar(vencidas.map(([, v]) => v.fila));
          this.memoria = undefined; // las filas cambian de posición al purgar: se recarga la próxima vez
          this.cargando = undefined;
        }
      } catch (error) {
        console.error("[avisoPropuestaPendiente] No se pudo guardar el aviso (el freno sigue activo en memoria):", error instanceof Error ? error.message : error);
      }
      return true;
    });
  }
}

export const frenoAvisoPropuesta = new FrenoAvisoPropuesta();
