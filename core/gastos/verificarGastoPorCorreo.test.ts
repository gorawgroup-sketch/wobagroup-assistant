import assert from "node:assert/strict";
import test from "node:test";
import { HoldedApiError } from "../holded/write";
import type { GastoPorCorreo } from "./gastoPorCorreoStore";
import { revalidarRegistroRecienteDeCorreo } from "./verificarGastoPorCorreo";

const AHORA = Date.UTC(2026, 8, 18, 18, 0, 0);

function registro(creadoEn = AHORA - 60_000): GastoPorCorreo {
  return {
    mensajeIdGmail: "gmail-dhl",
    attachmentId: "1",
    gastoId: "purchase-fantasma",
    empresa: "WOBA",
    creadoEn,
  };
}

test("confirma por lectura directa un gasto reciente antes de saltar su PDF", async () => {
  let eliminaciones = 0;
  const estado = await revalidarRegistroRecienteDeCorreo(registro(), AHORA, {
    obtenerCompra: async () => ({ id: "purchase-fantasma" }),
    eliminarRegistro: async () => ++eliminaciones,
  });

  assert.equal(estado, "confirmado");
  assert.equal(eliminaciones, 0);
});

test("un 404 invalida solo la referencia exacta y permite releer el adjunto", async () => {
  const eliminados: Array<[string, string | undefined, string]> = [];
  const estado = await revalidarRegistroRecienteDeCorreo(registro(), AHORA, {
    obtenerCompra: async () => {
      throw new HoldedApiError(404, "WOBA", "not found");
    },
    eliminarRegistro: async (mensajeId, attachmentId, gastoId) => {
      eliminados.push([mensajeId, attachmentId, gastoId]);
      return 1;
    },
  });

  assert.equal(estado, "fantasma_eliminado");
  assert.deepEqual(eliminados, [["gmail-dhl", "1", "purchase-fantasma"]]);
});

test("un error distinto de 404 falla cerrado y no elimina memoria", async () => {
  let eliminaciones = 0;
  const estado = await revalidarRegistroRecienteDeCorreo(registro(), AHORA, {
    obtenerCompra: async () => {
      throw new HoldedApiError(429, "WOBA", "rate limited");
    },
    eliminarRegistro: async () => ++eliminaciones,
  });

  assert.equal(estado, "no_verificable");
  assert.equal(eliminaciones, 0);
});

test("un registro histórico no se borra por una limitación actual de /purchases", async () => {
  let lecturas = 0;
  let eliminaciones = 0;
  const haceTresDias = AHORA - 3 * 24 * 60 * 60 * 1000;
  const estado = await revalidarRegistroRecienteDeCorreo(registro(haceTresDias), AHORA, {
    obtenerCompra: async () => {
      lecturas++;
      throw new Error("no debería consultar");
    },
    eliminarRegistro: async () => ++eliminaciones,
  });

  assert.equal(estado, "confirmado");
  assert.equal(lecturas, 0);
  assert.equal(eliminaciones, 0);
});
