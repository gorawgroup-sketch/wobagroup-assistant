import assert from "node:assert/strict";
import test from "node:test";
import { botonesBorradorCorreo, textoBorradorCorreo } from "./reenviarBorradorCorreo";

test("el borrador reenviado conserva destinatario, asunto, adjunto y los botones draft_* originales", () => {
  const texto = textoBorradorCorreo({ id: "b1", chatId: 1, messageId: 5, to: "kelly@x.com", subject: "Re: Soportes", cuerpo: "Hola Kelly", creadoEn: 0, adjuntosDrive: [{ fileId: "f", nombre: "Declaracion.pdf", mimeType: "application/pdf" }] }, "🔁 renovado");
  assert.match(texto, /^🔁 renovado\n\n✉️ Borrador de correo para kelly@x.com:\nAsunto: Re: Soportes\n📎 Adjunto: Declaracion.pdf\n\nHola Kelly$/);
  assert.deepEqual(botonesBorradorCorreo("b1").flat().map((b) => b.callback_data), ["draft_enviar:b1", "draft_editar:b1", "draft_cancelar:b1"]);
});
