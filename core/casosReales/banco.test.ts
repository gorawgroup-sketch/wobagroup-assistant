import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ejecutarCasoBusquedaCargo, ejecutarCasoMonedasCuentas, type CasoReal } from "./banco";

const directorio = join(__dirname, "casos");
const casos: Array<{ fichero: string; caso: CasoReal }> = readdirSync(directorio)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((fichero) => ({ fichero, caso: JSON.parse(readFileSync(join(directorio, fichero), "utf8")) as CasoReal }));

test("el banco de casos reales no está vacío y cada caso declara su fuente", () => {
  assert.ok(casos.length >= 8, `hay ${casos.length} casos`);
  for (const { fichero, caso } of casos) {
    assert.ok(caso.fuente && caso.descripcion && caso.id, `${fichero}: faltan id, descripcion o fuente`);
  }
  assert.equal(new Set(casos.map((c) => c.caso.id)).size, casos.length, "los ids de los casos deben ser únicos");
});

for (const { fichero, caso } of casos) {
  test(`caso real — ${caso.id}: ${caso.descripcion}`, async () => {
    if (caso.tipo === "busqueda_cargo") {
      const r = await ejecutarCasoBusquedaCargo(caso);
      assert.deepEqual(r.candidatos, caso.esperado.candidatos, `${fichero}: candidatos ofrecidos`);
      assert.deepEqual(r.vistoPorConciliacionAutomatica, caso.esperado.vistoPorConciliacionAutomatica, `${fichero}: lo que ve la conciliación automática`);
      for (const boton of caso.esperado.botonesIncluyen ?? []) {
        assert.ok(r.botones.some((t) => t.includes(boton)), `${fichero}: falta el botón «${boton}»; hay ${JSON.stringify(r.botones)}`);
      }
      for (const fragmento of caso.esperado.trazaContiene ?? []) {
        assert.ok(r.traza.includes(fragmento), `${fichero}: la explicación debe contener «${fragmento}»; dice: ${r.traza}`);
      }
      for (const boton of caso.esperado.botonesExcluyen ?? []) {
        assert.ok(!r.botones.some((t) => t.includes(boton)), `${fichero}: no debe haber el botón «${boton}»; hay ${JSON.stringify(r.botones)}`);
      }
    } else {
      const r = await ejecutarCasoMonedasCuentas(caso);
      assert.deepEqual(r, caso.lecturas.map((l) => l.esperado), `${fichero}: monedas de cuenta`);
    }
  });
}
