import assert from "node:assert/strict";
import test from "node:test";
import { configFixture } from "../fixtures";
import { resumenAutomatico } from "../service";
import { ejecutarCaso } from "./arnes";
import { CASOS } from "./banco";

/** Banco de casos reales de extremo a extremo (sin IA): el informe que ve Carlos debe decir la causa real de cada caso. */
for (const caso of CASOS) {
  test(`caso real — ${caso.nombre}`, async () => {
    const { service } = ejecutarCaso(caso);
    const resultado = await service.revisar(configFixture);
    const informe = resumenAutomatico(resultado);
    for (const re of caso.espera) assert.match(informe, re, `[${caso.nombre}] ${caso.origen}\nInforme:\n${informe}`);
    for (const re of caso.noEspera) assert.doesNotMatch(informe, re, `[${caso.nombre}] no debía aparecer ${re}\nInforme:\n${informe}`);
  });
}
