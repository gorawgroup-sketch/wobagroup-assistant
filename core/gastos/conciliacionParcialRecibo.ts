import type { Empresa } from "../holded/client";
import { leerMovimientosCandidatos, type MovimientoBanco } from "../holded/pagosMultiples/pagos";
import { margenResiduoCentimos } from "../holded/conciliacionMultiple/model";

/**
 * Conciliación PARCIAL de un recibo cobrado en varios pagos (pedido de Carlos, 2026-10-04, hotel Metroart: 581,92 USD =
 * 451,30 + 130,62, y en el banco solo estaba el primer cargo): tras crear el gasto, WOBI ofrece conciliar esa parte con UN botón
 * y dejar el resto abierto, en vez de dejar al operador sin salida salvo «crear sin conciliar».
 *
 * La oferta nunca se hace sola ni se concilia sin el botón. Mismo criterio prudente que el cargo mayor (cargoMayor.ts): solo se
 * ofrece cuando hay UN ÚNICO cargo libre del mismo proveedor y la misma moneda alrededor de la fecha del gasto cuyo importe es
 * menor que el gasto; con varios (proveedores frecuentes como Uber) no se dice nada, porque invitaría a una conciliación
 * parcial equivocada. La ejecución usa la conciliación múltiple verificada paso a paso (modo parcial).
 */

/** Un cargo menor que esto (en proporción del gasto) no es «una parte» del recibo sino otra cosa. */
export const PROPORCION_MINIMA_PARTE = 0.1;

/**
 * Palabras demasiado genéricas para identificar a un proveedor: compartirlas no demuestra nada («Hotel Playa Sol» no es «Metroart
 * Hotel»; «Management Group Investors» no es «Madrid Hotel 101 Spain Management»).
 */
const PALABRAS_GENERICAS = new Set([
  "hotel", "hoteles", "hostal", "restaurante", "restaurant", "cafe", "cafeteria", "bar", "group", "grupo", "management", "investors",
  "company", "compania", "servicios", "services", "service", "international", "internacional", "airport", "aeropuerto", "shop", "store",
  "tienda", "payment", "payments", "pago", "pending", "the", "los", "las", "del", "and", "inc", "llc", "sas", "ltd", "corp", "sociedad",
]);
const normalizarPalabra = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** La primera palabra distintiva del proveedor (≥4 letras y no genérica), o undefined si no la tiene. */
export function palabraDistintiva(proveedor: string): string | undefined {
  return normalizarPalabra(proveedor).split(" ").find((w) => w.length >= 4 && !PALABRAS_GENERICAS.has(w));
}

/** El proveedor aparece en la descripción del banco por su palabra distintiva (no por una genérica). */
const coincideProveedor = (proveedor: string, descripcion: string): boolean => {
  const clave = palabraDistintiva(proveedor);
  return clave !== undefined && normalizarPalabra(descripcion).includes(clave);
};

/** Pura: el único cargo que puede ser una parte del gasto, o undefined. */
export function seleccionarCargoParcial(candidatos: MovimientoBanco[], gasto: { proveedor: string; monto: number }): MovimientoBanco | undefined {
  const margen = margenResiduoCentimos(Math.round(gasto.monto * 100)) / 100;
  const posibles = candidatos.filter((c) =>
    c.monto < gasto.monto - margen && c.monto >= gasto.monto * PROPORCION_MINIMA_PARTE && coincideProveedor(gasto.proveedor, c.descripcion));
  return posibles.length === 1 ? posibles[0] : undefined;
}

export interface DatosGastoParcial { empresa: Empresa; proveedor: string; monto: number; moneda: string; fecha: string }

export async function buscarCargoParcial(datos: DatosGastoParcial, leer: typeof leerMovimientosCandidatos = leerMovimientosCandidatos): Promise<MovimientoBanco | undefined> {
  // Sin una palabra distintiva del proveedor no puede haber oferta: ni se gasta una lectura del banco.
  if (!palabraDistintiva(datos.proveedor) || !(datos.monto > 0)) return undefined;
  const candidatos = await leer(datos.empresa, datos.moneda, datos.fecha);
  return seleccionarCargoParcial(candidatos, datos);
}

/** Resultado explícito: un fallo de lectura del banco NO equivale a «no hay cargo»; se dice. */
export type ConsultaCargoParcial = { tipo: "oferta"; cargo: MovimientoBanco } | { tipo: "ninguno" } | { tipo: "consulta_fallida"; motivo: string };

export async function consultarCargoParcial(datos: DatosGastoParcial, leer: typeof leerMovimientosCandidatos = leerMovimientosCandidatos): Promise<ConsultaCargoParcial> {
  if (!palabraDistintiva(datos.proveedor) || !(datos.monto > 0)) return { tipo: "ninguno" };
  try {
    const cargo = seleccionarCargoParcial(await leer(datos.empresa, datos.moneda, datos.fecha), datos);
    return cargo ? { tipo: "oferta", cargo } : { tipo: "ninguno" };
  } catch (error) {
    return { tipo: "consulta_fallida", motivo: error instanceof Error ? error.message : String(error) };
  }
}

