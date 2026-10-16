import type { Empresa } from "./client";

/**
 * Propuesta diaria de los pagos a colaboradores en divisa (pedido de Carlos, 16-10-2026, tras conciliar a mano 14 pares de Footprint en varias
 * rondas): cada mes entra un gasto «Monthly fee» sin pagar por colaborador y, días después, una transferencia «To <nombre> …» de la cuenta en USD
 * (o COP…) que incluye una comisión SWIFT de unos 28 USD. Este módulo SOLO PROPONE: empareja los casos demostrados y los entrega como las
 * preguntas de siempre («Conciliar con #1», con su botón de superadmin); nunca escribe en Holded, nunca toca tasas ni gastos.
 *
 * Un par es demostrado cuando coinciden a la vez: (1) el cargo es una transferencia («To …») cuya descripción lleva al menos dos palabras del nombre
 * del proveedor del gasto, (2) la misma moneda extranjera, (3) el cargo es igual al gasto o lo supera por una comisión razonable y (4) la
 * asignación gasto↔cargo es única (si hay varios gastos o cargos posibles y no se pueden ordenar por fecha sin duda, queda como dudoso).
 */
const MS_DIA = 86_400_000;
const TOLERANCIA = 0.011;
/** Comisión máxima admitida por moneda; en las demás (COP…) solo se empareja el importe exacto. */
export const COMISION_MAXIMA: Readonly<Record<string, number>> = { USD: 40, GBP: 35, CHF: 40 };
/** Un resto de cargo mayor por encima de esto ya no parece una comisión. */
export const MAX_FRACCION_RESTO = 0.1;
/** El cargo puede haberse hecho como mucho este tiempo antes o después de la fecha del gasto. */
const DIAS_ANTES = 7;
const DIAS_DESPUES = 45;
const PALABRAS_NEUTRAS = new Set(["de", "del", "la", "las", "los", "sas", "slu", "llc", "inc", "ltd", "sociedad", "limitada"]);
/** Vocabulario de los conceptos de una transferencia: nunca cuenta como parte del nombre de la persona. */
const PALABRAS_DE_CONCEPTO = new Set(["monthly", "fee", "fees", "partial", "honorarios", "profesionales", "comisiones", "comision", "commissions", "comissions", "commissionig", "payment", "salary", "sept", "september", "august", "july", "october", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]);

export interface CompraAbierta { id: string; contacto: string; numero: string; descripcion: string; fecha: string; total: number; pendiente: number; moneda: string }
export interface CargoAbierto { cuentaId: string; cuenta: string; id: string; fecha: string; importe: number; conciliado: number; moneda: string; descripcion: string; estado: "pending" | "partial" }
export interface ParColaborador { empresa: Empresa; compra: CompraAbierta; cargo: CargoAbierto; comision: number }
export interface ParDudoso { empresa: Empresa; compras: CompraAbierta[]; cargos: CargoAbierto[]; motivo: string }
export interface RestoAbierto { empresa: Empresa; cargo: CargoAbierto; resto: number; proveedor: string }

export const normalizar = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const palabras = (t: string): string[] => normalizar(t).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !PALABRAS_NEUTRAS.has(w));
const esTransferencia = (descripcion: string): boolean => /^to\s/i.test(descripcion.trim());
const dias = (fecha: string): number => Date.parse(`${fecha.slice(0, 10)}T00:00:00Z`) / MS_DIA;

/** ¿La descripción de la transferencia nombra al proveedor? Al menos dos palabras de su nombre y la mitad de ellas (tolera tildes, orden y una errata); los conceptos («Monthly Fee», meses…) no cuentan. */
export function nombraAlProveedor(proveedor: string, descripcion: string): boolean {
  const enDescripcion = new Set(palabras(descripcion).filter((w) => !PALABRAS_DE_CONCEPTO.has(w)));
  const nombre = palabras(proveedor);
  const coinciden = nombre.filter((p) => enDescripcion.has(p)).length;
  return coinciden >= 2 && coinciden >= nombre.length / 2;
}

/** Nombre de la persona dentro de una transferencia «To <nombre> Monthly Fee August»: sirve de clave de aprendizaje del tratamiento del resto. */
export const proveedorDeTransferencia = (descripcion: string): string =>
  descripcion.replace(/^to\s+/i, "").replace(/\b(monthly|honorarios|comisiones?|comissions?|commissionig|fee|partial|august|september|sept|jul|aug)\b.*$/i, "").trim() || descripcion.trim();

