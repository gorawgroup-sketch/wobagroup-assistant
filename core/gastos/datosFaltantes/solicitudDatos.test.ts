import assert from "node:assert/strict";
import test from "node:test";
import { agruparSolicitudes, ASUNTO_SOLICITUD_DATOS, CUERPO_SOLICITUD_DATOS, limpiarNombre, parsearRemitente } from "./solicitudDatos";
import { prepararSolicitudesDatos, type DepsSolicitud } from "./prepararSolicitudes";
import { renderizar, marcasDesconocidas } from "../../comunicaciones/plantilla";
import { agruparPorEmail } from "../../comunicaciones/destinatarios";
import type { GastoPendienteDatos } from "../gastoPendienteDatosStore";

/**
 * Pedir al creador del gasto lo que falta (Carlos, 2026-10-14; primera prueba: ticket de Crepes & Waffles de Kelly, sin fecha verificable): un correo
 * por persona con lo suyo, profesional, sin molestar dos veces y sin enviar nada sin el botón de un superadministrador.
 */
const AHORA = Date.UTC(2026, 9, 14, 18, 0);
const pend = (o: Partial<GastoPendienteDatos> & { id: string }): GastoPendienteDatos => ({
  chatId: 1, rutaLocal: "", nombreArchivoOriginal: "x.jpg", motivo: "fecha", creadoEn: AHORA - 5 * 3600_000, deColaCorreo: true,
  datos: { esFacturaOGasto: true, proveedor: "Crepes &amp; Waffles (nombre probable, no legible completo en el ticket)", monto: 245050, moneda: "COP", fecha: "", concepto: "Cena", lineas: [] } as never,
  correoOrigen: { de: "\"Kelly J. Correales Ducuara\" <Kelly@Footprint.global>", asunto: "Fwd: 65,67 euros - Cena Team Colombia - Visa", threadId: "t", messageIdHeader: "<m>", mensajeIdGmail: "g" },
  ...o,
});

test("limpiar el nombre leído del comprobante: sin entidades HTML ni la apostilla «nombre probable»", () => {
  assert.equal(limpiarNombre("Crepes &amp; Waffles (nombre probable, no legible completo en el ticket)"), "Crepes & Waffles");
  assert.equal(limpiarNombre("Tienda D1  Manila"), "Tienda D1 Manila");
  assert.deepEqual(parsearRemitente("\"Kelly J. Correales Ducuara\" <Kelly@Footprint.global>"), { nombre: "Kelly J. Correales Ducuara", email: "kelly@footprint.global" });
  assert.deepEqual(parsearRemitente("simon@x.com"), { nombre: "", email: "simon@x.com" });
});

test("un correo por creador con lo suyo; el mismo ticket reenviado dos veces cuenta una; lo que no se puede preguntar o no es de correo se omite", () => {
  const s = agruparSolicitudes([
    pend({ id: "a" }), pend({ id: "b", correoOrigen: { de: "\"Kelly J. Correales Ducuara\" <kelly@footprint.global>", asunto: "65,67 euros - Cena Team Colombia - Visa", threadId: "t", messageIdHeader: "<m>" } }),
    pend({ id: "c", motivo: "moneda", datos: { proveedor: "Cnidos y Rifados", monto: 180, moneda: "MXN" } as never, correoOrigen: { de: "Simon Talloen <s.talloen@gmail.com>", asunto: "Lunch - 180 pesos", threadId: "t2", messageIdHeader: "<m2>" } }),
    pend({ id: "d", motivo: "verificacion_duplicado" }), pend({ id: "e", deColaCorreo: false }), pend({ id: "f", correoOrigen: undefined }),
  ]);
  assert.deepEqual(s.map((x) => [x.nombre, x.email, x.pendientes]), [["Kelly J. Correales Ducuara", "kelly@footprint.global", ["a", "b"]], ["Simon Talloen", "s.talloen@gmail.com", ["c"]]]);
  assert.equal(s[0].detalle.split("\n").length, 1, "el ticket reenviado no se pregunta dos veces");
  assert.match(s[0].detalle, /Crepes & Waffles · 245\.050 COP \(correo «65,67 euros - Cena Team Colombia - Visa»\): no se distingue la fecha/);
  assert.match(s[1].detalle, /Cnidos y Rifados · 180 MXN.*moneda y el importe exacto/);
});

test("el correo es corporativo, lleva {nombre} y {detalle}, y se personaliza por persona sin dejar marcas sin sustituir", () => {
  assert.deepEqual(marcasDesconocidas(`${ASUNTO_SOLICITUD_DATOS}\n${CUERPO_SOLICITUD_DATOS}`), []);
  const [d] = agruparPorEmail([{ nombre: "Kelly J. Correales Ducuara", email: "kelly@footprint.global", detalle: "• Crepes & Waffles · 245.050 COP: no se distingue la fecha." }]);
  const t = renderizar(CUERPO_SOLICITUD_DATOS, d);
  assert.match(t, /^Hola, Kelly:/); assert.match(t, /Crepes & Waffles/); assert.doesNotMatch(t, /[{}]/);
  assert.match(t, /responde a este correo/); assert.match(t, /Gracias por tu colaboración/);
});

function deps(o: { pendientes?: GastoPendienteDatos[]; yaSolicitados?: string[]; preparadas?: unknown[]; registradas?: unknown[]; respuesta?: string } = {}): DepsSolicitud {
  return {
    pendientes: async () => o.pendientes ?? [], yaSolicitados: async () => new Set(o.yaSolicitados ?? []),
    preparar: async (_c, creadores) => { o.preparadas?.push(creadores); return o.respuesta ?? "Preparé el correo para 1 persona y lo mostré en el chat con sus botones; no se envió nada todavía."; },
    registrar: async (p) => { o.registradas?.push(p); }, emailsAdmin: async () => ["asistente@wobagroup.com"],
  };
}

test("prepara el correo y registra lo pedido; con ids solo esos; lo ya pedido no se repite; da tiempo a quien opera", async () => {
  const preparadas: unknown[] = [], registradas: unknown[] = [];
  const r = await prepararSolicitudesDatos(1, { ids: ["a"], ahora: AHORA }, deps({ pendientes: [pend({ id: "a" }), pend({ id: "z", correoOrigen: { de: "Otra <otra@x.com>", asunto: "x", threadId: "t", messageIdHeader: "<m>" } })], preparadas, registradas }));
  assert.match(r, /^Preparé/); assert.equal((preparadas[0] as unknown[]).length, 1); assert.deepEqual(registradas[0], [{ id: "a", creador: "kelly@footprint.global" }]);
  assert.match(await prepararSolicitudesDatos(1, { ahora: AHORA }, deps({ pendientes: [pend({ id: "a" })], yaSolicitados: ["a"] })), /No hay gastos pendientes/);
  assert.match(await prepararSolicitudesDatos(1, { minutosEspera: 600, ahora: AHORA }, deps({ pendientes: [pend({ id: "a" })] })), /No hay gastos pendientes/, "5 h < 10 h de espera");
  assert.match(await prepararSolicitudesDatos(1, { ids: ["nope"], ahora: AHORA }, deps({ pendientes: [pend({ id: "a" })] })), /no se pueden pedir a su creador/);
});

test("si preparar el resumen falla no se marca nada como pedido", async () => {
  const registradas: unknown[] = [];
  const r = await prepararSolicitudesDatos(1, { ahora: AHORA }, deps({ pendientes: [pend({ id: "a" })], registradas, respuesta: "Error: faltan datos" }));
  assert.match(r, /^Error/); assert.equal(registradas.length, 0);
});
