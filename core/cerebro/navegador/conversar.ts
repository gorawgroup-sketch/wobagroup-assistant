import type { CatalogoNavegacion } from "./catalogo";
import type { AlmacenContexto, EstadoConversacion, OpcionContexto } from "./contexto";
import { companiasMencionadas, interpretarNavegacion, normalizar, quitarCompanias, reconoceDestino, resolverDestino, seccionesReconocidas, type RespuestaNavegacion } from "./interprete";
import { LECTURAS_POR_CAPACIDAD, TIPO_POR_CAPACIDAD, lecturaNoConsultable, resumenDeLectura, type LecturaSeguros, type SnapshotSeguros } from "./lecturas";
import type { NivelAcceso } from "./permisos";

/**
 * Navegación CONVERSACIONAL de WOBi, SOLO LECTURA, modo determinista (E1: sin IA y sin coste). Encima de `interpretarNavegacion`:
 *  - conserva la compañía y el tema de la conversación (contexto estructurado en servidor, ver `contexto.ts`);
 *  - resuelve seguimientos («y el de Footprint», «y las renovaciones», «el segundo», «sí»);
 *  - para las tres vistas de Seguros adjunta una `lectura` de datos con su fecha, sus fuentes y su estado, y un `resumen` hecho con
 *    plantillas del servidor (ningún modelo escribe cifras ni fechas).
 *
 * Todo destino sale de `resolverDestino` o de `interpretarNavegacion` con la identidad de LA PETICIÓN EN CURSO: el contexto solo sugiere
 * qué capacidad y qué compañía probar, nunca concede acceso. Este módulo no importa herramientas, chat, modelos ni escritores.
 */

type Destino = Extract<RespuestaNavegacion, { tipo: "destino" }>;
type OrigenCompania = "texto" | "seleccionada" | "contexto";
type RespuestaBase = Exclude<RespuestaNavegacion, { tipo: "destino" }> | (Omit<Destino, "companyOrigen"> & { companyOrigen: OrigenCompania });
export type RespuestaConversar = RespuestaBase & { modo: "deterministico"; conversacionId: string; resumen: string; lectura?: LecturaSeguros };

export interface EntradaConversar {
  texto?: string;
  seleccion?: { capabilityId: string; companyId: string };
  companyId: string;
  nivel: NivelAcceso;
  catalogo: CatalogoNavegacion;
  requestId: string;
  /** Lo que devolvió el cliente en la petición anterior; solo vale si coincide con el emitido para ESTA identidad + dispositivo. */
  conversacionId?: unknown;
  /** Identidad + dispositivo, calculada por el servidor. */
  clave: string;
  almacen: AlmacenContexto;
  snapshotSeguros?: () => Promise<SnapshotSeguros>;
  ahora: () => number;
  /** Solo para pruebas: tiempo máximo de espera de la lectura. */
  tiempoMaxMs?: number;
}

export const TIEMPO_MAX_LECTURA_MS = 8_000;

/* ───────── seguimientos ───────── */

const RELLENO = new Set(["y", "e", "el", "la", "los", "las", "lo", "de", "del", "en", "ese", "esa", "mismo", "misma", "tambien", "ademas", "para", "con", "ahora", "otra", "vez", "pero", "igual", "tal", "que", "a", "al", "un", "una", "pues", "entonces", "quiero", "dime", "muestrame", "abre", "abrelo", "abrela"]);
const AFIRMACION = /^(?:si|vale|ok|okay|dale|claro|adelante|de acuerdo|correcto|exacto|hazlo|abrelo|abrela|abre|por favor)$/;
const ORDINAL = /^(?:(?:el|la|lo|opcion|numero|n|la opcion|el numero)\s+)*(primero|primera|1|uno|segundo|segunda|2|dos|tercero|tercera|3|tres|cuarto|cuarta|4|cuatro|ultimo|ultima)$/;
const POSICION: Record<string, number> = { primero: 0, primera: 0, "1": 0, uno: 0, segundo: 1, segunda: 1, "2": 1, dos: 1, tercero: 2, tercera: 2, "3": 2, tres: 2, cuarto: 3, cuarta: 3, "4": 3, cuatro: 3 };

