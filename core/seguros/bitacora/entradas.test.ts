import assert from "node:assert/strict";
import test from "node:test";
import type { ResultadoCalendarioPagos } from "../pagos/calendarioPagos";
import { describirCambio, entradaAvisos, entradaCambio, entradaError, entradaPagos, entradaSemanal, entradaVigilante } from "./entradas";
import { items, resultadoVigilante } from "./pruebas";

const informe = { titulo: "🛡️ Seguros", cuerpo: "Cuerpo del aviso" };

// --- vigilante ----------------------------------------------------------------------------------------------------

test("vigilante sin nada nuevo: queda constancia de que corrió y no encontró novedades", () => {
  const e = entradaVigilante({ resultado: resultadoVigilante(), informe: null, entregado: null });
  assert.equal(e.tarea, "vigilante");
  assert.equal(e.origen, "programada");
  assert.equal(e.resultado, "sin_novedades");
  assert.equal(e.resumen, "Banco, correo y registro revisados: sin novedades");
  assert.equal(e.detalle.avisos, undefined);
  assert.deepEqual(e.detalle.cifras, { confirmados: 0, enTransitoNuevos: 0, devoluciones: 0, cargosNuevos: 0, correosNuevos: 0, enTransitoAhora: 0, cargosARevisarAhora: 0 });
});

test("vigilante con novedades y aviso entregado: cuenta qué encontró y guarda el texto exacto que recibió Carlos", () => {
  const e = entradaVigilante({ resultado: resultadoVigilante({ nuevo: { confirmados: items(1), correos: items(2) }, informe }), informe, entregado: true });
  assert.equal(e.resultado, "con_novedades");
  assert.equal(e.resumen, "Novedades: 1 pago confirmado, 2 correos nuevos de aseguradoras · aviso enviado por Telegram");
  assert.deepEqual(e.detalle.avisos, [{ canal: "telegram", titulo: "🛡️ Seguros", texto: "Cuerpo del aviso", entregado: true }]);
  assert.equal(e.detalle.cifras?.confirmados, 1);
  assert.equal(e.detalle.cifras?.correosNuevos, 2);
});

test("vigilante cuyo aviso no llegó a Telegram: es una advertencia y el aviso consta como no entregado", () => {
  const e = entradaVigilante({ resultado: resultadoVigilante({ nuevo: { devoluciones: items(1) }, informe }), informe, entregado: false });
  assert.equal(e.resultado, "con_advertencias");
  assert.match(e.resumen, /1 devolución · el aviso no llegó a Telegram y queda pendiente de reenvío/);
  assert.equal(e.detalle.avisos?.[0].entregado, false);
});

test("vigilante que reenvía un aviso anterior lo dice, y un cargo que sigue en tránsito se cuenta aunque no sea nuevo", () => {
  const e = entradaVigilante({ resultado: resultadoVigilante({ ahora: { enTransito: items(2) } }), informe: null, entregado: null, reenviado: true });
  assert.equal(e.resultado, "sin_novedades", "lo que ya se avisó no es una novedad");
  assert.match(e.resumen, /reenviado un aviso anterior que no había llegado/);
  assert.match(e.resumen, /2 cargos siguen en tránsito sin confirmar/);
  const uno = entradaVigilante({ resultado: resultadoVigilante({ ahora: { enTransito: items(1) } }), informe: null, entregado: null });
  assert.match(uno.resumen, /1 cargo sigue en tránsito sin confirmar/);
});

test("vigilante con lecturas fallidas: revisión incompleta, con cada advertencia en las notas", () => {
  const e = entradaVigilante({
    resultado: resultadoVigilante({ nuevo: { advertencias: ["No pude leer la cuenta de EWORKS"], fallosPersistentes: ["Gmail falla desde hace 3 días"] } }),
    informe: null, entregado: null,
  });
  assert.equal(e.resultado, "con_advertencias");
  assert.match(e.resumen, /revisión incompleta \(2 advertencias\)/);
  assert.deepEqual(e.detalle.notas, ["No pude leer la cuenta de EWORKS", "Gmail falla desde hace 3 días"]);
});

test("una revisión pedida desde el chat consta como manual", () => {
  assert.equal(entradaVigilante({ resultado: resultadoVigilante(), informe: null, entregado: null, origen: "manual" }).origen, "manual");
});

