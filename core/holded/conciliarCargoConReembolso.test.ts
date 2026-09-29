import assert from "node:assert/strict";
import test from "node:test";
import { conciliarCargoConReembolso } from "./conciliarCargoConReembolso";
import { HoldedApiError } from "./write";

const plan = {
  cargo: { accountId: "usd", movementId: "cargo", fecha: "2026-09-28" },
  reembolso: { accountId: "eur", movementId: "reembolso", fecha: "2026-09-28" },
};

function banco(opciones: { falloReembolso?: unknown; falloCargo?: unknown; reembolsoSinEfecto?: boolean } = {}) {
  const estado = {
    pendiente: 1.71,
    cargo: { amount: "-43.53", status: "partial", reconciled_amount: "-28.43" },
    reembolso: { amount: "11.55", status: "pending", reconciled_amount: "0.00" },
  };
  const envios: string[] = [];
  const deps = {
    leerCompra: async () => ({ payments_pending: estado.pendiente.toFixed(2).replace(".", ","), total: "93854,00" }),
    leerMovimiento: async (_e: unknown, _a: string, id: string) => ({ ...(id === "cargo" ? estado.cargo : estado.reembolso) }),
    enviar: async (_e: unknown, _a: string, id: string) => {
      envios.push(id);
      if (id === "reembolso") {
        if (opciones.falloReembolso) throw opciones.falloReembolso;
        if (!opciones.reembolsoSinEfecto) { estado.reembolso = { amount: "11.55", status: "reconciled", reconciled_amount: "11.55" }; estado.pendiente += 11.55; }
      } else {
        if (opciones.falloCargo) throw opciones.falloCargo;
        estado.cargo = { amount: "-43.53", status: estado.pendiente > 12 ? "reconciled" : "partial", reconciled_amount: estado.pendiente > 12 ? "-43.53" : "-30.38" };
        estado.pendiente = 0;
      }
    },
  };
  return { deps: deps as never, envios, estado };
}

test("enlaza primero el reembolso y después el resto del cargo, y lo confirma por lectura", async () => {
  const b = banco();
  const r = await conciliarCargoConReembolso("Footprint", "compra", plan, b.deps);
  assert.deepEqual(b.envios, ["reembolso", "cargo"]);
  assert.equal(r.completo, true);
  assert.match(r.nota, /Reembolso enlazado/);
});

test("si Holded rechaza el reembolso (4xx) sigue con el cargo y no lo da por completo", async () => {
  const b = banco({ falloReembolso: new HoldedApiError(422, "Footprint", "no admitido") });
  const r = await conciliarCargoConReembolso("Footprint", "compra", plan, b.deps);
  assert.deepEqual(b.envios, ["reembolso", "cargo"]);
  assert.equal(r.completo, false);
  assert.match(r.nota, /no admite enlazar ese reembolso/);
  assert.equal(b.estado.pendiente, 0);
});

test("un resultado incierto en el reembolso detiene todo: no se toca el cargo", async () => {
  const b = banco({ falloReembolso: new Error("timeout") });
  const r = await conciliarCargoConReembolso("Footprint", "compra", plan, b.deps);
  assert.deepEqual(b.envios, ["reembolso"]);
  assert.equal(r.completo, false);
});

test("un envío aceptado sin efecto visible detiene todo", async () => {
  const b = banco({ reembolsoSinEfecto: true });
  const r = await conciliarCargoConReembolso("Footprint", "compra", plan, b.deps);
  assert.deepEqual(b.envios, ["reembolso"]);
  assert.equal(r.completo, false);
});

test("repetir tras haber terminado no envía nada", async () => {
  const b = banco();
  await conciliarCargoConReembolso("Footprint", "compra", plan, b.deps);
  b.envios.length = 0;
  const r = await conciliarCargoConReembolso("Footprint", "compra", plan, b.deps);
  assert.deepEqual(b.envios, []);
  assert.equal(r.completo, true);
});
