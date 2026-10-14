import assert from "node:assert/strict";
import test from "node:test";
import { elegirMensajeConAdjuntosPendientes, mensajeDelHiloConAdjuntosPendientes } from "./mensajeConAdjuntosDelHilo";
import type { CorreoResumen } from "./client";

const base = (id: string, fecha: string, adj: string[]): CorreoResumen => ({
  id, threadId: "hilo", messageIdHeader: `<${id}>`, de: "RODOAR SERVICE SL <rodoarservice.28@gmail.com>", asunto: "Re: FACTURA PENDIENTE", fecha, extracto: "",
  adjuntos: adj.map((f, i) => ({ filename: f, mimeType: "application/pdf", attachmentId: `a${i}`, size: 125386, partId: String(i + 1) })),
});

// Caso real RODOAR 14-10-2026: factura a las 11:57 (y reenviada a las 16:23), acuse de recibo sin adjunto a las 17:49.
test("si el último mensaje no trae adjuntos, se procesa el anterior más reciente con adjuntos pendientes", () => {
  const ultimo = base("m5", "Wed, 14 Oct 2026 17:49:00 +0200", []);
  const r = elegirMensajeConAdjuntosPendientes(ultimo, [
    { resumen: base("m2", "Wed, 14 Oct 2026 11:57:00 +0200", ["FACTURA EWORKS.pdf"]), adjuntosPendientes: 1 },
    { resumen: base("m3", "Wed, 14 Oct 2026 16:23:00 +0200", ["FACTURA EWORKS.pdf"]), adjuntosPendientes: 1 },
  ]);
  assert.equal(r?.id, "m3");
});

test("si el último ya trae adjuntos, o los anteriores ya se procesaron, se mantiene el último", () => {
  const conAdjunto = base("m5", "Wed, 14 Oct 2026 17:49:00 +0200", ["x.pdf"]);
  assert.equal(elegirMensajeConAdjuntosPendientes(conAdjunto, [{ resumen: base("m2", "Wed, 14 Oct 2026 11:57:00 +0200", ["f.pdf"]), adjuntosPendientes: 1 }]), undefined);
  const sinAdjunto = base("m5", "Wed, 14 Oct 2026 17:49:00 +0200", []);
  assert.equal(elegirMensajeConAdjuntosPendientes(sinAdjunto, [{ resumen: base("m2", "Wed, 14 Oct 2026 11:57:00 +0200", ["f.pdf"]), adjuntosPendientes: 0 }]), undefined);
});

test("con red simulada: lista el hilo, lee los anteriores y descarta los adjuntos ya registrados o descartados", async () => {
  const ultimo = base("m5", "Wed, 14 Oct 2026 17:49:00 +0200", []);
  const r = await mensajeDelHiloConAdjuntosPendientes(ultimo, {
    listar: async () => [{ id: "m1" }, { id: "m2" }, { id: "m5" }],
    resumen: async (id) => id === "m2" ? base("m2", "Wed, 14 Oct 2026 11:57:00 +0200", ["FACTURA EWORKS.pdf"]) : base(id, "Wed, 14 Oct 2026 11:06:00 +0200", []),
    pendiente: async (mensajeId) => mensajeId === "m2",
  });
  assert.equal(r?.id, "m2");
});
