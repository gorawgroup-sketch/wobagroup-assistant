import assert from "node:assert/strict";
import test from "node:test";
import type { BankMovement, Empresa, TreasuryAccount } from "../../holded/client";
import { leerMovimientosBancarios, normalizarMovimiento, type FuentesBanco } from "./lecturaBancaria";

const cuentaEur: TreasuryAccount = { id: "c1", name: "BBVA ", currency: "EUR", type: "bank" };
const cuentaUsd: TreasuryAccount = { id: "c2", name: "FTG USD", currency: "USD", type: "bank" };

test("un apunte de Holded se normaliza: importe firmado, día, equivalente en EUR y saldo posterior", () => {
  const m = normalizarMovimiento("WOBA", cuentaEur, {
    id: "m1", description: "Markel Insurance SE ADEUDO A SU CARGO", amount: "-323.24", currency: "EUR", balance: "-399.28",
    booking_date: "2026-10-05T00:00:00+00:00", status: "pending",
  });
  assert.deepEqual(m, {
    empresa: "WOBA", cuentaId: "c1", cuenta: "BBVA", id: "m1", fecha: "2026-10-05", descripcion: "Markel Insurance SE ADEUDO A SU CARGO",
    importe: -323.24, moneda: "EUR", importeEur: -323.24, estado: "pending", saldoTras: -399.28,
  });
});

test("en una cuenta en dólares el equivalente en euros es el que calcula Holded; sin él, no se inventa", () => {
  const con = normalizarMovimiento("Footprint", cuentaUsd, { id: "m2", description: "Iati", amount: -76.89, currency: "USD", accounting_amount: "-65.97", accounting_currency: "EUR", booking_date: "2026-08-27T00:00:00+00:00" });
  assert.equal(con?.importeEur, -65.97);
  const sin = normalizarMovimiento("Footprint", cuentaUsd, { id: "m3", description: "Iati", amount: -10, currency: "USD", booking_date: "2026-08-27T00:00:00+00:00" });
  assert.equal(sin?.importeEur, null);
});

test("un apunte sin id o con un importe ilegible se descarta", () => {
  assert.equal(normalizarMovimiento("WOBA", cuentaEur, { description: "x", amount: "-5" } as BankMovement), null);
  assert.equal(normalizarMovimiento("WOBA", cuentaEur, { id: "m4", description: "x", amount: "n/a" }), null);
});

function fuentes(comportamiento: Partial<Record<Empresa, { fallaCuentas?: boolean; fallaMovimientos?: string[] }>>): FuentesBanco & { llamadas: string[] } {
  const llamadas: string[] = [];
  return {
    llamadas,
    listTreasuryAccounts: async (empresa) => {
      llamadas.push(`cuentas:${empresa}`);
      if (comportamiento[empresa]?.fallaCuentas) throw new Error("Holded 503");
      return [cuentaEur, { id: "arch", name: "Vieja", archived: true }, { id: "gw", name: "Pasarela", type: "gateway" }, cuentaUsd];
    },
    listBankMovements: async (empresa, cuentaId) => {
      llamadas.push(`movs:${empresa}:${cuentaId}`);
      if (comportamiento[empresa]?.fallaMovimientos?.includes(cuentaId)) throw new Error("Holded 403");
      return [{ id: `${empresa}-${cuentaId}`, description: "x", amount: "-1", currency: "EUR", booking_date: "2026-10-01T00:00:00+00:00" }];
    },
  };
}

test("se leen todas las cuentas vivas de cada empresa (sin archivadas ni pasarelas) y las empresas completas se anotan", async () => {
  const f = fuentes({});
  const r = await leerMovimientosBancarios(["WOBA", "EWORKS"], "2026-08-21", "2026-10-05", f, 0);
  assert.equal(r.cuentasLeidas, 4);
  assert.equal(r.movimientos.length, 4);
  assert.deepEqual([...r.empresasCompletas].sort(), ["EWORKS", "WOBA"]);
  assert.deepEqual(r.fallos, []);
  assert.ok(!f.llamadas.some((l) => l.endsWith(":arch") || l.endsWith(":gw")));
});

test("una cuenta que falla (también al reintentar) se anota y su empresa NO queda como completa; el resto sigue leyéndose", async () => {
  const r = await leerMovimientosBancarios(["WOBA", "Footprint"], "2026-08-21", "2026-10-05", fuentes({ Footprint: { fallaMovimientos: ["c2"] } }), 0);
  assert.equal(r.fallos.length, 1);
  assert.deepEqual(r.fallos[0], { empresa: "Footprint", cuenta: "FTG USD", error: "Holded 403" });
  assert.deepEqual([...r.empresasCompletas], ["WOBA"]);
  assert.equal(r.movimientos.filter((m) => m.empresa === "Footprint").length, 1);
});

test("si no se pueden ni listar las cuentas de una empresa, se anota y esa empresa no cuenta como leída", async () => {
  const r = await leerMovimientosBancarios(["WOBA", "EWORKS"], "2026-08-21", "2026-10-05", fuentes({ EWORKS: { fallaCuentas: true } }), 0);
  assert.deepEqual(r.fallos, [{ empresa: "EWORKS", cuenta: "(todas)", error: "Holded 503" }]);
  assert.deepEqual([...r.empresasCompletas], ["WOBA"]);
});

test("un fallo suelto se reintenta una vez y, si entonces responde, no se anota nada", async () => {
  let intentos = 0;
  const f: FuentesBanco = {
    listTreasuryAccounts: async () => [cuentaEur],
    listBankMovements: async () => {
      intentos++;
      if (intentos === 1) throw new Error("Holded 403");
      return [{ id: "m", description: "x", amount: "-1", currency: "EUR", booking_date: "2026-10-01T00:00:00+00:00" }];
    },
  };
  const r = await leerMovimientosBancarios(["WOBA"], "2026-08-21", "2026-10-05", f, 0);
  assert.equal(intentos, 2);
  assert.deepEqual(r.fallos, []);
  assert.equal(r.movimientos.length, 1);
});
