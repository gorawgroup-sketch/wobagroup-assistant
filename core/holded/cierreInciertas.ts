import { normalizarNombreContacto, type InspeccionCreacionContacto, type RegistroCreacionContacto } from "./durableContact";
import type { RegistroCreacionCompra } from "./durablePurchase";

/**
 * Cierre AUTOMÁTICO de registros inciertos antiguos (compras y contactos), sin botones ni aprobaciones: solo cierra lo que la lectura de
 * Holded DEMUESTRA y avisa una vez de lo que no puede decidir. Nunca escribe en Holded: solo mueve registros de nuestro propio ledger a
 * «preparada» (nada llegó a hacerse) con una marca visible. Antes quedaban para siempre como «inciertos» y aparecían cada día en el
 * diagnóstico sin que nadie pudiera cerrarlos (caso 2026-10-13: dos intentos fallidos del 21-09 ya sustituidos por intentos correctos).
 *
 * Reglas (todas conservadoras; ante la duda, no se cierra):
 *  - solo registros con más de 24 h desde su último movimiento;
 *  - CONTACTO: si la búsqueda exacta por nombre/NIF devuelve 0 contactos → nunca se creó → se cierra. 1 exacto → lo verifica el reconciliador
 *    normal (no se cierra aquí). Varios → dudoso (aviso). Una búsqueda fallida o incompleta no cierra nada;
 *  - COMPRA: solo si NO existe una compra con su marca y SÍ existe otra compra propia creada después, de la misma fecha y del mismo proveedor
 *    (mismo id o mismo nombre normalizado): el gasto se registró bien en un intento posterior. Sin esa prueba, dudoso (aviso).
 */
export const EDAD_MINIMA_CIERRE_MS = 24 * 60 * 60_000;
/** Un intento posterior se busca hasta 7 días después: los reintentos reales llegan en minutos u horas. */
export const VENTANA_INTENTO_POSTERIOR_MS = 7 * 24 * 60 * 60_000;
/** Solo se avisa de un dudoso mientras tiene entre 1 y 3 días: un aviso, no un recordatorio diario. */
export const VENTANA_AVISO_MS = 3 * 24 * 60 * 60_000;

export interface CompraPosterior { id: string; fecha: string; contactId: string; contactoNombre: string; notas: string }

export interface DepsCierreInciertas {
  contactosInciertos(): Promise<RegistroCreacionContacto[]>;
  inspeccionarContacto(r: RegistroCreacionContacto): Promise<InspeccionCreacionContacto>;
  cerrarContacto(clave: string): Promise<boolean>;
  comprasInciertas(): Promise<RegistroCreacionCompra[]>;
  nombreDeContacto(empresa: RegistroCreacionCompra["empresa"], contactId: string): Promise<string>;
  comprasPropiasPosteriores(empresa: RegistroCreacionCompra["empresa"], desdeMs: number, hastaMs: number): Promise<CompraPosterior[]>;
  cerrarCompra(clave: string): Promise<boolean>;
  avisar(texto: string): Promise<void>;
  ahora?: () => number;
  /** Solo comprueba y cuenta; no cierra ni avisa. */
  simular?: boolean;
}

export interface CasoCerrado { tipo: "contacto" | "compra"; clave: string; descripcion: string; motivo: string }
export interface CasoDudoso { tipo: "contacto" | "compra"; clave: string; descripcion: string; motivo: string; edadMs: number }
export interface ResultadoCierre { cerrados: CasoCerrado[]; dudosos: CasoDudoso[]; omitidos: number; simulado: boolean }

const fecha10 = (v: string): string => String(v ?? "").slice(0, 10);

/**
 * ¿Dos nombres de contacto son del mismo proveedor? Holded repite a veces el nombre entre paréntesis («Albert Heijn (Albert Heijn)») y puede haber
 * dos fichas del mismo comercio, así que además del mismo id se acepta que TODAS las palabras del nombre más corto estén en el otro, siempre que
 * el corto tenga al menos 2 palabras (un nombre de una sola palabra exige igualdad: «Uber» no es «Uber Eats»).
 */
export function mismoProveedor(a: string, b: string): boolean {
  const ta = normalizarNombreContacto(a).split(" ").filter(Boolean), tb = normalizarNombreContacto(b).split(" ").filter(Boolean);
  if (ta.length === 0 || tb.length === 0) return false;
  const [corto, largo] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (corto.length === 1) return largo.length === 1 && corto[0] === largo[0];
  return corto.every((t) => largo.includes(t));
}

