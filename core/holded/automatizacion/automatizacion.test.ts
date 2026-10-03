import assert from "node:assert/strict";
import test from "node:test";
import cron from "node-cron";
import { fechaHoyEspana } from "../../utils/diaHabil";
import type { Empresa, TreasuryAccount } from "../client";
import { coincideNombreLegal, etiquetaEmpresa, NOMBRES_LEGALES } from "./empresas";
import { clasificarDocumento } from "./clasificacionTicket";
import { empresasAutomatizacion, modoAutomatizacion, parsearCasosAprobados } from "./modo";
import type { CuentaParaNavegador, NavegadorHolded, ResultadoNavegador } from "./navegador";
import {
  clasificarCuenta, cuentaTieneActualizacionConfirmada, lanzarSincronizacionBancaria, reabrirTransitoriasDelDia, textoAvisoSincronizacion,
  verificarSincronizacionBancaria, VENTANA_VERIFICACION_MS,
} from "./sincronizacionBancaria";
import { claveTicket, reabrirTicketsTransitorios, reevaluarCambiosNormales, detalleDiferencias, diferenciasInstantanea, instantaneaCompra, inventarioCandidatos, procesarColaTickets, registrarClasificacionDocumento } from "./tickets";
import { AlmacenTrabajosMemoria } from "./trabajos";
import { nombreVariableSesion, sesionWebConfigurada } from "./navegadorHolded";

function conEntorno<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previo: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { previo[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return fn().finally(() => { for (const k of Object.keys(previo)) { if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k]; } });
}

/* ───────── modo / kill-switch ───────── */
test("sin variable, ambas automatizaciones están apagadas; un valor desconocido tampoco activa nada", () => {
  assert.equal(modoAutomatizacion("TICKETS", {}), "apagado");
  assert.equal(modoAutomatizacion("SYNC_BANCARIA", { WOBI_HOLDED_SYNC_BANCARIA_MODO: "quizas" }), "apagado");
  assert.equal(modoAutomatizacion("SYNC_BANCARIA", { WOBI_HOLDED_SYNC_BANCARIA_MODO: "activo" }), "activo");
});
test("en modo activo el alcance es explícito: sin lista no se toca ninguna empresa", () => {
  assert.deepEqual(empresasAutomatizacion("TICKETS", { WOBI_HOLDED_TICKETS_MODO: "activo" }), []);
  assert.deepEqual(empresasAutomatizacion("TICKETS", { WOBI_HOLDED_TICKETS_MODO: "activo", WOBI_HOLDED_TICKETS_EMPRESAS: "footprint" }), ["Footprint"]);
  assert.deepEqual(empresasAutomatizacion("TICKETS", { WOBI_HOLDED_TICKETS_MODO: "apagado", WOBI_HOLDED_TICKETS_EMPRESAS: "WOBA" }), []);
});

test("lista aprobada: formato estricto «Empresa:id» (24 hex), duplicados y entradas mal escritas se descartan", () => {
  const a = "6abf7e24b0a79d7d54045e45", b = "6abfbede7b93a80707000b6d";
  assert.deepEqual(parsearCasosAprobados(`Footprint:${a}, footprint:${b},Footprint:${a}`), [{ empresa: "Footprint", id: a }, { empresa: "Footprint", id: b }]);
  assert.deepEqual(parsearCasosAprobados(`WOBA:${a},Inventada:${b},WOBA:corto,WOBA:,${b}`), [{ empresa: "WOBA", id: a }]);
  assert.deepEqual(parsearCasosAprobados(undefined), []);
  assert.deepEqual(parsearCasosAprobados(""), []);
});

test("sesión web por empresa: variable propia de cada empresa; la general solo como último recurso; sin ninguna, no hay sesión", () => {
  assert.equal(nombreVariableSesion("Footprint"), "WOBI_HOLDED_WEB_SESSION_FOOTPRINT");
  assert.equal(nombreVariableSesion("EWORKS"), "WOBI_HOLDED_WEB_SESSION_EWORKS");
  assert.equal(sesionWebConfigurada("Footprint", {}), false);
  assert.equal(sesionWebConfigurada(undefined, {}), false);
  assert.equal(sesionWebConfigurada("Footprint", { WOBI_HOLDED_WEB_SESSION_FOOTPRINT: "x" }), true);
  assert.equal(sesionWebConfigurada("WOBA", { WOBI_HOLDED_WEB_SESSION_FOOTPRINT: "x" }), false); // la de otra empresa no vale
  assert.equal(sesionWebConfigurada("WOBA", { WOBI_HOLDED_WEB_SESSION: "x" }), true); // la general, último recurso
  assert.equal(sesionWebConfigurada(undefined, { WOBI_HOLDED_WEB_SESSION_EWORKS: "x" }), true);
});

/* ───────── horario / cambio de hora ───────── */
test("06:00 Madrid: la fecha de la clave es la de Madrid en verano e invierno, y el cron es válido", () => {
  assert.equal(fechaHoyEspana(new Date("2026-07-01T04:00:00Z")), "2026-07-01"); // 06:00 CEST
  assert.equal(fechaHoyEspana(new Date("2026-01-15T05:00:00Z")), "2026-01-15"); // 06:00 CET
  assert.equal(fechaHoyEspana(new Date("2026-03-29T04:00:00Z")), "2026-03-29"); // día del cambio a verano
  assert.equal(fechaHoyEspana(new Date("2026-10-25T05:00:00Z")), "2026-10-25"); // día del cambio a invierno
  for (const expr of ["0 6 * * *", "10,30,50 6-9 * * *", "45 9 * * *", "5,35 * * * *", "30 2 * * *"]) assert.ok(cron.validate(expr), expr);
});

