/**
 * Lecturas de SEGUROS para el navegador conversacional (E1: determinista, sin IA). Solo lectura sobre el MISMO snapshot que ya alimenta el
 * panel (`obtenerEstadoCerebro()`, inyectado por el router: este módulo no importa nada del sistema). Cada lectura dice:
 *  - cuándo se leyó de verdad (`leidoEn` = el dato más antiguo entre las fuentes usadas, nunca «ahora» por defecto);
 *  - de qué fuentes salió y si cada una respondió (`fuentes`, copia de `EstadoFuente`);
 *  - si es `completa`, `incompleta` (dato conservado de una lectura anterior, fuente desconocida o en refresco) o `no_consultable`.
 *
 * Reglas que NO se rompen:
 *  - una fuente que falló y no tiene lectura anterior es `no_consultable`: jamás `items: []` ni `total: 0` (un fallo no es «no hay»);
 *  - `total` solo existe con lectura `completa`;
 *  - nada se calcula ni se suma: los importes son los del registro, tal cual, y nunca se mezclan monedas;
 *  - el texto de `resumen` sale de plantillas con los datos de la lectura: ningún modelo escribe cifras.
 */

export interface FuenteLectura {
  fuente: string;
  ok: boolean;
  verificadoEn: string;
  ultimoExitoEn: string | null;
  conservado: boolean;
  causa?: string;
}

/** Lo mínimo que necesita el navegador del estado de Seguros del panel (estructuralmente compatible con `EstadoSeguros`). */
export interface SnapshotSeguros {
  generadoEn: string;
  refrescando: boolean;
  fuentes: FuenteLectura[];
  seguros: {
    polizas: Array<{ id: string; empresa: string; tipoCobertura: string; aseguradora: string }>;
    pagosSinConfirmar: Array<{ id: string; empresa: string; tipoCobertura: string; aseguradora: string; prima: string; moneda: string; estadoPago: string }>;
    proximos: Array<{ fecha: string; diasRestantes: number; tipo: "vencimiento" | "pago"; empresa: string; polizaId: string; texto: string }>;
    bitacora: Array<{ id: string; cuando: string; etiqueta: string; resultado: string; resumen: string }> | null;
    /** null = no se pudo leer (no «sin pagos programados»). */
    calendarioPagos: Array<{ polizaId: string; empresa: string; fecha: string; diasRestantes: number; importe: number; moneda: string; concepto: string }> | null;
    /** false = los complementos (bitácora, calendario de pagos…) no se pudieron leer. */
    complementosDisponibles: boolean;
  };
}

export type TipoLectura = "seguros_pagos_pendientes" | "seguros_proximas_renovaciones" | "seguros_actividad";
export type EstadoLectura = "completa" | "incompleta" | "no_consultable";

export interface LecturaSeguros {
  tipo: TipoLectura;
  /** null en la actividad: es del grupo completo. */
  empresa: string | null;
  /** El más antiguo de los últimos éxitos de las fuentes usadas; null si no se sabe. */
  leidoEn: string | null;
  generadoEn: string;
  estado: EstadoLectura;
  refrescando: boolean;
  fuentes: FuenteLectura[];
  avisos: string[];
  /** Solo con estado `completa`. */
  total?: number;
  mostrados?: number;
  /** Ausente (no vacío) cuando la lectura es `no_consultable`. */
  items?: Array<Record<string, string | number>>;
  /** Causa legible del fallo cuando es `no_consultable`. */
  causa?: string;
  /** Solo en pagos pendientes: el siguiente pago programado de la compañía, tal cual consta en el calendario (ausente si no hay o no se pudo leer). */
  proximoPago?: Record<string, string | number>;
}

export const MAX_ITEMS_LECTURA = 10;
export const AVISO_ACTIVIDAD_GRUPO = "La actividad de Wobi Seguros es del grupo completo: no se atribuye a una sola compañía.";
export const FUENTE_POLIZAS = "seguros.polizas";
export const FUENTE_COMPLEMENTOS = "seguros.complementos";

const CAUSAS: Record<string, string> = {
  timeout: "se agotó el tiempo de lectura", cuota: "Google Sheets limitó las lecturas por un momento", transporte: "falló la conexión", otro: "falló la lectura",
};
const causaLegible = (causa?: string): string => (causa ? CAUSAS[causa] ?? "falló la lectura" : "falló la lectura");