test("vigilante: cada mensaje de la pasada consta con SU hora de entrega (el informe pendiente reenviado sale primero)", () => {
  const pendiente = { titulo: "Antiguo", cuerpo: "No llegó ayer" };
  const e = entradaVigilante({
    resultado: resultadoVigilante({ nuevo: { confirmados: items(1) }, informe }), informe, entregado: true,
    entregadoEn: "2026-10-09T06:35:41.200Z", reenvio: { informe: pendiente, entregadoEn: "2026-10-09T06:35:40.100Z" },
  });
  assert.deepEqual(e.detalle.avisos, [
    { canal: "telegram", titulo: "Antiguo", texto: "No llegó ayer", entregado: true, entregadoEn: "2026-10-09T06:35:40.100Z" },
    { canal: "telegram", titulo: "🛡️ Seguros", texto: "Cuerpo del aviso", entregado: true, entregadoEn: "2026-10-09T06:35:41.200Z" },
  ]);
  assert.match(e.resumen, /reenviado un aviso anterior que no había llegado/);
  const soloReenvio = entradaVigilante({ resultado: resultadoVigilante(), informe: null, entregado: null, reenvio: { informe: pendiente, entregadoEn: "2026-10-09T06:35:40.100Z" } });
  assert.equal(soloReenvio.detalle.avisos?.length, 1, "un reenvío sin informe nuevo también deja su aviso");
  const noLlego = entradaVigilante({ resultado: resultadoVigilante({ nuevo: { devoluciones: items(1) }, informe }), informe, entregado: false, entregadoEn: "2026-10-09T06:35:41.200Z" });
  assert.equal(noLlego.detalle.avisos?.[0].entregadoEn, undefined, "si no llegó no hay hora de entrega aunque se pase una");
});

test("avisos del registro, calendario de pagos y resumen semanal anotan la hora de entrega de su mensaje", () => {
  const cierre = entradaAvisos({ activas: { pagos: 1, renovaciones: 0 }, nuevas: { pagos: 1, renovaciones: 0 }, envio: { titulo: "T", cuerpo: "C", entregado: true, entregadoEn: "2026-10-09T06:50:09.000Z" } });
  assert.equal(cierre.detalle.avisos?.[0].entregadoEn, "2026-10-09T06:50:09.000Z");
  const pagos = entradaPagos({ r: resultadoPagos({ avisos: items(1) as unknown as ResultadoCalendarioPagos["avisos"], informe }), informe, entregado: true, entregadoEn: "2026-10-09T06:55:20.000Z" });
  assert.equal(pagos.detalle.avisos?.[0].entregadoEn, "2026-10-09T06:55:20.000Z");
  const semanal = entradaSemanal({ informe, entregado: true, entregadoEn: "2026-10-12T07:10:05.000Z" });
  assert.equal(semanal.detalle.avisos?.[0].entregadoEn, "2026-10-12T07:10:05.000Z");
});

// --- avisos del registro ------------------------------------------------------------------------------------------

test("avisos del registro sin nada activo, con todo ya avisado, enviado y fallido", () => {
  const nada = entradaAvisos({ activas: { pagos: 0, renovaciones: 0 }, nuevas: { pagos: 0, renovaciones: 0 }, envio: null });
  assert.equal(nada.resultado, "sin_novedades");
  assert.equal(nada.resumen, "Registro revisado: ninguna póliza vence en 30 días ni hay pagos pendientes.");

  const yaAvisado = entradaAvisos({ activas: { pagos: 1, renovaciones: 2 }, nuevas: { pagos: 0, renovaciones: 0 }, envio: null });
  assert.equal(yaAvisado.resultado, "sin_novedades");
  assert.equal(yaAvisado.resumen, "Registro revisado: 3 casos activos, todos ya avisados antes.");
  assert.equal(entradaAvisos({ activas: { pagos: 1, renovaciones: 0 }, nuevas: { pagos: 0, renovaciones: 0 }, envio: null }).resumen, "Registro revisado: 1 caso activo, todos ya avisados antes.");

  const enviado = entradaAvisos({ activas: { pagos: 1, renovaciones: 2 }, nuevas: { pagos: 1, renovaciones: 2 }, envio: { titulo: "T", cuerpo: "C", entregado: true } });
  assert.equal(enviado.resultado, "con_novedades");
  assert.equal(enviado.resumen, "Aviso enviado por Telegram: 1 pago pendiente o devuelto y 2 pólizas a 30 días o menos de vencer.");
  assert.deepEqual(enviado.detalle.avisos, [{ canal: "telegram", titulo: "T", texto: "C", entregado: true }]);

  const fallido = entradaAvisos({ activas: { pagos: 1, renovaciones: 0 }, nuevas: { pagos: 1, renovaciones: 0 }, envio: { titulo: "T", cuerpo: "C", entregado: false } });
  assert.equal(fallido.resultado, "error");
  assert.match(fallido.resumen, /No se pudo entregar el aviso a Telegram; se reintenta mañana/);
  assert.equal(fallido.detalle.avisos?.[0].entregado, false);
});