/* ───────── sincronización bancaria ───────── */
const cuenta = (id: string, extra: Partial<TreasuryAccount> = {}): TreasuryAccount => ({
  id, name: `Cuenta ${id}`, type: "bank", currency: "EUR", institution_id: "revolut_business_es", institution_name: "Revolut", archived: false,
  synced_at: "2026-10-01T10:00:00+00:00", transactions_pending_to_reconcile: 2, ...extra });

test("clasifica: conectada vs manual, efectivo y archivada", () => {
  assert.equal(clasificarCuenta("WOBA", cuenta("a")).sincronizable, true);
  assert.equal(clasificarCuenta("WOBA", cuenta("b", { archived: true })).motivo, "archivada");
  assert.equal(clasificarCuenta("WOBA", cuenta("c", { type: "gateway", institution_id: null, institution_name: undefined, synced_at: null })).sincronizable, false);
  assert.equal(clasificarCuenta("WOBA", cuenta("d", { type: "cash", institution_id: null, institution_name: undefined })).motivo, "efectivo");
  assert.equal(clasificarCuenta("WOBA", cuenta("e")).clave, "WOBA:e");
});

class NavegadorFalso implements NavegadorHolded {
  llamadas: string[] = [];
  identidades: string[] = [];
  leerNombreLegal?: (empresa: Empresa) => Promise<ResultadoNavegador>;
  constructor(private respuesta: (c: CuentaParaNavegador) => ResultadoNavegador = () => ({ estado: "ok" }), identidad?: (empresa: Empresa) => ResultadoNavegador) {
    if (identidad) this.leerNombreLegal = async (e) => { this.identidades.push(e); return identidad(e); };
  }
  async sincronizarCuenta(_e: string, c: CuentaParaNavegador) { this.llamadas.push(c.id); return this.respuesta(c); }
  async desmarcarFacturaDeCompra(): Promise<ResultadoNavegador> { throw new Error("no aplica"); }
  async cerrar() {}
}
const ENV_SYNC = { WOBI_HOLDED_SYNC_BANCARIA_MODO: "activo", WOBI_HOLDED_SYNC_BANCARIA_EMPRESAS: "WOBA" };

test("modo activo: lanza, NO declara completada hasta ver synced_at posterior; luego completada con hora de verificación", () =>
  conEntorno(ENV_SYNC, async () => {
    let t = Date.parse("2026-10-02T04:00:00Z");
    let sync = "2026-10-01T10:00:00+00:00";
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso();
    const dep = { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a", { synced_at: sync }), cuenta("manual", { institution_id: null, institution_name: undefined })], ahora: () => t, dormir: async () => {} };
    const r = await lanzarSincronizacionBancaria("2026-10-02", dep);
    assert.deepEqual(nav.llamadas, ["a"]); // la manual no se toca
    assert.equal(r.cuentas, 1);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "en_curso"); // botón pulsado ≠ completada
    t += 5 * 60_000;
    assert.deepEqual(await verificarSincronizacionBancaria(dep), { verificadas: 1, completadas: 0, noConfirmadas: 0 }); // sin evidencia aún
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "en_curso");
    sync = "2026-10-02T04:03:00+00:00";
    await verificarSincronizacionBancaria(dep);
    const fin = await almacen.obtener("sync:2026-10-02:WOBA:a");
    assert.equal(fin?.estado, "completado");
    assert.ok(fin?.verificadoEn);
    assert.equal((await cuentaTieneActualizacionConfirmada(almacen, "WOBA", "a", Date.parse("2026-10-02T00:00:00Z"))).confirmada, true);
  }));

test("sincronización lanzada pero sin evidencia dentro de la ventana → «no confirmado», nunca completada", () =>
  conEntorno(ENV_SYNC, async () => {
    let t = Date.parse("2026-10-02T04:00:00Z");
    const almacen = new AlmacenTrabajosMemoria();
    const dep = { almacen, navegador: () => new NavegadorFalso(), leerCuentas: async () => [cuenta("a")], ahora: () => t, dormir: async () => {} };
    await lanzarSincronizacionBancaria("2026-10-02", dep);
    t += VENTANA_VERIFICACION_MS + 60_000;
    const r = await verificarSincronizacionBancaria(dep);
    assert.equal(r.noConfirmadas, 1);
    const trabajo = await almacen.obtener("sync:2026-10-02:WOBA:a");
    assert.equal(trabajo?.estado, "no_confirmado");
    assert.match(textoAvisoSincronizacion([trabajo!]) ?? "", /sin actualización confirmada/);
    assert.equal((await cuentaTieneActualizacionConfirmada(almacen, "WOBA", "a", 0)).confirmada, false);
  }));

test("sesión caducada o banco que exige consentimiento: requiere intervención, sin reintentos ni reconexión", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso(() => ({ estado: "sesion_caducada", detalle: "caducó" }));
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a")], dormir: async () => {} });
    assert.equal(nav.llamadas.length, 1);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "requiere_intervencion");
  }));

test("sin sesión web configurada: requiere intervención (no se inventa nada)", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => undefined, leerCuentas: async () => [cuenta("a")] });
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "requiere_intervencion");
  }));

