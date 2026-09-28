import test from "node:test";
import assert from "node:assert/strict";
import { construirTecladoGasto, movimientoRecomendadoPropuesta, opcionesTecladoDesdePropuesta } from "./gastoTeclado";
import type { PropuestaGasto } from "./gastoProposalSheet";

function propuestaBase(): PropuestaGasto {
  return {
    id: "propuesta",
    empresa: "Footprint",
    proveedor: "ESSO Minderhout",
    monto: 87.9,
    moneda: "EUR",
    fecha: "2026-08-30",
    concepto: "Gasolina",
    rutaLocal: "/tmp/esso.pdf",
    nombreArchivoOriginal: "esso.pdf",
    candidatos: [],
    lineas: [],
    chatId: 1,
    messageId: 2,
    creadoEn: 3,
  };
}

test("un único movimiento recomendado conserva Crear y conciliar sin presentarlo como ambiguo", () => {
  const propuesta: PropuestaGasto = {
    ...propuestaBase(),
    hayMovimientoBancario: true,
    movimientosAmbiguos: [{
      accountId: "cuenta",
      movementId: "movimiento-esso",
      descripcion: "Esso Minderhout",
      monto: -88.69,
      moneda: "EUR",
      fecha: "2026-08-30",
      origenCoincidencia: "aproximada",
    }],
  };

  assert.equal(movimientoRecomendadoPropuesta(propuesta)?.movementId, "movimiento-esso");
  const opciones = opcionesTecladoDesdePropuesta(propuesta);
  assert.equal(opciones.hayMovimientoBancario, true);
  assert.equal(opciones.numMovimientosAmbiguos, undefined);
  const textos = construirTecladoGasto(propuesta, opciones).flat().map((b) => b.text);
  assert.ok(textos.some((t) => t.includes("Crear y conciliar")));
  assert.equal(textos.some((t) => t.includes("Conciliar con #1")), false);
});

test("varios movimientos siguen exigiendo elegir uno explícitamente", () => {
  const base = propuestaBase();
  const propuesta: PropuestaGasto = {
    ...base,
    hayMovimientoBancario: false,
    movimientosAmbiguos: [1, 2].map((n) => ({
      accountId: "cuenta",
      movementId: `movimiento-${n}`,
      descripcion: `Esso combustible ${n}`,
      monto: -87.9,
      moneda: "EUR",
      fecha: "2026-08-30",
    })),
  };
  const opciones = opcionesTecladoDesdePropuesta(propuesta);
  assert.equal(opciones.numMovimientosAmbiguos, 2);
  const textos = construirTecladoGasto(propuesta, opciones).flat().map((b) => b.text);
  assert.ok(textos.some((t) => t.includes("Conciliar con #1")));
  assert.ok(textos.some((t) => t.includes("Conciliar con #2")));
});

test('no ofrece crear sin cargo compatible ni con restaurante para un taxi',()=>{
 for(const descripcion of ['', 'Osteria Del Lovo']){
  const p={...propuestaBase(),proveedor:'Bolt',concepto:'Taxi',hayMovimientoBancario:true,
   movimientosAmbiguos:descripcion?[{accountId:'a',movementId:'m',descripcion,monto:-15,moneda:'EUR',fecha:'2026-09-10'}]:[]};
  const botones=construirTecladoGasto(p,opcionesTecladoDesdePropuesta(p)).flat();
  assert.equal(botones.some(b=>/gasto_toggle:propuesta:(crear|nuevo)/.test(b.callback_data??'')),false);
 }
});

test("permite saltar un gasto de la cola sin convertirlo en una decisión financiera", () => {
  const propuesta: PropuestaGasto = {
    ...propuestaBase(),
    deColaCorreo: true,
    correoOrigen: {
      threadId: "thread-mera",
      mensajeIdGmail: "message-mera",
      messageIdHeader: "<message-mera@example.com>",
      asunto: "MERA EL DORADO",
      de: "facturas@example.com",
    },
  };

  const botones = construirTecladoGasto(propuesta, opcionesTecladoDesdePropuesta(propuesta)).flat();
  const posponer = botones.find((boton) => boton.callback_data === "gasto_posponer:propuesta");

  assert.equal(posponer?.text, "⏭️ Saltar por ahora y seguir con los correos");
  assert.equal(posponer?.callback_data?.startsWith("gasto_toggle:"), false);
});

test("no permite saltar propuestas ajenas a la cola ni correos sin identidad exacta", () => {
  const casos: PropuestaGasto[] = [
    {
      ...propuestaBase(),
      correoOrigen: {
        threadId: "thread",
        mensajeIdGmail: "message",
        messageIdHeader: "<message@example.com>",
        asunto: "Correo fuera de la cola",
        de: "proveedor@example.com",
      },
    },
    {
      ...propuestaBase(),
      deColaCorreo: true,
      correoOrigen: {
        threadId: "thread",
        messageIdHeader: "<message@example.com>",
        asunto: "Correo incompleto",
        de: "proveedor@example.com",
      },
    },
  ];

  for (const propuesta of casos) {
    const botones = construirTecladoGasto(propuesta, opcionesTecladoDesdePropuesta(propuesta)).flat();
    assert.equal(botones.some((boton) => boton.callback_data === "gasto_posponer:propuesta"), false);
  }
});
