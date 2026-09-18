import { HoldedApiError, obtenerCompraHoldedPorId } from "../holded/write";
import {
  eliminarGastoDesdeCorreo,
  type GastoPorCorreo,
} from "./gastoPorCorreoStore";

const VENTANA_REVALIDAR_GASTO_RECIENTE_MS = 48 * 60 * 60 * 1000;

export type EstadoRegistroGastoPorCorreo =
  | "confirmado"
  | "fantasma_eliminado"
  | "no_verificable";

interface DependenciasRevalidacion {
  obtenerCompra: typeof obtenerCompraHoldedPorId;
  eliminarRegistro: typeof eliminarGastoDesdeCorreo;
}

const dependenciasReales: DependenciasRevalidacion = {
  obtenerCompra: obtenerCompraHoldedPorId,
  eliminarRegistro: eliminarGastoDesdeCorreo,
};

/**
 * La memoria por correo evita duplicados, pero no puede convertir un id del
 * POST en prueba de existencia. Revalidamos solo registros recientes: los
 * antiguos pueden ser tickets que Holded ya ocultó de /purchases y siguen
 * siendo una defensa válida. Un 404 reciente elimina exclusivamente esa
 * referencia fantasma y permite que el flujo descargue y lea de nuevo el
 * adjunto real. Errores distintos de 404 fallan cerrados.
 */
export async function revalidarRegistroRecienteDeCorreo(
  registro: GastoPorCorreo,
  ahora = Date.now(),
  dependencias: DependenciasRevalidacion = dependenciasReales
): Promise<EstadoRegistroGastoPorCorreo> {
  if (ahora - registro.creadoEn > VENTANA_REVALIDAR_GASTO_RECIENTE_MS) {
    return "confirmado";
  }
  try {
    const compra = await dependencias.obtenerCompra(registro.empresa, registro.gastoId);
    if (compra.id !== registro.gastoId) return "no_verificable";
    return "confirmado";
  } catch (error) {
    if (!(error instanceof HoldedApiError) || error.status !== 404) {
      return "no_verificable";
    }
    await dependencias.eliminarRegistro(
      registro.mensajeIdGmail,
      registro.attachmentId,
      registro.gastoId
    );
    return "fantasma_eliminado";
  }
}
