import { listTreasuryAccounts, invalidarCacheCuentasTesoreria, type Empresa, type TreasuryAccount } from "../client";
import { empresasAutomatizacion, modoAutomatizacion } from "./modo";
import { requiereIntervencion, type NavegadorHolded } from "./navegador";
import { nuevoTrabajo, type AlmacenTrabajos, type Trabajo } from "./trabajos";

/**
 * Sincronización bancaria diaria de Holded. Hechos verificados contra la API real (2026-10-02):
 *  - No existe endpoint para lanzar ni consultar una sincronización. Lo único que expone Holded es `synced_at`
 *    por cuenta: es la EVIDENCIA con la que se verifica. Pulsar «Sincronizar» solo se puede desde la interfaz web.
 *  - Una cuenta cuenta como «completada» solo si su `synced_at` pasa a ser posterior al instante en que se lanzó.
 *  - Nunca se desconecta ni se reconecta un banco.
 */
export const VENTANA_VERIFICACION_MS = 3 * 60 * 60_000; // pasada esa ventana sin evidencia → «no confirmado»
export const MAX_INTENTOS_LANZAR = 3;

export interface CuentaBancaria {
  empresa: Empresa;
  id: string;
  /** Clave estable entre ejecuciones: empresa + id de cuenta de Holded. */
  clave: string;
  nombre: string;
  moneda: string;
  institucion?: string;
  sincronizadaEn?: number;
  pendientes?: number;
  sincronizable: boolean;
  motivo?: string;
}

/** Conectada = no archivada, de tipo banco/tarjeta/pasarela Y con institución enlazada. Manual/efectivo/contable: omitida. */
export function clasificarCuenta(empresa: Empresa, c: TreasuryAccount): CuentaBancaria {
  const institucion = typeof c.institution_name === "string" && c.institution_name ? c.institution_name : undefined;
  const sincronizadaEn = typeof c.synced_at === "string" && c.synced_at ? Date.parse(c.synced_at) : undefined;
  const base: CuentaBancaria = {
    empresa, id: c.id, clave: `${empresa}:${c.id}`, nombre: c.name ?? c.id, moneda: c.currency ?? "?", institucion,
    sincronizadaEn: Number.isFinite(sincronizadaEn) ? sincronizadaEn : undefined,
    pendientes: typeof c.transactions_pending_to_reconcile === "number" ? c.transactions_pending_to_reconcile : undefined,
    sincronizable: false,
  };
  if (c.archived === true) return { ...base, motivo: "archivada" };
  if (!institucion || !c.institution_id) return { ...base, motivo: c.type === "cash" ? "efectivo" : "manual_o_contable (sin banco enlazado)" };
  if (c.type !== "bank" && c.type !== "card" && c.type !== "gateway") return { ...base, motivo: `tipo_${String(c.type)}` };
  return { ...base, sincronizable: true };
}

export const claveSincronizacion = (fecha: string, c: Pick<CuentaBancaria, "clave">) => `sync:${fecha}:${c.clave}`;

/** Una cuenta «con actualización confirmada» desde `desde` según el registro: la conciliación posterior lo consulta. */
export async function cuentaTieneActualizacionConfirmada(
  almacen: AlmacenTrabajos, empresa: Empresa, cuentaId: string, desde: number,
): Promise<{ confirmada: boolean; verificadaEn?: number; estado?: string }> {
  const trabajos = await almacen.listar({ tipo: "sync_bancaria", empresa, desde });
  const mejor = trabajos
    .filter((t) => t.objetivo === cuentaId && t.estado === "completado" && (t.verificadoEn ?? 0) >= desde)
    .sort((a, b) => (b.verificadoEn ?? 0) - (a.verificadoEn ?? 0))[0];
  if (mejor) return { confirmada: true, verificadaEn: mejor.verificadoEn, estado: mejor.estado };
  const ultimo = trabajos.filter((t) => t.objetivo === cuentaId).sort((a, b) => b.actualizadoEn - a.actualizadoEn)[0];
  return { confirmada: false, estado: ultimo?.estado };
}

export interface DependenciasSync {
  almacen: AlmacenTrabajos;
  navegador?: () => NavegadorHolded | undefined;
  leerCuentas?: (empresa: Empresa) => Promise<TreasuryAccount[]>;
  notificar?: (texto: string) => Promise<void>;
  ahora?: () => number;
  /** Espera entre intentos al lanzar (ms); en pruebas, 0. */
  esperaMs?: (intento: number) => number;
  dormir?: (ms: number) => Promise<void>;
}

