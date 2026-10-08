import assert from "node:assert/strict";
import test from "node:test";
import type { EntradaNueva } from "../bitacora/tipos";
import type { TelegramCallbackQuery } from "../../telegram/types";
import type { CambioPendiente } from "./cambiosPendientes";
import { handleSegurosCambioCallback, type DepsCallbackSeguros } from "./callbackSeguros";

const CHAT = 7001;

function pendiente(parcial: Partial<CambioPendiente> = {}): CambioPendiente {
  return { id: "sc12345678", chatId: CHAT, messageId: 55, accion: "actualizar_poliza", datos: "{}", cita: "Ya pagué el recibo", creadoEn: Date.now(), ...parcial };
}

function pulsacion(data: string, chatId = CHAT, nombre = "Carlos"): TelegramCallbackQuery {
  return { id: "cb1", from: { id: 99, first_name: nombre } as TelegramCallbackQuery["from"], message: { message_id: 55, chat: { id: chatId } } as TelegramCallbackQuery["message"], data };
}

function entorno(inicial: CambioPendiente[] = [pendiente()]) {
  const almacen = new Map(inicial.map((c) => [c.id, c]));
  const log = { respuestas: [] as Array<string | undefined>, ediciones: [] as string[], caducadas: [] as string[], aplicados: [] as Array<{ cambio: CambioPendiente; por: string }> };
  const comportamiento = { aplicar: async (_c: CambioPendiente, _por: string) => ({ ok: true, mensaje: "Registro actualizado." }), editarFalla: false, responderFalla: false };
  const deps: DepsCallbackSeguros = {
    almacen: {
      ver: async (id) => almacen.get(id),
      consumir: async (id) => { const c = almacen.get(id); almacen.delete(id); return c; },
    },
    aplicar: async (cambio, por) => { log.aplicados.push({ cambio, por }); return comportamiento.aplicar(cambio, por); },
    responder: async (_id, texto) => { if (comportamiento.responderFalla) throw new Error("query is too old"); log.respuestas.push(texto); },
    editar: async (_chat, _msg, texto) => { if (comportamiento.editarFalla) throw new Error("message can't be edited"); log.ediciones.push(texto); },
    retirarCaducada: async (_cb, texto) => { log.caducadas.push(texto); },
  };
  return { deps, almacen, log, comportamiento };
}

test("Aplicar: consume la propuesta, la aplica con el nombre de quien pulsa y muestra el resultado", async () => {
  const e = entorno();
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678", CHAT, "Carlos"), e.deps);
  assert.equal(e.log.aplicados.length, 1);
  assert.equal(e.log.aplicados[0].por, "Carlos");
  assert.equal(e.almacen.size, 0, "la propuesta se decide una sola vez");
  assert.deepEqual(e.log.ediciones, ["🔄 Aplicando el cambio…", "✅ Registro actualizado."]);
});

test("Aplicar con un resultado rechazado (la fila cambió) lo muestra como aviso, no como éxito", async () => {
  const e = entorno();
  e.comportamiento.aplicar = async () => ({ ok: false, mensaje: "No se aplicó: la póliza cambió desde que preparé la propuesta." });
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), e.deps);
  assert.equal(e.log.ediciones.at(-1), "⚠️ No se aplicó: la póliza cambió desde que preparé la propuesta.");
});

test("Aplicar cuando escribir falla: la propuesta ya no está pendiente y el mensaje manda comprobar el registro (nunca repite solo)", async () => {
  const e = entorno();
  e.comportamiento.aplicar = async () => { throw new Error("Quota exceeded"); };
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), e.deps);
  assert.match(e.log.ediciones.at(-1) ?? "", /No pude confirmar el cambio: Quota exceeded/);
  assert.match(e.log.ediciones.at(-1) ?? "", /Comprueba el registro antes de repetirlo/);
  assert.equal(e.almacen.size, 0);
});

test("Cancelar: no aplica nada, retira la propuesta y lo dice", async () => {
  const e = entorno();
  await handleSegurosCambioCallback(pulsacion("segcambio_cancelar:sc12345678"), e.deps);
  assert.equal(e.log.aplicados.length, 0);
  assert.equal(e.almacen.size, 0);
  assert.deepEqual(e.log.ediciones, ["❌ Cancelado: no se cambió nada."]);
});

test("una propuesta caducada o ya decidida se retira del chat sin aplicar nada", async () => {
  const e = entorno([]);
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), e.deps);
  assert.equal(e.log.aplicados.length, 0);
  assert.deepEqual(e.log.caducadas, ["Esta propuesta ya no está disponible (expiró o ya se decidió)."]);
});

test("doble pulsación: la segunda ya no encuentra la propuesta y no la aplica otra vez", async () => {
  const e = entorno();
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), e.deps);
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), e.deps);
  assert.equal(e.log.aplicados.length, 1);
  assert.equal(e.log.caducadas.length, 1);
});

