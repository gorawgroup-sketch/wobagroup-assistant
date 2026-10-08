import assert from "node:assert/strict";
import test from "node:test";
import { registrarActividad, type DepsRegistro } from "./registrar";
import type { EntradaBitacora, EntradaNueva } from "./tipos";

const nueva: EntradaNueva = { tarea: "pagos", origen: "programada", resultado: "sin_novedades", resumen: "Calendario revisado", detalle: {} };

function depsFalsas(comportamiento: Partial<DepsRegistro> = {}) {
  const log = { guardadas: [] as EntradaBitacora[], podas: 0, invalidaciones: 0 };
  const deps: DepsRegistro = {
    agregar: async (e) => { log.guardadas.push(e); },
    podar: async () => { log.podas++; return 2; },
    ahora: () => new Date("2026-10-09T06:55:03.000Z"),
    nuevoId: () => "id-fijo",
    invalidar: () => { log.invalidaciones++; },
    ...comportamiento,
  };
  return { deps, log };
}

const silenciar = async <T>(trabajo: () => Promise<T>): Promise<T> => {
  const original = [console.error, console.log];
  console.error = () => {}; console.log = () => {};
  try { return await trabajo(); } finally { [console.error, console.log] = original; }
};

test("registrar pone el id y el instante, avisa a Cerebro y devuelve que se guardó", async () => {
  const { deps, log } = depsFalsas();
  assert.equal(await registrarActividad(nueva, {}, deps), true);
  assert.deepEqual(log.guardadas, [{ ...nueva, id: "id-fijo", cuando: "2026-10-09T06:55:03.000Z" }]);
  assert.equal(log.invalidaciones, 1);
  assert.equal(log.podas, 0, "sin pedirlo no se poda");
});

test("solo poda cuando se pide y la constancia se guardó", async () => {
  const pedida = depsFalsas();
  await registrarActividad(nueva, { podar: true }, pedida.deps);
  assert.equal(pedida.log.podas, 1);

  const fallida = depsFalsas({ agregar: async () => { throw new Error("Sheets agotado"); } });
  assert.equal(await silenciar(() => registrarActividad(nueva, { podar: true }, fallida.deps)), false);
  assert.equal(fallida.log.podas, 0, "si no se guardó nada no hay motivo para podar");
});

test("la bitácora cuenta el trabajo, no lo condiciona: nada de lo que falle dentro puede propagarse a la tarea", async () => {
  const { deps } = depsFalsas({
    agregar: async () => { throw new Error("Quota exceeded"); },
    invalidar: () => { throw new Error("la caché explotó"); },
    podar: async () => { throw new Error("no se pudo borrar"); },
  });
  assert.equal(await silenciar(() => registrarActividad(nueva, { podar: true }, deps)), false);
  const soloPoda = depsFalsas({ podar: async () => { throw new Error("no se pudo borrar"); } });
  assert.equal(await silenciar(() => registrarActividad(nueva, { podar: true }, soloPoda.deps)), true, "la constancia sí se guardó");
});