/* ───────── fuentes → estado y fecha de lectura ───────── */

interface EvaluacionFuentes { estado: EstadoLectura; fuentes: FuenteLectura[]; avisos: string[]; leidoEn: string | null; causa?: string }

export function evaluarFuentes(snapshot: Pick<SnapshotSeguros, "fuentes" | "refrescando">, nombres: string[]): EvaluacionFuentes {
  const fuentes: FuenteLectura[] = [];
  const avisos: string[] = [];
  const exitos: string[] = [];
  let estado: EstadoLectura = "completa";
  let causa: string | undefined;
  for (const nombre of nombres) {
    const f = snapshot.fuentes.find((x) => x.fuente === nombre);
    if (!f) {
      // Sin constancia de la fuente: no se afirma que esté fresca ni que esté rota.
      avisos.push(`No hay constancia de cuándo se leyó «${nombre}»: no puedo asegurar que la lectura esté completa ni actualizada.`);
      if (estado === "completa") estado = "incompleta";
      continue;
    }
    fuentes.push({ fuente: f.fuente, ok: f.ok, verificadoEn: f.verificadoEn, ultimoExitoEn: f.ultimoExitoEn, conservado: f.conservado, ...(f.causa ? { causa: f.causa } : {}) });
    if (f.ok) { if (f.ultimoExitoEn ?? f.verificadoEn) exitos.push((f.ultimoExitoEn ?? f.verificadoEn) as string); continue; }
    if (f.conservado && f.ultimoExitoEn) {
      avisos.push(`No se pudo releer «${nombre}» (${causaLegible(f.causa)}): se muestra la última lectura buena, del ${f.ultimoExitoEn}.`);
      exitos.push(f.ultimoExitoEn);
      if (estado === "completa") estado = "incompleta";
    } else {
      estado = "no_consultable"; causa = causaLegible(f.causa);
    }
  }
  if (snapshot.refrescando) avisos.push("Hay una actualización en curso: los datos pueden cambiar en unos segundos.");
  const leidoEn = exitos.length > 0 ? [...exitos].sort()[0] : null;
  return { estado, fuentes, avisos, leidoEn, ...(causa ? { causa } : {}) };
}

function base(tipo: TipoLectura, empresa: string | null, snapshot: SnapshotSeguros, ev: EvaluacionFuentes): LecturaSeguros {
  return { tipo, empresa, leidoEn: ev.estado === "no_consultable" ? null : ev.leidoEn, generadoEn: snapshot.generadoEn, estado: ev.estado, refrescando: snapshot.refrescando, fuentes: ev.fuentes, avisos: ev.avisos, ...(ev.causa ? { causa: ev.causa } : {}) };
}

const sinDatos = (l: LecturaSeguros): LecturaSeguros => ({ ...l, leidoEn: null });

/* ───────── las tres lecturas ───────── */

export function leerPagosPendientes(snapshot: SnapshotSeguros, empresa: string): LecturaSeguros {
  const ev = evaluarFuentes(snapshot, [FUENTE_POLIZAS]);
  const l = base("seguros_pagos_pendientes", empresa, snapshot, ev);
  if (ev.estado === "no_consultable") return sinDatos(l);
  const todos = snapshot.seguros.pagosSinConfirmar.filter((p) => p.empresa === empresa);
  const items = todos.slice(0, MAX_ITEMS_LECTURA).map((p) => ({
    polizaId: p.id, tipoCobertura: p.tipoCobertura, aseguradora: p.aseguradora, prima: p.prima, moneda: p.moneda, estadoPago: p.estadoPago,
  }));
  // El calendario de pagos es un complemento: si no se pudo leer, falta el «próximo pago programado» y se dice (no se calla ni se inventa).
  const avisos = [...l.avisos];
  let estado = l.estado;
  let proximoPago: LecturaSeguros["proximoPago"];
  if (snapshot.seguros.calendarioPagos === null) {
    avisos.push("No se pudo leer el calendario de pagos: no puedo decir cuál es el próximo pago programado.");
    estado = "incompleta";
  } else {
    const siguiente = snapshot.seguros.calendarioPagos.filter((c) => c.empresa === empresa && c.diasRestantes >= 0)
      .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.polizaId.localeCompare(b.polizaId))[0];
    if (siguiente) proximoPago = { polizaId: siguiente.polizaId, fecha: siguiente.fecha, diasRestantes: siguiente.diasRestantes, importe: siguiente.importe, moneda: siguiente.moneda, concepto: siguiente.concepto };
  }
  return { ...l, estado, avisos, ...(estado === "completa" ? { total: todos.length } : {}), mostrados: items.length, items, ...(proximoPago ? { proximoPago } : {}) };
}

