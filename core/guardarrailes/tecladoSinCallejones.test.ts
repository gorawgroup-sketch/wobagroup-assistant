import assert from "node:assert/strict";
import test from "node:test";
import { construirTecladoGasto, opcionesTecladoDesdePropuesta } from "../gastos/gastoTeclado";
import type { PropuestaGasto } from "../gastos/gastoProposalSheet";
import { candidatoUtilizableParaGasto } from "../holded/write";

/**
 * Invariante: toda propuesta que llega al operador tiene AL MENOS UNA salida accionable (crear, crear y conciliar, adjuntar a
 * un gasto existente o cancelar). Caso real 2026-09-28: un ticket con su cargo exacto en Holded se quedó sin ningún botón de
 * crear (solo «Corregir clasificación», «Ajustar monto»…): un callejón sin salida. Se recorren las combinaciones de estado
 * que puede producir el flujo y se comprueba el teclado real.
 */
const SALIDAS = /^(crear|crearconciliar|crearconciliar_\d+|adjuntar_\d+|nuevo|cancelar)$/;

const cargo = (descripcion: string, extra: Record<string, unknown> = {}) => ({
  accountId: "a", movementId: `m-${descripcion}`, descripcion, monto: -3.91, moneda: "USD", fecha: "2026-09-25", origenCoincidencia: "exacta" as const, ...extra,
});
const candidatoHolded = { id: "c1", contactName: "X", fecha: "2026-09-25", total: 3.91, descripcion: "d", documentNumber: "1", moneda: "USD" };

const CARGOS: Record<string, unknown[]> = {
  "sin cargo": [],
  "un cargo compatible por nombre": [cargo("Mi Cafetería Centro")],
  "un cargo por confirmar": [cargo("SQ *XYZ 88", { compatibilidad: "por_confirmar" })],
  "un cargo aprendido": [cargo("SQ *XYZ 88", { compatibilidad: "aprendido" })],
  "dos cargos compatibles": [cargo("Mi Cafetería Centro"), cargo("Mi Cafetería Norte")],
  "un cargo de categoría contradictoria": [cargo("Osteria Del Lovo")],
};

test("todo estado de propuesta tiene al menos una salida accionable (crear, adjuntar o cancelar)", () => {
  const sinSalida: string[] = [];
  const sinCrear: string[] = [];
  let estados = 0;
  for (const [nombreCargos, cargos] of Object.entries(CARGOS)) {
    for (const candidatos of [0, 1, 2]) {
      for (const correo of [false, true]) {
        for (const fechaValida of [true, false]) {
          const propuesta = {
            id: "p", empresa: "Footprint", proveedor: "Bolt", concepto: nombreCargos === "un cargo de categoría contradictoria" ? "Taxi aeropuerto" : "Café",
            monto: 3.91, moneda: "USD", fecha: fechaValida ? "2026-09-25" : "", candidatos: Array.from({ length: candidatos }, () => candidatoHolded),
            lineas: [], chatId: 1, messageId: 1, creadoEn: 1, hayMovimientoBancario: cargos.length === 1,
            movimientosAmbiguos: cargos, ...(correo ? { correoOrigen: { de: "a@b.c", asunto: "s", threadId: "t", messageIdHeader: "<m>", mensajeIdGmail: "g" } } : {}),
          } as unknown as PropuestaGasto;
          const teclas = construirTecladoGasto(propuesta, opcionesTecladoDesdePropuesta(propuesta)).flat()
            .map((b) => b.callback_data?.split(":")[2] ?? "");
          estados++;
          // Nunca decir «encontré el cargo» sin dar el botón de crear: con un cargo utilizable, fecha válida y sin gastos
          // de Holded que adjuntar, tiene que haber «Crear» o «Crear y conciliar».
          const hayCargoUtilizable = cargos.some((c) => candidatoUtilizableParaGasto(propuesta.proveedor, propuesta.concepto, c as never));
          if (hayCargoUtilizable && fechaValida && candidatos === 0 && !teclas.some((t) => /^(crear|crearconciliar|crearconciliar_\d+)$/.test(t))) {
            sinCrear.push(`${nombreCargos} | correo: ${correo} → botones: ${JSON.stringify(teclas)}`);
          }
          if (!teclas.some((t) => SALIDAS.test(t))) {
            sinSalida.push(`${nombreCargos} | candidatos de Holded: ${candidatos} | correo: ${correo} | fecha válida: ${fechaValida} → botones: ${JSON.stringify(teclas)}`);
          }
        }
      }
    }
  }
  assert.ok(estados >= 70, `se recorrieron ${estados} estados`);
  assert.deepEqual(sinSalida, [], `Estados SIN salida accionable (callejón):\n${sinSalida.join("\n")}`);
  assert.deepEqual(sinCrear, [], `Hay un cargo utilizable pero NO hay botón de crear (caso real 2026-09-28):\n${sinCrear.join("\n")}`);
});
