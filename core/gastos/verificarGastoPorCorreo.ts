import { compraTieneComprobante, HoldedApiError, obtenerCompraHoldedPorId } from "../holded/write";
import {
  marcarGastoDesdeCorreoCompletado,
  type GastoPorCorreo,
} from "./gastoPorCorreoStore";

const VENTANA_REVALIDAR_GASTO_RECIENTE_MS = 48 * 60 * 60 * 1000;

export type EstadoRegistroGastoPorCorreo =
  | "confirmado"
  | "incompleto"
  | "fantasma_eliminado"
  | "no_verificable";

interface DependenciasRevalidacion {
  obtenerCompra: typeof obtenerCompraHoldedPorId;
  tieneComprobante: typeof compraTieneComprobante;
  marcarCompletado: typeof marcarGastoDesdeCorreoCompletado;
}

const dependenciasReales: DependenciasRevalidacion = {
  obtenerCompra: obtenerCompraHoldedPorId,
  tieneComprobante: compraTieneComprobante,
  marcarCompletado: marcarGastoDesdeCorreoCompletado,
};

function numeroHolded(valor: unknown): number | undefined {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : undefined;
  if (typeof valor !== "string" || !valor.trim()) return undefined;
  const limpio = valor.includes(",")
    ? valor.replace(/\./g, "").replace(",", ".")
    : valor;
  const numero = Number(limpio);
  return Number.isFinite(numero) ? numero : undefined;
}

/**
 * La memoria por correo evita duplicados, pero no puede convertir un id del
 * POST en prueba de existencia. Revalidamos solo registros recientes: los
 * antiguos pueden ser tickets que Holded ya ocultó de /purchases y siguen
 * siendo una defensa válida. Un 404 nunca autoriza a recrear: también puede
 * significar que la compra se convirtió en ticket. Los registros completos
 * conservan su cierre; los abiertos o legacy quedan no verificables y el
 * correo sigue sin leer para revisión, sin perder la barrera antieduplicado.
 */
export async function revalidarRegistroRecienteDeCorreo(
  registro: GastoPorCorreo,
  ahora = Date.now(),
  dependencias: Partial<DependenciasRevalidacion> = dependenciasReales
): Promise<EstadoRegistroGastoPorCorreo> {
  const deps = { ...dependenciasReales, ...dependencias };
  if (registro.completado && ahora - registro.creadoEn > VENTANA_REVALIDAR_GASTO_RECIENTE_MS) {
    return "confirmado";
  }
  try {
    const compra = await deps.obtenerCompra(registro.empresa, registro.gastoId);
    if (compra.id !== registro.gastoId) return "no_verificable";
    if (registro.completado !== true) {
      const [conComprobante, pendiente] = await Promise.all([
        deps.tieneComprobante(registro.empresa, registro.gastoId),
        Promise.resolve(numeroHolded(compra.payments_pending)),
      ]);
      // Recuperación de solo lectura: si un crash ocurrió después de adjuntar
      // y conciliar pero antes de cerrar nuestra memoria, Holded mismo prueba
      // el estado terminal y evitamos pedir que se repita cualquier escritura.
      if (conComprobante && pendiente !== undefined && pendiente <= 0.005) {
        await deps.marcarCompletado({
          mensajeIdGmail: registro.mensajeIdGmail,
          gastoId: registro.gastoId,
        });
        return "confirmado";
      }
      return "incompleto";
    }
    return "confirmado";
  } catch (error) {
    if (error instanceof HoldedApiError && error.status === 404 && registro.completado === true) {
      // Una compra completada puede desaparecer de /purchases al convertirla
      // en ticket. La memoria terminal es la evidencia durable que evita
      // recrearla; borrar el registro aquí produciría un duplicado real.
      return "confirmado";
    }
    return "no_verificable";
  }
}