test("una cuenta que falla no bloquea a las demás; los errores transitorios se reintentan con límite", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso((c) => (c.id === "mala" ? { estado: "error", detalle: "boom" } : { estado: "ok" }));
    const dep = { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("mala"), cuenta("buena")], dormir: async () => {}, esperaMs: () => 0 };
    // Pasada 1 (06:00): la mala queda «solicitada» para reintentarse; la buena se lanza y no se repite.
    await lanzarSincronizacionBancaria("2026-10-02", dep);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:mala"))?.estado, "solicitado");
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:buena"))?.estado, "en_curso");
    // Pasadas 2 y 3 (06:40 y 07:20): al agotar las del día pasa a «fallido»; la buena sigue sin repetirse.
    await lanzarSincronizacionBancaria("2026-10-02", dep);
    await lanzarSincronizacionBancaria("2026-10-02", dep);
    assert.equal(nav.llamadas.filter((x) => x === "mala").length, 3);
    assert.equal(nav.llamadas.filter((x) => x === "buena").length, 1);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:mala"))?.estado, "fallido");
  }));

test("fallo transitorio de la pantalla (empresa sin activar, botón aún sin aparecer): se recupera en una pasada posterior, sin intervención", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    let intento = 0;
    const nav = new NavegadorFalso(() => (++intento === 1 ? { estado: "elemento_no_encontrado", detalle: "La empresa activa en Holded no es WOBA; no se tocó nada" } : { estado: "ok" }));
    const dep = { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a")], dormir: async () => {} };
    await lanzarSincronizacionBancaria("2026-10-02", dep);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "solicitado"); // NO «requiere intervención»
    await lanzarSincronizacionBancaria("2026-10-02", dep); // pasada de las 06:40
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "en_curso");
  }));

test("nombres legales: coinciden sin tildes/mayúsculas/puntuación y el título de Holded no cuenta como nombre legal", () => {
  assert.equal(coincideNombreLegal("EWORKS", "COMPAÑIA DE PROYECTOS EWORKS SL"), true); // así lo muestra Holded
  assert.equal(coincideNombreLegal("WOBA", "Business Atelier Europa SL"), true);
  assert.equal(coincideNombreLegal("Footprint", "business footprint eu s.l."), false); // «S.L.» ≠ «SL»: no se acepta a ojo
  assert.equal(coincideNombreLegal("Footprint", "BUSINESS FOOTPRINT EU SL"), true);
  assert.equal(coincideNombreLegal("WOBA", "WOBA"), false);
  assert.equal(coincideNombreLegal("WOBA", "BUSINESS FOOTPRINT EU SL"), false); // empresa equivocada
  assert.equal(etiquetaEmpresa("Footprint"), `Footprint (${NOMBRES_LEGALES.Footprint})`);
  assert.match(textoAvisoSincronizacion([{ clave: "k", tipo: "sync_bancaria", empresa: "WOBA", objetivo: "x", estado: "fallido", intentos: 1, creadoEn: 1, actualizadoEn: 1, evidencia: { nombre: "Main" } }]) ?? "", /WOBA \(Business Atelier Europa SL\)/);
});

test("identidad: si el nombre legal de la empresa activa NO coincide, no se pulsa nada y lo decide una persona; si coincide, se sincroniza", () =>
  conEntorno(ENV_SYNC, async () => {
    // 1) nombre equivocado (p. ej. la empresa activa es otra)
    let almacen = new AlmacenTrabajosMemoria();
    let nav = new NavegadorFalso(() => ({ estado: "ok" }), () => ({ estado: "ok", detalle: "BUSINESS FOOTPRINT EU SL" }));
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a"), cuenta("b")], dormir: async () => {} });
    assert.equal(nav.llamadas.length, 0);
    assert.equal(nav.identidades.length, 1); // se lee UNA vez por empresa y pasada, no por cuenta
    const t = await almacen.obtener("sync:2026-10-02:WOBA:a");
    assert.equal(t?.estado, "requiere_intervencion");
    assert.match(t?.ultimoError ?? "", /nombre legal.*no es el esperado/);
    // 2) nombre correcto → sincroniza y deja constancia
    almacen = new AlmacenTrabajosMemoria();
    nav = new NavegadorFalso(() => ({ estado: "ok" }), () => ({ estado: "ok", detalle: "Business Atelier Europa SL" }));
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a")], dormir: async () => {} });
    assert.deepEqual(nav.llamadas, ["a"]);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.evidencia.nombreLegalVerificado, "Business Atelier Europa SL");
    // 3) no se pudo leer la identidad: transitorio (no se pulsa nada, se reintenta en la siguiente pasada)
    almacen = new AlmacenTrabajosMemoria();
    nav = new NavegadorFalso(() => ({ estado: "ok" }), () => ({ estado: "elemento_no_encontrado", detalle: "No se pudo leer el nombre legal en el panel de configuración" }));
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a")], dormir: async () => {} });
    assert.equal(nav.llamadas.length, 0);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "solicitado");
  }));

