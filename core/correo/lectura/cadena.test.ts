import assert from "node:assert/strict";
import test from "node:test";
import { describirPersona, leerCadena, parsearPersona, quitarFirma, remitenteOriginalDeReenvio } from "./cadena";

test("direcciones reales del buzón: con mailto, entre ángulos sueltos, con paréntesis y solo nombre", () => {
  assert.deepEqual(parsearPersona("Admin Asistente <asistente@wobagroup.com<mailto:asistente@wobagroup.com>>"), { nombre: "Admin Asistente", email: "asistente@wobagroup.com" });
  assert.deepEqual(parsearPersona("<chusgt@gmail.com>"), { nombre: undefined, email: "chusgt@gmail.com" });
  assert.deepEqual(parsearPersona("Simon Talloen (simon.talloen@gmail.com)"), { nombre: undefined, email: undefined }, "sin ángulos no se acepta una dirección entre paréntesis");
  assert.deepEqual(parsearPersona('"Alejandra González Rojas" <Alejandra@WobaGroup.com>'), { nombre: "Alejandra González Rojas", email: "alejandra@wobagroup.com" });
  assert.deepEqual(parsearPersona("Alberto Comolli"), { nombre: "Alberto Comolli", email: undefined });
  assert.equal(describirPersona(parsearPersona("Ana <a@b.com>")), "Ana <a@b.com>");
});

const REENVIO_GMAIL = `Revisa esto y dime qué hacemos.

---------- Forwarded message ---------
De: <chusgt@gmail.com>
Date: mar, 6 oct 2026 a la(s) 6:17 p.m.
Subject: Re: Factura Alquiler LUARCA OCTUBRE 2026
To: ChusGT <chusgt@gmail.com>
Cc: Alberto Comolli <alberto@wobagroup.com>

Adjunto la factura de octubre. Un saludo`;

test("un reenvío de Gmail: el remitente real es el autor reenviado, no quien lo reenvió", () => {
  const l = leerCadena("Carlos Gonzalez <carlos@wobagroup.com>", REENVIO_GMAIL);
  assert.equal(l.esReenvio, true);
  assert.equal(l.mensajeNuevo, "Revisa esto y dime qué hacemos.");
  assert.deepEqual(l.remitenteReal, { nombre: undefined, email: "chusgt@gmail.com" });
  assert.equal(describirPersona(l.reenviadoPor!), "Carlos Gonzalez <carlos@wobagroup.com>");
  assert.equal(l.cadena[0].asunto, "Re: Factura Alquiler LUARCA OCTUBRE 2026");
  assert.match(l.cadena[0].texto, /Adjunto la factura de octubre/);
});

test("un correo que no es reenvío ni cadena: la cabecera manda y todo el texto es nuevo", () => {
  const l = leerCadena("Ana <ana@x.com>", "Hola, te envío la factura.\nSaludos");
  assert.equal(l.esReenvio, false);
  assert.deepEqual(l.remitenteReal, { nombre: "Ana", email: "ana@x.com" });
  assert.equal(l.reenviadoPor, undefined);
  assert.equal(l.mensajeNuevo, "Hola, te envío la factura.\nSaludos");
  assert.equal(l.cadena.length, 0);
});

const RESPUESTA_INGLES = `Hola:

1. Rappi: adjunto el comprobante.

Saludos,

On Tue, Oct 6, 2026 at 10:21 AM Admin Asistente <asistente@wobagroup.com>
wrote:

> Hola, Alejandro:
>
> Estamos desarrollando la habilidad de nuestro asistente.`;

test("una respuesta con la cita partida en dos líneas («… <a@b.com>⏎ wrote:») separa el mensaje nuevo del historial", () => {
  const l = leerCadena("Alejandro Florez <alejandro.florez@footprint.global>", RESPUESTA_INGLES);
  assert.equal(l.esReenvio, false);
  assert.equal(l.mensajeNuevo, "Hola:\n\n1. Rappi: adjunto el comprobante.\n\nSaludos,");
  assert.equal(l.cadena.length, 1);
  assert.equal(l.cadena[0].origen, "cita");
  assert.equal(l.cadena[0].de.email, "asistente@wobagroup.com");
  assert.match(l.cadena[0].texto, /Estamos desarrollando la habilidad/);
  assert.equal(l.remitenteReal.email, "alejandro.florez@footprint.global");
  assert.equal(l.originador.email, "alejandro.florez@footprint.global", "el único autor anterior es el propio buzón: el originador es quien responde");
});

