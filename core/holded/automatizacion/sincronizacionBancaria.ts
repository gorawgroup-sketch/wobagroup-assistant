import { listTreasuryAccounts, invalidarCacheCuentasTesoreria, type Empresa, type TreasuryAccount } from "../client";
import { empresasAutomatizacion, modoAutomatizacion, parsearCasosAprobados } from "./modo";
import { registrarTraza } from "./traza";
import { coincideNombreLegal, etiquetaEmpresa, NOMBRES_LEGALES } from "./empresas";
import { requiereIntervencion, type NavegadorHolded, type ResultadoNavegador } from "./navegador";
import { nuevoTrabajo, type AlmacenTrabajos, type Trabajo } from "./trabajos";

/**
 * Sincronización bancaria diaria de Holded. Hechos verificados contra la API real (2026-10-02):
 *  - No existe endpoint para lanzar ni consultar una sincronización. Lo único que expone Holded es `synced_at`
 *    por cuenta: es la EVIDENCIA con la que se verifica. Pulsar «Sincronizar» solo se puede desde la interfaz web.
 *  - Una cuenta cuenta como «completada» solo si su `synced_at` pasa a ser posterior al instante en que se lanzó.
 *  - Nunca se desconecta ni se reconecta un banco.
 */
export const VENTANA_VERIFICACION_MS = 3 * 60 * 60_000; // pasada esa ventana sin evidencia → «no confirmado»
export const MAX_PASADAS_DIA = 3; // pasadas de lanzamiento por cuenta y día (06:00, 06:40, 07:20)

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
  /** Intentos dentro de una misma pasada (por defecto 1: el navegador ya reintenta por dentro). */
  intentosPorPasada?: number;
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
  if (modo === "activo") await reabrirTransitoriasDelDia(dep.almacen, fecha, ahora);

  for (const empresa of empresasAutomatizacion("SYNC_BANCARIA")) {
    let cuentas: CuentaBancaria[];
    try { cuentas = (await leer(empresa)).map((c) => clasificarCuenta(empresa, c)); }
    catch (error) {
      // Un fallo de Holded no es «no hay cuentas»: se registra y se sigue con las demás empresas.
      resumen.detalle.push({ clave: `${empresa}:*`, nombre: empresa, estado: "fallido", nota: `No se pudo leer la tesorería: ${msg(error)}` });
      resumen.porEstado.fallido = (resumen.porEstado.fallido ?? 0) + 1;
      continue;
    }
    // Alcance aprobado por Carlos para las primeras ejecuciones: WOBI_HOLDED_SYNC_BANCARIA_CUENTAS="Empresa:idCuenta,…".
    // Sin la variable, se sincronizan todas las cuentas conectadas de las empresas en alcance.
    const aprobadas = parsearCasosAprobados(process.env.WOBI_HOLDED_SYNC_BANCARIA_CUENTAS);
    // Identidad de la empresa activa: se lee UNA vez por empresa y pasada (solo si hay alguna cuenta que lanzar).
    let identidad: Promise<ResultadoNavegador> | undefined;
    const verificarIdentidad = (nav: NavegadorHolded) => (identidad ??= nav.leerNombreLegal ? nav.leerNombreLegal(empresa).catch((e): ResultadoNavegador => ({ estado: "error", detalle: msg(e) })) : Promise.resolve({ estado: "ok" as const, detalle: "" }));
    for (const cuenta of cuentas) {
      if (!cuenta.sincronizable) continue; // las manuales/archivadas no son trabajo: no ensucian el registro
      if (aprobadas.length > 0 && !aprobadas.some((a) => a.empresa === empresa && a.id === cuenta.id)) continue;
      resumen.cuentas++;
      const clave = claveSincronizacion(fecha, cuenta);
      const resultado = await dep.almacen.conExclusion(clave, () => procesarCuenta(cuenta, clave, modo, dep, ahora, dormir, verificarIdentidad));
      const t = resultado === "ocupado" ? await dep.almacen.obtener(clave) : resultado;
      const estado = t?.estado ?? "en_curso";
      resumen.porEstado[estado] = (resumen.porEstado[estado] ?? 0) + 1;
      resumen.detalle.push({ clave: cuenta.clave, nombre: cuenta.nombre, estado, nota: t?.ultimoError });
    }
  }
  return resumen;
}

const MOTIVO_TRANSITORIO = /empresa activa|Cambiar cuenta|lista de cuentas|No se abrió|No se pudo activar|No se encontró el botón|No se pudo verificar la identidad|No se pudo leer el nombre/i;
const MOTIVO_HUMANO = /consentimiento|renovar|reconectar|reautoriz|sesión web|sesion web|Sin sesión|nombre legal/i;