function comisionDelPar(c: CompraAbierta, m: CargoAbierto): number | undefined {
  if (m.estado !== "pending" || !esTransferencia(m.descripcion) || m.moneda !== c.moneda || c.moneda === "EUR") return undefined;
  if (c.pendiente < c.total - TOLERANCIA) return undefined; // gasto ya con pagos: no es el caso
  if (!nombraAlProveedor(c.contacto, m.descripcion)) return undefined;
  const diferencia = Math.round((Math.abs(m.importe) - c.total) * 100) / 100;
  if (diferencia < -TOLERANCIA || diferencia > (COMISION_MAXIMA[c.moneda] ?? TOLERANCIA)) return undefined;
  const antes = dias(c.fecha) - dias(m.fecha); // días que el cargo es ANTERIOR al gasto
  if (!Number.isFinite(antes)) return undefined; // fecha ilegible: no se demuestra nada
  if (antes > DIAS_ANTES || -antes > DIAS_DESPUES) return undefined;
  return Math.max(0, diferencia);
}

/**
 * Empareja gastos sin pagar con transferencias pendientes. Agrupa por componentes conexos: un gasto y un cargo solos son un par; varios gastos y varios
 * cargos del mismo proveedor (Andrés: dos meses, dos transferencias) se emparejan por ORDEN de fecha solo si hay tantos gastos como cargos y cada par
 * resultante es compatible; en cualquier otro caso se deja como dudoso, con su motivo, y no se propone nada.
 */
export function emparejarPagosColaboradores(empresa: Empresa, compras: CompraAbierta[], cargos: CargoAbierto[]): { pares: ParColaborador[]; dudosos: ParDudoso[] } {
  const aristas = new Map<string, number>(); // `${iCompra}|${iCargo}` -> comisión
  compras.forEach((c, i) => cargos.forEach((m, j) => { const k = comisionDelPar(c, m); if (k !== undefined) aristas.set(`${i}|${j}`, k); }));
  // Componentes conexos
  const padre = new Map<string, string>();
  const raiz = (x: string): string => { let r = x; while (padre.get(r) !== r) r = padre.get(r)!; return r; };
  const unir = (a: string, b: string) => { padre.set(raiz(a), raiz(b)); };
  for (const clave of aristas.keys()) {
    const [i, j] = clave.split("|");
    for (const n of [`c${i}`, `m${j}`]) if (!padre.has(n)) padre.set(n, n);
    unir(`c${i}`, `m${j}`);
  }
  const grupos = new Map<string, { c: number[]; m: number[] }>();
  for (const n of padre.keys()) {
    const g = grupos.get(raiz(n)) ?? { c: [], m: [] };
    (n[0] === "c" ? g.c : g.m).push(Number(n.slice(1)));
    grupos.set(raiz(n), g);
  }
  const pares: ParColaborador[] = [];
  const dudosos: ParDudoso[] = [];
  for (const g of grupos.values()) {
    const ci = [...g.c].sort((x, y) => compras[x].fecha.localeCompare(compras[y].fecha));
    const mj = [...g.m].sort((x, y) => cargos[x].fecha.localeCompare(cargos[y].fecha));
    // Emparejamiento por ORDEN de fecha: válido solo si hay tantos gastos como cargos, ninguna fecha repetida (el orden sería arbitrario) y cada par resultante es compatible.
    const sinEmpates = ci.length === 1 || (new Set(ci.map((i) => compras[i].fecha)).size === ci.length && new Set(mj.map((j) => cargos[j].fecha)).size === mj.length);
    if (sinEmpates && ci.length === mj.length && ci.every((i, k) => aristas.has(`${i}|${mj[k]}`))) {
      ci.forEach((i, k) => pares.push({ empresa, compra: compras[i], cargo: cargos[mj[k]], comision: aristas.get(`${i}|${mj[k]}`) ?? 0 }));
    } else {
      dudosos.push({ empresa, compras: ci.map((i) => compras[i]), cargos: mj.map((j) => cargos[j]), motivo: `${ci.length} gasto(s) sin pagar y ${mj.length} transferencia(s) posibles del mismo proveedor: no se puede asegurar cuál va con cuál.` });
    }
  }
  return { pares, dudosos };
}

/** Transferencias ya conciliadas en parte cuyo resto parece una comisión (para cerrarlo como gasto bancario). */
export function restosAbiertos(empresa: Empresa, cargos: CargoAbierto[]): RestoAbierto[] {
  return cargos.flatMap((m) => {
    if (m.estado !== "partial" || m.importe >= 0 || !esTransferencia(m.descripcion)) return [];
    const resto = Math.round((Math.abs(m.importe) - Math.abs(m.conciliado)) * 100) / 100;
    if (!(resto > 0.005) || resto > Math.abs(m.importe) * MAX_FRACCION_RESTO) return [];
    return [{ empresa, cargo: m, resto, proveedor: proveedorDeTransferencia(m.descripcion) }];
  });
}

