import assert from "node:assert/strict";
import test from "node:test";
import { seleccionarPropuestaGastoParaRecordatorio, type PropuestaGasto } from "./gastoProposalSheet";

// Caso real (Carlos, Droguería Pura / Simon Talloen, Footprint, 2026-10-01): una propuesta de gasto
// falló con CuentaContableNoInferidaError y quedó repuesta con sus botones, pero el modelo no tenía
// ninguna forma de reconocerla como "atascada" cuando Carlos escribió "reprocesa el correo de X" en
// el chat. Ver PendientesSensibles.gastoPropuesta en core/claude/client.ts y
// PropuestaGasto.motivoReintento.
test("seleccionarPropuestaGastoParaRecordatorio: elige la más reciente con evidencia de reintento, nunca una pendiente normal", () => {
  const crear = (
    id: string,
    creadoEn: number,
    opciones: { messageId?: number; motivoReintento?: string } = {}
  ): PropuestaGasto => ({
    id,
    empresa: "Footprint",
    proveedor: "Proveedor",
    monto: 10,
    moneda: "EUR",
    fecha: "2026-09-20",
    concepto: "Gasto",
    rutaLocal: "/tmp/recibo.pdf",
    nombreArchivoOriginal: "recibo.pdf",
    candidatos: [],
    lineas: [],
    chatId: 1,
    messageId: opciones.messageId ?? 100,
    creadoEn,
    motivoReintento: opciones.motivoReintento,
  });

  assert.equal(seleccionarPropuestaGastoParaRecordatorio([]), undefined);

  const normalPendiente = crear("normal", 10);
  assert.equal(
    seleccionarPropuestaGastoParaRecordatorio([normalPendiente]),
    undefined,
    "una propuesta pendiente normal (sin motivoReintento) es el estado más común del día a día — nunca se avisa, o cada turno forzaría saltar a Sonnet"
  );

  const atascada = crear("atascada", 20, { motivoReintento: "No pude inferir una cuenta contable segura" });
  assert.equal(seleccionarPropuestaGastoParaRecordatorio([normalPendiente, atascada])?.id, "atascada");

  const atascadaVieja = crear("atascada-vieja", 10, { motivoReintento: "Error viejo" });
  const atascadaNueva = crear("atascada-nueva", 30, { motivoReintento: "Error nuevo" });
  assert.equal(
    seleccionarPropuestaGastoParaRecordatorio([atascadaVieja, atascadaNueva])?.id,
    "atascada-nueva",
    "entre varias atascadas, gana la más reciente por creadoEn"
  );

  const nuncaMostrada = crear("sin-mostrar", 40, { messageId: 0, motivoReintento: "Error" });
  assert.equal(
    seleccionarPropuestaGastoParaRecordatorio([nuncaMostrada]),
    undefined,
    "messageId=0 significa que nunca llegó a mostrarse con botones — nada que recordarle al usuario todavía"
  );
});
