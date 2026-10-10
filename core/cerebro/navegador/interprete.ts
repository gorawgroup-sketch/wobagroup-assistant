import type { Capacidad, CatalogoNavegacion } from "./catalogo";
import { restriccionDeFuente, tieneAcceso, type NivelAcceso } from "./permisos";

/**
 * Interpretación de navegación de WOBi: de un texto (o de una opción ya elegida) a UNO de tres resultados — `destino`, `aclaracion` o
 * `no_disponible`. Es una función PURA y síncrona: no hace red, no lee datos de negocio, no invoca herramientas ni modelos, no escribe
 * nada. Solo puede proponer capacidades que existen en el catálogo y que la identidad (ya resuelta por el servidor) puede abrir.
 *
 * Nunca se devuelve una URL, un selector ni un script: la única salida «de navegación» es un `capabilityId` registrado + un `companyId`.
 * El texto se usa solo para puntuar contra el catálogo; su contenido jamás se copia a la respuesta (salvo opciones del propio catálogo).
 */

export type MotivoNoDisponible = "agente_previsto" | "destino_no_implementado" | "permiso_insuficiente" | "fuente_no_consultable";

export interface OpcionNavegacion { capabilityId: string; companyId: string; etiqueta: string; sinFiltro?: boolean }

interface Comun { requestId: string; catalogVersion: string }
export type RespuestaNavegacion =
  | (Comun & { tipo: "destino"; capabilityId: string; companyId: string; companyOrigen: "texto" | "seleccionada"; etiqueta: string; avisos: string[] })
  | (Comun & { tipo: "aclaracion"; pregunta: string; opciones: OpcionNavegacion[] })
  | (Comun & { tipo: "no_disponible"; motivo: MotivoNoDisponible; mensaje: string; capabilityId?: string; companyId?: string;
      /** Solo en `destino_no_implementado` de una sección: el módulo completo que SÍ se puede abrir (siempre `sinFiltro`). */
      alternativa?: OpcionNavegacion });

export interface EntradaInterpretacion {
  texto?: string;
  /** Opción ya mostrada por una aclaración anterior: se valida igual que un texto, contra el catálogo y los permisos. */
  seleccion?: { capabilityId: string; companyId: string };
  companyId: string;
  nivel: NivelAcceso;
  catalogo: CatalogoNavegacion;
  requestId: string;
}

export const MAX_TEXTO_NAVEGACION = 200;

/* ───────── texto ───────── */

export const normalizar = (t: string): string =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const COMPANIAS: Array<{ id: string; patron: RegExp }> = [
  { id: "WOBA", patron: /\bwoba\b|\bbusiness atelier\b/ },
  { id: "Footprint", patron: /\bfootprint\b/ },
  { id: "EWORKS", patron: /\be ?works\b|\bewks\b/ },
];

