import { agregarFila, leerFilas } from "../../google/sheetsKeyValueStore";

/** Qué gastos pendientes de datos ya se le han pedido a su creador (para no pedirlo dos veces) y en qué comunicación quedó el correo. */
const TAB = "_solicitudes_datos_gasto";
const HEADERS = ["pendiente", "creador", "comunicacion", "preparadaEn"];
export const DIAS_ENTRE_SOLICITUDES = 7;

export async function pendientesYaSolicitados(ahora = Date.now()): Promise<Set<string>> {
  const desde = ahora - DIAS_ENTRE_SOLICITUDES * 86_400_000;
  return new Set((await leerFilas(TAB, HEADERS.length, HEADERS)).filter((f) => (Number(f.valores[3]) || 0) >= desde).map((f) => f.valores[0]));
}

export async function registrarSolicitudes(pendientes: Array<{ id: string; creador: string }>, comunicacion: string, ahora = Date.now()): Promise<void> {
  for (const p of pendientes) await agregarFila(TAB, HEADERS.length, HEADERS, [p.id, p.creador, comunicacion, ahora]);
}