/** Una de las opciones de la última aclaración: «sí» (si había una sola), «el primero/segundo/último» o «el de Footprint» (si es inequívoco). */
function elegirOpcion(t: string, resto: string[], menciones: string[], opciones: OpcionContexto[]): OpcionContexto | null {
  if (opciones.length === 1 && AFIRMACION.test(t)) return opciones[0];
  const ord = ORDINAL.exec(t);
  if (ord) {
    const idx = ord[1] === "ultimo" || ord[1] === "ultima" ? opciones.length - 1 : POSICION[ord[1]];
    return opciones[idx] ?? null;
  }
  if (menciones.length === 1 && resto.length === 0) {
    const deEsta = opciones.filter((o) => o.companyId === menciones[0]);
    if (deEsta.length === 1) return deEsta[0];
  }
  return null;
}

/* ───────── lectura ───────── */

const conLimite = async <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("Tiempo de lectura agotado")), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

async function leerSeguros(e: EntradaConversar, capabilityId: string, companyId: string): Promise<LecturaSeguros> {
  const tipo = TIPO_POR_CAPACIDAD[capabilityId];
  const empresa = tipo === "seguros_actividad" ? null : companyId;
  const generadoEn = new Date(e.ahora()).toISOString();
  try {
    if (!e.snapshotSeguros) return lecturaNoConsultable(tipo, empresa, generadoEn, "la lectura de Seguros no está conectada");
    const snapshot = await conLimite(e.snapshotSeguros(), e.tiempoMaxMs ?? TIEMPO_MAX_LECTURA_MS);
    return LECTURAS_POR_CAPACIDAD[capabilityId](snapshot, companyId);
  } catch (error) {
    const agotado = error instanceof Error && error.message === "Tiempo de lectura agotado";
    console.error("[navegador] No se pudo leer Seguros:", error instanceof Error ? error.name : "Error");
    return lecturaNoConsultable(tipo, empresa, generadoEn, agotado ? "se agotó el tiempo de lectura" : "no se pudo leer el estado de Seguros");
  }
}

/* ───────── decisión ───────── */

function decidir(e: EntradaConversar, ctx: EstadoConversacion | null): { r: RespuestaBase; companyBase: string } {
  const rc = { catalogo: e.catalogo, nivel: e.nivel, requestId: e.requestId };
  const validas = e.catalogo.companias;
  // Si la persona cambió la compañía del selector desde la última petición, manda el selector y se olvidan las opciones pendientes.
  const cambioSelector = ctx !== null && ctx.companySeleccionada !== e.companyId;
  const heredar = ctx !== null && !cambioSelector && ctx.companyId !== e.companyId && validas.includes(ctx.companyId);
  const companyBase = heredar && ctx ? ctx.companyId : e.companyId;
  const origenBase: "seleccionada" | "contexto" = heredar ? "contexto" : "seleccionada";
  const opcionesVigentes = ctx && !cambioSelector ? ctx.opciones : [];

  if (e.seleccion) return { r: interpretarNavegacion({ seleccion: e.seleccion, companyId: e.companyId, nivel: e.nivel, catalogo: e.catalogo, requestId: e.requestId }), companyBase };

  const texto = e.texto ?? "";
  const t = normalizar(texto);
  const menciones = companiasMencionadas(t, validas);
  const resto = quitarCompanias(t).split(" ").filter((w) => w && !RELLENO.has(w));

  // 1. Respuesta a lo que se le ofreció.
  if (opcionesVigentes.length > 0) {
    const o = elegirOpcion(t, resto, menciones, opcionesVigentes);
    if (o) return { r: interpretarNavegacion({ seleccion: { capabilityId: o.capabilityId, companyId: o.companyId }, companyId: e.companyId, nivel: e.nivel, catalogo: e.catalogo, requestId: e.requestId }), companyBase };
  }

  // 2. «y el de Footprint»: mismo destino, otra compañía. La compañía del texto manda; el destino se revalida con la identidad actual.
  if (ctx?.capabilityId && menciones.length === 1 && resto.length === 0) {
    const cap = e.catalogo.capacidades.find((c) => c.id === ctx.capabilityId);
    if (cap) return { r: resolverDestino(cap, menciones[0], "texto", rc), companyBase };
  }

  // 3. «y las renovaciones», «y la actividad»: otro destino dentro del mismo tema y con la compañía de la conversación.
  // Solo se completa con el módulo del tema cuando eso hace aparecer una SECCIÓN nueva («y la actividad»): que el módulo solo ya sea
  // reconocible no significa que el texto («sí», «el primero»…) pida algo.
  let textoEfectivo = texto;
  if (ctx?.capabilityId && !reconoceDestino(texto, e.catalogo)) {
    const [, area, modulo] = ctx.capabilityId.split(":");
    const padre = e.catalogo.capacidades.find((c) => c.id === (ctx.capabilityId?.startsWith("section:") ? `module:${area}:${modulo}` : ctx.capabilityId));
    if (padre) {
      const antes = seccionesReconocidas(padre.label, e.catalogo);
      const completado = `${padre.label} ${texto}`;
      if (seccionesReconocidas(completado, e.catalogo).some((id) => !antes.includes(id))) textoEfectivo = completado;
    }
  }
  const r = interpretarNavegacion({ texto: textoEfectivo, companyId: companyBase, nivel: e.nivel, catalogo: e.catalogo, requestId: e.requestId });
  if (r.tipo === "destino" && r.companyOrigen === "seleccionada" && origenBase === "contexto") return { r: { ...r, companyOrigen: "contexto" }, companyBase };
  return { r, companyBase };
}