test("las cuentas de hoy que fallaron por un motivo transitorio se reabren; las que exigen a una persona, no; y con límite de pasadas", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const base = { tipo: "sync_bancaria" as const, empresa: "WOBA", intentos: 1, creadoEn: Date.now(), actualizadoEn: Date.now(), estado: "requiere_intervencion" as const };
    await almacen.guardar({ ...base, clave: "sync:2026-10-03:WOBA:t", objetivo: "t", evidencia: {}, ultimoError: "La empresa activa en Holded no es WOBA; no se tocó nada" });
    await almacen.guardar({ ...base, clave: "sync:2026-10-03:WOBA:c", objetivo: "c", evidencia: {}, ultimoError: "La cuenta pide renovar el consentimiento del banco" });
    await almacen.guardar({ ...base, clave: "sync:2026-10-03:WOBA:n", objetivo: "n", evidencia: {}, ultimoError: "El nombre legal de la empresa activa en Holded («X») no es el esperado («Y»); no se tocó nada" });
    await almacen.guardar({ ...base, clave: "sync:2026-10-03:WOBA:l", objetivo: "l", evidencia: { pasadas: 3 }, ultimoError: "La empresa activa en Holded no es WOBA; no se tocó nada" });
    await almacen.guardar({ ...base, clave: "sync:2026-10-02:WOBA:ayer", objetivo: "ayer", evidencia: {}, ultimoError: "La empresa activa en Holded no es WOBA; no se tocó nada" });
    assert.equal(await reabrirTransitoriasDelDia(almacen, "2026-10-03"), 1);
    assert.equal((await almacen.obtener("sync:2026-10-03:WOBA:t"))?.estado, "solicitado");
    for (const k of ["c", "n", "l"]) assert.equal((await almacen.obtener(`sync:2026-10-03:WOBA:${k}`))?.estado, "requiere_intervencion");
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:ayer"))?.estado, "requiere_intervencion"); // de otro día: no se toca
  }));

test("confirmación en pantalla: «Actualizado hace unos segundos» junto al saldo deja la cuenta completada, con el texto y la hora como evidencia", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso(() => ({ estado: "ok", detalle: "Sincronizada", confirmadoEnPantalla: "Actualizado hace unos segundos" }));
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a"), cuenta("b")], dormir: async () => {} });
    const t = await almacen.obtener("sync:2026-10-02:WOBA:a");
    assert.equal(t?.estado, "completado");
    assert.equal(t?.evidencia.confirmadoEnPantalla, "Actualizado hace unos segundos");
    assert.ok(t?.verificadoEn);
    assert.equal((await cuentaTieneActualizacionConfirmada(almacen, "WOBA", "a", 0)).confirmada, true);
  }));

test("lo que sí exige a una persona no se reintenta: consentimiento del banco, sesión caducada", () =>
  conEntorno(ENV_SYNC, async () => {
    for (const r of [{ estado: "elemento_no_encontrado", detalle: "La cuenta pide renovar el consentimiento del banco" }, { estado: "sesion_caducada", detalle: "caducó" }] as ResultadoNavegador[]) {
      const almacen = new AlmacenTrabajosMemoria();
      const nav = new NavegadorFalso(() => r);
      const dep = { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a")], dormir: async () => {} };
      await lanzarSincronizacionBancaria("2026-10-02", dep);
      await lanzarSincronizacionBancaria("2026-10-02", dep);
      assert.equal(nav.llamadas.length, 1);
      assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "requiere_intervencion");
    }
  }));

test("antes de reintentar se mira el estado real: si Holded ya actualizó, no se repite la acción", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    let lecturas = 0;
    const nav = new NavegadorFalso(() => ({ estado: "error", detalle: "timeout tras pulsar" }));
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, ahora: () => Date.parse("2026-10-02T04:00:00Z"), dormir: async () => {}, esperaMs: () => 0,
      leerCuentas: async () => [cuenta("a", { synced_at: ++lecturas > 1 ? "2026-10-02T04:01:00+00:00" : "2026-10-01T10:00:00+00:00" })] });
    assert.equal(nav.llamadas.length, 1);
    assert.equal((await almacen.obtener("sync:2026-10-02:WOBA:a"))?.estado, "en_curso");
  }));

test("reinicio / doble disparo: la segunda ejecución del día no vuelve a lanzar lo ya lanzado", () =>
  conEntorno(ENV_SYNC, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso();
    const dep = { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a")], dormir: async () => {} };
    await lanzarSincronizacionBancaria("2026-10-02", dep);
    await Promise.all([lanzarSincronizacionBancaria("2026-10-02", dep), lanzarSincronizacionBancaria("2026-10-02", dep)]);
    assert.equal(nav.llamadas.length, 1);
  }));

test("lista aprobada de cuentas: solo se sincronizan esas aunque haya más cuentas conectadas", () =>
  conEntorno({ ...ENV_SYNC, WOBI_HOLDED_SYNC_BANCARIA_CUENTAS: "WOBA:6abf8bd5817558d83806a754" }, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso();
    const a = "6abf8bd5817558d83806a754", b = "6abf8bd5817558d83806a755";
    await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, leerCuentas: async () => [cuenta(a), cuenta(b)], dormir: async () => {} });
    assert.deepEqual(nav.llamadas, [a]);
    assert.equal(await almacen.obtener(`sync:2026-10-02:WOBA:${b}`), undefined);
  }));

test("simulación: no abre el navegador ni escribe; solo registra lo que haría", () =>
  conEntorno({ WOBI_HOLDED_SYNC_BANCARIA_MODO: "simulacion" }, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso();
    const r = await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, leerCuentas: async () => [cuenta("a")] });
    assert.equal(nav.llamadas.length, 0);
    assert.equal(r.porEstado.simulado, 3); // una por empresa (el lector falso devuelve la misma cuenta)
  }));

