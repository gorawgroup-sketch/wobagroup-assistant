import assert from "node:assert/strict";
import test from "node:test";
import {
  buscarFragmentosRelevantes,
  obtenerModoRetrieval,
  puntuarTextoConocimiento,
} from "./loader";

test("recupera la cuenta 623 desde un fragmento del PGC sin enviar el documento completo", () => {
  const maxCaracteres = 14_000;
  const fragmentos = buscarFragmentosRelevantes(
    "cuenta 623 servicios profesionales independientes",
    { incluirPGC: true, maxCaracteres, maxFragmentos: 5 }
  );

  assert.ok(fragmentos.length > 0);
  assert.ok(
    fragmentos.some((fragmento) =>
      fragmento.contenido.includes("623. Servicios de profesionales independientes")
    )
  );
  assert.ok(fragmentos.some((fragmento) => fragmento.nombre === "PGC_4_cuadro_y_definiciones_de_cuentas.md"));
  assert.ok(fragmentos.reduce((total, fragmento) => total + fragmento.contenido.length, 0) <= maxCaracteres);
  assert.ok(fragmentos.every((fragmento) => fragmento.contenido.length <= 6_000));
});

test("el ámbito documental puede excluir por completo el PGC", () => {
  const fragmentos = buscarFragmentosRelevantes("responsabilidades de Footprint", {
    incluirPGC: false,
    maxCaracteres: 10_000,
  });

  assert.ok(fragmentos.length > 0);
  assert.ok(fragmentos.some((fragmento) => fragmento.nombre === "responsabilidades.md"));
  assert.ok(fragmentos.every((fragmento) => !fragmento.nombre.startsWith("PGC_")));
});

test("el puntaje prioriza una corrección que comparte proveedor y categoría", () => {
  const consulta = "Business Atelier servicios profesionales independientes";
  const relevante = puntuarTextoConocimiento(
    "Business Atelier se clasifica en Servicios de profesionales independientes",
    consulta
  );
  const irrelevante = puntuarTextoConocimiento("Adobe se paga con tarjeta el día 4", consulta);
  assert.ok(relevante > irrelevante);
});

test("el diagnóstico publica el modo fragmentado y su presupuesto", () => {
  const modo = obtenerModoRetrieval();
  assert.equal(modo.modo, "scoring_fragmentos");
  assert.ok(modo.fragmentos > modo.documentos);
  assert.equal(modo.maxCaracteresPorConsulta, 14_000);
});