export async function cerrarInciertasAntiguas(deps: DepsCierreInciertas): Promise<ResultadoCierre> {
  const ahora = (deps.ahora ?? Date.now)();
  const cerrados: CasoCerrado[] = [];
  const dudosos: CasoDudoso[] = [];
  let omitidos = 0;
  const cierra = async (tipo: CasoCerrado["tipo"], clave: string, descripcion: string, motivo: string, cerrar: (c: string) => Promise<boolean>) => {
    if (!deps.simular && !(await cerrar(clave))) { omitidos++; return; } // otro proceso ya lo resolvió: no se cuenta como cierre
    cerrados.push({ tipo, clave, descripcion, motivo });
  };

  for (const r of await deps.contactosInciertos()) {
    if (r.estado !== "incierta" || ahora - r.actualizadoEn < EDAD_MINIMA_CIERRE_MS) { omitidos++; continue; }
    const descripcion = `contacto «${r.nombre}» (${r.empresa})`;
    let inspeccion: InspeccionCreacionContacto;
    try { inspeccion = await deps.inspeccionarContacto(r); }
    catch (error) {
      // Una búsqueda fallida o incompleta NO demuestra nada: no se cierra y no se avisa (se reintenta mañana).
      console.error(`[cierreInciertas] No se pudo inspeccionar ${descripcion}:`, error instanceof Error ? error.name : "Error");
      omitidos++; continue;
    }
    if (inspeccion.estado === "ausente") await cierra("contacto", r.clave, descripcion, "no existe ningún contacto con ese nombre en Holded: la creación nunca llegó a hacerse", deps.cerrarContacto);
    else if (inspeccion.estado === "unico") omitidos++; // lo verifica el reconciliador de arranque
    else dudosos.push({ tipo: "contacto", clave: r.clave, descripcion, edadMs: ahora - r.actualizadoEn, motivo: `Holded devuelve ${inspeccion.cantidad} contactos para ese nombre: hay que resolver el duplicado a mano` });
  }

  for (const r of await deps.comprasInciertas()) {
    if (r.estado !== "incierta" || ahora - r.actualizadoEn < EDAD_MINIMA_CIERRE_MS) { omitidos++; continue; }
    const descripcion = `compra de ${r.empresa} del ${fecha10(r.fecha)} (intento del ${new Date(r.creadoEn).toISOString().slice(0, 16).replace("T", " ")} UTC)`;
    let posteriores: CompraPosterior[]; let nombre: string;
    try {
      nombre = await deps.nombreDeContacto(r.empresa, r.contactId);
      posteriores = await deps.comprasPropiasPosteriores(r.empresa, r.creadoEn, r.creadoEn + VENTANA_INTENTO_POSTERIOR_MS);
    } catch (error) {
      console.error(`[cierreInciertas] No se pudo comprobar ${descripcion}:`, error instanceof Error ? error.name : "Error");
      omitidos++; continue;
    }
    // Si existe una compra con la marca de este intento, el intento SÍ se hizo: lo verifica el reconciliador, aquí no se cierra.
    const marca = r.marcador.replace(/^\[wobi:|\]$/g, "").slice(0, 16);
    if (marca && posteriores.some((p) => p.notas.includes(marca))) { omitidos++; continue; }
    const sustituta = posteriores.find((p) => fecha10(p.fecha) === fecha10(r.fecha) && (p.contactId === r.contactId || mismoProveedor(p.contactoNombre, nombre)));
    if (sustituta) await cierra("compra", r.clave, descripcion, `el gasto ya está registrado una sola vez en la compra ${sustituta.id} (mismo proveedor y fecha, creada después con otra marca); este intento no dejó ninguna compra`, deps.cerrarCompra);
    else dudosos.push({ tipo: "compra", clave: r.clave, descripcion, edadMs: ahora - r.actualizadoEn, motivo: "no encuentro ninguna compra con su marca ni otra posterior del mismo proveedor y fecha: no puedo demostrar que no exista (los tickets no aparecen en el listado)" });
  }

  const avisables = dudosos.filter((d) => d.edadMs >= EDAD_MINIMA_CIERRE_MS && d.edadMs <= VENTANA_AVISO_MS);
  if (!deps.simular && avisables.length > 0) {
    await deps.avisar([
      `ℹ️ WOBI revisó ${avisables.length} operación(es) de Holded que quedaron sin confirmar y no puede cerrarlas sola:`,
      ...avisables.slice(0, 10).map((d) => `  • ${d.descripcion}: ${d.motivo}`),
      "",
      "No hay que hacer nada con prisa: no se ha creado ni borrado nada. Si quieres, pídeme que las revise.",
    ].join("\n"));
  }
  return { cerrados, dudosos, omitidos, simulado: Boolean(deps.simular) };
}
