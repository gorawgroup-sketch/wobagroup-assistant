import { randomUUID } from "node:crypto";
import { agregarFila, leerFilas } from "../../google/sheetsKeyValueStore";
import { conMutex } from "../../utils/asyncMutex";
import type { LoteConciliaciones } from "./model";

const TAB = "_lotes_conciliaciones_audit";
const HEADERS = ["eventoId", "loteId", "fecha", "estado", "loteJSON"];

export interface StoreLotes {
  listar(): Promise<LoteConciliaciones[]>;
  guardar(lote: LoteConciliaciones): Promise<void>;
}

/**
 * Registro append-only del lote (propuesta, aprobación, avance y resultado), con el mismo almacén de Sheets que el de los planes: nunca elimina
 * filas y comprueba por relectura que lo guardado es lo que se quiso guardar. Los pagos en sí los registra cada plan en
 * `_conciliaciones_multiples_audit`; aquí queda quién aprobó qué lote y cómo terminó. Igual que el resto, requiere UN solo proceso escritor.
 */
export const storeLotesConciliaciones: StoreLotes = {
  async listar() {
    const filas = await leerFilas(TAB, HEADERS.length, HEADERS);
    if (filas.length >= 9500) throw new Error("El registro de lotes de conciliación requiere archivado controlado antes de continuar.");
    const lotes = new Map<string, LoteConciliaciones>();
    for (const fila of filas) {
      const l = JSON.parse(fila.valores[4]) as LoteConciliaciones;
      if (!l?.id || l.id !== fila.valores[1] || l.estado !== fila.valores[3] || !Array.isArray(l.incluidos)) throw new Error("Registro de lote corrupto; se bloquean escrituras.");
      lotes.set(l.id, l);
    }
    return [...lotes.values()];
  },
  async guardar(l) {
    if (JSON.stringify(l).length > 45000) throw new Error("Lote demasiado grande para el registro durable; reduce el número de pares.");
    await conMutex(`${TAB}:eventos`, async () => {
      await this.listar();
      await agregarFila(TAB, HEADERS.length, HEADERS, [randomUUID(), l.id, new Date().toISOString(), l.estado, JSON.stringify(l)]);
      const persistido = (await this.listar()).find((x) => x.id === l.id);
      if (JSON.stringify(persistido) !== JSON.stringify(l)) throw new Error("No se pudo verificar el registro del lote; no continuar.");
    });
  },
};
