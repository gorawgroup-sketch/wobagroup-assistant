import type { Empresa } from "../client";
import { claveTicket } from "./tickets";
import { nuevoTrabajo, type AlmacenTrabajos, type Trabajo } from "./trabajos";

/**
 * Decisiones de Carlos sobre la conversión a ticket (botones del chat). Solo tocan el registro propio de WOBI: la conversión real en
 * Holded la hace después la cola, con todas sus comprobaciones (creado por WOBI, conciliado, comprobante, cuidados).
 */
export type ResultadoDecision = "aprobado" | "rechazado" | "no_encontrado" | "ya_resuelto";

/** «Convertir a ticket»: el gasto dudoso pasa a la cola con la aprobación escrita de Carlos. */
export async function aprobarDudoso(almacen: AlmacenTrabajos, empresa: Empresa, id: string, ahora = Date.now()): Promise<ResultadoDecision> {
  const t = await almacen.obtener(claveTicket(empresa, id));
  if (!t) return "no_encontrado";
  if (t.estado !== "requiere_intervencion" || t.evidencia.origen !== "regla_revisar") return "ya_resuelto";
  t.estado = "solicitado"; t.ultimoError = undefined; t.actualizadoEn = ahora;
  t.evidencia = { ...t.evidencia, origen: "lista_aprobada", aprobadoPorCarlos: true, clasificacion: "ticket" };
  await almacen.guardar(t);
  await almacen.evento(t.clave, "aprobado_por_boton", {});
  return "aprobado";
}

/** «No es ticket»: se cierra sin convertir y no se vuelve a preguntar por este gasto. */
export async function rechazarDudoso(almacen: AlmacenTrabajos, empresa: Empresa, id: string, ahora = Date.now()): Promise<ResultadoDecision> {
  const t = await almacen.obtener(claveTicket(empresa, id));
  if (!t) return "no_encontrado";
  if (t.estado !== "requiere_intervencion" || t.evidencia.origen !== "regla_revisar") return "ya_resuelto";
  t.estado = "omitido"; t.ultimoError = "Carlos indicó que no es un ticket"; t.actualizadoEn = ahora;
  await almacen.guardar(t);
  await almacen.evento(t.clave, "rechazado_por_boton", {});
  return "rechazado";
}

/** «Reanudar conversión»: da por revisados los casos con cambios inesperados de las últimas 24 h para que el disyuntor se rearme. */
export async function reanudarDisyuntor(almacen: AlmacenTrabajos, ahora = Date.now()): Promise<number> {
  let n = 0;
  for (const t of await almacen.listar({ tipo: "ticket", estados: ["requiere_intervencion"], desde: ahora - 24 * 3_600_000 })) {
    if (!Array.isArray(t.evidencia.camposCambiados) || t.evidencia.camposCambiados.length === 0) continue;
    t.evidencia = { ...t.evidencia, camposCambiadosRevisados: t.evidencia.camposCambiados, camposCambiados: undefined, revisadoPorCarlos: true };
    t.actualizadoEn = ahora;
    await almacen.guardar(t);
    await almacen.evento(t.clave, "disyuntor_reanudado", {});
    n++;
  }
  return n;
}

/** Registro de un gasto DUDOSO pendiente de la decisión de Carlos (la regla no pudo decidir sola). */
export async function registrarDudoso(almacen: AlmacenTrabajos, d: { empresa: Empresa; id: string; proveedor: string; motivos: string[] }, ahora = Date.now()): Promise<boolean> {
  const clave = claveTicket(d.empresa, d.id);
  if (await almacen.obtener(clave)) return false;
  const t = nuevoTrabajo({ clave, tipo: "ticket", empresa: d.empresa, objetivo: d.id }, ahora);
  t.estado = "requiere_intervencion"; t.ultimoError = "Pendiente de tu decisión (botón en el chat)";
  t.evidencia = { origen: "regla_revisar", proveedor: d.proveedor, motivos: d.motivos };
  await almacen.guardar(t);
  await almacen.evento(clave, "dudoso_pendiente_de_decision", { motivos: d.motivos });
  return true;
}

/**
 * El gasto que crea WOBI ya trae un registro PROVISIONAL («Clasificación dudosa», 0 intentos, origen «recepcion»). Cuando la regla
 * tampoco puede decidir, ese registro se convierte en la pregunta pendiente de Carlos (origen «regla_revisar», la que atienden los
 * botones «Convertir a ticket / No es ticket»). Antes `registrarDudoso` veía el registro y no hacía nada: la pregunta no llegaba nunca
 * (caso real 08-10-2026, Footprint: cuatro tickets de Colombia sin convertir y sin que nadie preguntara). Devuelve true si hay que preguntar.
 */
export async function convertirProvisionalEnDudoso(
  almacen: AlmacenTrabajos, previo: Trabajo, d: { proveedor: string; motivos: string[] }, ahora = Date.now(),
): Promise<boolean> {
  previo.estado = "requiere_intervencion"; previo.ultimoError = "Pendiente de tu decisión (botón en el chat)"; previo.actualizadoEn = ahora;
  previo.evidencia = {
    ...previo.evidencia, origen: "regla_revisar", proveedor: d.proveedor, motivos: d.motivos,
    clasificacionProvisional: { clasificacion: previo.evidencia.clasificacion, motivos: previo.evidencia.motivos },
  };
  await almacen.guardar(previo);
  await almacen.evento(previo.clave, "dudoso_pendiente_de_decision", { motivos: d.motivos, desdeProvisional: true });
  return true;
}
