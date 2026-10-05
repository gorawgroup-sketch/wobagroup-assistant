import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { analizarAutomatico, llamarConReparo, MAX_INTENTOS_FORMATO, type LlamarModeloAnalisis } from "./analyze";
import type { CorreoAuto } from "./model";

const herramienta = (input: unknown, id = "t1"): Anthropic.ContentBlock[] => [{ type: "tool_use", id, name: "analisis_correo_automatico", input } as never];
const valido = (extra: Record<string, unknown> = {}) => ({ completo: true, resumen: "Recibo de Uber", otrasAcciones: false, recibos: [], ...extra });
const FUENTES = new Set(["cuerpo"]);

function secuencia(respuestas: Array<{ content: Anthropic.ContentBlock[]; stop_reason?: string | null }>) {
  const llamadas: Parameters<LlamarModeloAnalisis>[0][] = [];
  const llamar: LlamarModeloAnalisis = async (p) => { llamadas.push({ ...p, messages: structuredClone(p.messages) }); const r = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)]; return { content: r.content, stop_reason: r.stop_reason ?? "tool_use" }; };
  return { llamar, llamadas };
}

test("reparación: una respuesta sin estructura verificable se devuelve al modelo con el motivo exacto y se acepta la corrección (caso «Análisis sin estructura verificable»)", async () => {
  const { llamar, llamadas } = secuencia([{ content: herramienta({ resumen: "falta completo" }) }, { content: herramienta(valido()) }]);
  const a = await llamarConReparo(llamar, "sys", "contenido", FUENTES);
  assert.equal(a.completo, true);
  assert.equal(llamadas.length, 2);
  const retorno = llamadas[1].messages.at(-1)!.content as Array<{ type: string; is_error?: boolean; content?: string }>;
  assert.equal(retorno[0].type, "tool_result"); assert.equal(retorno[0].is_error, true);
  assert.match(String(retorno[0].content), /no pasó la validación: Análisis sin estructura verificable/);
  assert.equal(llamadas[1].maxTokens, 16000, "tras el primer intento se amplía el margen de salida");
});
test("reparación: sin llamar a la herramienta o cortada por longitud también se corrige; tras varios intentos fallidos se rinde con el motivo", async () => {
  const sinHerramienta = secuencia([{ content: [{ type: "text", text: "hola" } as never] }, { content: herramienta(valido()) }]);
  assert.equal((await llamarConReparo(sinHerramienta.llamar, "s", "c", FUENTES)).completo, true);
  assert.match(String(sinHerramienta.llamadas[1].messages.at(-1)!.content), /exactamente UNA vez/);
  const cortada = secuencia([{ content: herramienta(valido()), stop_reason: "max_tokens" }, { content: herramienta(valido()) }]);
  assert.equal((await llamarConReparo(cortada.llamar, "s", "c", FUENTES)).completo, true);
  const mala = secuencia([{ content: herramienta({}) }]);
  await assert.rejects(() => llamarConReparo(mala.llamar, "s", "c", FUENTES), new RegExp(`tras ${MAX_INTENTOS_FORMATO} intentos`));
  assert.equal(mala.llamadas.length, MAX_INTENTOS_FORMATO);
});

const correo = (extra: Partial<CorreoAuto> = {}): CorreoAuto => ({ id: "m1", threadId: "t1", de: "a@b.c", asunto: "Taxi", fecha: "x", recibidoEn: 1, cuerpo: "texto", contextoHilo: "", adjuntos: [], huella: "h", ...extra } as CorreoAuto);

test("verificación: «incompleto» sin nombrar una parte concreta se relee UNA vez y, si todo era legible, queda completo", async () => {
  const { llamar, llamadas } = secuencia([{ content: herramienta(valido({ completo: false, resumen: "no coincide el asunto con el importe" })) }, { content: herramienta(valido({ completo: true, resumen: "Todo legible" })) }]);
  const a = await analizarAutomatico(correo(), { memoria: null }, llamar);
  assert.equal(llamadas.length, 2);
  assert.equal(a.completo, true); assert.match(a.resumen, /Confirmado en una segunda lectura/);
  const ultimoUsuario = JSON.stringify(llamadas[1].messages[0].content);
  assert.match(ultimoUsuario, /VERIFICACIÓN.*no coincide el asunto con el importe/s);
});
test("verificación: si el primer análisis YA nombra la parte ilegible no se relee; si la segunda lectura también es incompleta, se mantiene incompleto con detalle", async () => {
  const nombrada = secuencia([{ content: herramienta(valido({ completo: false, detalleIncompleto: "El PDF adjunto está protegido con contraseña" })) }]);
  const a = await analizarAutomatico(correo(), { memoria: null }, nombrada.llamar);
  assert.equal(nombrada.llamadas.length, 1); assert.equal(a.completo, false); assert.match(a.detalleIncompleto ?? "", /contraseña/);
  const siempre = secuencia([{ content: herramienta(valido({ completo: false, resumen: "algo falta" })) }]);
  const b = await analizarAutomatico(correo(), { memoria: null }, siempre.llamar);
  assert.equal(siempre.llamadas.length, 2); assert.equal(b.completo, false); assert.ok(b.detalleIncompleto);
});
test("adjunto ilegible: un posible comprobante (Factura.doc) impide dar la lectura por completa; uno informativo (Circular.doc) no tumba el correo", async () => {
  const doc = (nombre: string) => ({ id: "1", nombre, mime: "application/msword", data: Buffer.from("no-es-legible") });
  const conFactura = secuencia([{ content: herramienta(valido({ completo: true })) }]);
  const a = await analizarAutomatico(correo({ adjuntos: [doc("Factura 123.doc")] }), { memoria: null }, conFactura.llamar);
  assert.equal(a.completo, false); assert.match(a.detalleIncompleto ?? "", /Factura 123\.doc/); assert.equal(a.otrasAcciones, true);
  assert.match(JSON.stringify(conFactura.llamadas[0].messages[0].content), /ADJUNTO NO LEGIBLE POR EL SISTEMA: Factura 123\.doc/);
  const informativo = secuencia([{ content: herramienta(valido({ completo: true })) }]);
  const b = await analizarAutomatico(correo({ adjuntos: [doc("1.3 Circular informativa - Blog.doc")] }), { memoria: null }, informativo.llamar);
  assert.equal(b.completo, true); assert.match(b.resumen, /No se pudo leer el adjunto informativo/);
});
test("los límites deterministas y el error de lectura no llaman al modelo", async () => {
  const { llamar, llamadas } = secuencia([{ content: herramienta(valido()) }]);
  const e = await analizarAutomatico(correo({ lecturaError: "Adjunto supera 25 MB" }), { memoria: null }, llamar);
  assert.equal(e.completo, false); assert.equal(e.detalleIncompleto, "Adjunto supera 25 MB");
  const g = await analizarAutomatico(correo({ cuerpo: "x".repeat(250_000) }), { memoria: null }, llamar);
  assert.equal(g.motivoManual, "lectura_excede_limite");
  assert.equal(llamadas.length, 0);
});