test("apagado: no lee ni toca nada", () =>
  conEntorno({ WOBI_HOLDED_SYNC_BANCARIA_MODO: undefined }, async () => {
    let leido = false;
    const r = await lanzarSincronizacionBancaria("2026-10-02", { almacen: new AlmacenTrabajosMemoria(), leerCuentas: async () => { leido = true; return []; } });
    assert.equal(leido, false);
    assert.equal(r.cuentas, 0);
  }));

test("un fallo de Holded al leer cuentas no se toma por «no hay cuentas» y no frena a otras empresas", () =>
  conEntorno({ WOBI_HOLDED_SYNC_BANCARIA_MODO: "activo", WOBI_HOLDED_SYNC_BANCARIA_EMPRESAS: "WOBA,EWORKS" }, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const nav = new NavegadorFalso();
    const r = await lanzarSincronizacionBancaria("2026-10-02", { almacen, navegador: () => nav, dormir: async () => {},
      leerCuentas: async (e) => { if (e === "WOBA") throw new Error("503"); return [cuenta("x")]; } });
    assert.equal(r.porEstado.fallido, 1);
    assert.equal((await almacen.obtener("sync:2026-10-02:EWORKS:x"))?.estado, "en_curso");
  }));

/* ───────── clasificación ticket/factura ───────── */
test("ticket auténtico: se declara ticket/simplificado y no identifica al comprador", () => {
  const r = clasificarDocumento({ proveedor: "Nori Nori", textoEvidencia: "Factura Simplificada nº 123", reciboSimplificado: true, numeroDocumento: "123" });
  assert.equal(r.tipo, "ticket");
});
test("factura auténtica: identifica al comprador o se declara factura con número", () => {
  assert.equal(clasificarDocumento({ proveedor: "DHL", identificaComprador: true, numeroDocumento: "F-1" }).tipo, "factura");
  assert.equal(clasificarDocumento({ proveedor: "Hotel", textoEvidencia: "Invoice number 8891", numeroDocumento: "8891" }).tipo, "factura");
});
test("dudoso: falta el número o el extractor marcó simplificado «por duda» → revisar, nunca ticket", () => {
  assert.equal(clasificarDocumento({ proveedor: "Uber", textoEvidencia: "Viaje 12/09" }).tipo, "revisar");
  assert.equal(clasificarDocumento({ proveedor: "Uber", reciboSimplificado: true, textoEvidencia: "Viaje" }).tipo, "revisar");
  assert.equal(clasificarDocumento({ proveedor: "X", textoEvidencia: "ticket, Factura nº 12", reciboSimplificado: true }).tipo, "revisar"); // contradictorio
});

/* ───────── conversión a ticket ───────── */
const compra = (extra: Record<string, unknown> = {}) => ({ id: "c1", contact_id: "k1", date: "2026-09-20", currency: "USD", currency_change: "1.0905", subtotal: "10,00", total: "10,00", tax: "0,00",
  document_number: "A-1", status: "completed", notes: "[wobi:" + "a".repeat(64) + "]", tags: ["b", "a"], payments_total: "10,00", payments_pending: "0,00", payments_detail: [{ id: "p1", amount: "10,00", bank_id: "banco1" }],
  lines: [{ name: "Viaje", price: "10,00", units: "1,00", discount: "0,00", tax: "0", taxes: [], account: "acc1", retention: "0,00", tags: [] }], deduction_date: null, accounting_date: null, ...extra });

class MundoHolded {
  listado = new Set<string>(["c1"]);
  compras = new Map<string, Record<string, unknown>>([["c1", compra()]]);
  fallaLectura = false;
  adjuntos = 1;
  leer = async (_e: string, ruta: string) => {
    if (this.fallaLectura) throw Object.assign(new Error("503"), { status: 503 });
    if (ruta.endsWith("/attachments")) return { items: Array.from({ length: this.adjuntos }, (_, i) => ({ id: `comprobante${i}.pdf` })) };
    if (ruta === "/purchases") return { items: [...this.listado].map((id) => ({ id })), has_more: false };
    const id = ruta.split("/").pop()!;
    const c = this.compras.get(id);
    if (!c) throw Object.assign(new Error("404"), { status: 404 });
    return c;
  };
}
const navegadorTickets = (mundo: MundoHolded, accion: (mundo: MundoHolded) => ResultadoNavegador, opcionesVistas?: Array<{ borrador?: boolean } | undefined>): NavegadorHolded => ({
  sincronizarCuenta: async () => ({ estado: "ok" }), cerrar: async () => {},
  desmarcarFacturaDeCompra: async (_e, _id, opciones) => { opcionesVistas?.push(opciones); return accion(mundo); },
});
const ENV_TICKETS = { WOBI_HOLDED_TICKETS_MODO: "activo", WOBI_HOLDED_TICKETS_EMPRESAS: "Footprint" };
async function preparar(estadoInicial: "solicitado" = "solicitado") {
  const almacen = new AlmacenTrabajosMemoria();
  const t = await registrarClasificacionDocumento(almacen, { empresa: "Footprint", compraId: "c1", proveedor: "Nori", textoEvidencia: "Factura Simplificada", reciboSimplificado: true, numeroDocumento: "9" });
  assert.equal(t?.estado, estadoInicial);
  return almacen;
}

