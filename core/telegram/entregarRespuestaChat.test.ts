import assert from "node:assert/strict";
import test from "node:test";
import { configurarEntregaRespuestaChatParaPruebas, entregarRespuestaChat } from "./entregarRespuestaChat";
import { MARCA_MENSAJE_SISTEMA } from "../claude/respuestaImitaSistema";

const CHAT = 8731933107;
const IMITACION = "🔄 Revisando el siguiente correo...\n\n📄 *Ticket/recibo detectado* — no encontré…\n\nPropuesta para crear un gasto nuevo:\nEmpresa: Footprint\nProveedor: Board Riders Inc\nImporte: 11.15 USD";

function escenario(parciales: { activo?: { id: string; mensajeId: string; asunto: string; de: string }; reenviada?: boolean; enCola?: number } = {}) {
  const entregados: string[] = []; const botones: string[] = []; const reenvios: string[] = [];
  const restaurar = configurarEntregaRespuestaChatParaPruebas({
    entregar: async (_c, _m, texto) => { entregados.push(texto); },
    enviarConBotones: async (_c, texto, filas) => { botones.push(`${texto} → ${filas[0][0].callback_data}`); return 1; },
    avisosRecientes: async () => [],
    obtenerActivoActual: (async () => parciales.activo) as never,
    contarPendientesTotal: async () => parciales.enCola ?? 0,
    reenviarPreguntaPendienteDelCorreo: async (_c, mensajeId) => {
      reenvios.push(mensajeId);
      return parciales.reenviada ? { tipo: "conciliacion" as const, descripcion: "Airalo — 12.5 USD" } : undefined;
    },
  });
  return { entregados, botones, reenvios, restaurar };
}

test("una respuesta normal se entrega tal cual", async () => {
  const e = escenario();
  await entregarRespuestaChat(CHAT, 7, "Listo, el saldo de la cuenta es 1.234,56 €.");
  assert.deepEqual(e.entregados, ["Listo, el saldo de la cuenta es 1.234,56 €."]);
  e.restaurar();
});

test("caso real: la imitación no se entrega; con un correo activo se reenvía su pregunta real con botones", async () => {
  const e = escenario({ activo: { id: "hilo", mensajeId: "msg", asunto: "$ 12,50 - Airalo - Revolut", de: "Juan" }, reenviada: true });
  await entregarRespuestaChat(CHAT, 7, IMITACION);
  assert.deepEqual(e.reenvios, ["msg"]);
  assert.equal(e.entregados.length, 1);
  assert.match(e.entregados[0], /Airalo — 12\.5 USD/);
  assert.doesNotMatch(e.entregados[0], /Board Riders|Propuesta para crear/);
  e.restaurar();
});

test("sin correo activo y con cola: se ofrece el botón real para procesar el siguiente", async () => {
  const e = escenario({ enCola: 4 });
  await entregarRespuestaChat(CHAT, 7, IMITACION);
  assert.match(e.entregados[0], /Quedan 4 correo/);
  assert.deepEqual(e.botones, ["¿Proceso el siguiente correo de la cola? → colacorreo_siguiente"]);
  e.restaurar();
});

test("sin nada pendiente se dice la verdad, y un activo sin pregunta viva remite a /revisarcorreo", async () => {
  const vacio = escenario();
  await entregarRespuestaChat(CHAT, 7, IMITACION);
  assert.match(vacio.entregados[0], /cola de correo está vacía/);
  vacio.restaurar();
  const sinPregunta = escenario({ activo: { id: "h", mensajeId: "m", asunto: "Televic", de: "X" }, reenviada: false });
  await entregarRespuestaChat(CHAT, 7, IMITACION);
  assert.match(sinPregunta.entregados[0], /no encuentro una pregunta viva/);
  sinPregunta.restaurar();
});

test("si el modelo copia la marca interna al empezar su respuesta, el usuario nunca la ve", async () => {
  const e = escenario();
  await entregarRespuestaChat(CHAT, 7, `${MARCA_MENSAJE_SISTEMA}\nEl saldo es correcto.`);
  assert.deepEqual(e.entregados, ["El saldo es correcto."]);
  e.restaurar();
});
