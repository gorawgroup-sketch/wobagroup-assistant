/**
 * Cambios que el especialista PROPONE y una persona aprueba con un botón.
 *
 * Por qué no escribe directo (revisión independiente, 05/10/2026): la frase que el agente cita para justificar una
 * escritura la redacta el modelo del chat principal, y "la frase está en el mensaje" prueba presencia, no intención
 * («¿Ya pagué el recibo de Markel?» contiene «ya pagué el recibo de Markel»). Ningún control sobre el texto sustituye a
 * una persona que ve exactamente qué va a cambiar y lo aprueba. Es el mismo patrón de todo lo que escribe en este
 * sistema: se propone, se muestra el antes y el ahora, y solo el botón de un superadministrador lo aplica.
 *
 * Una propuesta lleva la VERSIÓN de la fila que se leyó al prepararla: si alguien (o el vigilante) la cambió mientras
 * tanto, no se aplica —se pide de nuevo— y nunca se pisa su cambio ni la prueba de pago que vigila el vigilante.
 */
import { createHash, randomUUID } from "node:crypto";
import { leerFilas, agregarFila, actualizarFila, eliminarFila } from "../../google/sheetsKeyValueStore";
import type { PolizaConFila } from "../polizaRegistroSheet";
import type { EstadoPago, EstadoPoliza, Poliza } from "../types";
import {
  agregarConocimiento,
  esRecuerdoRetirable,
  leerConocimiento,
  TIPOS_CONOCIMIENTO,
  type AlmacenConocimiento,
  type TipoConocimiento,
} from "./conocimiento";
import { diaMes } from "../vigilante/fechas";
import { parsearImporteSimple } from "../vigilante/importes";

export type AccionCambio = "actualizar_poliza" | "recordar" | "retirar_recuerdo";

export interface DatosActualizarPoliza {
  polizaId: string;
  cambios: Record<string, string>;
  motivo: string;
  /** Huella de la fila tal como estaba al preparar la propuesta. */
  versionFila: string;
}
export interface DatosRecordar { tipo: TipoConocimiento; texto: string }
export interface DatosRetirar { id: string; motivo: string }

export interface CambioPendiente {
  id: string;
  chatId: number;
  messageId: number;
  accion: AccionCambio;
  /** JSON de DatosActualizarPoliza | DatosRecordar | DatosRetirar. */
  datos: string;
  /** Frase de la persona en la que se apoya la propuesta (informativa; decide el botón). */
  cita: string;
  creadoEn: number;
}

// --- validación (pura) ---------------------------------------------------------------------------------------------

export const CAMPOS_EDITABLES = [
  "estado", "estadoPago", "prima", "periodicidad", "fechaInicioVigencia", "fechaVencimiento", "capitalAsegurado", "franquicia",
  "cuentaDeCargo", "numeroPoliza", "tipoCobertura", "activoAsociado", "aseguradora", "correduria", "moneda",
] as const;
export type CampoEditable = (typeof CAMPOS_EDITABLES)[number];
const ESTADOS: readonly EstadoPoliza[] = ["vigente", "vencida", "no_contratada", "pendiente_confirmacion"];
const ESTADOS_PAGO: readonly EstadoPago[] = ["pagado", "pendiente", "sin_confirmar", "no_aplica"];
const CAMPOS_FECHA: readonly string[] = ["fechaInicioVigencia", "fechaVencimiento"];

