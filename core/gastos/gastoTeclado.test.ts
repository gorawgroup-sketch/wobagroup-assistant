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

test('sin cargo compatible NO se ofrece conciliar, pero SÍ crear sin conciliar (restaurado 2026-09-28)',()=>{
 for(const descripcion of ['', 'Osteria Del Lovo']){
  const p={...propuestaBase(),proveedor:'Bolt',concepto:'Taxi',hayMovimientoBancario:true,
   movimientosAmbiguos:descripcion?[{accountId:'a',movementId:'m',descripcion,monto:-15,moneda:'EUR',fecha:'2026-09-10'}]:[]};
  const botones=construirTecladoGasto(p,opcionesTecladoDesdePropuesta(p)).flat();
  const claves=botones.map(b=>b.callback_data?.split(':')[2]);
  assert.equal(claves.some(k=>k==='crearconciliar'||k?.startsWith('crearconciliar_')),false,'nunca conciliar contra un cargo que no encaja');
  assert.equal(claves.includes('crear'),true,'crear sin conciliar sigue disponible');
 }
});

test('sin fecha documental válida no se ofrece crear (recibos sin fecha siguen bloqueados)',()=>{
 const p={...propuestaBase(),fecha:'',movimientosAmbiguos:[]};
 const claves=construirTecladoGasto(p,opcionesTecladoDesdePropuesta(p)).flat().map(b=>b.callback_data?.split(':')[2]);
 assert.equal(claves.some(k=>k==='crear'||k==='nuevo'||k?.startsWith('crearconciliar')),false);
});

test('un cargo por_confirmar (importe y fecha exactos, nombre distinto) sí habilita Crear y conciliar; sin él solo queda crear sin conciliar', () => {
  const base = { ...propuestaBase(), proveedor: 'Mi Cafetería', concepto: 'Café', hayMovimientoBancario: true };
  const cargo = { accountId: 'a', movementId: 'm', descripcion: 'SQ *XYZ 88', monto: -3.91, moneda: 'USD', fecha: '2026-08-30', origenCoincidencia: 'exacta' as const };
  const conMarca = { ...base, movimientosAmbiguos: [{ ...cargo, compatibilidad: 'por_confirmar' as const }] };
  const textosConMarca = construirTecladoGasto(conMarca, opcionesTecladoDesdePropuesta(conMarca)).flat().map((b) => b.text);
  assert.ok(textosConMarca.some((t) => t.includes('Crear y conciliar')), 'el cargo por confirmar habilita crear y conciliar');
  const sinMarca = { ...base, movimientosAmbiguos: [cargo] };
  const textosSinMarca = construirTecladoGasto(sinMarca, opcionesTecladoDesdePropuesta(sinMarca)).flat().map((b) => b.text);
  assert.equal(textosSinMarca.some((t) => t.includes('Crear y conciliar')), false, 'un nombre irreconocible sin evidencia no habilita conciliar');
  assert.ok(textosSinMarca.some((t) => t.includes('Crear')), 'pero crear sin conciliar sigue disponible');
});

test('con gastos parecidos ya registrados hay salida para descartar: «Crear gasto nuevo» y «Cancelar»', () => {
  const p = { ...propuestaBase(), candidatos: [{ id: "c1", contactName: "X", fecha: "2026-08-30", total: 87.9, descripcion: "d", documentNumber: "1", moneda: "EUR" }], movimientosAmbiguos: [] } as unknown as PropuestaGasto;
  const claves = construirTecladoGasto(p, opcionesTecladoDesdePropuesta(p)).flat().map((b) => b.callback_data?.split(":")[2]);
  assert.ok(claves.includes("adjuntar_0"));
  assert.ok(claves.includes("nuevo"), "«Crear gasto nuevo» (ya no depende de que exista un cargo)");
  assert.ok(claves.includes("cancelar"), "«Cancelar» faltaba con candidatos de Holded");
});