/** Palabras que piden un FILTRO, una SECCIÓN, una fecha o una cifra: hoy ningún destino del catálogo las admite. */
const REFINAMIENTOS: Array<{ etiqueta: string; patron: RegExp }> = [
  { etiqueta: "pendientes", patron: /\bpendientes?\b|\bpor (?:pagar|cobrar|conciliar|renovar)\b/ },
  { etiqueta: "vencimientos", patron: /\bvencid[oa]s?\b|\bvencimientos?\b|\bproxim[oa]s?\b|\batrasad[oa]s?\b|\bimpagad[oa]s?\b/ },
  { etiqueta: "pagos", patron: /\bpagos?\b|\bcobros?\b|\brecibos?\b/ },
  { etiqueta: "renovaciones", patron: /\brenovacion(?:es)?\b/ },
  { etiqueta: "cifras", patron: /\bcuanto(?:s)?\b|\bsaldos?\b|\bimportes?\b|\btotal(?:es)?\b|\bcifras?\b|\bcostes?\b|\bcostos?\b|\bgast(?:o|os|amos|ado)\b/ },
  { etiqueta: "fechas", patron: /\bhoy\b|\bmanana\b|\besta semana\b|\beste mes\b|\bultimo mes\b|\b20\d\d\b|\b(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/ },
];

const RUIDO = new Set(["de", "del", "la", "el", "los", "las", "un", "una", "y", "o", "en", "a", "al", "por", "para", "con", "mi", "mis", "me", "te", "que", "hay", "ver", "abre", "abrir", "muestra", "muestrame", "ir", "llevame", "dame", "necesito", "quiero", "wobi", "pidele", "pide", "favor", "porfa", "por favor", "todo", "todos", "toda", "todas", "sobre", "acerca", "como", "esta", "estan", "estoy", "busco", "buscando", "donde", "esta"]);
/** Palabras demasiado genéricas para identificar un destino por sí solas (salen en muchos nombres de módulo). */
const GENERICAS = new Set(["control", "documentos", "documento", "gestion", "espacio", "area", "areas", "modulo", "modulos", "herramientas", "informacion", "datos"]);

/**
 * Destinos PRECISOS (secciones). Una sección se reconoce por (a) una frase que la nombra sin ambigüedad (`autocontenida`) o (b) palabras
 * de su tema JUNTO CON el módulo padre en el texto (`conModulo`). `cubre` son los refinamientos que la sección ya resuelve por sí misma:
 * cualquier otro (fecha, cifra…) sigue sin estar soportado y se aclara. Una clave que no exista en el catálogo se ignora.
 */
export const INTENCIONES_SECCION: Record<string, { autocontenida: RegExp[]; conModulo: RegExp[]; cubre: string[] }> = {
  "section:insurance:seguros:pagos_pendientes": {
    autocontenida: [/\bpagos? (?:pendientes?|sin confirmar|por confirmar) de (?:los |las )?(?:seguros?|polizas?)\b/, /\bpolizas? (?:pendientes? de pago|sin pagar)\b/, /\bpagos? de (?:los |las )?(?:seguros?|polizas?)\b/],
    conModulo: [/\bpagos?\b/, /\bpendientes?\b/, /\bsin confirmar\b/, /\bpor pagar\b/, /\brecibos?\b/],
    cubre: ["pendientes", "pagos"],
  },
  "section:insurance:seguros:proximas_renovaciones": {
    autocontenida: [/\brenovacion(?:es)?\b/, /\bpolizas? por (?:vencer|renovar)\b/, /\bproximos? vencimientos? de (?:los |las )?(?:seguros?|polizas?)\b/],
    conModulo: [/\bvencimientos?\b/, /\bproxim[oa]s?\b/, /\bvencen\b/, /\bpor vencer\b/, /\bpor renovar\b/],
    cubre: ["renovaciones", "vencimientos"],
  },
  "section:insurance:seguros:actividad": {
    autocontenida: [/\bactividad de (?:wobi )?seguros\b/, /\bque (?:ha|han) hecho (?:wobi )?seguros\b/, /\bbitacora de (?:wobi )?seguros\b/],
    conModulo: [/\bactividad\b/, /\bbitacora\b/, /\bhistorial\b/, /\bultimas? acciones\b/, /\bque ha hecho\b/],
    cubre: [],
  },
};

/** «De todas las empresas», «del grupo»…: pide una vista conjunta que las secciones por compañía NO ofrecen. */
const PIDE_GRUPO = /\btod(?:as|os) (?:las |los )?(?:empresas|companias|sociedades)\b|\bdel grupo\b|\bde todo el grupo\b|\bconjunt[oa]s?\b|\blas tres (?:empresas|companias)\b/;
export const AVISO_GRUPO = "Esta vista es del grupo completo: no se atribuye a una sola compañía.";

/** Sinónimos propios del servidor por capacidad. Una clave que no exista en el catálogo se ignora (el catálogo manda, nunca esta tabla). */
export const ALIAS: Record<string, string[]> = {
  "area:finance": ["finanzas", "financiero", "financiera", "contabilidad", "finanza"],
  "module:finance:holded": ["holded", "contabilidad en holded", "gastos", "facturas", "factura", "conciliacion", "conciliaciones", "asientos", "movimientos bancarios", "banco", "bancos"],
  "module:finance:cashflow": ["cashflow", "cash flow", "flujo de caja", "tesoreria", "caja", "liquidez"],
  "module:finance:fiscal": ["fiscal", "fiscalidad", "impuestos", "iva", "irpf", "hacienda", "tributos", "modelo 303", "modelo 111"],
  "area:operations": ["operaciones", "operativa", "operativo"],
  "module:operations:drive": ["drive", "google drive", "archivos", "carpetas", "documentos", "documentos en drive"],
  "module:operations:correo": ["correo", "correos", "email", "emails", "mail", "mails", "bandeja", "bandeja de entrada"],
  "module:operations:conocimiento": ["conocimiento", "base de conocimiento", "lo que sabe wobi"],
  "module:operations:calendario": ["calendario", "agenda", "eventos", "reuniones", "citas"],
  "area:insurance": ["seguros", "seguro"],
  "module:insurance:seguros": ["seguros", "seguro", "polizas", "poliza", "aseguradora", "aseguradoras", "correduria", "control de seguros"],
  "area:corporate": ["corporate", "corporativo", "corporativa", "societario"],
  "module:corporate:drive": ["documentacion corporativa", "documentos corporativos", "estatutos", "escrituras", "actas", "poderes"],
  "module:corporate:strategic_planning": ["planeacion estrategica", "plan estrategico", "planificacion estrategica", "estrategia"],
  "area:people": ["gestion humana", "personas", "rrhh", "recursos humanos", "nominas", "empleados", "equipo"],
  "area:marketing": ["marketing", "social media", "redes sociales", "campanas", "publicidad"],
  "area:commercial": ["ventas", "clientes", "leads", "comercial", "cartera de clientes"],
  "area:procurement": ["compras", "proveedores", "aprovisionamiento"],
  "area:compliance": ["compliance", "cumplimiento", "normativo", "cumplimiento normativo"],
  "area:quality": ["calidad", "iso", "iso 9001", "iso 14001", "medioambiente", "medio ambiente"],
  "area:technology": ["tecnologia", "seguridad informatica", "ciberseguridad", "informatica", "sistemas"],
  "area:processes": ["procesos", "procedimientos", "procedimiento"],
};

/** Palabras sueltas de un nombre que pueden identificar el destino con poco peso (para capacidades nuevas sin sinónimos). */
const tokensSignificativos = (t: string): string[] =>
  normalizar(t).split(" ").filter((w) => w.length >= 5 && !RUIDO.has(w) && !GENERICAS.has(w));

interface Puntuada { cap: Capacidad; puntos: number }

const contiene = (texto: string, frase: string): boolean => ` ${texto} `.includes(` ${frase} `);

/** Puntúa cada capacidad contra el texto. Frase completa de nombre o sinónimo = 10 + 2 por palabra; palabra significativa del nombre = 6. */
export function puntuar(textoNorm: string, capacidades: Capacidad[]): Puntuada[] {
  const salida: Puntuada[] = [];
  for (const cap of capacidades) {
    let mejor = 0;
    const frases = new Set<string>([normalizar(cap.label), ...(ALIAS[cap.id] ?? []).map(normalizar)]);
    for (const f of frases) {
      if (f && contiene(textoNorm, f)) mejor = Math.max(mejor, 10 + 2 * f.split(" ").length);
    }
    // Una palabra suelta del nombre de una SECCIÓN («pagos», «actividad») no la identifica: solo su frase completa o su intención.
    if (mejor === 0 && cap.target.kind !== "section") for (const w of tokensSignificativos(cap.label)) if (contiene(textoNorm, w)) mejor = Math.max(mejor, 6);
    if (mejor > 0) salida.push({ cap, puntos: mejor });
  }
  return salida.sort((a, b) => b.puntos - a.puntos || a.cap.id.localeCompare(b.cap.id));
}

/** Añade las secciones cuya INTENCIÓN reconoce el texto (ver `INTENCIONES_SECCION`). Solo secciones registradas en el catálogo. */
function conIntenciones(textoNorm: string, caps: Capacidad[], base: Puntuada[]): Puntuada[] {
  const salida = [...base];
  for (const cap of caps) {
    const intencion = INTENCIONES_SECCION[cap.id];
    if (!intencion || cap.target.kind !== "section") continue;
    const padre = `module:${cap.target.area}:${cap.target.module}`;
    const moduloPresente = base.some((p) => p.cap.id === padre || p.cap.id === `area:${cap.target.area}`);
    const puntos = intencion.autocontenida.some((r) => r.test(textoNorm)) ? 20 : moduloPresente && intencion.conModulo.some((r) => r.test(textoNorm)) ? 18 : 0;
    if (puntos === 0) continue;
    const i = salida.findIndex((p) => p.cap.id === cap.id);
    if (i >= 0) salida[i] = { cap, puntos: Math.max(salida[i].puntos, puntos) };
    else salida.push({ cap, puntos });
  }
  return salida.sort((a, b) => b.puntos - a.puntos || a.cap.id.localeCompare(b.cap.id));
}

/**
 * Si coinciden un área y uno de SUS módulos, vale el módulo (es el destino concreto); un área con varios módulos coincidentes se
 * mantiene. Y si coincide una sección de un módulo, el módulo padre ya no compite con ella (la sección es el destino concreto).
 */
function sinAreasRedundantes(c: Puntuada[]): Puntuada[] {
  return c.filter((p) => {
    if (p.cap.target.kind === "module") return !c.some((q) => q.cap.target.kind === "section" && q.cap.id.startsWith(`section:${p.cap.id.slice("module:".length)}:`));
    if (p.cap.target.kind !== "area") return true;
    const modulos = c.filter((q) => q.cap.target.kind === "module" && q.cap.id.startsWith(`module:${p.cap.target.id}:`));
    const secciones = c.filter((q) => q.cap.target.kind === "section" && q.cap.target.area === p.cap.target.id);
    return modulos.length === 0 && secciones.length === 0;
  });
}

const refinamientosDe = (textoNorm: string): string[] => REFINAMIENTOS.filter((r) => r.patron.test(textoNorm)).map((r) => r.etiqueta);
const companiasMencionadas = (textoNorm: string, validas: string[]): string[] =>
  COMPANIAS.filter((c) => c.patron.test(textoNorm) && validas.includes(c.id)).map((c) => c.id);

const quitarCompanias = (textoNorm: string): string => {
  let t = textoNorm;
  for (const c of COMPANIAS) t = t.replace(new RegExp(c.patron.source, "g"), " ");
  return t.replace(/\s+/g, " ").trim();
};

/* ───────── resultado de un destino concreto ───────── */

export interface ContextoResolucion { catalogo: CatalogoNavegacion; nivel: NivelAcceso; requestId: string }

/** Aplica, en este orden: agente previsto → permiso → fuente consultable → destino. Es el ÚNICO camino que produce un `destino`. */
export function resolverDestino(cap: Capacidad, companyId: string, origen: "texto" | "seleccionada", ctx: ContextoResolucion): RespuestaNavegacion {
  const base = { requestId: ctx.requestId, catalogVersion: ctx.catalogo.version };
  if (!cap.companies.includes(companyId)) {
    return { ...base, tipo: "no_disponible", motivo: "permiso_insuficiente", mensaje: "Esa compañía no tiene este destino.", capabilityId: cap.id, companyId };
  }
  if (cap.status === "planned") {
    return { ...base, tipo: "no_disponible", motivo: "agente_previsto", capabilityId: cap.id, companyId,
      mensaje: `«${cap.label}» es un espacio previsto: todavía no tiene agente ni herramientas conectadas.` };
  }
  if (!tieneAcceso(ctx.nivel, cap.id)) {
    return { ...base, tipo: "no_disponible", motivo: "permiso_insuficiente", capabilityId: cap.id, companyId,
      mensaje: `Tu acceso actual no permite abrir «${cap.label}». Si lo necesitas, pídele acceso a un administrador.` };
  }
  // Destino preciso registrado cuya vista aún no existe: se dice tal cual y se ofrece el módulo completo, jamás se abre como si estuviera hecho.
  if (cap.status === "registered") {
    const padre = ctx.catalogo.capacidades.find((c) => c.id === padreDe(cap));
    const alternativa = padre && padre.status === "available" && padre.companies.includes(companyId) && tieneAcceso(ctx.nivel, padre.id)
      ? opcionDe(padre, companyId, true) : undefined;
    return { ...base, tipo: "no_disponible", motivo: "destino_no_implementado", capabilityId: cap.id, companyId,
      mensaje: `La vista «${cap.label}» ya está registrada, pero todavía no está implementada.${alternativa ? ` Puedo abrir «${alternativa.etiqueta}» completo, sin filtrar.` : ""}`,
      ...(alternativa ? { alternativa } : {}) };
  }
  const restriccion = restriccionDeFuente(cap, companyId);
  if (restriccion?.tipo === "no_consultable") {
    return { ...base, tipo: "no_disponible", motivo: "fuente_no_consultable", capabilityId: cap.id, companyId, mensaje: restriccion.mensaje };
  }
  const avisos = [...(restriccion ? [restriccion.mensaje] : []), ...(cap.scope === "group" ? [AVISO_GRUPO] : [])];
  return { ...base, tipo: "destino", capabilityId: cap.id, companyId, companyOrigen: origen, etiqueta: cap.label, avisos };
}

const padreDe = (cap: Capacidad): string => (cap.target.kind === "section" ? `module:${cap.target.area}:${cap.target.module}` : cap.id);

const opcionDe = (cap: Capacidad, companyId: string, sinFiltro = false): OpcionNavegacion =>
  ({ capabilityId: cap.id, companyId, etiqueta: cap.label, ...(sinFiltro ? { sinFiltro: true } : {}) });

/** Solo se OFRECEN destinos que esta identidad puede abrir y que están disponibles. */
const ofrecibles = (caps: Capacidad[], companyId: string, nivel: NivelAcceso): Capacidad[] =>
  caps.filter((c) => c.status === "available" && c.companies.includes(companyId) && tieneAcceso(nivel, c.id));

/* ───────── punto de entrada ───────── */

export function interpretarNavegacion(e: EntradaInterpretacion): RespuestaNavegacion {
  const ctx: ContextoResolucion = { catalogo: e.catalogo, nivel: e.nivel, requestId: e.requestId };
  const base = { requestId: e.requestId, catalogVersion: e.catalogo.version };
  const caps = e.catalogo.capacidades;

  // Opción elegida en una aclaración: mismo camino de validación, sin texto.
  if (e.seleccion) {
    const cap = caps.find((c) => c.id === e.seleccion?.capabilityId);
    if (!cap || !e.catalogo.companias.includes(e.seleccion.companyId)) {
      return { ...base, tipo: "no_disponible", motivo: "destino_no_implementado", mensaje: "Ese destino ya no está en el catálogo." };
    }
    return resolverDestino(cap, e.seleccion.companyId, "seleccionada", ctx);
  }

  const original = normalizar(e.texto ?? "");
  const mencionadas = companiasMencionadas(original, e.catalogo.companias);
  const textoNorm = quitarCompanias(original);
  const refinamientos = refinamientosDe(textoNorm);
  // Los sinónimos de ALIAS no incluyen palabras de refinamiento (pagos, renovaciones…): «pagos de seguros» puntúa «seguros» y marca «pagos» aparte.
  const candidatas = sinAreasRedundantes(conIntenciones(textoNorm, caps, puntuar(textoNorm, caps)));

  if (candidatas.length === 0) {
    const disponibles = ofrecibles(caps.filter((c) => c.target.kind === "area"), e.companyId, e.nivel).slice(0, 6);
    if (refinamientos.length > 0) {
      return { ...base, tipo: "no_disponible", motivo: "destino_no_implementado",
        mensaje: "Todavía no puedo resolver cifras, fechas ni filtros desde el navegador. Puedes abrir un área y consultarlo allí o preguntárselo a WOBi en el chat." };
    }
    return { ...base, tipo: "aclaracion", pregunta: "No reconozco esa petición. ¿Quieres abrir alguna de estas áreas?",
      opciones: disponibles.map((c) => opcionDe(c, e.companyId)) };
  }

  const mejor = candidatas[0];
  const empatadas = candidatas.filter((c) => mejor.puntos - c.puntos < 4);
  const companyElegida = mencionadas.length === 1 ? mencionadas[0] : e.companyId;
  const origen: "texto" | "seleccionada" = mencionadas.length === 1 ? "texto" : "seleccionada";

  // Más de un destino posible: se pregunta, con solo destinos permitidos y abribles.
  if (empatadas.length > 1) {
    const opciones = ofrecibles(empatadas.map((c) => c.cap), companyElegida, e.nivel).slice(0, 4);
    if (opciones.length > 1) {
      return { ...base, tipo: "aclaracion", pregunta: "¿A cuál te refieres?", opciones: opciones.map((c) => opcionDe(c, companyElegida)) };
    }
    // Varias secciones reconocidas y ninguna abrible aún: se dice cuáles son, sin abrir ni elegir una al azar.
    const secciones = empatadas.filter((c) => c.cap.target.kind === "section");
    if (secciones.length > 1 && secciones.every((c) => c.cap.status === "registered") && tieneAcceso(e.nivel, secciones[0].cap.id)) {
      const padre = caps.find((c) => c.id === padreDe(secciones[0].cap));
      const alternativa = padre && padre.status === "available" && padre.companies.includes(companyElegida) && tieneAcceso(e.nivel, padre.id) ? opcionDe(padre, companyElegida, true) : undefined;
      return { ...base, tipo: "no_disponible", motivo: "destino_no_implementado", companyId: companyElegida,
        mensaje: `Las vistas ${secciones.map((c) => `«${c.cap.label}»`).join(" y ")} ya están registradas, pero todavía no están implementadas.${alternativa ? ` Puedo abrir «${alternativa.etiqueta}» completo, sin filtrar.` : ""}`,
        ...(alternativa ? { alternativa } : {}) };
    }
  }
  const cap = mejor.cap;

  // Lo que NO depende de la compañía (área prevista, vista sin implementar, permiso) se dice antes de preguntar nada: no se ofrecen opciones que no se pueden abrir.
  if (cap.status !== "available" || !tieneAcceso(e.nivel, cap.id)) return resolverDestino(cap, companyElegida, origen, ctx);

  // Varias compañías nombradas: el cashflow conjunto, los permisos o la fuente pueden diferir; que elija.
  if (mencionadas.length > 1) {
    const opciones = mencionadas.filter((c) => cap.companies.includes(c));
    return { ...base, tipo: "aclaracion", pregunta: `Nombras varias compañías. ¿De cuál quieres abrir «${cap.label}»?`,
      opciones: opciones.map((c) => opcionDe(cap, c)) };
  }

  const resuelto = resolverDestino(cap, companyElegida, origen, ctx);
  if (resuelto.tipo !== "destino") return resuelto;

  // Vista POR COMPAÑÍA y la petición pide «todas las empresas»/«el grupo»: no existe vista conjunta, y no se elige una compañía por el usuario.
  if (cap.scope === "company" && cap.target.kind === "section" && PIDE_GRUPO.test(original)) {
    return { ...base, tipo: "aclaracion", pregunta: `«${cap.label}» se abre por compañía, no hay una vista conjunta. ¿De cuál?`,
      opciones: e.catalogo.companias.filter((c) => cap.companies.includes(c)).map((c) => opcionDe(cap, c)) };
  }

  // Filtro, sección, fecha o cifra pedidos y no soportados: nunca se abre el destino como si estuviera filtrado. Los refinamientos que la
  // propia sección ya resuelve (p. ej. «pendientes» en «pagos pendientes») no cuentan.
  const cubiertos = INTENCIONES_SECCION[cap.id]?.cubre ?? [];
  const sinSoporte = refinamientos.filter((r) => !cubiertos.includes(r));
  if (sinSoporte.length > 0) {
    return { ...base, tipo: "aclaracion",
      pregunta: `Todavía no puedo abrir «${cap.label}» ya filtrado por ${sinSoporte.join(", ")}: solo se abre ${cap.target.kind === "section" ? "la vista" : "el módulo"} completo. ¿Lo abro así?`,
      opciones: [opcionDe(cap, companyElegida, true)] };
  }

  return resuelto;
}