export interface ResumenSync {
  fecha: string;
  modo: string;
  cuentas: number;
  porEstado: Record<string, number>;
  detalle: Array<{ clave: string; nombre: string; estado: string; nota?: string }>;
}

const leerCuentasFrescas = async (empresa: Empresa) => { invalidarCacheCuentasTesoreria(empresa); return listTreasuryAccounts(empresa); };

/**
 * Fase 1 (06:00): decide qué cuentas sincronizar y lanza la acción. NO declara nada completado: eso es de la fase 2.
 * Una cuenta que falle no bloquea a las demás.
 */
export async function lanzarSincronizacionBancaria(fecha: string, dep: DependenciasSync): Promise<ResumenSync> {
  const ahora = dep.ahora ?? Date.now;
  const modo = modoAutomatizacion("SYNC_BANCARIA");
  const resumen: ResumenSync = { fecha, modo, cuentas: 0, porEstado: {}, detalle: [] };
  if (modo === "apagado") return resumen;
  const leer = dep.leerCuentas ?? leerCuentasFrescas;
  const dormir = dep.dormir ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  for (const empresa of empresasAutomatizacion("SYNC_BANCARIA")) {
    let cuentas: CuentaBancaria[];
    try { cuentas = (await leer(empresa)).map((c) => clasificarCuenta(empresa, c)); }
    catch (error) {
      // Un fallo de Holded no es «no hay cuentas»: se registra y se sigue con las demás empresas.
      resumen.detalle.push({ clave: `${empresa}:*`, nombre: empresa, estado: "fallido", nota: `No se pudo leer la tesorería: ${msg(error)}` });
      resumen.porEstado.fallido = (resumen.porEstado.fallido ?? 0) + 1;
      continue;
    }
    for (const cuenta of cuentas) {
      if (!cuenta.sincronizable) continue; // las manuales/archivadas no son trabajo: no ensucian el registro
      resumen.cuentas++;
      const clave = claveSincronizacion(fecha, cuenta);
      const resultado = await dep.almacen.conExclusion(clave, () => procesarCuenta(cuenta, clave, modo, dep, ahora, dormir));
      const t = resultado === "ocupado" ? await dep.almacen.obtener(clave) : resultado;
      const estado = t?.estado ?? "en_curso";
      resumen.porEstado[estado] = (resumen.porEstado[estado] ?? 0) + 1;
      resumen.detalle.push({ clave: cuenta.clave, nombre: cuenta.nombre, estado, nota: t?.ultimoError });
    }
  }
  return resumen;
}

async function procesarCuenta(
  cuenta: CuentaBancaria, clave: string, modo: string, dep: DependenciasSync, ahora: () => number, dormir: (ms: number) => Promise<void>,
): Promise<Trabajo> {
  let t = await dep.almacen.obtener(clave);
  // Reanudación tras reinicio o doble disparo: solo se repite lo que NO llegó a lanzarse.
  if (t && t.estado !== "solicitado") return t;
  t ??= nuevoTrabajo({ clave, tipo: "sync_bancaria", empresa: cuenta.empresa, objetivo: cuenta.id }, ahora());
  t.evidencia = { ...t.evidencia, nombre: cuenta.nombre, institucion: cuenta.institucion, syncedAtAntes: cuenta.sincronizadaEn ?? null, pendientesAntes: cuenta.pendientes ?? null };
  const guardar = async (estado?: Trabajo["estado"]) => { if (estado) t!.estado = estado; t!.actualizadoEn = ahora(); await dep.almacen.guardar(t!); return t!; };

  if (modo === "simulacion") {
    await dep.almacen.evento(clave, "simulado", { haria: "pulsar «Sincronizar» y verificar synced_at", ...t.evidencia });
    return guardar("simulado");
  }
  const navegador = dep.navegador?.();
  if (!navegador) {
    t.ultimoError = "Sin sesión web de Holded configurada en el servidor";
    await dep.almacen.evento(clave, "sin_navegador");
    return guardar("requiere_intervencion");
  }
  const lanzamiento = ahora();
  for (let intento = 1; intento <= MAX_INTENTOS_LANZAR; intento++) {
    t.intentos = intento;
    t.solicitadoEn = lanzamiento;
    const r = await navegador.sincronizarCuenta(cuenta.empresa, { id: cuenta.id, nombre: cuenta.nombre, institucion: cuenta.institucion })
      .catch((e): { estado: "error"; detalle: string } => ({ estado: "error", detalle: msg(e) }));
    await dep.almacen.evento(clave, "lanzado", { intento, resultado: r });
    if (r.estado === "ok") { t.ultimoError = undefined; return guardar("en_curso"); }
    t.ultimoError = r.detalle;
    if (requiereIntervencion(r)) return guardar("requiere_intervencion");
    await guardar();
    // Reintento con espera creciente; antes de repetir se mira el estado real por si la acción sí llegó a surtir efecto.
    await dormir((dep.esperaMs ?? ((n) => n * 30_000))(intento));
    const frescas = await (dep.leerCuentas ?? leerCuentasFrescas)(cuenta.empresa).catch(() => undefined);
    const actual = frescas?.find((c) => c.id === cuenta.id);
    const sync = marcaSync(actual);
    if (sync !== undefined && sync > lanzamiento) { t.evidencia.syncedAtDespues = actual!.synced_at; return guardar("en_curso"); }
  }
  return guardar("fallido");
}

