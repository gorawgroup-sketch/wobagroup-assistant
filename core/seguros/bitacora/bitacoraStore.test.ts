import assert from "node:assert/strict";
import test from "node:test";
import { acotarDetalle, entradaAFila, filaAEntrada, filasAPodar } from "./bitacoraStore";
import { entrada } from "./pruebas";
import { MAX_AVISOS, MAX_EVENTOS, MAX_NOTAS, MAX_TEXTO_AVISO } from "./tipos";

const aFila = (e: ReturnType<typeof entrada>, rowIndex = 5) => ({ rowIndex, valores: entradaAFila(e) });

test("una entrada se escribe y se lee de vuelta sin pérdida (avisos con saltos de línea, eventos, cifras y notas)", () => {
  const original = entrada({
    tarea: "pagos", resultado: "con_novedades", resumen: "Calendario revisado: 6 pagos previstos",
    detalle: {
      avisos: [{ canal: "telegram", titulo: "🛡️ Seguros — pagos", texto: "línea 1\nlínea 2", entregado: true }],
      eventos: [{ accion: "creado", titulo: "🛡️ Seguro: Allianz — 955,00 €", inicio: "2027-02-26T08:00:00.000Z" }],
      cifras: { previstos: 6, eventosCreados: 1 },
      notas: ["una advertencia"],
    },
  });
  assert.deepEqual(filaAEntrada(aFila(original, 9)), { ...original, rowIndex: 9 });
});

test("una fila a medias o editada a mano no rompe la lectura: se ignora", () => {
  const buena = aFila(entrada());
  assert.ok(filaAEntrada(buena));
  for (const [i, valor] of [[0, ""], [1, "ayer"], [2, "inventada"], [3, "nadie"], [4, "quizá"]] as const) {
    const valores = [...buena.valores]; valores[i] = valor;
    assert.equal(filaAEntrada({ rowIndex: 2, valores }), null, `columna ${i} = «${valor}»`);
  }
});

test("un detalle ilegible deja la entrada sin detalle (no tumba la lectura de las demás)", () => {
  const original = console.error;
  console.error = () => {};
  try {
    const valores = [...aFila(entrada()).valores]; valores[6] = "{esto no es json";
    const leida = filaAEntrada({ rowIndex: 3, valores });
    assert.ok(leida);
    assert.deepEqual(leida.detalle, {});
    for (const crudo of ["", "[1,2]", "7"]) {
      const v = [...valores]; v[6] = crudo;
      assert.deepEqual(filaAEntrada({ rowIndex: 3, valores: v })?.detalle, {}, `«${crudo}»`);
    }
  } finally { console.error = original; }
});

test("el detalle se acota: pocos avisos, texto limitado, cifras finitas y notas cortas", () => {
  const detalle = acotarDetalle({
    avisos: Array.from({ length: 10 }, (_, i) => ({ canal: "telegram" as const, titulo: `aviso ${i}`, texto: "x".repeat(5000), entregado: true })),
    eventos: Array.from({ length: 50 }, (_, i) => ({ accion: "creado" as const, titulo: `ev ${i}`, inicio: "2027-01-01T08:00:00.000Z" })),
    cifras: { buena: 3, mala: Number.NaN, infinita: Number.POSITIVE_INFINITY },
    notas: Array.from({ length: 30 }, () => "n".repeat(1000)),
  });
  assert.equal(detalle.avisos?.length, MAX_AVISOS);
  assert.ok(detalle.avisos?.every((a) => a.texto.length === MAX_TEXTO_AVISO));
  assert.equal(detalle.eventos?.length, MAX_EVENTOS);
  assert.deepEqual(detalle.cifras, { buena: 3 });
  assert.equal(detalle.notas?.length, MAX_NOTAS);
  assert.ok(detalle.notas?.every((n) => n.length <= 240));
});

test("el resumen se recorta y un detalle que aun así no cabe en una celda se sustituye por un aviso (la fila nunca se rechaza)", () => {
  const largo = entradaAFila(entrada({ resumen: "r".repeat(2000) }));
  assert.ok(largo[5].length <= 400);
  const cifras = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`cifra_numero_${i}`, i]));
  const desbordado = entradaAFila(entrada({ detalle: { cifras } }));
  assert.ok(desbordado[6].length < 200);
  assert.match(desbordado[6], /Detalle demasiado largo/);
});

test("la poda quita las más antiguas solo cuando se pasa del máximo y deja las más recientes", () => {
  const fila = (rowIndex: number, dia: number) => ({ rowIndex, cuando: `2026-09-${String(dia).padStart(2, "0")}T08:00:00.000Z` });
  const justas = [fila(2, 1), fila(3, 2), fila(4, 3), fila(5, 4), fila(6, 5)];
  assert.deepEqual(filasAPodar(justas, 5, 3), [], "en el máximo no se poda");
  // Desordenadas a propósito: la antigüedad se decide por la fecha, no por la posición en la hoja.
  const pasadas = [fila(7, 6), fila(2, 1), fila(5, 4), fila(3, 2), fila(6, 5), fila(4, 3)];
  assert.deepEqual(filasAPodar(pasadas, 5, 3).sort((a, b) => a - b), [2, 3, 4], "se conservan las 3 más recientes (días 4, 5 y 6)");
});
