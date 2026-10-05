import assert from "node:assert/strict";
import test from "node:test";
import {
  consultaGmailSeguros,
  direccionDe,
  esRemitenteDeSeguros,
  leerCorreosDeSeguros,
  senalesDeCorreo,
  type FuentesCorreo,
  type ResumenCorreoCrudo,
} from "./correos";

// Correos REALES del buzón del asistente (28/09 → 01/10/2026): remitentes, asuntos y adjuntos tal cual llegaron.
const CORREOS: ResumenCorreoCrudo[] = [
  {
    id: "1a0f286089852088", threadId: "t1", de: "Jaquelin Lovey <jaquelin.lovey@acodrid.com>",
    asunto: "URGENTE -- RECIBOS PENDIENTES DE PÓLIZA 54239034.2 (MULTIRRIESGO) - WOBA (BUSINESS ATELIER EUROPA SL)",
    fecha: "Wed, 30 Sep 2026 13:34:19 +0000",
    extracto: "Buenos días Carlos, Como continuación a la conversación telefónica que acabamos de mantener, lamento comunicarte que no podemos volver a pasar al cobro el recibo",
    adjuntos: [],
  },
  {
    id: "1a0f632faa7e6a37", threadId: "t2", de: "Maria Jose Mejia <mjose.mejia@acodrid.com>",
    asunto: "RECIBOS - JUSTIFICANTES PAGO -  PÓLIZA 54239034.2 (MULTIRRIESGO) - WOBA (BUSINESS ATELIER EUROPA SL)",
    fecha: "Thu, 1 Oct 2026 06:42:05 +0000",
    extracto: "Buenos días: Les adjuntamos justificante de pago correspondiente a la transferencia que nos han hecho llegar.",
    adjuntos: [{ filename: "transfer_confirmation.pdf" }, { filename: "DuplicadoRecibo (1).pdf" }, { filename: "DuplicadoRecibo.pdf" }],
  },
  {
    id: "1a0f65e316eefdde", threadId: "t3", de: "Jaquelin Lovey <jaquelin.lovey@acodrid.com>",
    asunto: "RE: Documentos pendientes — pólizas WOBA (Business Atelier Europa SL)",
    fecha: "Thu, 1 Oct 2026 07:29:16 +0000",
    extracto: "Buenos días Carlos, Adjunto reenvío los dos últimos suplementos de las pólizas solicitadas, que corresponden a la anualidad en curso.",
    adjuntos: [{ filename: "BUSINESS ATELIER EUROPA, S.L.  023S00453RCG Condiciones Particulares.pdf" }, { filename: "054239034.2 (SUPLEMENTO).pdf" }],
  },
  {
    id: "1a0f24af051a37c8", threadId: "t4", de: '"Kelly J. Correales Ducuara" <kelly@footprint.global>',
    asunto: "6,09 euros - Uber Medellin - Visa", fecha: "Wed, 30 Sep 2026 12:29:46 +0000", extracto: "Saludos / Best Regards", adjuntos: [{ filename: "receipt_b3338bb8.pdf" }],
  },
];

function fuentes(correos: ResumenCorreoCrudo[]): FuentesCorreo & { consultas: string[] } {
  const consultas: string[] = [];
  return {
    consultas,
    buscarMensajes: async (consulta) => { consultas.push(consulta); return correos.map((c) => c.id); },
    obtenerResumenCorreo: async (id) => correos.find((c) => c.id === id) as ResumenCorreoCrudo,
  };
}

test("el remitente se decide por la dirección real, nunca por el nombre visible", () => {
  assert.equal(direccionDe('"Kelly J. Correales" <kelly@footprint.global>'), "kelly@footprint.global");
  assert.ok(esRemitenteDeSeguros("Jaquelin Lovey <jaquelin.lovey@acodrid.com>"));
  assert.ok(esRemitenteDeSeguros("avisos@mail.allianz.es"));
  assert.ok(!esRemitenteDeSeguros('"jaquelin.lovey@acodrid.com" <atacante@otrodominio.com>'));
  assert.ok(!esRemitenteDeSeguros("alguien@acodrid.com.falso.net"));
  assert.ok(!esRemitenteDeSeguros("kelly@footprint.global"));
});

test("la consulta de Gmail busca solo remitentes de seguros desde la fecha dada", () => {
  const q = consultaGmailSeguros("2026-10-01");
  assert.match(q, /^from:\(acodrid\.com OR /);
  assert.match(q, /after:2026\/10\/01$/);
});

test("el aviso urgente de Acodrid se marca como posible incidencia", () => {
  const c = CORREOS[0];
  assert.ok(senalesDeCorreo(c.asunto, c.extracto, []).includes("incidencia"));
});

test("el envío de justificantes se marca como recibo y como documento adjunto, sin incidencia", () => {
  const c = CORREOS[1];
  const s = senalesDeCorreo(c.asunto, c.extracto, c.adjuntos.map((a) => a.filename));
  assert.ok(s.includes("recibo"));
  assert.ok(s.includes("documento"));
  assert.ok(!s.includes("incidencia"));
});

test("«Documentos pendientes» con los suplementos adjuntos NO es una incidencia, es un documento", () => {
  const c = CORREOS[2];
  const s = senalesDeCorreo(c.asunto, c.extracto, c.adjuntos.map((a) => a.filename));
  assert.deepEqual(s, ["documento"]);
});

test("pedir que se devuelvan firmados los documentos se marca como firma", () => {
  assert.ok(senalesDeCorreo("Suplemento 3.3", "Os pedimos devolver firmadas todas las páginas", []).includes("firma"));
});

test("se leen solo los correos de seguros, ordenados del más antiguo al más reciente, con sus adjuntos", async () => {
  const f = fuentes(CORREOS);
  const leidos = await leerCorreosDeSeguros("2026-09-28", f);
  assert.deepEqual(leidos.map((c) => c.id), ["1a0f286089852088", "1a0f632faa7e6a37", "1a0f65e316eefdde"]);
  assert.equal(leidos[0].remitente, "Jaquelin Lovey");
  assert.deepEqual(leidos[1].adjuntos, ["transfer_confirmation.pdf", "DuplicadoRecibo (1).pdf", "DuplicadoRecibo.pdf"]);
  assert.equal(f.consultas.length, 1);
});
