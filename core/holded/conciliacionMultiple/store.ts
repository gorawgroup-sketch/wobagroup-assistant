import { randomUUID } from "node:crypto";
import { agregarFila, leerFilas } from "../../google/sheetsKeyValueStore";
import { conMutex } from "../../utils/asyncMutex";
import type { Empresa } from "../client";
import { claveMovimiento, reservaActiva, type PlanConciliacion, type StorePlanes } from "./model";

const TAB = "_conciliaciones_multiples_audit";
const HEADERS = ["eventoId", "planId", "fecha", "estado", "planJSON"];

/** Registro append-only: propuestas, aprobación, POST en vuelo y verificaciones sobreviven a redeploys.
 * Igual que el KV existente, requiere UN solo proceso escritor (Sheets no ofrece CAS).
 * Nunca elimina filas: evita desplazamientos y conserva toda la evidencia de cada intento.
 */
export const storeConciliacionMultiple: StorePlanes = {
  async listar() {
    const filas = await leerFilas(TAB, HEADERS.length, HEADERS);
    if (filas.length >= 9500) throw new Error("El registro de conciliación requiere archivado controlado antes de continuar.");
    const planes = new Map<string, PlanConciliacion>();
    for (const fila of filas) {
      const p = JSON.parse(fila.valores[4]) as PlanConciliacion;
      if (!p?.id || p.id !== fila.valores[1] || p.estado !== fila.valores[3] || !p.compra?.id || !Array.isArray(p.movimientos)) {
        throw new Error("Registro de conciliación corrupto; se bloquean escrituras.");
      }
      planes.set(p.id, p);
    }
    return [...planes.values()];
  },
  async guardar(p) {
    if (JSON.stringify(p).length > 45000) throw new Error("Plan demasiado grande para el registro durable; reduce el lote.");
    await conMutex(`${TAB}:eventos`, async () => {
      // Margen para completar un lote sin alcanzar el límite de lectura del KV.
      await this.listar();
      await agregarFila(TAB, HEADERS.length, HEADERS, [randomUUID(), p.id, new Date().toISOString(), p.estado, JSON.stringify(p)]);
      const persistido = (await this.listar()).find((plan) => plan.id === p.id);
      if (JSON.stringify(persistido) !== JSON.stringify(p)) throw new Error("No se pudo verificar el registro del plan; no continuar.");
    });
  },
};

/** La ruta antigua también respeta reservas del lote (incluye estados inciertos tras reinicios). */
export async function comprobarReservaConciliacionMultiple(empresa: Empresa, compraId: string, accountId: string, movementId: string): Promise<void> {
  const planes = await storeConciliacionMultiple.listar();
  const reservado = planes.find((p) => p.empresa === empresa && reservaActiva(p) &&
    (p.compra.id === compraId || p.movimientos.some((m) => claveMovimiento(m) === `${accountId}/${movementId}`)));
  if (reservado) throw new Error(`Operación bloqueada por el plan de conciliación múltiple ${reservado.id} (${reservado.estado}). Consulta ese plan.`);
}

export async function buscarPlanActivoDeCompra(empresa: Empresa, compraId: string): Promise<PlanConciliacion | undefined> {
  return (await storeConciliacionMultiple.listar()).find((p) => p.empresa === empresa && p.compra.id === compraId && reservaActiva(p));
}
