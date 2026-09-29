import assert from "node:assert/strict";
import test from "node:test";
import { MARCA_MENSAJE_SISTEMA, quitarMarcaSistema, respuestaImitaMensajeSistema } from "./respuestaImitaSistema";

// Texto real (abreviado) del mensaje de las 20:13 del 28/09: progreso + título recortado + propuesta.
const PROPUESTA = [
  "📄 *Ticket/recibo detectado* — no encontré ningún gasto ya registrado en Holded que corresponda.", "",
  "Propuesta para crear un gasto nuevo:", "Empresa: Footprint", "Proveedor: Board Riders Inc", "Importe: 11.15 USD",
  "Fecha: 2026-09-27", "Concepto: Compra tienda deportiva Board Riders Inc — Puerto Rico — Juan Camilo Salazar",
].join("\n");
const IMITACION_REAL = `🔄 Revisando el siguiente correo...\n\n📄 *Ticket/recibo detectado* — no encontré ningún gasto ya registrado…\n\n${PROPUESTA}`;

test("el mensaje real del incidente se reconoce como imitación", () => {
  assert.deepEqual(respuestaImitaMensajeSistema(IMITACION_REAL), { imita: true, motivo: "progreso" });
  assert.deepEqual(respuestaImitaMensajeSistema(PROPUESTA), { imita: true, motivo: "propuesta_de_gasto" });
});

test("una respuesta normal, aunque hable de propuestas, no es imitación", () => {
  for (const normal of [
    "La propuesta de Board Riders decía «Ticket/recibo detectado» y quedó pendiente; ¿quieres que la reenvíe?",
    "No hay ninguna propuesta de gasto pendiente en este chat.",
    "Revisando el correo de ayer encontré tres facturas de Cratevo.",
    "Empresa: Footprint es la que tiene el cargo; el importe fue de 11,15 USD.",
  ]) assert.equal(respuestaImitaMensajeSistema(normal).imita, false, normal);
});

test("una copia literal de un aviso automático reciente se detecta aunque cambie el encabezado", () => {
  const aviso = `${MARCA_MENSAJE_SISTEMA}\n⚠️ La compra ya tiene pagos. Su conciliación requiere revisión; no se ofrecerán otros cargos ni se añadirán pagos. Verificar solo relee el resultado anterior. Si quieres continuar con otros correos deja el saldo pendiente y sigue con la cola de revisión.`;
  const copia = "Claro, aquí lo tienes:\n⚠️ La compra ya tiene pagos. Su conciliación requiere revisión; no se ofrecerán otros cargos ni se añadirán pagos. Verificar solo relee el resultado anterior. Si quieres continuar con otros correos deja el saldo pendiente y sigue con la cola de revisión.";
  assert.deepEqual(respuestaImitaMensajeSistema(copia, [aviso]), { imita: true, motivo: "copia_literal" });
  assert.equal(respuestaImitaMensajeSistema("La compra ya tiene pagos, así que no hay nada que conciliar.", [aviso]).imita, false);
});

test("la marca de sistema se quita para mostrar el historial y no afecta a textos sin marca", () => {
  assert.equal(quitarMarcaSistema(`${MARCA_MENSAJE_SISTEMA}\nHola`), "Hola");
  assert.equal(quitarMarcaSistema("Hola"), "Hola");
});