test("dos pulsaciones a la vez: solo una consigue la propuesta", async () => {
  const e = entorno();
  let llamadas = 0;
  const original = e.deps.almacen.consumir;
  // Ambas pasan por `ver`; solo la primera en llegar a `consumir` se lleva la propuesta.
  e.deps.almacen.consumir = async (id) => { const orden = ++llamadas; await new Promise((r) => setTimeout(r, 5)); return orden === 1 ? original(id) : undefined; };
  await Promise.all([
    handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), e.deps),
    handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), e.deps),
  ]);
  assert.equal(e.log.aplicados.length, 1);
  assert.equal(e.log.caducadas.length, 1, "la otra pulsación ve que ya no está");
});

test("un botón pulsado desde otro chat NO aplica ni destruye la propuesta del chat original", async () => {
  const e = entorno();
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678", 9999), e.deps);
  assert.equal(e.log.aplicados.length, 0);
  assert.equal(e.almacen.size, 1, "la propuesta sigue disponible para su chat");
  assert.deepEqual(e.log.respuestas, ["Este botón no es de este chat."]);
});

test("una acción desconocida con este prefijo no se interpreta como «aplicar»", async () => {
  const e = entorno();
  for (const data of ["segcambio_otra:sc12345678", "segcambio_aplicar", "segcambio_aplicar:", "segcambio_:sc12345678"]) {
    await handleSegurosCambioCallback(pulsacion(data), e.deps);
  }
  assert.equal(e.log.aplicados.length, 0);
  assert.equal(e.almacen.size, 1);
});

test("si no se puede editar el mensaje o responder al botón, la decisión se cumple igual", async () => {
  const e = entorno();
  e.comportamiento.editarFalla = true;
  e.comportamiento.responderFalla = true;
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), e.deps);
  assert.equal(e.log.aplicados.length, 1, "el cambio se aplica aunque Telegram falle al editar");
  assert.equal(e.almacen.size, 0);
});

test("quien pulsa sin nombre de pila queda identificado por su usuario o su id", async () => {
  const e = entorno();
  const cb = pulsacion("segcambio_aplicar:sc12345678");
  cb.from = { id: 42, username: "carlos_woba" } as TelegramCallbackQuery["from"];
  await handleSegurosCambioCallback(cb, e.deps);
  assert.equal(e.log.aplicados[0].por, "@carlos_woba");
});

const propuestaDeRecordar = () => pendiente({ accion: "recordar", datos: JSON.stringify({ tipo: "decision", texto: "Se excluye la RC del multirriesgo de WOBA" }) });

test("la decisión queda en la bitácora: aplicar (con su resultado), cancelar y fallo al aplicar", async () => {
  const aplicada = entorno([propuestaDeRecordar()]);
  const registros: EntradaNueva[] = [];
  aplicada.deps.registrar = async (entrada) => { registros.push(entrada); };
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678", CHAT, "Carlos"), aplicada.deps);
  assert.equal(registros.length, 1);
  assert.equal(registros[0].tarea, "agente");
  assert.equal(registros[0].origen, "agente");
  assert.equal(registros[0].resultado, "con_novedades");
  assert.equal(registros[0].resumen, "Carlos aprobó y se aplicó: recordar (decision): «Se excluye la RC del multirriesgo de WOBA».");

  const cancelada = entorno([propuestaDeRecordar()]);
  const registrosCancelar: EntradaNueva[] = [];
  cancelada.deps.registrar = async (entrada) => { registrosCancelar.push(entrada); };
  await handleSegurosCambioCallback(pulsacion("segcambio_cancelar:sc12345678", CHAT, "Carlos"), cancelada.deps);
  assert.equal(registrosCancelar.length, 1);
  assert.match(registrosCancelar[0].resumen, /Carlos canceló la propuesta: recordar \(decision\)/);
  assert.equal(registrosCancelar[0].resultado, "sin_novedades");

  const fallida = entorno([propuestaDeRecordar()]);
  fallida.comportamiento.aplicar = async () => { throw new Error("Quota exceeded"); };
  const registrosFallo: EntradaNueva[] = [];
  fallida.deps.registrar = async (entrada) => { registrosFallo.push(entrada); };
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), fallida.deps);
  assert.equal(registrosFallo[0].resultado, "error");
  assert.deepEqual(registrosFallo[0].detalle.notas, ["Quota exceeded"]);
});

test("una bitácora que falla no impide ni deshace la decisión", async () => {
  const e = entorno([propuestaDeRecordar()]);
  e.deps.registrar = async () => { throw new Error("Sheets agotado"); };
  const original = console.error; console.error = () => {};
  try { await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), e.deps); } finally { console.error = original; }
  assert.equal(e.log.aplicados.length, 1);
  assert.equal(e.almacen.size, 0);
  assert.equal(e.log.ediciones.at(-1), "✅ Registro actualizado.");
});

test("lo que no llega a decidirse (propuesta caducada o botón de otro chat) no deja constancia", async () => {
  const caducada = entorno([]);
  const registros: EntradaNueva[] = [];
  caducada.deps.registrar = async (entrada) => { registros.push(entrada); };
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678"), caducada.deps);
  const otroChat = entorno([propuestaDeRecordar()]);
  otroChat.deps.registrar = async (entrada) => { registros.push(entrada); };
  await handleSegurosCambioCallback(pulsacion("segcambio_aplicar:sc12345678", 9999), otroChat.deps);
  assert.equal(registros.length, 0);
});