// --- calendario de pagos ------------------------------------------------------------------------------------------

const resultadoPagos = (parcial: Partial<ResultadoCalendarioPagos> = {}): ResultadoCalendarioPagos => ({
  hoy: "2026-10-09", eventosCreados: 0, eventosRetirados: 0, eventos: [], previstos: 6,
  proximo: { fecha: "2027-02-27", empresa: "EWORKS", concepto: "RC Markel", importe: 840.74, moneda: "EUR", estimado: true },
  avisos: [], informe: null, advertencias: [], ...parcial,
});
const evento = (accion: "creado" | "retirado", n: number) => ({ accion, titulo: `🛡️ Seguro ${n}`, inicio: "2027-02-24T08:00:00.000Z" });

test("calendario de pagos: dice qué eventos puso, cuándo toca lo siguiente y que ningún pago está a 1-3 días", () => {
  const e = entradaPagos({ r: resultadoPagos({ eventosCreados: 2, eventos: [evento("creado", 1), evento("creado", 2)] }), informe: null, entregado: null });
  assert.equal(e.tarea, "pagos");
  assert.equal(e.resultado, "con_novedades");
  assert.equal(e.resumen, "Calendario revisado: 6 pagos previstos · eventos de calendario: 2 creado(s), 0 retirado(s) · próximo pago: 27/02/2027 (EWORKS, RC Markel) · ningún pago a 1-3 días");
  assert.equal(e.detalle.eventos?.length, 2);
  assert.deepEqual(e.detalle.cifras, { previstos: 6, eventosCreados: 2, eventosRetirados: 0, pagosAvisados: 0 });
});

test("calendario de pagos que no cambia nada: sin novedades pero consta que corrió", () => {
  const e = entradaPagos({ r: resultadoPagos(), informe: null, entregado: null });
  assert.equal(e.resultado, "sin_novedades");
  assert.equal(e.resumen, "Calendario revisado: 6 pagos previstos · próximo pago: 27/02/2027 (EWORKS, RC Markel) · ningún pago a 1-3 días");
  assert.equal(entradaPagos({ r: resultadoPagos({ proximo: null, previstos: 0 }), informe: null, entregado: null }).resumen, "Calendario revisado: 0 pagos previstos · ningún pago a 1-3 días");
});

test("calendario de pagos con aviso: entregado es novedad; no entregado y las advertencias, advertencia", () => {
  const avisos = items(2) as unknown as ResultadoCalendarioPagos["avisos"];
  const entregado = entradaPagos({ r: resultadoPagos({ avisos, informe }), informe, entregado: true });
  assert.equal(entregado.resultado, "con_novedades");
  assert.match(entregado.resumen, /aviso enviado de 2 pagos/);
  assert.equal(entregado.detalle.avisos?.[0].texto, "Cuerpo del aviso");

  const fallido = entradaPagos({ r: resultadoPagos({ avisos, informe }), informe, entregado: false });
  assert.equal(fallido.resultado, "con_advertencias");
  assert.match(fallido.resumen, /el aviso no llegó a Telegram \(se repite mañana\)/);

  const conAdvertencia = entradaPagos({ r: resultadoPagos({ advertencias: ["No pude crear el evento de «X»"] }), informe: null, entregado: null });
  assert.equal(conAdvertencia.resultado, "con_advertencias");
  assert.deepEqual(conAdvertencia.detalle.notas, ["No pude crear el evento de «X»"]);
});