/** Primer día del trimestre natural de la fecha: los periodos anteriores suelen estar cerrados en Holded y no dejan crear el gasto bancario. */
export function inicioTrimestre(ahora: number): string {
  const d = new Date(ahora);
  return `${d.getUTCFullYear()}-${String(Math.floor(d.getUTCMonth() / 3) * 3 + 1).padStart(2, "0")}-01`;
}

const dinero = (n: number, moneda: string): string => `${n.toFixed(2).replace(".", ",")} ${moneda}`;
const corta = (f: string): string => `${f.slice(8, 10)}/${f.slice(5, 7)}`;

export interface EnvioPropuesta { ok: boolean; motivo: string }

/** Lee el texto que devuelven las herramientas de propuesta: solo cuenta como enviada la que de verdad dejó la pregunta publicada («fallida» no lo es). */
export const envioDePar = (texto: string): EnvioPropuesta => ({ ok: /Ya le mandé por Telegram[\s\S]*\(esperando_eleccion\)/.test(texto), motivo: texto });
export const envioDeResto = (texto: string): EnvioPropuesta => ({ ok: /Te mostré la propuesta con su botón/.test(texto), motivo: texto });

export interface DepsPropuestaColaboradores {
  empresas: readonly Empresa[];
  leerCompras(empresa: Empresa): Promise<CompraAbierta[]>;
  leerCargos(empresa: Empresa): Promise<CargoAbierto[]>;
  /** Última vez (ms) que se propuso cada clave. */
  yaPropuestas(): Promise<Map<string, number>>;
  marcarPropuestas(claves: string[]): Promise<void>;
  /** Manda la pregunta con botón de siempre; `ok` solo si quedó publicada (con el motivo cuando no). */
  proponerPar(par: ParColaborador): Promise<EnvioPropuesta>;
  proponerResto(resto: RestoAbierto): Promise<EnvioPropuesta>;
  avisar(texto: string): Promise<void>;
  ahora(): number;
  simular?: boolean;
}

export interface ResultadoPropuestaColaboradores {
  simulado: boolean;
  pares: ParColaborador[];
  dudosos: ParDudoso[];
  restosPropuestos: RestoAbierto[];
  restosAManoOCerrados: RestoAbierto[];
  enviados: string[];
  fallos: string[];
  empresasConError: Empresa[];
}

export const clavePar = (p: ParColaborador): string => `par:${p.compra.id}|${p.cargo.cuentaId}/${p.cargo.id}`;
export const claveResto = (r: RestoAbierto): string => `resto:${r.cargo.cuentaId}/${r.cargo.id}|${Math.round(r.resto * 100)}`;
export const claveRestoAntiguo = (r: RestoAbierto): string => `restoantiguo:${r.cargo.cuentaId}/${r.cargo.id}|${Math.round(r.resto * 100)}`;
/** Días de espera antes de volver a proponer cada tipo de aviso: lo accionable cada semana; lo informativo (dudosos, restos antiguos) cada mes. */
const VENTANA_DIAS = { par: 7, resto: 7, dudoso: 30, restoantiguo: 30 } as const;
export const claveDudoso = (d: ParDudoso): string => `dudoso:${[...d.compras.map((c) => c.id), ...d.cargos.map((m) => `${m.cuentaId}/${m.id}`)].sort().join(",")}`;

/**
 * Recorre las empresas, empareja, y propone SOLO lo nuevo: primero intenta cada propuesta (y marca al instante las que salieron, para no duplicarlas aunque
 * falle el aviso) y después manda UN aviso con lo enviado, lo que falló (con su motivo), los dudosos, los restos antiguos y las empresas que no se pudieron leer.
 * Un fallo al leer una empresa no tumba las demás ni se toma como «no hay pares». Sin novedades no escribe a nadie. En simulación no manda ni marca nada.
 */
