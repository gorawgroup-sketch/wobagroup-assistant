import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { areasTocadas, colisiones } from "./colision-de-area.mjs";

const { areas } = JSON.parse(readFileSync(new URL("../../.github/areas-criticas.json", import.meta.url), "utf8"));

test("detecta el área por prefijo de carpeta o por archivo exacto", () => {
  assert.deepEqual([...areasTocadas(["core/gmail/automatico/service.ts", "docs/x.md"], areas)], ["correo-automatico"]);
  assert.deepEqual([...areasTocadas(["core/gastos/procesarGastoEntrante.ts"], areas)], ["gastos-entrantes"]);
  assert.deepEqual([...areasTocadas(["core/gastos/otroArchivo.ts"], areas)], []);
});

test("solo choca con PR abiertos más antiguos que tocan la misma área; los borradores no cuentan", () => {
  const actual = { numero: 410, archivos: ["core/gmail/automatico/service.ts"] };
  const abiertos = [
    { numero: 401, titulo: "antiguo misma área", borrador: false, archivos: ["core/gmail/automatico/analyze.ts"] },
    { numero: 405, titulo: "otra área", borrador: false, archivos: ["core/seguros/agente/agente.ts"] },
    { numero: 412, titulo: "más nuevo", borrador: false, archivos: ["core/gmail/automatico/model.ts"] },
    { numero: 399, titulo: "borrador", borrador: true, archivos: ["core/gmail/automatico/model.ts"] },
  ];
  assert.deepEqual(colisiones(actual, abiertos, areas), [{ numero: 401, titulo: "antiguo misma área", areas: ["correo-automatico"] }]);
});

test("un PR que no toca áreas críticas nunca choca", () => {
  assert.deepEqual(colisiones({ numero: 500, archivos: ["docs/a.md"] }, [{ numero: 1, titulo: "x", borrador: false, archivos: ["core/gmail/automatico/service.ts"] }], areas), []);
});