test("«El … escribió:» con nombre y (email) y citas «>» anidadas", () => {
  const cuerpo = `Gracias, lo reviso.

El mié, 30 sept 2026 a la(s) 2:34 p.m., Jaquelin Lovey (jaquelin.lovey@acodrid.com<mailto:jaquelin.lovey@acodrid.com>) escribió:
> Buenos días Carlos,
> Como continuación a la conversación telefónica, lamento comunicarte la cancelación.
>
> El lun, 28 sept 2026 a las 9:44, Alba López Moya (<alba.lopez@raminatrans.com<mailto:alba.lopez@raminatrans.com>>) escribió:
> > Alberto, adjunto BL final con fecha on board 25/09.`;
  const l = leerCadena("Carlos Gonzalez <carlos@wobagroup.com>", cuerpo);
  assert.equal(l.mensajeNuevo, "Gracias, lo reviso.");
  assert.deepEqual(l.cadena.map((m) => m.de.email), ["jaquelin.lovey@acodrid.com", "alba.lopez@raminatrans.com"]);
  assert.equal(l.cadena[0].de.nombre, "Jaquelin Lovey");
  assert.equal(l.cadena[1].de.nombre, "Alba López Moya");
  assert.equal(l.originador.email, "alba.lopez@raminatrans.com");
  assert.equal(l.remitenteReal.email, "carlos@wobagroup.com", "una respuesta no es un reenvío: quien escribe es la cabecera");
});

test("reenvío de un correo que ya era una respuesta del propio buzón: el remitente real salta al autor que no es el buzón", () => {
  const cuerpo = `Fwd, por favor atiende.

---------- Forwarded message ---------
De: Admin Asistente <asistente@wobagroup.com<mailto:asistente@wobagroup.com>>
Date: mié, 30 sept 2026 a la(s) 7:06 p.m.
Subject: Re: URGENTE -- RECIBOS PENDIENTES DE PÓLIZA
To: Pep <pep@aseguradora.es>

Estimado Pep, hemos revisado los recibos.

El mar, 29 sept 2026 a las 10:00, Pep Soler <pep@aseguradora.es> escribió:
> Os adjunto los recibos pendientes de la póliza.`;
  const l = leerCadena("Carlos Gonzalez <carlos@wobagroup.com>", cuerpo);
  assert.equal(l.esReenvio, true);
  assert.equal(l.remitenteReal.email, "pep@aseguradora.es", "el primer bloque es del buzón; el real es la persona de la cadena");
  assert.equal(l.originador.email, "pep@aseguradora.es");
  assert.equal(describirPersona(l.reenviadoPor!), "Carlos Gonzalez <carlos@wobagroup.com>");
});

test("cadena de Outlook en línea (De/Enviado/Para/Asunto tras una raya) y «Original Message»", () => {
  const outlook = `Ok, procedo.

________________________________
De: Alberto Comolli <alberto@wobagroup.com>
Enviado: martes, 6 de octubre de 2026 9:12
Para: Alba López
Asunto: RE: BL final

Adjunto el BL.`;
  const l = leerCadena("Alba López <alba@raminatrans.com>", outlook);
  assert.equal(l.mensajeNuevo, "Ok, procedo.");
  assert.equal(l.cadena[0].de.email, "alberto@wobagroup.com");
  assert.equal(l.cadena[0].asunto, "RE: BL final");
  assert.match(l.cadena[0].texto, /Adjunto el BL/);
  const original = leerCadena("X <x@y.com>", "Hola\n\n-----Original Message-----\nFrom: Bea <bea@z.com>\nSent: Mon\nSubject: Hi\n\nTexto");
  assert.equal(original.cadena[0].origen, "original");
  assert.equal(original.cadena[0].de.email, "bea@z.com");
});

