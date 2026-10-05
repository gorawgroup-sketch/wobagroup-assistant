import assert from "node:assert/strict";
import test from "node:test";
import {
  agregarConocimiento,
  CONOCIMIENTO_INICIAL,
  formatearConocimiento,
  idConocimientoNuevo,
  leerConocimiento,
  type AlmacenConocimiento,
  type EntradaConocimiento,
} from "./conocimiento";

function almacenEnMemoria(inicial: EntradaConocimiento[] = []) {
  const filas = [...inicial];
  const almacen: AlmacenConocimiento & { filas: EntradaConocimiento[]; escrituras: number } = {
    filas,
    escrituras: 0,
    leer: async () => filas.map((f) => ({ ...f })),
    agregar: async (e) => { almacen.escrituras++; filas.push({ ...e }); },
    retirar: async (id, motivo) => {
      const i = filas.findIndex((f) => f.id === id);
      if (i < 0) return false;
      filas[i] = { ...filas[i], vigente: false, texto: `${filas[i].texto} [RETIRADO: ${motivo}]` };
      return true;
    },
  };
  return almacen;
}

test("la memoria sembrada trae las decisiones de Carlos ya documentadas, con su fuente", () => {
  const ids = CONOCIMIENTO_INICIAL.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "ids repetidos");
  for (const esperado of ["dec-aegon-fuera-de-alcance", "dec-hold-transporte-equipos", "pend-excluir-rc-multirriesgo", "regla-correos", "contacto-acodrid"]) {
    assert.ok(ids.includes(esperado), esperado);
  }
  assert.ok(CONOCIMIENTO_INICIAL.every((e) => e.fuente && /^\d{4}-\d{2}-\d{2}$/.test(e.fecha) && e.vigente));
});

test("al primer uso la memoria vacía se siembra una sola vez, aunque dos consultas lleguen a la vez", async () => {
  const almacen = almacenEnMemoria();
  const [a, b] = await Promise.all([leerConocimiento(almacen), leerConocimiento(almacen)]);
  assert.equal(a.length, CONOCIMIENTO_INICIAL.length);
  assert.equal(b.length, CONOCIMIENTO_INICIAL.length);
  assert.equal(almacen.escrituras, CONOCIMIENTO_INICIAL.length);
  await leerConocimiento(almacen);
  assert.equal(almacen.escrituras, CONOCIMIENTO_INICIAL.length, "no se vuelve a sembrar");
});

test("una memoria que ya tiene contenido NO se vuelve a sembrar", async () => {
  const almacen = almacenEnMemoria([{ id: "x", tipo: "hecho", texto: "algo", fuente: "Carlos", fecha: "2026-10-05", vigente: true }]);
  const leidas = await leerConocimiento(almacen);
  assert.equal(leidas.length, 1);
  assert.equal(almacen.escrituras, 0);
});

test("lo que Carlos cuenta se añade con id estable: repetirlo no duplica", async () => {
  const almacen = almacenEnMemoria(CONOCIMIENTO_INICIAL);
  const entrada = { tipo: "decision" as const, texto: "Retomar el seguro de transporte cuando Boris dé fecha de lanzamiento.", fuente: "Carlos, 12/10/2026", fecha: "2026-10-12" };
  const primera = await agregarConocimiento(entrada, almacen);
  const segunda = await agregarConocimiento(entrada, almacen);
  assert.equal(primera.id, segunda.id);
  assert.equal(almacen.filas.filter((f) => f.id === primera.id).length, 1);
  assert.equal(idConocimientoNuevo("decision", entrada.texto, "2026-10-12"), primera.id);
});

test("el dossier agrupa lo vigente por tipo y deja fuera lo retirado", () => {
  const texto = formatearConocimiento([
    { id: "a", tipo: "decision", texto: "Decisión A", fuente: "Carlos", fecha: "2026-10-01", vigente: true },
    { id: "b", tipo: "decision", texto: "Decisión B retirada", fuente: "Carlos", fecha: "2026-10-01", vigente: false },
    { id: "c", tipo: "pendiente_carlos", texto: "Responder a Acodrid", fuente: "correo", fecha: "2026-10-02", vigente: true },
  ]);
  assert.match(texto, /Decisiones de Carlos:\n- \[a\] Decisión A \(Carlos\)/);
  assert.match(texto, /Esperando respuesta o acción de Carlos:\n- \[c\]/);
  assert.doesNotMatch(texto, /Decisión B/);
});
