export interface MetadataPestana {
  gridId: number;
  rowCount: number;
}

type CargadorMetadata = () => Promise<ReadonlyMap<string, MetadataPestana>>;

export interface DiagnosticoCacheMetadataPestanas {
  solicitudes: number;
  cargas: number;
  reutilizadas: number;
  compartidas: number;
  errores: number;
  pestanasConocidas: number;
}

/**
 * Fotografía de la estructura de un spreadsheet compartida por todos los
 * stores del proceso. No contiene celdas ni datos de negocio: solo título,
 * gridId y capacidad física de cada pestaña.
 *
 * La promesa en curso actúa como single-flight: si veinte stores arrancan a
 * la vez, todos esperan la misma llamada a spreadsheets.get. Un fallo nunca
 * queda cacheado, por lo que la siguiente operación puede reintentar.
 */
export class CacheMetadataPestanas {
  private fotografia: Map<string, MetadataPestana> | null = null;
  private cargaEnCurso: Promise<Map<string, MetadataPestana>> | null = null;
  private metricas = { solicitudes: 0, cargas: 0, reutilizadas: 0, compartidas: 0, errores: 0 };

  constructor(private readonly cargar: CargadorMetadata) {}

  async obtener(nombre: string): Promise<MetadataPestana | undefined> {
    this.metricas.solicitudes++;
    return (await this.obtenerFotografia()).get(nombre);
  }

  registrar(nombre: string, metadata: MetadataPestana): void {
    if (!this.fotografia) this.fotografia = new Map();
    this.fotografia.set(nombre, metadata);
  }

  diagnostico(): DiagnosticoCacheMetadataPestanas {
    return {
      ...this.metricas,
      pestanasConocidas: this.fotografia?.size ?? 0,
    };
  }

  private obtenerFotografia(): Promise<Map<string, MetadataPestana>> {
    if (this.fotografia) {
      this.metricas.reutilizadas++;
      return Promise.resolve(this.fotografia);
    }
    if (this.cargaEnCurso) {
      this.metricas.compartidas++;
      return this.cargaEnCurso;
    }

    this.metricas.cargas++;
    this.cargaEnCurso = this.cargar()
      .then((metadata) => {
        const fotografia = new Map(metadata);
        this.fotografia = fotografia;
        return fotografia;
      })
      .catch((error) => {
        this.metricas.errores++;
        throw error;
      })
      .finally(() => {
        this.cargaEnCurso = null;
      });
    return this.cargaEnCurso;
  }
}