export async function proponerPagosColaboradores(d: DepsPropuestaColaboradores): Promise<ResultadoPropuestaColaboradores> {
  const ultimas = await d.yaPropuestas();
  const ahora = d.ahora();
  const reciente = (clave: string, tipo: keyof typeof VENTANA_DIAS): boolean => { const t = ultimas.get(clave); return t !== undefined && ahora - t < VENTANA_DIAS[tipo] * MS_DIA; };
  const trimestre = inicioTrimestre(ahora);
  const r: ResultadoPropuestaColaboradores = { simulado: d.simular === true, pares: [], dudosos: [], restosPropuestos: [], restosAManoOCerrados: [], enviados: [], fallos: [], empresasConError: [] };
  for (const empresa of d.empresas) {
    try {
      const [compras, cargos] = await Promise.all([d.leerCompras(empresa), d.leerCargos(empresa)]);
      const { pares, dudosos } = emparejarPagosColaboradores(empresa, compras, cargos);
      r.pares.push(...pares.filter((p) => !reciente(clavePar(p), "par")));
      r.dudosos.push(...dudosos.filter((x) => !reciente(claveDudoso(x), "dudoso")));
      for (const x of restosAbiertos(empresa, cargos)) {
        if (x.cargo.fecha >= trimestre) { if (!reciente(claveResto(x), "resto")) r.restosPropuestos.push(x); }
        else if (!reciente(claveRestoAntiguo(x), "restoantiguo")) r.restosAManoOCerrados.push(x);
      }
    } catch (error) {
      console.error(`[pagosColaboradores] No se pudo revisar ${empresa}:`, error instanceof Error ? error.name : "Error");
      r.empresasConError.push(empresa);
    }
  }
  const hayNovedades = r.pares.length + r.dudosos.length + r.restosPropuestos.length + r.restosAManoOCerrados.length + r.empresasConError.length > 0;
  if (r.simulado || !hayNovedades) return r;

  const enviadosTxt: string[] = [], fallosTxt: string[] = [];
  const intentar = async (clave: string, texto: string, enviar: () => Promise<EnvioPropuesta>): Promise<void> => {
    let envio: EnvioPropuesta;
    try { envio = await enviar(); } catch (error) { envio = { ok: false, motivo: error instanceof Error ? error.message : "error desconocido" }; }
    if (envio.ok) {
      r.enviados.push(clave); enviadosTxt.push(texto);
      await d.marcarPropuestas([clave]).catch((error) => console.error("[pagosColaboradores] No se pudo marcar una propuesta enviada:", error instanceof Error ? error.name : "Error"));
    } else { r.fallos.push(clave); fallosTxt.push(`${texto} — no pude proponerlo: ${envio.motivo.slice(0, 220)}`); }
  };
  for (const p of r.pares) await intentar(clavePar(p), `• ${p.empresa} · ${p.compra.contacto} — gasto ${p.compra.numero || "s/n"} ${dinero(p.compra.total, p.compra.moneda)} ↔ «${p.cargo.descripcion}» ${dinero(Math.abs(p.cargo.importe), p.cargo.moneda)} (${corta(p.cargo.fecha)})${p.comision > TOLERANCIA ? `, comisión ${dinero(p.comision, p.compra.moneda)}` : ""}`, () => d.proponerPar(p));
  for (const x of r.restosPropuestos) await intentar(claveResto(x), `• ${x.empresa} · resto de «${x.cargo.descripcion}» (${corta(x.cargo.fecha)}): ${dinero(x.resto, x.cargo.moneda)}`, () => d.proponerResto(x));

  const lineas: string[] = [];
  if (enviadosTxt.length) lineas.push(`Pagos a colaboradores: te mandé ${enviadosTxt.length} propuesta(s) con su botón; no se concilia nada hasta que lo pulses.`, ...enviadosTxt);
  if (fallosTxt.length) lineas.push(`\nNo pude proponer (${fallosTxt.length}):`, ...fallosTxt);
  if (r.restosAManoOCerrados.length) {
    lineas.push(`\nRestos de trimestres anteriores (${r.restosAManoOCerrados.length}): Holded suele tener esos periodos cerrados, así que no propongo crear el gasto bancario; ajústalos a mano o pídeme que lo intente.`);
    for (const x of r.restosAManoOCerrados) lineas.push(`• ${x.empresa} · «${x.cargo.descripcion}» (${corta(x.cargo.fecha)}): ${dinero(x.resto, x.cargo.moneda)}`);
  }
  if (r.dudosos.length) {
    lineas.push(`\nDudosos (${r.dudosos.length}), no propongo nada:`);
    for (const x of r.dudosos) lineas.push(`• ${x.empresa} · ${x.compras.map((c) => `${c.contacto} ${c.numero || "s/n"} ${dinero(c.total, c.moneda)}`).join(" / ")} ↔ ${x.cargos.map((m) => `${dinero(Math.abs(m.importe), m.moneda)} (${corta(m.fecha)})`).join(" / ")}: ${x.motivo}`);
  }
  if (r.empresasConError.length) lineas.push(`\nNo pude leer Holded de: ${r.empresasConError.join(", ")}. No se revisó esa empresa; lo reintento en la próxima pasada.`);
  try {
    await d.avisar(lineas.join("\n"));
    // Lo informativo y los fallos se marcan solo si el aviso llegó: si no, se reintentan mañana.
    const informativas = [...r.fallos, ...r.dudosos.map(claveDudoso), ...r.restosAManoOCerrados.map(claveRestoAntiguo)];
    if (informativas.length) await d.marcarPropuestas(informativas);
  } catch (error) {
    console.error("[pagosColaboradores] No se pudo mandar el aviso (se reintenta en la próxima pasada):", error instanceof Error ? error.name : "Error");
  }
  return r;
}
