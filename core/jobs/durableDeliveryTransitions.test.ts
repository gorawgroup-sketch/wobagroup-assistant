import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

async function fuente(ruta: string): Promise<string> {
  return readFile(join(process.cwd(), ruta), "utf8");
}

test("clasificacion y desambiguacion solo exponen una decision despues de confirmar Telegram", async () => {
  const [flujo, clasificacion, desambiguacion] = await Promise.all([
    fuente("core/documental/processClassification.ts"),
    fuente("core/documental/classificationStore.ts"),
    fuente("core/documental/disambiguationStore.ts"),
  ]);

  assert.match(flujo, /messageId:\s*0[\s\S]*sendTelegramMessageWithButtons[\s\S]*actualizarMessageIdDesambiguacion/);
  assert.match(flujo, /consumirPendienteDesambiguacionPorId\(pendiente\.id, archivo\.chatId\)/);
  assert.match(flujo, /actualizarMessageIdClasificacion\(propuesta\.id, messageId\)[\s\S]*obtenerPropuestaClasificacion\(propuesta\.id\)/);
  assert.match(flujo, /consumirPropuestaClasificacion\(propuesta\.id\)/);
  assert.match(clasificacion, /propuesta\.chatId === chatId && propuesta\.messageId > 0/);
  assert.match(desambiguacion, /"messageId"/);
  assert.match(desambiguacion, /pendiente\.messageId > 0/);
});

test("borradores y ofertas limpian la reserva si no pueden confirmar su entrega", async () => {
  const [handler, herramienta, borradores, ofertas] = await Promise.all([
    fuente("core/gmail/emailCallbackHandler.ts"),
    fuente("core/tools/proposeEmail.ts"),
    fuente("core/gmail/emailDraftStore.ts"),
    fuente("core/gmail/emailReplyOfferStore.ts"),
  ]);

  const inicioBorrador = handler.indexOf("export async function generarBorradorYOfrecer");
  const finBorrador = handler.indexOf("export async function ofrecerResponderCorreo", inicioBorrador);
  const publicarBorrador = handler.slice(inicioBorrador, finBorrador);
  assert.match(publicarBorrador, /await actualizarMessageIdBorrador\(borrador\.id, telegramMessageId\)/);
  assert.match(publicarBorrador, /await obtenerBorradorCorreo\(borrador\.id\)/);
  assert.match(publicarBorrador, /await consumirBorradorCorreo\(borradorCreado\.id\)/);
  assert.match(publicarBorrador, /editTelegramMessage\([\s\S]*telegramMessageId[\s\S]*\[\]/);
  assert.doesNotMatch(publicarBorrador, /actualizarMessageIdBorrador\([^\n]+\.catch/);

  const inicioOferta = handler.indexOf("export async function ofrecerResponderCorreo");
  const finOferta = handler.indexOf("function tecladoOfertaResponder", inicioOferta);
  const publicarOferta = handler.slice(inicioOferta, finOferta);
  assert.match(publicarOferta, /await actualizarMessageIdOfertaResponder\(oferta\.id, messageIdPublicado\)/);
  assert.match(publicarOferta, /await obtenerOfertaResponderCorreo\(oferta\.id\)/);
  assert.match(publicarOferta, /await consumirOfertaResponderCorreo\(oferta\.id\)/);
  assert.match(publicarOferta, /revertirIncrementoPendientesActivo\(chatId, identidadExacta\)/);
  assert.match(publicarOferta, /if \(ofertaExistente\) return ofertaExistente\.messageId > 0/);

  assert.match(herramienta, /await actualizarMessageIdBorrador\(borrador\.id, messageId\)[\s\S]*obtenerBorradorCorreo\(borrador\.id\)/);
  assert.match(herramienta, /consumirBorradorCorreo\(borrador\.id\)/);
  assert.match(borradores, /borrador\.chatId === chatId && borrador\.messageId > 0/);
  assert.match(ofertas, /oferta\.chatId === chatId && oferta\.messageId > 0/);
});

test("las transiciones de texto persisten antes de retirar UI y restauran el consumo fallido", async () => {
  const rutasStores = [
    "core/gastos/pendienteCorreccionGastoStore.ts",
    "core/gastos/pendienteAjusteMontoGastoStore.ts",
    "core/gastos/pendienteAccionGastoStore.ts",
    "core/gastos/pendienteSeleccionGastoStore.ts",
    "core/gmail/emailDraftEditStore.ts",
  ];
  const [handler, servidor, ...stores] = await Promise.all([
    fuente("core/gmail/emailCallbackHandler.ts"),
    fuente("src/server.ts"),
    ...rutasStores.map(fuente),
  ]);

  for (const [indice, store] of stores.entries()) {
    assert.match(store, /conMutex\(MUTEX_TRANSICIONES/,
      `${rutasStores[indice]} debe serializar read→write/delete`);
    assert.match(store, /actualizarFila\(TAB_NAME/,
      `${rutasStores[indice]} debe reemplazar sin ventana delete→insert`);
    assert.match(store, /export async function restaurarPendiente/,
      `${rutasStores[indice]} debe poder restaurar un claim fallido`);
  }

  for (const nombre of [
    "restaurarPendienteCorreccionGasto",
    "restaurarPendienteAjusteMontoGasto",
    "restaurarPendienteAccionGasto",
    "restaurarPendienteSeleccionGasto",
    "restaurarPendienteEdicionBorrador",
  ]) {
    assert.match(servidor, new RegExp(`${nombre}\\(`));
  }

  const inicioEditar = handler.indexOf('if (accion === "draft_editar")');
  const finEditar = handler.indexOf("// draft_enviar", inicioEditar);
  const editar = handler.slice(inicioEditar, finEditar);
  assert.ok(
    editar.indexOf("guardarPendienteEdicionBorrador") < editar.indexOf("editTelegramMessage("),
    "draft_editar debe guardar el siguiente estado antes de quitar los botones"
  );
});