/**
 * Fase 2 (varias veces tras las 06:00): comprueba con evidencia de Holded las cuentas «en curso». Completada solo si
 * `synced_at` es posterior al lanzamiento; vencida la ventana sin evidencia → «no confirmado» (nunca «completada»).
 */
export async function verificarSincronizacionBancaria(dep: DependenciasSync, desde?: number): Promise<{ verificadas: number; completadas: number; noConfirmadas: number }> {
  const ahora = dep.ahora ?? Date.now;
  const leer = dep.leerCuentas ?? leerCuentasFrescas;
  const pendientes = await dep.almacen.listar({ tipo: "sync_bancaria", estados: ["en_curso"], desde: desde ?? ahora() - 24 * 3_600_000 });
  const salida = { verificadas: 0, completadas: 0, noConfirmadas: 0 };
  const cache = new Map<Empresa, TreasuryAccount[] | null>();
  for (const t of pendientes) {
    const empresa = t.empresa as Empresa;
    if (!cache.has(empresa)) cache.set(empresa, await leer(empresa).catch(() => null));
    const cuentas = cache.get(empresa);
    if (!cuentas) continue; // Holded no respondió: no se deduce nada, se reintenta en la siguiente pasada
    const actual = cuentas.find((c) => c.id === t.objetivo);
    const sync = marcaSync(actual);
    salida.verificadas++;
    t.verificadoEn = ahora();
    if (actual && sync !== undefined && Number.isFinite(sync) && sync > (t.solicitadoEn ?? 0)) {
      t.estado = "completado";
      t.evidencia = { ...t.evidencia, syncedAtDespues: actual.synced_at, pendientesDespues: actual.transactions_pending_to_reconcile ?? null };
      salida.completadas++;
    } else if (ahora() - (t.solicitadoEn ?? t.creadoEn) > VENTANA_VERIFICACION_MS) {
      t.estado = "no_confirmado";
      t.ultimoError = "Holded no mostró una actualización posterior al lanzamiento dentro de la ventana de verificación";
      salida.noConfirmadas++;
    }
    t.actualizadoEn = ahora();
    await dep.almacen.guardar(t);
    await dep.almacen.evento(t.clave, "verificado", { estado: t.estado, syncedAt: actual?.synced_at ?? null });
  }
  return salida;
}

/** Aviso a Carlos solo si hay algo que él deba hacer o saber; en silencio si todo salió bien. */
export function textoAvisoSincronizacion(trabajos: Trabajo[]): string | undefined {
  const mal = trabajos.filter((t) => ["fallido", "requiere_intervencion", "no_confirmado"].includes(t.estado));
  if (mal.length === 0) return undefined;
  const lineas = mal.map((t) => `  • ${t.empresa} · ${String(t.evidencia.nombre ?? t.objetivo)}: ${t.estado.replace(/_/g, " ")}${t.ultimoError ? ` — ${t.ultimoError}` : ""}`);
  return [`⚠️ Sincronización bancaria de Holded: ${mal.length} cuenta(s) sin actualización confirmada.`, ...lineas,
    "", "Si hace falta renovar el consentimiento del banco o la sesión web de Holded, tiene que hacerlo una persona; el sistema no reconecta bancos."].join("\n");
}

function marcaSync(c: TreasuryAccount | undefined): number | undefined {
  const v = c?.synced_at;
  const ms = typeof v === "string" && v ? Date.parse(v) : undefined;
  return ms !== undefined && Number.isFinite(ms) ? ms : undefined;
}

function msg(e: unknown): string { return (e instanceof Error ? e.message : String(e)).slice(0, 300); }