/** Una fecha AAAA-MM-DD que existe en el calendario (2026-13-45 no). */
export function esFechaReal(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const d = new Date(`${valor}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === valor;
}

/** Devuelve el motivo del rechazo, o null si el valor es válido para ese campo. */
export function validarCambio(campo: string, valor: unknown): string | null {
  if (!(CAMPOS_EDITABLES as readonly string[]).includes(campo)) return `el campo «${campo}» no se puede cambiar (editables: ${CAMPOS_EDITABLES.join(", ")})`;
  if (typeof valor !== "string") return `el valor de «${campo}» debe ser texto`;
  if (valor.length > 600) return `el valor de «${campo}» es demasiado largo`;
  if (campo === "estado" && !(ESTADOS as readonly string[]).includes(valor)) return `«estado» solo admite ${ESTADOS.join(", ")}`;
  if (campo === "estadoPago" && !(ESTADOS_PAGO as readonly string[]).includes(valor)) return `«estadoPago» solo admite ${ESTADOS_PAGO.join(", ")}`;
  if (CAMPOS_FECHA.includes(campo) && valor !== "" && !esFechaReal(valor)) return `«${campo}» debe ser una fecha real AAAA-MM-DD (o vacía)`;
  // Una prima en texto libre saca la póliza del cruce automático con el banco: el detalle va en las notas.
  if (campo === "prima" && valor !== "" && parsearImporteSimple(valor) == null) return "«prima» debe ser un importe limpio como 1475.84 (el detalle de cuotas va en las notas)";
  return null;
}

/** Huella de todos los campos de la fila: cambia con cualquier edición, de quien sea. */
export function versionFila(p: PolizaConFila): string {
  const { rowIndex: _rowIndex, ...campos } = p;
  return createHash("sha1").update(JSON.stringify(Object.entries(campos).sort(([a], [b]) => a.localeCompare(b)))).digest("hex").slice(0, 16);
}

const etiqueta = (p: PolizaConFila) => `[${p.empresa}] ${p.tipoCobertura}${p.numeroPoliza ? ` (${p.numeroPoliza})` : ""}`;

/** Diferencias reales entre la fila y los cambios pedidos: «campo: «antes» → «ahora»». */
export function diferencias(p: PolizaConFila, cambios: Record<string, string>): string[] {
  return Object.entries(cambios)
    .filter(([campo, nuevo]) => String((p as unknown as Record<string, string>)[campo] ?? "") !== nuevo)
    .map(([campo, nuevo]) => `${campo}: «${String((p as unknown as Record<string, string>)[campo] ?? "") || "vacío"}» → «${nuevo || "vacío"}»`);
}

/** El mensaje que ve quien va a aprobar: exactamente qué cambia, y que no cambia nada hasta que pulse. */
export function textoDePropuesta(accion: AccionCambio, datos: DatosActualizarPoliza | DatosRecordar | DatosRetirar, cita: string, poliza?: PolizaConFila): string {
  const peticion = cita ? `\nPetición: «${cita.slice(0, 200)}»` : "";
  const pie = "\n\nNo se cambia nada hasta que lo apruebes.";
  if (accion === "actualizar_poliza") {
    const d = datos as DatosActualizarPoliza;
    return `🛡️ Wobi Seguros propone un cambio en el registro\nPóliza: ${poliza ? etiqueta(poliza) : d.polizaId}\n${poliza ? diferencias(poliza, d.cambios).map((l) => `• ${l}`).join("\n") : ""}\nMotivo: ${d.motivo}${peticion}${pie}`;
  }
  if (accion === "recordar") {
    const d = datos as DatosRecordar;
    return `🛡️ Wobi Seguros propone recordar (${d.tipo})\n«${d.texto}»${peticion}${pie}`;
  }
  const d = datos as DatosRetirar;
  return `🛡️ Wobi Seguros propone retirar de su memoria el recuerdo ${d.id}\nMotivo: ${d.motivo}${peticion}${pie}`;
}

// --- almacén de pendientes ------------------------------------------------------------------------------------------

export interface AlmacenCambios {
  crear(datos: Omit<CambioPendiente, "id" | "creadoEn" | "messageId">): Promise<CambioPendiente>;
  actualizarMessageId(id: string, messageId: number): Promise<void>;
  /** Lee la propuesta SIN retirarla (para comprobar el chat antes de decidirla). */
  ver(id: string): Promise<CambioPendiente | undefined>;
  /** Devuelve la propuesta y la RETIRA (aprobada o cancelada): una propuesta solo se decide una vez. */
  consumir(id: string): Promise<CambioPendiente | undefined>;
}

const TAB_NAME = "_pendientes_cambio_seguros";
const HEADERS = ["id", "chatId", "messageId", "accion", "datos", "cita", "creadoEn"];
const NUM_COLS = HEADERS.length;
const TTL_MS = 24 * 60 * 60 * 1000;

function filaAObjeto(v: string[]): CambioPendiente | null {
  if (!v[0] || !v[3] || !v[4]) return null;
  return { id: v[0], chatId: Number(v[1]), messageId: Number(v[2]), accion: v[3] as AccionCambio, datos: v[4], cita: v[5] ?? "", creadoEn: Number(v[6]) };
}
const objetoAFila = (c: CambioPendiente): (string | number)[] => [c.id, c.chatId, c.messageId, c.accion, c.datos, c.cita, c.creadoEn];

async function leerVigentes(): Promise<Array<{ rowIndex: number; cambio: CambioPendiente }>> {
  const ahora = Date.now();
  return (await leerFilas(TAB_NAME, NUM_COLS, HEADERS))
    .map((f) => ({ rowIndex: f.rowIndex, cambio: filaAObjeto(f.valores) }))
    .filter((f): f is { rowIndex: number; cambio: CambioPendiente } => f.cambio !== null && ahora - f.cambio.creadoEn <= TTL_MS);
}

export const almacenCambiosReal: AlmacenCambios = {
  async crear(datos) {
    const cambio: CambioPendiente = { ...datos, id: `sc${randomUUID().slice(0, 8)}`, messageId: 0, creadoEn: Date.now() };
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, objetoAFila(cambio));
    return cambio;
  },
  async actualizarMessageId(id, messageId) {
    const fila = (await leerVigentes()).find((f) => f.cambio.id === id);
    if (fila) await actualizarFila(TAB_NAME, fila.rowIndex, NUM_COLS, objetoAFila({ ...fila.cambio, messageId }));
  },
  async ver(id) {
    return (await leerVigentes()).find((f) => f.cambio.id === id)?.cambio;
  },
  async consumir(id) {
    const fila = (await leerVigentes()).find((f) => f.cambio.id === id);
    if (!fila) return undefined;
    await eliminarFila(TAB_NAME, fila.rowIndex, HEADERS);
    return fila.cambio;
  },
};

// --- aplicar (tras el botón) -----------------------------------------------------------------------------------------

export interface DepsAplicar {
  hoy(): string;
  listarPolizas(): Promise<PolizaConFila[]>;
  actualizarPoliza(rowIndex: number, poliza: Poliza): Promise<void>;
  conocimiento: AlmacenConocimiento;
  invalidarCerebro(): void;
}

export interface ResultadoAplicar {
  ok: boolean;
  mensaje: string;
}

/** Texto libre para una nota: una línea, acotado, y sin «|» (separa las notas del registro y las frases «PRÓXIMO PAGO»). */
const unaLinea = (v: unknown, max: number) => String(v ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, max);

const refrescar = (deps: DepsAplicar) => {
  try { deps.invalidarCerebro(); } catch (error) { console.error("[agenteSeguros] No se pudo refrescar Cerebro (no crítico):", error); }
};

export async function aplicarCambio(cambio: CambioPendiente, aprobadoPor: string, deps: DepsAplicar): Promise<ResultadoAplicar> {
  const hoy = deps.hoy();
  const quien = unaLinea(aprobadoPor, 80) || "un superadministrador";
  let datos: unknown;
  try { datos = JSON.parse(cambio.datos); } catch { return { ok: false, mensaje: "La propuesta está dañada; vuelve a pedírmela." }; }

  if (cambio.accion === "actualizar_poliza") {
    const d = datos as DatosActualizarPoliza;
    const cambios = d.cambios && typeof d.cambios === "object" ? d.cambios : {};
    if (Object.keys(cambios).length === 0) return { ok: false, mensaje: "No se aplicó: la propuesta no traía ningún cambio." };
    for (const [campo, valor] of Object.entries(cambios)) {
      const problema = validarCambio(campo, valor);
      if (problema) return { ok: false, mensaje: `No se aplicó: ${problema}.` };
    }
    const poliza = (await deps.listarPolizas()).find((p) => p.id === d.polizaId);
    if (!poliza) return { ok: false, mensaje: `No se aplicó: ya no existe la póliza «${d.polizaId}».` };
    if (versionFila(poliza) !== d.versionFila) {
      return { ok: false, mensaje: "No se aplicó: la póliza cambió desde que preparé la propuesta (alguien la editó o el vigilante la actualizó). Pídemelo de nuevo y lo preparo con lo último." };
    }
    const dif = diferencias(poliza, cambios);
    if (dif.length === 0) return { ok: true, mensaje: "Sin cambios: el registro ya tenía esos valores." };
    const nueva: PolizaConFila = { ...poliza };
    for (const [campo, valor] of Object.entries(cambios)) (nueva as unknown as Record<string, string>)[campo] = valor;
    nueva.ultimaVerificacion = hoy;
    nueva.notas = `✍️ Wobi Seguros (${hoy}), a petición de la persona («${unaLinea(cambio.cita, 120)}») y aprobado por ${quien}: ${unaLinea(d.motivo, 300)}. Cambios: ${dif.join("; ")}.${poliza.notas ? ` || ${poliza.notas}` : ""}`;
    const { rowIndex, ...sinFila } = nueva;
    await deps.actualizarPoliza(rowIndex, sinFila);
    refrescar(deps);
    console.log("[agenteSeguros] cambio aplicado", JSON.stringify({ accion: cambio.accion, poliza: poliza.id, campos: dif.length }));
    return { ok: true, mensaje: `Registro actualizado (${etiqueta(poliza)}): ${dif.join("; ")}. Queda constancia en las notas.` };
  }

  if (cambio.accion === "recordar") {
    const d = datos as DatosRecordar;
    if (!(TIPOS_CONOCIMIENTO as readonly string[]).includes(d.tipo)) return { ok: false, mensaje: "No se aplicó: tipo de recuerdo inválido." };
    const guardada = await agregarConocimiento({ tipo: d.tipo, texto: d.texto, fuente: `${quien}, ${diaMes(hoy)}/${hoy.slice(0, 4)}`, fecha: hoy }, deps.conocimiento);
    refrescar(deps);
    return { ok: true, mensaje: `Guardado en la memoria de Wobi Seguros (${guardada.id}).` };
  }

  const d = datos as DatosRetirar;
  if (!esRecuerdoRetirable(d.id)) return { ok: false, mensaje: "No se aplicó: es una decisión, regla o contacto de la memoria base; si ya no vale, se cambia en la hoja `_seguros_conocimiento`." };
  const existentes = await leerConocimiento(deps.conocimiento);
  if (!existentes.some((e) => e.id === d.id && e.vigente)) return { ok: false, mensaje: `No se aplicó: no hay un recuerdo vigente con id ${d.id}.` };
  const ok = await deps.conocimiento.retirar(d.id, `${d.motivo} (aprobado por ${quien})`);
  if (ok) refrescar(deps);
  return ok ? { ok: true, mensaje: "Retirado de la memoria." } : { ok: false, mensaje: "No se pudo retirar el recuerdo." };
}
