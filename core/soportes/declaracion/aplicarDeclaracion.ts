import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { descargarArchivoDrive } from "../../drive/client";
import { procesarGastoEntrante } from "../../gastos/procesarGastoEntrante";
import { adjuntarComprobanteHolded, verificarDuplicadoGastoEstricto } from "../../holded/write";
import type { Empresa } from "../../holded/client";
import { sendTelegramMessage, sendTelegramMessageWithButtons } from "../../telegram/client";
import { actualizarDeclaracion, type CargoDeclarado, type Declaracion } from "./declaracionStore";

/**
 * Paso C del flujo «declaración de gastos sin soporte» (Carlos, 12-10-2026): con la declaración FIRMADA, ese mismo documento
 * pasa a ser el soporte de cada cargo que relaciona, en cualquier empresa y para cualquier persona. Dos situaciones por cargo:
 *  - el gasto YA existe en Holded (compra única localizada por proveedor, importe y fecha) → se le adjunta la declaración;
 *  - no existe → se propone crearlo con la declaración como comprobante, por el mismo camino de siempre (propuesta con
 *    «Crear y conciliar», contacto, duplicados, conciliación), que ya tiene todas las protecciones.
 * Nada se escribe sin el botón «Aplicar»; cada gasto nuevo lleva además su propio botón. Un cargo con varias compras
 * posibles se deja a mano y se dice.
 */
const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

export type SituacionCargo = "existente" | "nuevo" | "ambiguo" | "ya_aplicado";
export interface CargoPlanificado { cargo: CargoDeclarado; situacion: SituacionCargo; compraId?: string; detalle?: string }
export interface PlanAplicacion { declaracion: Declaracion; cargos: CargoPlanificado[] }

export interface LectorHoldedPlan {
  compras: (empresa: Empresa, c: CargoDeclarado) => Promise<{ compras: Array<{ id: string; contactName: string; total: number; fecha: string }> }>;
}

const lectorReal: LectorHoldedPlan = {
  compras: (empresa, c) => verificarDuplicadoGastoEstricto(empresa, { proveedor: c.lugar, monto: c.valor, fecha: c.fecha, moneda: c.moneda }),
};

/** Clasifica cada cargo (lógica pura sobre lo que Holded devuelve). */
export function clasificarCargo(c: CargoDeclarado, compras: Array<{ id: string; contactName: string; total: number; fecha: string }>): CargoPlanificado {
  if (c.estadoSoporte === "adjuntado" || c.estadoSoporte === "propuesto") return { cargo: c, situacion: "ya_aplicado", compraId: c.compraId };
  if (compras.length === 1) return { cargo: c, situacion: "existente", compraId: compras[0].id, detalle: `${compras[0].contactName} · ${compras[0].total} · ${compras[0].fecha}` };
  if (compras.length > 1) return { cargo: c, situacion: "ambiguo", detalle: compras.map((x) => `${x.contactName} ${x.total} ${x.fecha}`).join(" / ") };
  return { cargo: c, situacion: "nuevo" };
}

export async function planificarAplicacion(d: Declaracion, lector: LectorHoldedPlan = lectorReal): Promise<PlanAplicacion> {
  const cargos: CargoPlanificado[] = [];
  for (const c of d.cargos) {
    if (c.estadoSoporte === "adjuntado" || c.estadoSoporte === "propuesto") { cargos.push(clasificarCargo(c, [])); continue; }
    const { compras } = await lector.compras(d.empresa as Empresa, c);
    cargos.push(clasificarCargo(c, compras));
  }
  return { declaracion: d, cargos };
}

export function textoPlan(p: PlanAplicacion): string {
  const n = (s: SituacionCargo) => p.cargos.filter((x) => x.situacion === s);
  const linea = (x: CargoPlanificado) => `  • ${x.cargo.fecha} · ${x.cargo.lugar} · ${x.cargo.valor.toFixed(2)} ${x.cargo.moneda}${x.detalle ? ` → ${x.detalle}` : ""}`;
  const partes = [`📎 Declaración firmada de ${p.declaracion.titular} (${p.declaracion.empresa}): soporte para ${p.declaracion.cargos.length} cargo(s).`];
  if (n("existente").length) partes.push(`Ya registrados en Holded (se les adjunta la declaración): ${n("existente").length}`, ...n("existente").map(linea));
  if (n("nuevo").length) partes.push(`Sin gasto en Holded (se propone crearlos con la declaración como comprobante, cada uno con su botón): ${n("nuevo").length}`, ...n("nuevo").map(linea));
  if (n("ambiguo").length) partes.push(`Con varias compras posibles (los dejo a mano): ${n("ambiguo").length}`, ...n("ambiguo").map(linea));
  if (n("ya_aplicado").length) partes.push(`Ya aplicados antes: ${n("ya_aplicado").length}`);
  return partes.join("\n");
}