/**
 * Cuentas de HOY que quedaron en «requiere intervención» por un motivo que ahora se sabe transitorio (pantalla recargada, empresa
 * sin activar…): se reabren para la siguiente pasada, dentro del límite de pasadas del día. Nunca las que exigen a una persona
 * (consentimiento del banco, sesión, nombre legal que no coincide).
 */
export async function reabrirTransitoriasDelDia(almacen: AlmacenTrabajos, fecha: string, ahora: () => number = Date.now): Promise<number> {
  let reabiertas = 0;
  const candidatos = (await almacen.listar({ tipo: "sync_bancaria", estados: ["requiere_intervencion"], desde: ahora() - 36 * 3_600_000 })).filter((t) => t.clave.startsWith(`sync:${fecha}:`));
  for (const t of candidatos) {
    const motivo = t.ultimoError ?? "";
    if (MOTIVO_HUMANO.test(motivo) || !MOTIVO_TRANSITORIO.test(motivo) || Number(t.evidencia.pasadas ?? 0) >= MAX_PASADAS_DIA) continue;
    t.estado = "solicitado"; t.actualizadoEn = ahora();
    t.evidencia.pasadas = Number(t.evidencia.pasadas ?? 0) + 1;
    await almacen.guardar(t);
    await almacen.evento(t.clave, "reabierta_transitoria", { motivo });
    reabiertas++;
  }
  return reabiertas;
}