const f2 = (n: number) => n.toFixed(2);

export function textoOfertaParcial(c: MovimientoBanco, gasto: DatosGastoParcial, descripcionGasto: string): string {
  return `Encontré en el banco UN cargo de "${c.descripcion || "(sin descripción)"}" — ${f2(c.monto)} ${c.moneda} (${c.fecha}, ${c.cuenta}), ` +
    `menor que el gasto "${descripcionGasto}" (${f2(gasto.monto)} ${gasto.moneda}): podría ser una parte del recibo si se cobró en varios pagos.\n\n` +
    `Si lo concilias, ese cargo queda conciliado y el gasto queda con ${f2(gasto.monto - c.monto)} ${gasto.moneda} ABIERTOS, a la espera del cargo que falta. ` +
    `Si no es una parte de este recibo, no lo concilies.`;
}

export interface ResultadoParcial { estado: "conciliada" | "incierta" | "fallida"; nota: string; soloLectura?: boolean }

interface ServicioParcial {
  preparar(d: { empresa: Empresa; chatId: number; compraId: string; movimientos: Array<{ accountId: string; movementId: string; fecha: string }>; motivo: string; parcial: boolean }): Promise<{ id: string }>;
  decidir(id: string, chatId: number, usuarioId: number, aprobar: boolean): Promise<{ estado: string; detalle?: string; compra: { pendienteCentimos: number; moneda: string } }>;
}

/**
 * Ejecuta la conciliación parcial al pulsar el botón. Vuelve a localizar el cargo por su id (si ya no es el único candidato o dejó
 * de estar libre, no se concilia nada) y delega en la conciliación múltiple en modo parcial, que relee Holded antes de escribir,
 * verifica el pago y no cierra ningún residuo de cambio. Nunca lanza.
 */
export async function conciliarParcialDeRecibo(
  p: { empresa: Empresa; chatId: number; gastoId: string; proveedor: string; monto: number; moneda: string; fecha: string },
  movementId: string,
  usuarioId: number,
  deps: { leer?: typeof leerMovimientosCandidatos; servicio?: ServicioParcial } = {}
): Promise<ResultadoParcial> {
  try {
    const cargo = await buscarCargoParcial(p, deps.leer);
    if (!cargo || cargo.movementId !== movementId) {
      return { estado: "fallida", nota: "\n\n⚠️ El cargo que se ofreció ya no es el único candidato libre (cambió en el banco). No concilié nada; vuelve a intentarlo desde el chat." };
    }
    const servicio = deps.servicio ?? (await import("../holded/conciliacionMultiple/runtime")).conciliacionMultiple as unknown as ServicioParcial;
    const motivo = `Recibo cobrado en varios pagos; el banco refleja por ahora este cargo de ${cargo.descripcion || p.proveedor} (${f2(cargo.monto)} ${cargo.moneda}, ${cargo.fecha}). ` +
      `Conciliación parcial aprobada por el operador con el botón; el resto del saldo queda abierto a propósito.`;
    const plan = await servicio.preparar({
      empresa: p.empresa, chatId: p.chatId, compraId: p.gastoId, parcial: true, motivo: motivo.slice(0, 500),
      movimientos: [{ accountId: cargo.accountId, movementId: cargo.movementId, fecha: cargo.fecha }],
    });
    const r = await servicio.decidir(plan.id, p.chatId, usuarioId, true);
    if (r.estado === "completado") {
      return { estado: "conciliada", nota: `\n\n✅ Conciliada la parte encontrada: ${f2(cargo.monto)} ${cargo.moneda} ("${cargo.descripcion}", ${cargo.fecha}). ` +
        `El gasto queda con ${f2(r.compra.pendienteCentimos / 100)} ${r.compra.moneda} ABIERTOS, a la espera del cargo que falta (plan ${plan.id}).` };
    }
    if (r.estado === "incierto" || r.estado === "ejecutando") {
      return { estado: "incierta", nota: `\n\n⏳ La conciliación parcial se envió pero no quedó verificada (plan ${plan.id}): ${r.detalle ?? "revisar el plan"}. No se repetirá nada automáticamente; verifica en Holded antes de volver a intentarla.` };
    }
    return { estado: "fallida", nota: `\n\n⚠️ No se concilió nada: ${r.detalle ?? `el plan quedó ${r.estado}`}.` };
  } catch (error) {
    return { estado: "fallida", nota: `\n\n⚠️ No pude preparar la conciliación parcial: ${error instanceof Error ? error.message : String(error)}. No se escribió nada en Holded.` };
  }
}