// --- resumen semanal ----------------------------------------------------------------------------------------------

test("resumen semanal: sin nada que contar, enviado y fallido", () => {
  assert.equal(entradaSemanal({ informe: null, entregado: null }).resultado, "sin_novedades");
  assert.equal(entradaSemanal({ informe: null, entregado: null }).resumen, "Resumen semanal: nada que contar esta semana.");
  const enviado = entradaSemanal({ informe, entregado: true });
  assert.equal(enviado.resultado, "con_novedades");
  assert.equal(enviado.detalle.avisos?.[0].entregado, true);
  const fallido = entradaSemanal({ informe, entregado: false });
  assert.equal(fallido.resultado, "error");
  assert.equal(fallido.detalle.avisos?.[0].entregado, false);
});

// --- decisiones sobre propuestas del especialista -----------------------------------------------------------------

const cambioPoliza = { accion: "actualizar_poliza" as const, datos: JSON.stringify({ polizaId: "woba_rc_markel", cambios: { estadoPago: "pagado", notas: "x" }, motivo: "m", versionFila: "v" }) };

test("cada propuesta se describe en una línea (qué se decidió) sin volver a leer el registro", () => {
  assert.equal(describirCambio(cambioPoliza), "cambio en la póliza woba_rc_markel (estadoPago, notas)");
  assert.equal(describirCambio({ accion: "recordar", datos: JSON.stringify({ tipo: "decision", texto: "Se excluye\nla RC del multirriesgo" }) }), "recordar (decision): «Se excluye la RC del multirriesgo»");
  assert.equal(describirCambio({ accion: "retirar_recuerdo", datos: JSON.stringify({ id: "k-1", motivo: "obsoleto" }) }), "retirar de la memoria el recuerdo k-1");
  const original = console.error; console.error = () => {};
  try { assert.equal(describirCambio({ accion: "actualizar_poliza", datos: "{no" }), "cambio en la póliza ?", "unos datos dañados no impiden describirla"); } finally { console.error = original; }
});

test("aprobar, aplicar con rechazo, fallar al aplicar y cancelar quedan cada uno con su resultado", () => {
  const ok = entradaCambio({ cambio: cambioPoliza, decision: "aplicar", por: "Carlos", resultado: { ok: true, mensaje: "Registro actualizado." } });
  assert.equal(ok.tarea, "agente");
  assert.equal(ok.origen, "agente");
  assert.equal(ok.resultado, "con_novedades");
  assert.equal(ok.resumen, "Carlos aprobó y se aplicó: cambio en la póliza woba_rc_markel (estadoPago, notas).");

  const rechazado = entradaCambio({ cambio: cambioPoliza, decision: "aplicar", por: "Carlos", resultado: { ok: false, mensaje: "No se aplicó: la póliza cambió." } });
  assert.equal(rechazado.resultado, "con_advertencias");
  assert.deepEqual(rechazado.detalle.notas, ["No se aplicó: la póliza cambió."]);

  const fallo = entradaCambio({ cambio: cambioPoliza, decision: "aplicar", por: "Carlos", error: new Error("Quota exceeded") });
  assert.equal(fallo.resultado, "error");
  assert.deepEqual(fallo.detalle.notas, ["Quota exceeded"]);

  const cancelado = entradaCambio({ cambio: cambioPoliza, decision: "cancelar", por: "Carlos" });
  assert.equal(cancelado.resultado, "sin_novedades");
  assert.equal(cancelado.resumen, "Carlos canceló la propuesta: cambio en la póliza woba_rc_markel (estadoPago, notas). No se cambió nada.");
});

test("un error de una tarea consta con su causa, acotada", () => {
  const e = entradaError("pagos", "programada", new Error("boom"), "La revisión falló");
  assert.equal(e.resultado, "error");
  assert.equal(e.resumen, "La revisión falló: boom");
  assert.ok(entradaError("pagos", "programada", new Error("x".repeat(5000))).resumen.length <= 400);
  assert.equal(entradaError("vigilante", "programada", "texto suelto").resumen, "La tarea falló: texto suelto");
});