async function procesarCuenta(
  cuenta: CuentaBancaria, clave: string, modo: string, dep: DependenciasSync, ahora: () => number, dormir: (ms: number) => Promise<void>,
  verificarIdentidad: (navegador: NavegadorHolded) => Promise<ResultadoNavegador>,
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
  // Identidad: el nombre LEGAL de la empresa activa en Holded debe ser el esperado (el título del selector no basta). Si no
  // coincide, no se toca nada y lo decide una persona; si no se pudo leer, es transitorio (se reintenta en la siguiente pasada).
  const identidad = await verificarIdentidad(navegador);
  if (identidad.estado === "ok" && identidad.detalle) {
    if (!coincideNombreLegal(cuenta.empresa, identidad.detalle)) {
      t.ultimoError = `El nombre legal de la empresa activa en Holded («${identidad.detalle}») no es el esperado («${NOMBRES_LEGALES[cuenta.empresa]}»); no se tocó nada`;
      await dep.almacen.evento(clave, "identidad_no_coincide", { leido: identidad.detalle });
      return guardar("requiere_intervencion");
    }
    t.evidencia.nombreLegalVerificado = identidad.detalle;
    registrarTraza("identidad_verificada", { empresa: cuenta.empresa });
    console.log("[sincronizacionBancariaHolded] identidad verificada", JSON.stringify({ empresa: cuenta.empresa, nombreLegal: identidad.detalle }));
  } else if (identidad.estado !== "ok") {
    t.ultimoError = `No se pudo verificar la identidad de la empresa: ${identidad.detalle}`;
    if (requiereIntervencion(identidad)) return guardar("requiere_intervencion");
    t.evidencia.pasadas = Number(t.evidencia.pasadas ?? 0) + 1;
    return guardar(Number(t.evidencia.pasadas) >= MAX_PASADAS_DIA ? "fallido" : "solicitado");
  }
  const lanzamiento = ahora();
  // Un intento por pasada: el propio navegador ya reintenta internamente. Si falla de forma transitoria, el trabajo queda
  // «solicitado» y las pasadas siguientes del día (06:40 y 07:20) lo repiten; tras MAX_PASADAS_DIA pasa a «fallido».
  const intentosPorPasada = dep.intentosPorPasada ?? 1;
  for (let intento = 1; intento <= intentosPorPasada; intento++) {
    t.intentos = (t.intentos ?? 0) + 1;
    t.solicitadoEn = lanzamiento;
    const r = await navegador.sincronizarCuenta(cuenta.empresa, { id: cuenta.id, nombre: cuenta.nombre, institucion: cuenta.institucion })
      .catch((e): { estado: "error"; detalle: string } => ({ estado: "error", detalle: msg(e) }));
    await dep.almacen.evento(clave, "lanzado", { intento, resultado: r });
    console.log("[sincronizacionBancariaHolded] cuenta", JSON.stringify({ clave, intento, resultado: r.estado, detalle: r.detalle?.slice(0, 160) }));
    registrarTraza("cuenta", { empresa: cuenta.empresa, nombre: cuenta.nombre, resultado: r.estado, detalle: r.detalle?.slice(0, 120) ?? null });
    if (r.estado === "ok" && r.confirmadoEnPantalla) {
      // Holded mostró «Actualizado hace unos segundos» junto al saldo: sincronizada, con la hora y el texto como evidencia.
      t.ultimoError = undefined; t.verificadoEn = ahora(); t.evidencia.confirmadoEnPantalla = r.confirmadoEnPantalla;
      return guardar("completado");
    }
    if (r.estado === "ok") { t.ultimoError = undefined; return guardar("en_curso"); }
    t.ultimoError = r.detalle;
    if (requiereIntervencion(r)) return guardar("requiere_intervencion");
    await guardar();
    // Antes de repetir se mira el estado real de Holded por si la acción sí llegó a surtir efecto.
    if (intento < intentosPorPasada) await dormir((dep.esperaMs ?? ((n) => n * 30_000))(intento));
    const frescas = await (dep.leerCuentas ?? leerCuentasFrescas)(cuenta.empresa).catch(() => undefined);
    const actual = frescas?.find((c) => c.id === cuenta.id);
    const sync = marcaSync(actual);
    if (sync !== undefined && sync > lanzamiento) { t.evidencia.syncedAtDespues = actual!.synced_at; return guardar("en_curso"); }
  }
  t.evidencia.pasadas = Number(t.evidencia.pasadas ?? 0) + 1;
  return guardar(Number(t.evidencia.pasadas) >= MAX_PASADAS_DIA ? "fallido" : "solicitado");
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

/**
 * Cierre del día (09:45): una cuenta que sigue «solicitada» o «en curso» ya no va a recibir más pasadas hoy. Caso real
 * (10-10-2026): la pasada de las 06:00 se alargó (5 min de espera por cuenta que no confirmaba), la de las 06:40 se omitió
 * por solapamiento y la de las 07:20 volvió a fallar; 5 cuentas conectadas (WOBA Main, Pocket EUR/USD, Footprint Emoney
 * EUR/USD) quedaron «solicitadas» con 2 de 3 pasadas, nunca pasaron a «fallido» y el aviso de las 09:45 salió vacío.
 * Aquí se cierran como «no confirmado» con su última causa, para que el aviso las nombre y el estado quede en el registro.
 */
export async function cerrarPendientesDelDia(almacen: AlmacenTrabajos, fecha: string, ahora: () => number = Date.now): Promise<Trabajo[]> {
  const abiertas = (await almacen.listar({ tipo: "sync_bancaria", estados: ["solicitado", "en_curso"], desde: ahora() - 36 * 3_600_000 }))
    .filter((t) => t.clave.startsWith(`sync:${fecha}:`));
  for (const t of abiertas) {
    const causa = t.ultimoError ? `; última causa: ${t.ultimoError}` : "";
    t.ultimoError = `No se completó en las pasadas del día (${t.intentos ?? 0} intento(s), ${Number(t.evidencia.pasadas ?? 0)} pasada(s))${causa}`;
    t.estado = "no_confirmado";
    t.actualizadoEn = ahora();
    await almacen.guardar(t);
    await almacen.evento(t.clave, "cerrado_sin_confirmar", { intentos: t.intentos ?? 0, pasadas: Number(t.evidencia.pasadas ?? 0) });
  }
  return abiertas;
}

/** Aviso a Carlos solo si hay algo que él deba hacer o saber; en silencio si todo salió bien. */
export function textoAvisoSincronizacion(trabajos: Trabajo[]): string | undefined {
  const mal = trabajos.filter((t) => ["fallido", "requiere_intervencion", "no_confirmado"].includes(t.estado));
  if (mal.length === 0) return undefined;
  const lineas = mal.map((t) => `  • ${etiquetaEmpresa(t.empresa)} · ${String(t.evidencia.nombre ?? t.objetivo)}: ${t.estado.replace(/_/g, " ")}${t.ultimoError ? ` — ${t.ultimoError}` : ""}`);
  return [`⚠️ Sincronización bancaria de Holded: ${mal.length} cuenta(s) sin actualización confirmada.`, ...lineas,
    "", "Si hace falta renovar el consentimiento del banco o la sesión web de Holded, tiene que hacerlo una persona; el sistema no reconecta bancos."].join("\n");
}

function marcaSync(c: TreasuryAccount | undefined): number | undefined {
  const v = c?.synced_at;
  const ms = typeof v === "string" && v ? Date.parse(v) : undefined;
  return ms !== undefined && Number.isFinite(ms) ? ms : undefined;
}

function msg(e: unknown): string { return (e instanceof Error ? e.message : String(e)).slice(0, 300); }
