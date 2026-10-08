import assert from "node:assert/strict";
import test from "node:test";
import { retomarPendientesMonedaSinPreguntar, type DependenciasRetoma } from "./retomarPendientesMoneda";
import type { GastoPendienteDatos } from "./gastoPendienteDatosStore";

const pendiente = (id: string, motivo: GastoPendienteDatos["motivo"]): GastoPendienteDatos => ({
  id, chatId: 1, rutaLocal: `/tmp/${id}.jpg`, nombreArchivoOriginal: `${id}.jpg`, creadoEn: 0, motivo,
  datos: { proveedor: "Cnidos y Rifados", monto: 180, moneda: "MXN" } as never,
});

function deps(lista: GastoPendienteDatos[], procesar: DependenciasRetoma["procesar"], actividad = false) {
  const restaurados: string[] = [];
  const consumidos: string[] = [];
  const d: DependenciasRetoma = {
    listar: async () => lista,
    consumir: async (_chat, id) => { consumidos.push(id); return lista.find((p) => p.id === id); },
    restaurar: async (p) => { restaurados.push(p.id); },
    procesar,
    hayActividadReciente: () => actividad,
  };
  return { d, restaurados, consumidos };
}

test("solo retoma los pendientes de moneda y lo hace en modo silencioso", async () => {
  const procesados: boolean[] = [];
  const { d, consumidos } = deps([pendiente("a", "moneda"), pendiente("b", "empresa")], async () => { procesados.push(true); return "pendiente_datos"; });
  const r = await retomarPendientesMonedaSinPreguntar(1, d);
  assert.deepEqual(consumidos, ["a"]);
  assert.deepEqual(r, { intentados: 1, resueltos: 0, siguenPendientes: 1, errores: 0 });
  assert.equal(procesados.length, 1);
});

test("si el cargo ya aparece, el pendiente queda resuelto (la propuesta la manda procesarGastoEntrante)", async () => {
  const { d } = deps([pendiente("a", "moneda")], async () => "propuesta_enviada" as never);
  const r = await retomarPendientesMonedaSinPreguntar(1, d);
  assert.equal(r.resueltos, 1);
});

test("un error al retomar restaura el pendiente y no se pierde", async () => {
  const { d, restaurados } = deps([pendiente("a", "moneda")], async () => { throw new Error("Holded 502"); });
  const r = await retomarPendientesMonedaSinPreguntar(1, d);
  assert.equal(r.errores, 1);
  assert.deepEqual(restaurados, ["a"]);
});

test("no compite con una respuesta del usuario en curso", async () => {
  const { d, consumidos } = deps([pendiente("a", "moneda")], async () => "pendiente_datos", true);
  const r = await retomarPendientesMonedaSinPreguntar(1, d);
  assert.equal(r.intentados, 0);
  assert.deepEqual(consumidos, []);
});