test("registro al recibir: ticket → cola; factura → omitido; dudoso → revisión, con evidencia; idempotente", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    const base = { empresa: "Footprint" as const, proveedor: "P" };
    assert.equal((await registrarClasificacionDocumento(almacen, { ...base, compraId: "t", textoEvidencia: "ticket" }))?.estado, "solicitado");
    assert.equal((await registrarClasificacionDocumento(almacen, { ...base, compraId: "f", identificaComprador: true }))?.estado, "omitido");
    const d = await registrarClasificacionDocumento(almacen, { ...base, compraId: "d" });
    assert.equal(d?.estado, "requiere_intervencion");
    assert.ok((d?.evidencia.motivos as string[]).length > 0);
    assert.equal(await registrarClasificacionDocumento(almacen, { ...base, compraId: "t", textoEvidencia: "ticket" }), undefined);
  }));

test("conversión correcta: gasto CONCILIADO conserva todo (cobros, tasa, cuentas, etiquetas) y queda ticket", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    const r = await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => { m.listado.delete("c1"); return { estado: "ok" }; }) });
    assert.equal(r.porEstado.completado, 1);
    const t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "completado");
    assert.ok(t?.verificadoEn);
  }));

test("si cambia cualquier otro campo (p. ej. tasa o cobro) el caso se detiene y se informa", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    const r = await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => { m.listado.delete("c1"); m.compras.set("c1", compra({ currency_change: "1.0000", payments_total: "0,00" })); return { estado: "ok" }; }) });
    assert.equal(r.porEstado.requiere_intervencion, 1);
    const t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.deepEqual(t?.evidencia.camposCambiados, ["cambio", "cobrado"]);
  }));

test("fallo/interrupción tras guardar: el navegador falla pero Holded ya lo tiene como ticket → completado, sin repetir", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => { m.listado.delete("c1"); return { estado: "error", detalle: "timeout al cerrar" }; }) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "completado");
  }));

test("guardado «ok» pero Holded sigue mostrándolo como factura → no confirmado (no se declara hecho)", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, () => ({ estado: "ok" })) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "no_confirmado");
  }));

test("gasto que ya era ticket: se omite sin tocar el navegador", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded(); mundo.listado.clear();
    let abierto = false;
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => { abierto = true; return undefined; } });
    assert.equal(abierto, false);
    const t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "omitido"); assert.equal(t?.evidencia.yaEraTicket, true);
  }));

test("sesión caducada: requiere intervención y no se reintenta; error transitorio: se reintenta hasta el límite", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, () => ({ estado: "sesion_caducada", detalle: "caducó" })) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "requiere_intervencion");

    const a2 = await preparar(); 
    for (let i = 0; i < 3; i++) await procesarColaTickets({ almacen: a2, leer: mundo.leer, navegador: () => navegadorTickets(mundo, () => ({ estado: "error", detalle: "fallo" })) });
    const t = await a2.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "fallido"); assert.equal(t?.intentos, 3);
  }));

test("conversión: un fallo transitorio de la pantalla deja el caso en cola para el siguiente ciclo (no «requiere intervención»); al agotar los intentos, «fallido»", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    const nav = () => navegadorTickets(mundo, () => ({ estado: "elemento_no_encontrado", detalle: "La empresa activa en Holded no es Footprint; no se tocó nada" }));
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "solicitado");
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav });
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav });
    const t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "fallido");
    assert.equal(t?.intentos, 3);
  }));

test("una lectura fallida de Holded no se interpreta: el caso queda en cola, sin tocar nada", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded(); mundo.fallaLectura = true;
    let abierto = false;
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => { abierto = true; return undefined; } });
    assert.equal(abierto, false);
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "solicitado");
  }));

test("simulación: lee y registra, nunca abre el navegador; el alcance de un caso controlado limita los ids", () =>
  conEntorno({ WOBI_HOLDED_TICKETS_MODO: "simulacion" }, async () => {
    const almacen = new AlmacenTrabajosMemoria();
    for (const id of ["c1", "otro"]) await almacen.guardar({ clave: claveTicket("Footprint", id), tipo: "ticket", empresa: "Footprint", objetivo: id, estado: "solicitado", intentos: 0, creadoEn: 1, actualizadoEn: 1, evidencia: {} });
    const mundo = new MundoHolded();
    let abierto = false;
    const r = await procesarColaTickets({ almacen, leer: mundo.leer, soloIds: new Set(["c1"]), navegador: () => { abierto = true; return undefined; } });
    assert.equal(abierto, false);
    assert.equal(r.revisados, 1);
    assert.equal((await almacen.obtener(claveTicket("Footprint", "otro")))?.estado, "solicitado");
    // La simulación no consume el caso: sigue en cola con lo que haría, listo para cuando se active.
    const simulado = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.equal(simulado?.estado, "solicitado");
    assert.ok(simulado?.evidencia.simulacion);
  }));

test("ejecuciones duplicadas simultáneas sobre el mismo gasto: el navegador se usa una sola vez", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    let usos = 0;
    const nav = () => navegadorTickets(mundo, (m) => { usos++; m.listado.delete("c1"); return { estado: "ok" }; });
    await Promise.all([procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav }), procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav })]);
    assert.equal(usos, 1);
  }));

test("borrador: se pasa al navegador para guardar como borrador, y si el guardado lo aprueba o mueve el vencimiento, se detiene", () =>
  conEntorno(ENV_TICKETS, async () => {
    const almacen = await preparar(); const mundo = new MundoHolded();
    mundo.compras.set("c1", compra({ draft: true, approved_at: null, due_date: "2026-09-09" }));
    const vistas: Array<{ borrador?: boolean } | undefined> = [];
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => {
      m.listado.delete("c1"); m.compras.set("c1", compra({ draft: false, approved_at: "2026-10-02T10:00:00", due_date: "2026-09-08" })); return { estado: "ok" };
    }, vistas) });
    assert.deepEqual(vistas, [{ borrador: true }]);
    const t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "requiere_intervencion");
    assert.deepEqual(t?.evidencia.camposCambiados, ["borrador", "aprobado", "vencimiento"]);
  }));

