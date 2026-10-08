import type { ResultadoVigilante } from "../vigilante/vigilante";
import type { ContenidoInforme, Informe } from "../vigilante/informe";
import type { EntradaBitacora } from "./tipos";

/** Ayudas de prueba de esta carpeta (nada de esto se usa en producción). */
export function entrada(parcial: Partial<EntradaBitacora> = {}): EntradaBitacora {
  return {
    id: "k1abc", cuando: "2026-10-08T15:35:07.000Z", tarea: "vigilante", origen: "programada", resultado: "sin_novedades",
    resumen: "Banco, correo y registro revisados: sin novedades", detalle: {}, ...parcial,
  };
}

const contenidoVacio = (): ContenidoInforme => ({
  hoy: "2026-10-08", devoluciones: [], confirmados: [], enTransito: [], cargos: [], correos: [], ambiguos: [], sinPago: [], advertencias: [], fallosPersistentes: [],
});

/** Un resultado del vigilante con lo que cada prueba necesite: `nuevo` es lo de esta revisión, `ahora` la situación completa. */
export function resultadoVigilante(opciones: { nuevo?: Partial<ContenidoInforme>; ahora?: Partial<ContenidoInforme>; informe?: Informe | null } = {}): ResultadoVigilante {
  return {
    hoy: "2026-10-08",
    contenido: { ...contenidoVacio(), ...opciones.nuevo },
    situacion: { ...contenidoVacio(), ...opciones.ahora },
    informe: opciones.informe ?? null,
    respuestaChat: "",
    clavesAvisadas: [],
    pendienteEnvio: null,
    escribioRegistro: false,
  };
}

/** n elementos opacos para rellenar las listas de un resultado (las entradas solo cuentan cuántos hay). */
export const items = (n: number): never[] => Array.from({ length: n }, () => ({}) as never);
