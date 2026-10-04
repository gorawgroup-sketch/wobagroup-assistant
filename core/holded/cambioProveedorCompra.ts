import { obtenerTodosLosAlias, registrarAliasProveedor, type FilaAlias } from "../gastos/proveedorAliasSheet";

/**
 * Cambiar el proveedor (contacto) de un gasto YA CREADO en Holded y dejar el sistema alineado. Caso real (Footprint,
 * 2026-10-04): un recibo de «Management Group Investors LLC» (Puerto Rico) quedó a nombre de «Madrid Hotel 101 Spain
 * Management, S.L.U.» (Barcelona, con NIF) y WOBI aprendió ese alias equivocado para la revisión automática.
 *
 * La edición en Holded la hace `editarCompraHolded` (verificada, con `contactoIdNuevo`); aquí vive lo que la rodea: qué
 * alias hay que corregir para que el error no se repita. Pura donde se puede, para probarla sin Sheets.
 */

export const normalizarNombreProveedor = (texto: string): string =>
  texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();

/**
 * Filas de alias que apuntan al contacto VIEJO y se llaman como el proveedor leído o como el proveedor nuevo: son las que
 * hay que re-apuntar al contacto nuevo. Nunca se toca un alias que apunte a otro contacto (p. ej. el de otro gasto con
 * ese mismo texto en otra moneda ya confirmado a mano a otro proveedor).
 */
export function aliasARepuntar(
  filas: Array<Pick<FilaAlias, "nombreDetectado" | "empresa" | "contactId" | "moneda">>,
  datos: { empresa: string; contactoViejoId: string; nombresLeidos: string[] }
): Array<{ nombreDetectado: string; moneda: string }> {
  const nombres = new Set(datos.nombresLeidos.map(normalizarNombreProveedor).filter(Boolean));
  return filas
    .filter((f) => f.empresa === datos.empresa && f.contactId === datos.contactoViejoId && nombres.has(normalizarNombreProveedor(f.nombreDetectado)))
    .map((f) => ({ nombreDetectado: f.nombreDetectado, moneda: f.moneda }));
}

export interface ResultadoAprendizajeProveedor { repuntados: number; creado: boolean }

/** Re-apunta los alias equivocados al contacto nuevo y, si no había ninguno, enseña el correcto. No lanza: es aprendizaje, el cambio ya está verificado. */
export async function aprenderProveedorCorregido(
  datos: { empresa: "WOBA" | "EWORKS" | "Footprint"; contactoViejoId: string; nombreLeido: string; nombreNuevo: string; contactoNuevoId: string; contactoNuevoNombre: string; moneda: string },
  deps = { listar: obtenerTodosLosAlias, registrar: registrarAliasProveedor }
): Promise<ResultadoAprendizajeProveedor> {
  const filas = await deps.listar();
  const objetivos = aliasARepuntar(filas, { empresa: datos.empresa, contactoViejoId: datos.contactoViejoId, nombresLeidos: [datos.nombreLeido, datos.nombreNuevo] });
  for (const o of objetivos) await deps.registrar(datos.empresa, o.nombreDetectado, datos.contactoNuevoId, datos.contactoNuevoNombre, o.moneda || undefined);
  if (objetivos.length > 0) return { repuntados: objetivos.length, creado: false };
  await deps.registrar(datos.empresa, datos.nombreLeido, datos.contactoNuevoId, datos.contactoNuevoNombre, datos.moneda || undefined);
  return { repuntados: 0, creado: true };
}