test("regla de Carlos: solo gastos creados por WOBI, conciliados y con comprobante; si falta algo se espera, y si no es de WOBI no se toca", () =>
  conEntorno(ENV_TICKETS, async () => {
    const abierto = { n: 0 };
    const nav = (m: MundoHolded) => () => { abierto.n++; return navegadorTickets(m, (x) => { x.listado.delete("c1"); return { estado: "ok" }; }); };
    // 1) no lo creó WOBI (sin marcador): omitido, jamás se abre el navegador
    let almacen = await preparar(); let mundo = new MundoHolded();
    mundo.compras.set("c1", compra({ notes: "creado a mano" }));
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav(mundo) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "omitido");
    // 2) aún sin conciliar: espera en cola, sin tocar nada
    almacen = await preparar(); mundo = new MundoHolded();
    mundo.compras.set("c1", compra({ payments_total: "0,00", payments_pending: "10,00", payments_detail: [] }));
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav(mundo) });
    let t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "solicitado"); assert.match(t?.ultimoError ?? "", /no está conciliado/);
    // 3) conciliado pero sin comprobante: espera
    almacen = await preparar(); mundo = new MundoHolded(); mundo.adjuntos = 0;
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav(mundo) });
    t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "solicitado"); assert.match(t?.ultimoError ?? "", /sin|no tiene comprobante/);
    // 4) tras demasiados días esperando, lo decide una persona
    almacen = await preparar(); mundo = new MundoHolded(); mundo.adjuntos = 0;
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav(mundo), ahora: () => Date.now() + 22 * 24 * 3_600_000 });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "requiere_intervencion");
    assert.equal(abierto.n, 0);
    // 5) completo, de WOBI, conciliado y con comprobante: se convierte
    almacen = await preparar(); mundo = new MundoHolded();
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: nav(mundo) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "completado");
    assert.equal(abierto.n, 1);
  }));

test("el detalle de diferencias dice QUÉ campo de QUÉ línea cambió (p. ej. la cuenta contable) y la fecha de aprobación es solo informativa", () => {
  const antes = instantaneaCompra(compra({ approved_at: "2026-09-17T21:13:00" }));
  const cambiada = compra({ approved_at: "2026-10-02T12:35:07" });
  (cambiada.lines[0] as Record<string, unknown>).account = "OTRA_CUENTA";
  const despues = instantaneaCompra(cambiada);
  const detalle = detalleDiferencias(antes, despues);
  assert.deepEqual(detalle.map((d) => d.campo), ["aprobadoEn", "linea[0].cuenta"]);
  assert.equal(detalle[0].informativo, true);
  assert.deepEqual(detalle[1], { campo: "linea[0].cuenta", antes: "acc1", despues: "OTRA_CUENTA" });
  assert.deepEqual(diferenciasInstantanea(antes, despues), ["lineas"]); // lo informativo no detiene; la cuenta sí
  assert.deepEqual(diferenciasInstantanea(antes, instantaneaCompra(compra({ approved_at: "2026-10-02T12:35:07" }))), []); // solo el sello de aprobación: no bloquea
});

test("efectos normales de pasar a ticket (sin impuestos en las líneas, etiquetas copiadas a la línea) NO detienen el caso; lo demás sí", () =>
  conEntorno(ENV_TICKETS, async () => {
    const conInvSuj = () => compra({ lines: [{ name: "Viaje", price: "10,00", units: "1,00", discount: "0,00", tax: "0", taxes: ["p_iva_invsuj"], account: "acc1", retention: "0,00", tags: [] }] });
    const comoTicket = (extra: Record<string, unknown> = {}) => compra({ ...extra, lines: [{ name: "Viaje", price: "10,00", units: "1,00", discount: "0,00", tax: "0", taxes: [], account: "acc1", retention: "0,00", tags: ["a", "b"] }] }); // la línea refleja las etiquetas del documento (["b","a"] en el fixture)
    // 1) caso real de Footprint: impuesto «inversión sujeto pasivo» vacío + etiquetas en la línea → completado
    let almacen = await preparar(); let mundo = new MundoHolded();
    mundo.compras.set("c1", conInvSuj());
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => { m.listado.delete("c1"); m.compras.set("c1", comoTicket()); return { estado: "ok" }; }) });
    const t = await almacen.obtener(claveTicket("Footprint", "c1"));
    assert.equal(t?.estado, "completado");
    assert.equal((t?.evidencia.diferencias as unknown[]).length, 2); // el detalle queda registrado aunque no detenga
    // 2) además cambia la cuenta contable → sí se detiene
    almacen = await preparar(); mundo = new MundoHolded(); mundo.compras.set("c1", conInvSuj());
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => {
      m.listado.delete("c1"); const c = comoTicket(); (c.lines[0] as Record<string, unknown>).account = "OTRA"; m.compras.set("c1", c); return { estado: "ok" }; }) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "requiere_intervencion");
    // 3) el documento tenía IVA real (importe > 0): quitar impuestos NO es normal → se detiene
    almacen = await preparar(); mundo = new MundoHolded(); mundo.compras.set("c1", compra({ tax: "2,10", lines: conInvSuj().lines }));
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => { m.listado.delete("c1"); m.compras.set("c1", comoTicket({ tax: "2,10" })); return { estado: "ok" }; }) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "requiere_intervencion");
    // 3b) las etiquetas del DOCUMENTO cambian (o la línea no las refleja exactamente) → se detiene
    almacen = await preparar(); mundo = new MundoHolded(); mundo.compras.set("c1", conInvSuj());
    await procesarColaTickets({ almacen, leer: mundo.leer, navegador: () => navegadorTickets(mundo, (m) => { m.listado.delete("c1"); m.compras.set("c1", comoTicket({ tags: ["otra"] })); return { estado: "ok" }; }) });
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "requiere_intervencion");
    // 4) reevaluación de casos previos que solo tenían efectos normales
    const previo = await almacen.obtener(claveTicket("Footprint", "c1"));
    previo!.estado = "requiere_intervencion"; previo!.evidencia.camposCambiados = ["lineas"];
    previo!.evidencia.antes = instantaneaCompra(conInvSuj()); previo!.evidencia.despues = instantaneaCompra(comoTicket());
    await almacen.guardar(previo!);
    assert.equal(await reevaluarCambiosNormales(almacen), 1);
    assert.equal((await almacen.obtener(claveTicket("Footprint", "c1")))?.estado, "completado");
  }));