test("un reenvío citado dentro de una respuesta no convierte el correo en reenvío", () => {
  const cuerpo = `Recibido.

On Thu, Oct 1, 2026, 08:47 Carlos Gonzalez <carlos@wobagroup.com> wrote:

> ---------- Forwarded message ---------
> De: Admin Asistente <asistente@wobagroup.com>
> Date: jue, 1 oct 2026 a la(s) 2:40 p.m.
> Subject: Re: Fwd: Car rental - 354.6
>
> Texto antiguo`;
  const l = leerCadena("Simon Talloen <simon@footprint.global>", cuerpo);
  assert.equal(l.esReenvio, false);
  assert.equal(l.remitenteReal.email, "simon@footprint.global");
  assert.equal(l.mensajeNuevo, "Recibido.");
  assert.ok(l.cadena.length >= 1);
});

// Protecciones heredadas del extractor anterior (core/gmail/remitenteReenvio.ts, revisión adversarial de 2026-09-30):
// el texto de un reenvío lo puede escribir cualquiera, así que ningún truco del «From:» debe producir una identidad falsa.
const reenvio = (from: string) => `Nota.\n\n---------- Forwarded message ---------\nFrom: ${from}\nDate: Mon\nSubject: x\n\nTexto`;

test("caso real Simon Talloen / Go Rent A Car: nombre y email del reenviado", () => {
  const l = leerCadena("Carlos <carlos@wobagroup.com>", reenvio("Simon Talloen <simon.talloen@gmail.com>"));
  assert.deepEqual(l.remitenteReal, { nombre: "Simon Talloen", email: "simon.talloen@gmail.com" });
});

test("variantes: «Mensaje reenviado» + «De:», y solo el email sin nombre", () => {
  const es = leerCadena("Carlos <carlos@wobagroup.com>", "---------- Mensaje reenviado ---------\nDe: Simon Talloen <simon.talloen@gmail.com>\nFecha: lun\n");
  assert.equal(es.remitenteReal.email, "simon.talloen@gmail.com");
  const suelto = leerCadena("Carlos <carlos@wobagroup.com>", reenvio("simon.talloen@gmail.com"));
  assert.deepEqual(suelto.remitenteReal, { nombre: undefined, email: "simon.talloen@gmail.com" });
});

test("un email falso dentro del nombre visible no engaña: la dirección es la de los ángulos y el «nombre» no se muestra", () => {
  const l = leerCadena("Carlos <carlos@wobagroup.com>", reenvio('"no-confiar@falso.com" <real@verdadero.com>'));
  assert.equal(l.remitenteReal.email, "real@verdadero.com");
  assert.equal(l.remitenteReal.nombre, undefined);
});

test("un ángulo sin cerrar o un formato «Nombre (email)» en un reenvío no producen un email: se cae a la cabecera", () => {
  for (const from of ["Simon <3 Talloen <simon.talloen@gmail.com>", "Simon Talloen (simon.talloen@gmail.com)"]) {
    const l = leerCadena("Carlos <carlos@wobagroup.com>", reenvio(from));
    assert.equal(l.remitenteReal.email, "carlos@wobagroup.com", from);
  }
});

test("un bloque de reenvío sin «From/De», o sin reenvío, no inventa nada", () => {
  assert.equal(leerCadena("Carlos <carlos@wobagroup.com>", "---------- Forwarded message ---------\nSubject: algo\nTo: alguien@x.com\n").cadena.length, 0);
  assert.equal(remitenteOriginalDeReenvio("Carlos <carlos@wobagroup.com>", "Hola, aquí va el recibo adjunto."), undefined);
});

test("la firma y el aviso legal de quien reenvía no cuentan como nota; un [image:] suelto en medio sí es texto", () => {
  const firma = `[image: WOBA]\nUSA | LATAM | EMEA\n\n[image: avixa] <#SignatureSanitizer_> Carlos González\n\n“The information contained in this message is confidential.`;
  assert.equal(quitarFirma(firma), "");
  assert.equal(quitarFirma("Atiende esto, por favor.\n\n-- \nCarlos"), "Atiende esto, por favor.");
  assert.equal(quitarFirma("Mira la foto:\n[image: captura]\ny dime."), "Mira la foto:\n[image: captura]\ny dime.");
  const l = leerCadena("Carlos <carlos@wobagroup.com>", `${firma}\n\n---------- Forwarded message ---------\nFrom: Ana <ana@x.com>\nDate: x\nSubject: y\n\nHola`);
  assert.equal(l.mensajeNuevo, "", "sin nota: solo reenvía");
  assert.equal(l.remitenteReal.email, "ana@x.com");
});
