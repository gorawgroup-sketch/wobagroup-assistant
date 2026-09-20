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
    completado: true,
  };
}

test("confirma por lectura directa un gasto reciente antes de saltar su PDF", async () => {
  const estado = await revalidarRegistroRecienteDeCorreo(registro(), AHORA, {
    obtenerCompra: async () => ({ id: "purchase-fantasma" }),
  });

  assert.equal(estado, "confirmado");
});

test("un gasto existente pero sin cierre terminal no permite marcar el correo leído", async () => {
  let cierres = 0;
  const estado = await revalidarRegistroRecienteDeCorreo({ ...registro(), completado: false }, AHORA, {
    obtenerCompra: async () => ({ id: "purchase-fantasma", payments_pending: "5,40" }),
    tieneComprobante: async () => true,
    marcarCompletado: async () => ++cierres,
  });

  assert.equal(estado, "incompleto");
  assert.equal(cierres, 0);
});

test("recupera por lectura un crash posterior a soporte y conciliación", async () => {
  let cierres = 0;
  const estado = await revalidarRegistroRecienteDeCorreo({ ...registro(), completado: false }, AHORA, {
    obtenerCompra: async () => ({ id: "purchase-fantasma", payments_pending: "0,00" }),
    tieneComprobante: async () => true,
    marcarCompletado: async () => { cierres++; return 1; },
  });

  assert.equal(estado, "confirmado");
  assert.equal(cierres, 1);
});

test("un 404 de una compra completada conserva la barrera porque puede ser un ticket", async () => {
  const estado = await revalidarRegistroRecienteDeCorreo(registro(), AHORA, {
    obtenerCompra: async () => {
      throw new HoldedApiError(404, "WOBA", "not found");
    },
  });

  assert.equal(estado, "confirmado");
});

test("un error distinto de 404 falla cerrado", async () => {
  const estado = await revalidarRegistroRecienteDeCorreo(registro(), AHORA, {
    obtenerCompra: async () => {
      throw new HoldedApiError(429, "WOBA", "rate limited");
    },
  });

  assert.equal(estado, "no_verificable");
});

test("un registro abierto o legacy con 404 permanece no verificable y nunca habilita recrear", async () => {
  for (const completado of [false, undefined]) {
    const estado = await revalidarRegistroRecienteDeCorreo({ ...registro(), completado }, AHORA, {
      obtenerCompra: async () => {
        throw new HoldedApiError(404, "WOBA", "puede ser ticket");
      },
    });
    assert.equal(estado, "no_verificable");
  }
});

test("un registro histórico no se borra por una limitación actual de /purchases", async () => {
  let lecturas = 0;
  const haceTresDias = AHORA - 3 * 24 * 60 * 60 * 1000;
  const estado = await revalidarRegistroRecienteDeCorreo(registro(haceTresDias), AHORA, {
    obtenerCompra: async () => {
      lecturas++;
      throw new Error("no debería consultar");
    },
  });

  assert.equal(estado, "confirmado");
  assert.equal(lecturas, 0);
});
