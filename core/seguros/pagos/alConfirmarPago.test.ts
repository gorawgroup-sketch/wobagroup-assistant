import assert from "node:assert/strict";
import test from "node:test";
import type { PagoConfirmado } from "../vigilante/cruces";
import type { MovimientoBanco } from "../vigilante/tipos";
import { actualizarCalendarioConPagoConfirmado, type DepsAlConfirmarPago } from "./alConfirmarPago";
import { pago } from "./pruebas";
import type { PagoSeguro, PagoSeguroConFila } from "./tipos";

const movimiento: MovimientoBanco = { empresa: "WOBA", cuentaId: "bbva", cuenta: "BBVA", id: "mov9", fecha: "2027-04-19", descripcion: "MARKEL ADEUDO", importe: -2050.1, moneda: "EUR", importeEur: -2050.1, estado: "pending", saldoTras: null };
const confirmado = (): PagoConfirmado => ({ polizas: [{ id: "woba_rc_markel" } as never], movimiento, consolidado: true });

function montar(filas: PagoSeguro[]) {
  const actuales: PagoSeguroConFila[] = filas.map((f, i) => ({ ...f, rowIndex: i + 2 }));
  const escrito = { actualizados: [] as Array<{ id: string; cambios: Partial<PagoSeguro> }>, agregados: [] as PagoSeguro[], invalidaciones: 0 };
  const deps: DepsAlConfirmarPago = {
    leerPagos: async () => actuales,
    actualizar: async (p, cambios) => { escrito.actualizados.push({ id: p.id, cambios }); },
    agregar: async (p) => { escrito.agregados.push(p); return true; },
    invalidarCerebro: () => { escrito.invalidaciones++; },
  };
  return { deps, escrito };
}

test("un pago confirmado por el vigilante marca su fila como pagada con el importe del banco, añade el siguiente de la serie y refresca Cerebro", async () => {
  const m = montar([pago({ id: "woba_rc_markel:2027-04-17", polizaId: "woba_rc_markel", fecha: "2027-04-17", importe: 2012.65, recurrenciaMeses: 12 })]);
  const r = await actualizarCalendarioConPagoConfirmado(confirmado(), "2027-04-20", m.deps);
  assert.equal(r.actualizaciones.length, 1);
  assert.deepEqual(m.escrito.actualizados.map((a) => [a.id, a.cambios.estado, a.cambios.importe]), [["woba_rc_markel:2027-04-17", "pagado", 2050.1]]);
  assert.deepEqual(m.escrito.agregados.map((p) => [p.id, p.fecha, p.importe, p.estimado]), [["woba_rc_markel:2028-04-17", "2028-04-17", 2050.1, true]]);
  assert.equal(m.escrito.invalidaciones, 1);
});

test("si ninguna fila corresponde (p. ej. el recibo suelto de un suplemento) no escribe ni refresca nada", async () => {
  const m = montar([pago({ id: "otra:2027-09-01", polizaId: "otra", fecha: "2027-09-01" })]);
  const r = await actualizarCalendarioConPagoConfirmado(confirmado(), "2027-04-20", m.deps);
  assert.deepEqual(r, { actualizaciones: [], nuevos: [] });
  assert.deepEqual(m.escrito, { actualizados: [], agregados: [], invalidaciones: 0 });
});