test("instantánea: ignora el orden de etiquetas y detecta cambios reales", () => {
  assert.deepEqual(diferenciasInstantanea(instantaneaCompra(compra()), instantaneaCompra(compra({ tags: ["a", "b"] }))), []);
  assert.deepEqual(diferenciasInstantanea(instantaneaCompra(compra()), instantaneaCompra(compra({ total: "10,01" }))), ["total"]);
});

test("inventario de candidatos antiguos: solo lectura; probable solo con proveedor de fuera de la UE sin identificación fiscal; el resto, a revisión", async () => {
  const leer = async (_e: string, ruta: string) => {
    if (ruta.endsWith("/attachments")) return { items: [{ id: "comprobante.pdf" }] };
    if (/^\/purchases\/\w+$/.test(ruta)) return compra();
    if (ruta === "/purchases") return { items: [{ id: "1", contact_id: "x", contact_name: "Uber", date: "2026-09-01", total: "5,00", currency: "USD", payments_total: "5,00" }, { id: "2", contact_id: "y", contact_name: "DHL Spain", date: "2026-09-02", total: "9,00", currency: "EUR", payments_total: "0,00" }], has_more: false };
    return ruta.endsWith("/x") ? { code: "", bill_address: { country_code: "US" } } : { code: "B123", bill_address: { country_code: "ES" } };
  };
  const c = await inventarioCandidatos("Footprint", "2026-09-01", "2026-09-30", leer);
  assert.deepEqual(c.map((x) => [x.compraId, x.nivel, x.conciliado]), [["1", "probable", true], ["2", "revisar", false]]);
  assert.equal(c[0].elegible, true); // la regla completa solo se evalúa para los probables
  assert.equal(c[1].elegible, undefined);
});

test("conversión: un caso atascado por un fallo transitorio de pantalla se reabre; los que exigen a una persona o ya guardaron, no", async () => {
  const almacen = new AlmacenTrabajosMemoria();
  const base = { tipo: "ticket" as const, empresa: "Footprint", intentos: 1, creadoEn: 1, actualizadoEn: 1, estado: "requiere_intervencion" as const, evidencia: {} as Record<string, unknown> };
  await almacen.guardar({ ...base, clave: "ticket:Footprint:a", objetivo: "a", ultimoError: "La empresa activa en Holded no es Footprint; no se tocó nada" });
  await almacen.guardar({ ...base, clave: "ticket:Footprint:b", objetivo: "b", ultimoError: "La sesión web de Holded caducó" });
  await almacen.guardar({ ...base, clave: "ticket:Footprint:c", objetivo: "c", evidencia: { despues: {} }, ultimoError: "No se encontró algo" });
  await almacen.guardar({ ...base, clave: "ticket:Footprint:d", objetivo: "d", intentos: 3, ultimoError: "No se abrió el editor del gasto" });
  assert.equal(await reabrirTicketsTransitorios(almacen), 1);
  assert.equal((await almacen.obtener("ticket:Footprint:a"))?.estado, "solicitado");
  for (const k of ["b", "c", "d"]) assert.equal((await almacen.obtener(`ticket:Footprint:${k}`))?.estado, "requiere_intervencion");
});

test("traza visible en /health: guarda los últimos eventos con hora y la versión, sin datos sensibles", async () => {
  const { registrarTraza, obtenerTrazaAutomatizacion, reiniciarTrazaParaPruebas, marcarEnEjecucion } = await import("./traza");
  reiniciarTrazaParaPruebas();
  for (let i = 0; i < 100; i++) registrarTraza("cuenta", { n: i });
  marcarEnEjecucion("sync_lanzar", true);
  const t = obtenerTrazaAutomatizacion();
  assert.equal(t.ultimosEventos.length, 40);
  assert.equal(t.ultimosEventos[39].datos?.n, 99);
  assert.ok("sync_lanzar" in t.enEjecucion);
  marcarEnEjecucion("sync_lanzar", false);
  assert.deepEqual(obtenerTrazaAutomatizacion().enEjecucion, {});
});
