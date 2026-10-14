import { leerComunicacion } from "../../comunicaciones/envioMasivoStore";
import { agregarFila, leerFilas } from "../../google/sheetsKeyValueStore";

/** Qué gastos pendientes de datos ya se le han pedido a su creador (para no pedirlo dos veces) y en qué comunicación quedó el correo. */
const TAB = "_solicitudes_datos_gasto";
const HEADERS = ["pendiente", "creador", "comunicacion", "preparadaEn"];
export const DIAS_ENTRE_SOLICITUDES = 7;

type LeerComunicacion = (id: string) => Promise<{ destinatarios: Array<{ estado: string }> } | undefined>;

/**
 * Pendientes que ya se pidieron hace poco, a partir de las filas del registro. Una solicitud CANCELADA (todos sus destinatarios omitidos) no cuenta como pedida:
 * caso real 2026-10-14, el correo a Kelly se canceló y el sistema lo daba por pedido durante 7 días. Sin comunicación enlazada (registros antiguos) o con la
 * lectura fallida se mantiene como pedida: no se molesta dos veces a alguien por un fallo de lectura.
 */
export async function pendientesVigentes(filas: ReadonlyArray<string[]>, ahora: number, leer: LeerComunicacion): Promise<Set<string>> {
  const desde = ahora - DIAS_ENTRE_SOLICITUDES * 86_400_000;
  const recientes = filas.filter((f) => (Number(f[3]) || 0) >= desde);
  const vigentes = new Map<string, boolean>();
  for (const id of new Set(recientes.map((f) => f[2]))) {
    if (!id || id === "preparada") { vigentes.set(id, true); continue; }
    try {
      const c = await leer(id);
      vigentes.set(id, c ? c.destinatarios.some((d) => d.estado !== "omitido") : true);
    } catch (error) {
      // Un fallo de lectura no demuestra que se cancelara: se sigue dando por pedida y se anota.
      console.error(`[solicitudDatos] No se pudo leer la comunicación ${id}; la solicitud se mantiene como pedida:`, error instanceof Error ? error.message : error);
      vigentes.set(id, true);
    }
  }
  return new Set(recientes.filter((f) => vigentes.get(f[2])).map((f) => f[0]));
}

export async function pendientesYaSolicitados(ahora = Date.now(), leer: LeerComunicacion = leerComunicacion): Promise<Set<string>> {
  return pendientesVigentes((await leerFilas(TAB, HEADERS.length, HEADERS)).map((f) => f.valores), ahora, leer);
}

export async function registrarSolicitudes(pendientes: Array<{ id: string; creador: string }>, comunicacion: string, ahora = Date.now()): Promise<void> {
  for (const p of pendientes) await agregarFila(TAB, HEADERS.length, HEADERS, [p.id, p.creador, comunicacion, ahora]);
}