export function leerProximasRenovaciones(snapshot: SnapshotSeguros, empresa: string): LecturaSeguros {
  const ev = evaluarFuentes(snapshot, [FUENTE_POLIZAS]);
  const l = base("seguros_proximas_renovaciones", empresa, snapshot, ev);
  if (ev.estado === "no_consultable") return sinDatos(l);
  const polizas = new Map(snapshot.seguros.polizas.map((p) => [p.id, p]));
  const todos = snapshot.seguros.proximos.filter((e) => e.tipo === "vencimiento" && e.empresa === empresa)
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.polizaId.localeCompare(b.polizaId));
  const items = todos.slice(0, MAX_ITEMS_LECTURA).map((e) => {
    const p = polizas.get(e.polizaId);
    return { polizaId: e.polizaId, tipoCobertura: p?.tipoCobertura ?? "", aseguradora: p?.aseguradora ?? "", fecha: e.fecha, diasRestantes: e.diasRestantes };
  });
  return { ...l, ...(ev.estado === "completa" ? { total: todos.length } : {}), mostrados: items.length, items };
}

export function leerActividad(snapshot: SnapshotSeguros): LecturaSeguros {
  const ev = evaluarFuentes(snapshot, [FUENTE_COMPLEMENTOS]);
  const avisos = [...ev.avisos, AVISO_ACTIVIDAD_GRUPO];
  if (ev.estado === "completa" && !snapshot.seguros.complementosDisponibles) {
    avisos.push("Los complementos de Seguros no están disponibles ahora: la lectura puede estar incompleta.");
    ev.estado = "incompleta";
  }
  const l = { ...base("seguros_actividad", null, snapshot, ev), avisos };
  // `bitacora === null` significa «no se pudo leer»: nunca es «sin actividad», aunque la fuente figure como correcta.
  if (ev.estado === "no_consultable" || snapshot.seguros.bitacora === null) {
    return { ...sinDatos(l), estado: "no_consultable", ...(ev.causa ? { causa: ev.causa } : { causa: "no se pudo leer la bitácora" }) };
  }
  const todos = snapshot.seguros.bitacora;
  const items = todos.slice(0, MAX_ITEMS_LECTURA).map((b) => ({ id: b.id, cuando: b.cuando, etiqueta: b.etiqueta, resultado: b.resultado, resumen: b.resumen }));
  return { ...l, ...(ev.estado === "completa" ? { total: todos.length } : {}), mostrados: items.length, items };
}

/** Capacidad del catálogo → lectura que la responde. Solo estas capacidades llevan datos. */
export const LECTURAS_POR_CAPACIDAD: Record<string, (s: SnapshotSeguros, empresa: string) => LecturaSeguros> = {
  "section:insurance:seguros:pagos_pendientes": leerPagosPendientes,
  "section:insurance:seguros:proximas_renovaciones": leerProximasRenovaciones,
  "section:insurance:seguros:actividad": (s) => leerActividad(s),
};

/** Lectura cuando ni siquiera se pudo obtener el snapshot: nunca se inventa, ni se calla. */
export function lecturaNoConsultable(tipo: TipoLectura, empresa: string | null, generadoEn: string, causa: string): LecturaSeguros {
  return { tipo, empresa, leidoEn: null, generadoEn, estado: "no_consultable", refrescando: false, fuentes: [], avisos: [], causa };
}

export const TIPO_POR_CAPACIDAD: Record<string, TipoLectura> = {
  "section:insurance:seguros:pagos_pendientes": "seguros_pagos_pendientes",
  "section:insurance:seguros:proximas_renovaciones": "seguros_proximas_renovaciones",
  "section:insurance:seguros:actividad": "seguros_actividad",
};

