import assert from "node:assert/strict";
import test from "node:test";
import { esSolicitudPeligrosa, etiquetaPermitida, exigirEtiquetasPermitidas, MAX_CONVERSIONES_POR_CICLO, UMBRAL_DISYUNTOR } from "./cuidados";
import { claveTicket, procesarColaTickets } from "./tickets";
import { AlmacenTrabajosMemoria, type Trabajo } from "./trabajos";

test("red: se bloquea cualquier DELETE y las escrituras sobre usuarios, suscripción, facturación y cierre de periodos; las lecturas y las escrituras normales pasan", () => {
  assert.equal(esSolicitudPeligrosa("DELETE", "https://app.holded.com/api/purchases/abc"), true);
  assert.equal(esSolicitudPeligrosa("POST", "https://app.holded.com/api/users/invite"), true);
  assert.equal(esSolicitudPeligrosa("PUT", "https://app.holded.com/api/subscription/plan"), true);
  assert.equal(esSolicitudPeligrosa("POST", "https://app.holded.com/api/billing/card"), true);
  assert.equal(esSolicitudPeligrosa("POST", "https://app.holded.com/api/accounting-period/close"), true);
  assert.equal(esSolicitudPeligrosa("GET", "https://app.holded.com/api/users"), false); // leer no daña
  assert.equal(esSolicitudPeligrosa("PUT", "https://app.holded.com/api/purchases/abc"), false); // guardar el gasto (conversión)
  assert.equal(esSolicitudPeligrosa("POST", "https://app.holded.com/api/banking/accounts/abc/sync"), false); // sincronizar
});

test("clics: nunca se pulsa una etiqueta de eliminar/borrar/invitar/cerrar periodo; las etiquetas de las tareas permitidas sí", () => {
  for (const mala of ["Eliminar", "Borrar documento", "Delete", "Invitar usuario", "Cerrar periodo", "Cancelar suscripción", "Anular"]) assert.equal(etiquetaPermitida(mala), false, mala);
  for (const buena of ["Sincronizar", "Guardar", "Guardar como borrador", "Opciones", "Cambiar cuenta", "Configuración"]) assert.equal(etiquetaPermitida(buena), true, buena);
  assert.throws(() => exigirEtiquetasPermitidas(["Guardar", "Eliminar"]), /prohibida/);
});

const trabajo = (id: string, extra: Partial<Trabajo> = {}): Trabajo => ({ clave: claveTicket("Footprint", id), tipo: "ticket", empresa: "Footprint", objetivo: id, estado: "solicitado", intentos: 0, creadoEn: Date.now(), actualizadoEn: Date.now(), evidencia: {}, ...extra });

test("disyuntor: con dos casos del día con cambios inesperados no se procesa nada más; con uno solo, sí", async () => {
  const prev = { ...process.env };
  try {
    process.env.WOBI_HOLDED_TICKETS_MODO = "activo"; process.env.WOBI_HOLDED_TICKETS_EMPRESAS = "Footprint";
    const almacen = new AlmacenTrabajosMemoria();
    await almacen.guardar(trabajo("pendiente"));
    await almacen.guardar(trabajo("m1", { estado: "requiere_intervencion", evidencia: { camposCambiados: ["total"] } }));
    let lecturas = 0; const leer = async () => { lecturas++; throw Object.assign(new Error("503"), { status: 503 }); };
    let r = await procesarColaTickets({ almacen, leer });
    assert.equal(r.disyuntor, undefined); assert.ok(lecturas > 0); // con un caso aún se procesa
    lecturas = 0;
    await almacen.guardar(trabajo("m2", { estado: "requiere_intervencion", evidencia: { camposCambiados: ["cobrado"] } }));
    r = await procesarColaTickets({ almacen, leer });
    assert.equal(r.disyuntor, UMBRAL_DISYUNTOR); assert.equal(lecturas, 0); // con dos, no toca nada
  } finally { for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k]; Object.assign(process.env, prev); }
});

test("tope por ciclo: nunca se procesan más de MAX_CONVERSIONES_POR_CICLO gastos de una vez", async () => {
  const prev = { ...process.env };
  try {
    process.env.WOBI_HOLDED_TICKETS_MODO = "activo"; process.env.WOBI_HOLDED_TICKETS_EMPRESAS = "Footprint";
    const almacen = new AlmacenTrabajosMemoria();
    for (let i = 0; i < 25; i++) await almacen.guardar(trabajo(`c${i}`));
    const r = await procesarColaTickets({ almacen, leer: async () => { throw Object.assign(new Error("503"), { status: 503 }); } });
    assert.equal(r.revisados, MAX_CONVERSIONES_POR_CICLO);
  } finally { for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k]; Object.assign(process.env, prev); }
});

test("red: las peticiones inofensivas de la interfaz (notificaciones, buscar usuario) no se bloquean", () => {
  assert.equal(esSolicitudPeligrosa("POST", "https://app.holded.com/user/notifications/load"), false);
  assert.equal(esSolicitudPeligrosa("POST", "https://app.holded.com/users/find/6380e926252608a7a3010c78"), false);
  assert.equal(esSolicitudPeligrosa("POST", "https://app.holded.com/users/invite"), true);
});
