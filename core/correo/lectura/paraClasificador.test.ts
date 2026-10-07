import assert from "node:assert/strict";
import test from "node:test";
import { leerCadena } from "./cadena";
import { lineaRemitenteReal, PRESUPUESTO_HISTORIAL, textoParaClasificador } from "./paraClasificador";

const cab = (de: string) => ({ de, asunto: "Asunto", fecha: "Tue, 6 Oct 2026" });
const reenvio = (nota: string, cuerpoOriginal: string) => `${nota}\n\n---------- Forwarded message ---------\nDe: Noelia Casas <ncasas@cratevo.com>\nDate: mar\nSubject: Nuevas obligaciones laborales\n\n${cuerpoOriginal}`;

test("un reenvío dice quién es el remitente real, quién lo reenvió y que no está verificado", () => {
  const c = "Carlos Gonzalez <carlos@wobagroup.com>";
  const cuerpo = reenvio("Atiende esto.", "Os informamos de las nuevas obligaciones laborales.");
  const t = textoParaClasificador(cab(c), leerCadena(c, cuerpo), cuerpo);
  assert.match(t, /Es un REENVÍO\. Remitente real del contenido: Noelia Casas <ncasas@cratevo\.com> — lo reenvió Carlos Gonzalez <carlos@wobagroup\.com>/);
  assert.match(t, /no está verificado/);
  assert.match(t, /Mensaje nuevo \(lo que escribe quien envía este correo\):\nAtiende esto\./);
  assert.match(t, /Mensaje reenviado 1 — de Noelia Casas <ncasas@cratevo\.com>, mar, asunto «Nuevas obligaciones laborales»:\nOs informamos/);
  assert.match(lineaRemitenteReal(leerCadena(c, cuerpo))!, /^Remitente real \(según el texto del correo, sin verificar\): Noelia Casas/);
});

test("un reenvío sin nota lo dice, y un correo sin cadena entra entero sin recortar", () => {
  const c = "Carlos Gonzalez <carlos@wobagroup.com>";
  const cuerpo = reenvio("[image: WOBA]\nUSA | LATAM | EMEA", "Contenido.");
  assert.match(textoParaClasificador(cab(c), leerCadena(c, cuerpo), cuerpo), /Mensaje nuevo: \(sin nota — solo reenvía o responde con el contenido de abajo\)/);
  const largo = "Línea de texto con datos.\n".repeat(1200); // ~30.000 caracteres: antes se cortaba a 8.000
  const t = textoParaClasificador(cab("Ana <ana@x.com>"), leerCadena("Ana <ana@x.com>", largo), largo);
  assert.ok(t.includes(largo.trim()), "el cuerpo sin cadena no se recorta");
  assert.equal(lineaRemitenteReal(leerCadena("Ana <ana@x.com>", largo)), undefined);
});

test("el historial largo se recorta con un aviso explícito y el primer mensaje de la cadena nunca se pierde", () => {
  const c = "Ana <ana@x.com>";
  const cuerpo = "Mi respuesta.\n\nOn Tue, Oct 6, 2026 at 10:21 AM Bea <bea@y.com> wrote:\n" + "> mensaje de bea con detalle\n".repeat(60) +
    "> \n> On Mon, Oct 5, 2026 at 9:00 AM Carlos <carlos@z.com> wrote:\n" + ("> texto antiguo muy largo de relleno para superar el presupuesto\n".repeat(900));
  const t = textoParaClasificador(cab(c), leerCadena(c, cuerpo), cuerpo);
  assert.match(t, /Mensaje nuevo \(lo que escribe quien envía este correo\):\nMi respuesta\./);
  assert.match(t, /Cita de un mensaje anterior 1 — de Bea <bea@y\.com>/);
  assert.match(t, /mensaje de bea con detalle/);
  assert.match(t, /\[Aviso: se omitieron \d+ caracteres del historial más antiguo/);
  assert.ok(t.length < PRESUPUESTO_HISTORIAL + 30_000);
});

test("una respuesta en cadena indica el autor más antiguo visible cuando difiere del remitente real", () => {
  const c = "Simon <simon@footprint.global>";
  const cuerpo = "Recibido.\n\nEl lun, 28 sept 2026 a las 9:44, Alba López Moya (<alba.lopez@raminatrans.com>) escribió:\n> Adjunto BL final.";
  assert.match(textoParaClasificador(cab(c), leerCadena(c, cuerpo), cuerpo), /Remitente real: Simon <simon@footprint\.global>\. Autor más antiguo visible de la cadena: Alba López Moya <alba\.lopez@raminatrans\.com>\./);
});
