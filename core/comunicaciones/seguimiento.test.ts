import assert from "node:assert/strict";
import test from "node:test";
import { asuntoConValorYMoneda, debeAvisar, esLaMismaPersona, seguirComunicacion, textoSeguimiento, type MensajeEntrante } from "./seguimiento";
import type { Comunicacion } from "./envioMasivoStore";

/**
 * Seguimiento de las respuestas a un correo a una audiencia: por persona, solo lectura, avisa de lo nuevo y, una vez a los 7 días, de quién no contesta.
 */
const T0 = Date.UTC(2026, 9, 14, 6, 18);
const com: Comunicacion = {
  cabecera: { rowIndex: 2, id: "e3ef96f4", chatId: 1, messageId: 9, descripcion: "Formato de soportes", asunto: "Soportes de tus gastos con tarjeta · Gracias y cómo enviarlos", cuerpo: "x", creadoEn: T0 },
  destinatarios: [
    { rowIndex: 2, comunicacion: "e3ef96f4", indice: 0, nombre: "Simon Talloen", email: "simon@footprint.global", empresas: ["Footprint"], estado: "enviado", creadoEn: T0 },
    { rowIndex: 3, comunicacion: "e3ef96f4", indice: 1, nombre: "Kelly Correales", email: "kelly@footprint.global", empresas: ["Footprint"], estado: "enviado", creadoEn: T0 },
  ],
};
const msg = (o: Partial<MensajeEntrante> = {}): MensajeEntrante => ({ id: "m1", threadId: "m1", de: "Simon <simon@footprint.global>", asunto: "Uber aeropuerto · 12,50 EUR · Footprint", fecha: "2026-10-14T10:00:00Z", esRespuesta: false, adjuntos: [{ nombre: "recibo.pdf", partId: "1", estado: "propuesta_pendiente" }], ...o });
const deps = (por: Record<string, MensajeEntrante[]>) => ({ entrantes: async (p: { nombre: string; email: string }) => por[p.email] ?? [] });

test("el formato pedido: el asunto lleva un valor con su moneda (y una respuesta «Re:» no cuenta por el prefijo)", () => {
  assert.equal(asuntoConValorYMoneda("Uber aeropuerto · 12,50 EUR · Footprint"), true);
  assert.equal(asuntoConValorYMoneda("Hotel Madrid 245.33 USD WOBA"), true);
  assert.equal(asuntoConValorYMoneda("Cena equipo · 30 € · WOBA"), true);
  assert.equal(asuntoConValorYMoneda("Re: Footprint · Soportes pendientes de tus gastos con tarjeta"), false);
  assert.equal(asuntoConValorYMoneda("Recibo"), false);
});

test("por persona: lo que ha escrito, lo nuevo frente a lo ya visto y quién no ha escrito", async () => {
  const personas = await seguirComunicacion(com, new Set(["m1"]), deps({ "simon@footprint.global": [msg(), msg({ id: "m2", threadId: "m2", asunto: "Taxi · 9 EUR · Footprint" })] }));
  assert.deepEqual(personas.map((p) => [p.nombre, p.mensajes.length, p.nuevos.length]), [["Simon Talloen", 2, 1], ["Kelly Correales", 0, 0]]);
  const t = textoSeguimiento(com, personas, { soloNovedades: true, ahora: T0 + 86_400_000 });
  assert.match(t, /1 han escrito, 1 no/); assert.match(t, /Sin ningún correo todavía: Kelly Correales/); assert.match(t, /Solo informo/);
  assert.match(t, /Taxi · 9 EUR/); assert.doesNotMatch(t, /Uber aeropuerto/, "con soloNovedades no repite lo ya visto");
});

test("el resumen marca el estado de cada adjunto y los asuntos fuera de formato o respondidos al hilo", async () => {
  const personas = await seguirComunicacion(com, new Set(), deps({ "kelly@footprint.global": [
    msg({ id: "a", asunto: "Recibo", adjuntos: [{ nombre: "r.pdf", partId: "1", estado: "gasto_creado" }] }),
    msg({ id: "b", threadId: "x", esRespuesta: true, asunto: "Re: Soportes", adjuntos: [{ nombre: "f.jpg", partId: "1", estado: "sin_procesar" }, { nombre: "g.jpg", partId: "2", estado: "descartado" }] }),
  ] }));
  const t = textoSeguimiento(com, personas, { ahora: T0 });
  assert.match(t, /asunto sin valor y moneda/); assert.match(t, /respondió al hilo/); assert.match(t, /ya es un gasto en Holded/); assert.match(t, /aún sin procesar/); assert.match(t, /descartado por ti/);
});

test("solo avisa si hay novedades; sin ellas, una sola vez a los 7 días por quienes no han escrito", async () => {
  const nada = await seguirComunicacion(com, new Set(), deps({}));
  assert.deepEqual(debeAvisar(com, nada, false, T0 + 2 * 86_400_000), { avisar: false, porSinRespuesta: false });
  assert.deepEqual(debeAvisar(com, nada, false, T0 + 8 * 86_400_000), { avisar: true, porSinRespuesta: true });
  assert.deepEqual(debeAvisar(com, nada, true, T0 + 9 * 86_400_000), { avisar: false, porSinRespuesta: false }, "ya se avisó de los que no escriben");
  const conNovedad = await seguirComunicacion(com, new Set(), deps({ "simon@footprint.global": [msg()] }));
  assert.deepEqual(debeAvisar(com, conNovedad, true, T0 + 3600_000), { avisar: true, porSinRespuesta: false });
  const todosVistos = await seguirComunicacion(com, new Set(["m1", "k"]), deps({ "simon@footprint.global": [msg()], "kelly@footprint.global": [msg({ id: "k", de: "kelly" })] }));
  assert.equal(debeAvisar(com, todosVistos, false, T0 + 3600_000).avisar, false);
});

test("la misma persona escribe desde otra dirección: vale el nombre visible con dos palabras en común, no un nombre de pila suelto", () => {
  const simon = { nombre: "Simon Talloen", email: "simon@footprint.global" };
  assert.equal(esLaMismaPersona("Simon Talloen <s.talloen@gmail.com>", simon), true, "Gmail personal");
  assert.equal(esLaMismaPersona("Simon <simon@footprint.global>", simon), true, "la dirección a la que se escribió");
  assert.equal(esLaMismaPersona("Simon Peters <simon.p@x.com>", simon), false, "solo el nombre de pila");
  assert.equal(esLaMismaPersona("\"Kelly J. Correales Ducuara\" <k@x.com>", { nombre: "Kelly Johanna Correales Ducuara", email: "kelly@footprint.global" }), true);
  assert.equal(esLaMismaPersona("Alberto Comolli <alberto@wobagroup.com>", { nombre: "Alberto Comolli", email: "alberto@footprint.global" }), true, "otro dominio de la misma persona");
  assert.equal(esLaMismaPersona("Carlos Gonzalez <carlos@wobagroup.com>", { nombre: "Alberto Comolli", email: "alberto@footprint.global" }), false);
  assert.equal(esLaMismaPersona("no-reply@airbnb.com", simon), false);
});
