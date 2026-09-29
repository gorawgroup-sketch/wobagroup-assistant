import assert from "node:assert/strict";
import test from "node:test";
import { dividirParaTelegram, MAX_PESO_TROZO_TELEGRAM, pesoTelegram, tituloDeTrozo } from "./dividirMensaje";

const LIMITE_TELEGRAM = 4096;
/** Lo que realmente se manda: el trozo escapado como HTML, con el título en negrita y el bloque expandible. */
const htmlDelTrozo = (trozo: string, titulo = "Revisión automática terminada. (3/3)") =>
  `<b>${titulo}</b>\n<blockquote expandable>${trozo.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>")}</blockquote>`;
const sinParesRotos = (t: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t);

test("un texto que cabe se devuelve tal cual, en un solo trozo", () => {
  assert.deepEqual(dividirParaTelegram("hola"), ["hola"]);
  assert.deepEqual(dividirParaTelegram(""), [""]);
});

test("el informe real de 49 correos (≈4.540 caracteres) se parte en trozos que caben, por líneas y sin perder nada", () => {
  const lineas = [
    "📬 Revisión automática terminada.",
    "Correos analizados automáticamente: 46.",
    ...Array.from({ length: 31 }, (_, i) => `• Footprint · ${(7 + i / 7).toFixed(2)} EUR · compra 6aba27f01b0791ea0a0827${String(i).padStart(2, "0")}.`),
    ...Array.from({ length: 22 }, (_, i) => `• ${i}: No se encontró un movimiento compatible con las reglas de importe, moneda y fecha, mediante el equivalente contable de Holded; requiere revisión manual.`),
  ];
  const texto = lineas.join("\n");
  assert.ok(texto.length > 4096, "el caso de prueba debe superar el límite de Telegram");
  const trozos = dividirParaTelegram(texto);
  assert.ok(trozos.length >= 2);
  for (const t of trozos) assert.ok(htmlDelTrozo(t).length <= LIMITE_TELEGRAM, `trozo de ${htmlDelTrozo(t).length} caracteres`);
  assert.equal(trozos.join("\n"), texto, "reunidos, los trozos reproducen el informe completo");
  for (const t of trozos) for (const l of t.split("\n")) assert.ok(lineas.includes(l), "cada trozo contiene solo líneas enteras");
});

test("una línea sola más larga que el tope se corta por palabras y sin perder texto", () => {
  const texto = Array.from({ length: 2500 }, (_, i) => `palabra${i}`).join(" ");
  const trozos = dividirParaTelegram(texto);
  assert.ok(trozos.length > 1);
  for (const t of trozos) assert.ok(pesoTelegram(t) <= MAX_PESO_TROZO_TELEGRAM);
  assert.equal(trozos.join(" "), texto);
});

test("el escapado HTML (& < >) infla el texto: los trozos se miden ya escapados", () => {
  const texto = "a & b < c > d\n".repeat(700);
  const trozos = dividirParaTelegram(texto);
  assert.ok(trozos.length > 1);
  for (const t of trozos) assert.ok(htmlDelTrozo(t).length <= LIMITE_TELEGRAM, `trozo escapado de ${htmlDelTrozo(t).length}`);
  const peor = "&".repeat(9000);
  for (const t of dividirParaTelegram(peor)) assert.ok(htmlDelTrozo(t).length <= LIMITE_TELEGRAM);
});

test("nunca parte un emoji (par sustituto) por la mitad", () => {
  const texto = "😀".repeat(3000);
  const trozos = dividirParaTelegram(texto);
  assert.ok(trozos.length > 1);
  for (const t of trozos) assert.ok(sinParesRotos(t), "trozo con un par sustituto roto");
  assert.equal(trozos.join(""), texto);
});

test("los marcadores ** cuentan como negrita al medir el peso", () => {
  assert.equal(pesoTelegram("**a**"), 5 + 4);
  assert.equal(pesoTelegram("a"), 1);
});

test("tituloDeTrozo solo añade (n/total) cuando hay más de un trozo", () => {
  assert.equal(tituloDeTrozo("Informe", 0, 1), "Informe");
  assert.equal(tituloDeTrozo("Informe", 1, 3), "Informe (2/3)");
});