export async function proponerAplicacion(chatId: number, d: Declaracion): Promise<void> {
  const plan = await planificarAplicacion(d);
  const accionables = plan.cargos.filter((x) => x.situacion === "existente" || x.situacion === "nuevo");
  if (!accionables.length) {
    await sendTelegramMessage(chatId, `${textoPlan(plan)}\n\nNo hay nada que aplicar automáticamente.`);
    return;
  }
  await sendTelegramMessageWithButtons(chatId, `${textoPlan(plan)}\n\n¿Aplico? Adjunto la declaración a los ya registrados y te propongo los nuevos con sus botones.`, [
    [{ text: `✅ Aplicar como soporte (${accionables.length})`, callback_data: `decl_aplicar:${d.id}` }],
    [{ text: "⏸️ Ahora no", callback_data: `decl_noaplicar:${d.id}` }],
  ]);
}

async function descargarFirmada(d: Declaracion): Promise<{ rutaLocal: string; nombre: string; mimeType: string }> {
  if (!d.archivoFirmadoDriveId) throw new Error("La declaración no tiene archivo firmado en Drive.");
  const a = await descargarArchivoDrive(d.archivoFirmadoDriveId);
  await mkdir(UPLOADS_DIR, { recursive: true });
  const ext = (a.name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".pdf").toLowerCase();
  const rutaLocal = join(UPLOADS_DIR, `${Date.now()}_declaracion_firmada_${d.id}${ext}`);
  await writeFile(rutaLocal, a.bytes);
  return { rutaLocal, nombre: a.name, mimeType: a.mimeType };
}

export interface ResultadoAplicacion { adjuntados: number; propuestos: number; fallos: string[] }

/** Ejecuta el plan tras el botón «Aplicar»: adjunta a los existentes y propone los nuevos; actualiza el estado por cargo. */
export async function aplicarDeclaracion(chatId: number, d: Declaracion): Promise<ResultadoAplicacion> {
  const plan = await planificarAplicacion(d);
  const firmada = await descargarFirmada(d);
  const resultado: ResultadoAplicacion = { adjuntados: 0, propuestos: 0, fallos: [] };
  const cargos = d.cargos.map((c) => ({ ...c }));
  const marcar = (id: string, cambios: Partial<CargoDeclarado>) => { const i = cargos.findIndex((c) => c.id === id); if (i >= 0) cargos[i] = { ...cargos[i], ...cambios }; };
  try {
    for (const x of plan.cargos) {
      try {
        if (x.situacion === "existente" && x.compraId) {
          await adjuntarComprobanteHolded(d.empresa as Empresa, x.compraId, firmada.rutaLocal, firmada.nombre, firmada.mimeType,
            { idempotencyKey: `declaracion:${d.id}:cargo:${x.cargo.id}:compra:${x.compraId}`, proceso: "declaracion_soporte" });
          marcar(x.cargo.id, { estadoSoporte: "adjuntado", compraId: x.compraId });
          resultado.adjuntados++;
        } else if (x.situacion === "nuevo") {
          // Copia propia por cargo: el flujo de gasto consume (y borra) el archivo que se le entrega.
          const copia = join(UPLOADS_DIR, `${Date.now()}_${x.cargo.id}_${firmada.nombre}`);
          await copyFile(firmada.rutaLocal, copia);
          const salida = await procesarGastoEntrante({
            chatId, rutaLocal: copia, nombreArchivoOriginal: firmada.nombre, mimeType: firmada.mimeType,
            datos: {
              esFacturaOGasto: true, proveedor: x.cargo.lugar, monto: x.cargo.valor, moneda: x.cargo.moneda, fecha: x.cargo.fecha,
              concepto: `Gasto sin comprobante · ${x.cargo.lugar} · declarado y firmado por ${d.titular}`, numeroDocumento: `DECL-${d.id}-${x.cargo.id}`,
              reciboSimplificado: true, lineas: [{ concepto: `Gasto sin comprobante (${x.cargo.lugar})`, base: x.cargo.valor, tipoIvaPct: 0 }],
              empresaProbable: d.empresa as Empresa, personaAsociada: d.titular, confianza: "alta",
              razon: `Soporte: declaración de gastos sin soporte firmada por ${d.titular} (${d.nombreArchivo}); cubre ${d.cargos.length} cargo(s).`,
            },
          });
          marcar(x.cargo.id, { estadoSoporte: salida === "propuesta_duplicada" ? "adjuntado" : "propuesto" });
          resultado.propuestos++;
        }
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        resultado.fallos.push(`${x.cargo.lugar} ${x.cargo.valor.toFixed(2)}: ${detalle}`);
        console.error(`[declaracion] Fallo aplicando el cargo ${x.cargo.id} de ${d.id}:`, detalle);
      }
    }
  } finally {
    await unlink(firmada.rutaLocal).catch(() => undefined);
  }
  const pendientes = cargos.filter((c) => !c.estadoSoporte);
  await actualizarDeclaracion(d.id, { cargos, estado: pendientes.length === 0 ? "aplicada" : d.estado,
    nota: `${d.nota ? `${d.nota} ` : ""}[${new Date().toISOString().slice(0, 10)}: aplicada → ${resultado.adjuntados} adjuntados, ${resultado.propuestos} propuestos${resultado.fallos.length ? `, ${resultado.fallos.length} fallos` : ""}]` });
  return resultado;
}