/* ───────── resumen (plantillas; sin modelo) ───────── */

export function haceCuanto(desdeIso: string | null, ahoraIso: string): string {
  if (!desdeIso) return "de fecha desconocida";
  const ms = Date.parse(ahoraIso) - Date.parse(desdeIso);
  if (!Number.isFinite(ms) || ms < 0) return `del ${desdeIso}`;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "de hace menos de un minuto";
  if (min < 60) return `de hace ${min} ${min === 1 ? "minuto" : "minutos"}`;
  const h = Math.floor(min / 60);
  if (h < 24) return `de hace ${h} ${h === 1 ? "hora" : "horas"}`;
  const d = Math.floor(h / 24);
  return `de hace ${d} ${d === 1 ? "día" : "días"}`;
}

/** Mismo importe, con coma decimal y siempre dos decimales: no se redondea ni se convierte nada. */
const importeEs = (n: number): string => n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
const plural = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`;
const QUE: Record<TipoLectura, { que: string; nada: string }> = {
  seguros_pagos_pendientes: { que: "los pagos de seguros", nada: "si hay o no pagos de seguros sin confirmar" },
  seguros_proximas_renovaciones: { que: "las próximas renovaciones de seguros", nada: "si hay o no renovaciones próximas" },
  seguros_actividad: { que: "la actividad de Wobi Seguros", nada: "si ha habido o no actividad" },
};

export function resumenDeLectura(l: LecturaSeguros): string {
  const donde = l.empresa ? ` en ${l.empresa}` : " (grupo completo)";
  const lectura = `Lectura ${haceCuanto(l.leidoEn, l.generadoEn)}.`;
  if (l.estado === "no_consultable") {
    return `No pude consultar ${QUE[l.tipo].que}${donde} ahora${l.causa ? ` (${l.causa})` : ""}, así que no puedo decir ${QUE[l.tipo].nada}. Inténtalo en unos minutos.`;
  }
  const items = l.items ?? [];
  const primero = items[0];
  const incompleta = l.estado === "incompleta";
  const prefijo = incompleta ? "Lectura incompleta o conservada. " : "";
  const cuenta = (n: number, uno: string, varios: string): string => (incompleta ? `En la última lectura buena constaban ${plural(n, uno, varios)}` : `Hay ${plural(n, uno, varios)}`);
  let cuerpo: string;
  switch (l.tipo) {
    case "seguros_pagos_pendientes": {
      const n = incompleta ? items.length : l.total ?? items.length;
      cuerpo = n === 0 ? (incompleta ? `En la última lectura buena no constaban pagos de seguros sin confirmar${donde}.` : `No hay pagos de seguros sin confirmar${donde}.`)
        : `${cuenta(n, "pago de seguros sin confirmar", "pagos de seguros sin confirmar")}${donde}.`;
      const pp = l.proximoPago;
      if (pp) cuerpo += ` El próximo pago programado es de ${importeEs(pp.importe as number)} ${pp.moneda} el ${pp.fecha}.`;
      break;
    }
    case "seguros_proximas_renovaciones": {
      const n = incompleta ? items.length : l.total ?? items.length;
      cuerpo = n === 0 ? (incompleta ? `En la última lectura buena no constaban renovaciones próximas${donde}.` : `No hay renovaciones próximas de seguros${donde}.`)
        : `${cuenta(n, "renovación próxima de seguros", "renovaciones próximas de seguros")}${donde}; la más cercana es ${primero?.tipoCobertura || "una póliza"} el ${primero?.fecha}${typeof primero?.diasRestantes === "number" ? ` (${primero.diasRestantes} días)` : ""}.`;
      break;
    }
    default: {
      cuerpo = items.length === 0 ? (incompleta ? "En la última lectura buena no constaba actividad de Wobi Seguros (grupo completo)." : "No hay actividad registrada de Wobi Seguros (grupo completo).")
        : `La última actividad de Wobi Seguros (grupo completo) fue «${primero?.etiqueta}» el ${primero?.cuando}.`;
    }
  }
  return `${prefijo}${cuerpo} ${lectura}`;
}