/* ───────── resumen y cierre ───────── */

function resumenDe(r: RespuestaBase, lectura?: LecturaSeguros): string {
  if (lectura) return resumenDeLectura(lectura);
  if (r.tipo === "aclaracion") return r.pregunta;
  if (r.tipo === "no_disponible") return r.mensaje;
  return `Abro «${r.etiqueta}» de ${r.companyId}.${r.avisos.length > 0 ? ` ${r.avisos.join(" ")}` : ""}`;
}

export async function conversar(e: EntradaConversar): Promise<RespuestaConversar> {
  const ctx = e.almacen.obtener(e.clave, e.conversacionId);
  const { r: decidida, companyBase } = decidir(e, ctx);
  let r: RespuestaBase = decidida;

  // Solo las vistas de Seguros llevan datos, y solo si el destino ya pasó estado, permiso y fuente (o es una vista registrada y autorizada).
  let lectura: LecturaSeguros | undefined;
  const capId = "capabilityId" in r ? r.capabilityId : undefined;
  if (capId && LECTURAS_POR_CAPACIDAD[capId] && (r.tipo === "destino" || (r.tipo === "no_disponible" && r.motivo === "destino_no_implementado")) && r.companyId) {
    lectura = await leerSeguros(e, capId, r.companyId);
    // Una fuente que no se pudo leer no se «abre» como si hubiera datos: se dice que no es consultable.
    if (r.tipo === "destino" && lectura.estado === "no_consultable") {
      r = { requestId: r.requestId, catalogVersion: r.catalogVersion, tipo: "no_disponible", motivo: "fuente_no_consultable", capabilityId: r.capabilityId, companyId: r.companyId, mensaje: resumenDeLectura(lectura) };
    }
  }

  const opciones: OpcionContexto[] = r.tipo === "aclaracion" ? r.opciones.map((o) => ({ capabilityId: o.capabilityId, companyId: o.companyId, ...(o.sinFiltro ? { sinFiltro: true } : {}) })) : [];
  const comun = opciones.length > 0 && opciones.every((o) => o.capabilityId === opciones[0].capabilityId) ? opciones[0].capabilityId : null;
  const estado: EstadoConversacion = {
    companyId: "companyId" in r && r.companyId ? r.companyId : companyBase,
    companySeleccionada: e.companyId,
    capabilityId: capId ?? comun ?? ctx?.capabilityId ?? null,
    opciones,
  };
  const conversacionId = e.almacen.guardar(e.clave, estado, ctx && typeof e.conversacionId === "string" ? e.conversacionId : undefined);
  return { ...r, modo: "deterministico", conversacionId, resumen: resumenDe(r, lectura), ...(lectura ? { lectura } : {}) };
}
