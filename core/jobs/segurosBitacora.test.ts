import assert from "node:assert/strict";
import test from "node:test";
import { items, resultadoVigilante } from "../seguros/bitacora/pruebas";
import type { EntradaNueva } from "../seguros/bitacora/tipos";
import type { DepsCalendarioPagos } from "../seguros/pagos/calendarioPagos";
import { pago } from "../seguros/pagos/pruebas";
import type { PagoSeguro, PagoSeguroConFila } from "../seguros/pagos/tipos";
import type { Informe } from "../seguros/vigilante/informe";
import type { FuentesVigilante, ResultadoVigilante } from "../seguros/vigilante/vigilante";
import { informeSemanalSeguros } from "./informeSemanalSeguros";
import { revisarAlertasSeguros } from "./revisarAlertasSeguros";
import { revisarPagosSeguros } from "./revisarPagosSeguros";
import { revisarSegurosVigilante } from "./revisarSegurosVigilante";

/** Ejecuta con (o sin) el chat de alertas configurado y la consola en silencio; deja el entorno como estaba. */
async function conChat<T>(valor: string | undefined, trabajo: () => Promise<T>): Promise<T> {
  const previo = process.env.CASHFLOW_ALERTS_CHAT_ID;
  if (valor === undefined) delete process.env.CASHFLOW_ALERTS_CHAT_ID; else process.env.CASHFLOW_ALERTS_CHAT_ID = valor;
  const consola = [console.error, console.log, console.warn];
  console.error = console.log = console.warn = () => {};
  try { return await trabajo(); } finally {
    [console.error, console.log, console.warn] = consola;
    if (previo === undefined) delete process.env.CASHFLOW_ALERTS_CHAT_ID; else process.env.CASHFLOW_ALERTS_CHAT_ID = previo;
  }
}

function registrador() {
  const registros: Array<{ entrada: EntradaNueva; opciones?: { podar?: boolean } }> = [];
  const registrar = async (entrada: EntradaNueva, opciones?: { podar?: boolean }) => { registros.push({ entrada, opciones }); return true; };
  return { registrar, registros };
}

const informe: Informe = { titulo: "🛡️ Seguros", cuerpo: "Cuerpo del aviso" };

// --- vigilante ----------------------------------------------------------------------------------------------------

function montarVigilante(resultado: ResultadoVigilante, opciones: { enviarFalla?: boolean; ejecutarFalla?: boolean } = {}) {
  const guardado: Array<{ id: string; version: string }> = [];
  const borrado: string[] = [];
  const enviados: string[] = [];
  let ejecuciones = 0;
  const fuentes = {
    ahora: () => new Date("2026-10-08T15:35:07Z"),
    guardarEstado: async (pares: Array<{ id: string; version: string }>) => { guardado.push(...pares); },
    borrarEstado: async (ids: string[]) => { borrado.push(...ids); },
  } as unknown as FuentesVigilante;
  const enviar = async (_chat: number, i: Informe) => { if (opciones.enviarFalla) throw new Error("Telegram 500"); enviados.push(i.titulo); };
  const ejecutar = async () => { ejecuciones++; if (opciones.ejecutarFalla) throw new Error("Holded 503"); return resultado; };
  return { fuentes, enviar, ejecutar, guardado, borrado, enviados, ejecuciones: () => ejecuciones };
}

test("vigilante sin novedades: no avisa, guarda su última revisión y deja constancia de que corrió", async () => {
  const m = montarVigilante(resultadoVigilante());
  const r = registrador();
  const salida = await conChat("4242", () => revisarSegurosVigilante(m.fuentes, m.enviar, { registrar: r.registrar, ejecutar: m.ejecutar }));
  assert.deepEqual(salida, { avisado: false });
  assert.equal(m.enviados.length, 0);
  assert.ok(m.guardado.some((g) => g.id === "ultima_revision"), "el panel sigue teniendo su «última revisión»");
  assert.equal(r.registros.length, 1);
  assert.equal(r.registros[0].entrada.tarea, "vigilante");
  assert.equal(r.registros[0].entrada.origen, "programada");
  assert.equal(r.registros[0].entrada.resultado, "sin_novedades");
});

test("vigilante con un aviso entregado: la constancia guarda el texto que recibió Carlos y marca lo avisado", async () => {
  const resultado = { ...resultadoVigilante({ nuevo: { confirmados: items(1) }, informe }), clavesAvisadas: [{ id: "pago:x", version: "1" }] };
  const m = montarVigilante(resultado);
  const r = registrador();
  const salida = await conChat("4242", () => revisarSegurosVigilante(m.fuentes, m.enviar, { registrar: r.registrar, ejecutar: m.ejecutar }));
  assert.deepEqual(salida, { avisado: true });
  assert.deepEqual(m.enviados, ["🛡️ Seguros"]);
  assert.ok(m.guardado.some((g) => g.id === "pago:x"));
  assert.equal(r.registros[0].entrada.resultado, "con_novedades");
  assert.deepEqual(r.registros[0].entrada.detalle.avisos, [{ canal: "telegram", titulo: "🛡️ Seguros", texto: "Cuerpo del aviso", entregado: true, entregadoEn: "2026-10-08T15:35:07.000Z" }]);
});

test("vigilante cuyo aviso no llega a Telegram: queda pendiente de reenvío y la constancia lo dice (no finge que llegó)", async () => {
  const m = montarVigilante({ ...resultadoVigilante({ nuevo: { devoluciones: items(1) }, informe }), clavesAvisadas: [{ id: "dev:y", version: "1" }] }, { enviarFalla: true });
  const r = registrador();
  const salida = await conChat("4242", () => revisarSegurosVigilante(m.fuentes, m.enviar, { registrar: r.registrar, ejecutar: m.ejecutar }));
  assert.deepEqual(salida, { avisado: false });
  assert.ok(m.guardado.some((g) => g.id === "pendiente_envio"), "el informe queda guardado para reenviarlo");
  assert.equal(r.registros[0].entrada.resultado, "con_advertencias");
  assert.equal(r.registros[0].entrada.detalle.avisos?.[0].entregado, false);
  assert.equal(r.registros[0].entrada.detalle.avisos?.[0].entregadoEn, undefined, "no llegó: no hay hora de entrega");
});

test("vigilante que reenvía un informe anterior pendiente lo anota y libera el pendiente", async () => {
  const m = montarVigilante({ ...resultadoVigilante(), pendienteEnvio: { titulo: "Antiguo", cuerpo: "No llegó ayer" } });
  const r = registrador();
  const salida = await conChat("4242", () => revisarSegurosVigilante(m.fuentes, m.enviar, { registrar: r.registrar, ejecutar: m.ejecutar }));
  assert.deepEqual(salida, { avisado: true });
  assert.deepEqual(m.enviados, ["Antiguo"]);
  assert.deepEqual(m.borrado, ["pendiente_envio"]);
  assert.match(r.registros[0].entrada.resumen, /reenviado un aviso anterior que no había llegado/);
  assert.deepEqual(r.registros[0].entrada.detalle.avisos, [{ canal: "telegram", titulo: "Antiguo", texto: "No llegó ayer", entregado: true, entregadoEn: "2026-10-08T15:35:07.000Z" }], "el reenvío también consta como aviso, con su hora");
});

test("si el vigilante falla, queda la constancia del error y el fallo sigue subiendo al planificador", async () => {
  const m = montarVigilante(resultadoVigilante(), { ejecutarFalla: true });
  const r = registrador();
  await assert.rejects(() => conChat("4242", () => revisarSegurosVigilante(m.fuentes, m.enviar, { registrar: r.registrar, ejecutar: m.ejecutar })), /Holded 503/);
  assert.equal(r.registros.length, 1);
  assert.equal(r.registros[0].entrada.resultado, "error");
  assert.match(r.registros[0].entrada.resumen, /La revisión falló: Holded 503/);
});

test("sin el chat de alertas configurado el vigilante no revisa nada, pero lo deja dicho en la bitácora en vez de callar", async () => {
  const m = montarVigilante(resultadoVigilante());
  const r = registrador();
  const salida = await conChat(undefined, () => revisarSegurosVigilante(m.fuentes, m.enviar, { registrar: r.registrar, ejecutar: m.ejecutar }));
  assert.deepEqual(salida, { avisado: false });
  assert.equal(m.ejecuciones(), 0);
  assert.equal(r.registros[0].entrada.resultado, "error");
  assert.match(r.registros[0].entrada.resumen, /Falta CASHFLOW_ALERTS_CHAT_ID/);
});

// --- calendario de pagos ------------------------------------------------------------------------------------------

function montarPagos(hoy: string, pagos: PagoSeguro[], opciones: { leerFalla?: boolean } = {}) {
  let filas: PagoSeguroConFila[] = pagos.map((p, i) => ({ ...p, rowIndex: i + 2 }));
  const deps: DepsCalendarioPagos = {
    hoy: () => hoy,
    leerPagos: async () => { if (opciones.leerFalla) throw new Error("Sheets agotado"); return filas.map((f) => ({ ...f })); },
    actualizar: async (p, cambios) => { const nuevo = { ...p, ...cambios }; filas = filas.map((f) => (f.id === p.id ? nuevo : f)); return nuevo; },
    cuentas: async () => [{ nombre: "BBVA", moneda: "EUR", saldo: 654.81, tipo: "bank" }],
    crearEvento: async () => "evt-1",
    borrarEvento: async () => {},
  };
  return { deps, filas: () => filas };
}

test("calendario de pagos: crea el evento, deja constancia con el evento y la pasada pide podar la bitácora", async () => {
  const m = montarPagos("2026-10-09", [pago({ fecha: "2027-03-01" })]);
  const r = registrador();
  const enviados: Informe[] = [];
  const salida = await conChat("4242", () => revisarPagosSeguros(m.deps, async (_c, i) => { enviados.push(i); }, r.registrar));
  assert.deepEqual(salida, { avisado: false });
  assert.equal(enviados.length, 0, "el pago está lejos: no toca avisar");
  assert.equal(r.registros.length, 1);
  const { entrada, opciones } = r.registros[0];
  assert.deepEqual(opciones, { podar: true });
  assert.equal(entrada.tarea, "pagos");
  assert.equal(entrada.resultado, "con_novedades");
  assert.equal(entrada.detalle.eventos?.length, 1);
  assert.equal(entrada.detalle.eventos?.[0].accion, "creado");
  assert.match(entrada.resumen, /1 pago previsto · eventos de calendario: 1 creado\(s\), 0 retirado\(s\) · próximo pago: 01\/03\/2027/);
});

test("calendario de pagos que avisa: el aviso entregado consta con su texto y queda marcado en el pago", async () => {
  const m = montarPagos("2026-10-09", [pago({ fecha: "2026-10-12", eventoCalendarId: "evt-0" })]);
  const r = registrador();
  const enviados: Informe[] = [];
  const salida = await conChat("4242", () => revisarPagosSeguros(m.deps, async (_c, i) => { enviados.push(i); }, r.registrar, () => new Date("2026-10-09T06:55:20.000Z")));
  assert.deepEqual(salida, { avisado: true });
  assert.equal(enviados.length, 1);
  assert.equal(m.filas()[0].avisos, "d3");
  const { entrada } = r.registros[0];
  assert.equal(entrada.resultado, "con_novedades");
  assert.equal(entrada.detalle.avisos?.[0].entregado, true);
  assert.equal(entrada.detalle.avisos?.[0].texto, enviados[0].cuerpo);
  assert.equal(entrada.detalle.avisos?.[0].entregadoEn, "2026-10-09T06:55:20.000Z", "la hora en que Telegram aceptó el mensaje, no la del final de la pasada");
});

test("calendario de pagos cuyo aviso no llega: no se marca como enviado (se repite) y la constancia lo dice", async () => {
  const m = montarPagos("2026-10-09", [pago({ fecha: "2026-10-12", eventoCalendarId: "evt-0" })]);
  const r = registrador();
  const salida = await conChat("4242", () => revisarPagosSeguros(m.deps, async () => { throw new Error("Telegram 500"); }, r.registrar));
  assert.deepEqual(salida, { avisado: false });
  assert.equal(m.filas()[0].avisos, "", "no se marca: se vuelve a intentar mañana");
  assert.equal(r.registros[0].entrada.resultado, "con_advertencias");
  assert.equal(r.registros[0].entrada.detalle.avisos?.[0].entregado, false);
});

test("calendario de pagos que no puede leer el calendario: constancia del error y el fallo sigue subiendo", async () => {
  const m = montarPagos("2026-10-09", [], { leerFalla: true });
  const r = registrador();
  await assert.rejects(() => conChat("4242", () => revisarPagosSeguros(m.deps, async () => {}, r.registrar)), /Sheets agotado/);
  assert.equal(r.registros[0].entrada.resultado, "error");
  assert.deepEqual(r.registros[0].opciones, { podar: true });
});

// --- avisos del registro y resumen semanal (sin tocar Sheets: solo el caso sin chat configurado) -----------------------

test("sin el chat de alertas, los avisos del registro y el resumen semanal también dejan su error en la bitácora", async () => {
  const avisos = registrador();
  assert.deepEqual(await conChat(undefined, () => revisarAlertasSeguros(avisos.registrar)), { avisosEnviados: 0 });
  assert.equal(avisos.registros[0].entrada.tarea, "avisos");
  assert.equal(avisos.registros[0].entrada.resultado, "error");

  const semanal = registrador();
  assert.deepEqual(await conChat(undefined, () => informeSemanalSeguros(semanal.registrar)), { enviado: false });
  assert.equal(semanal.registros[0].entrada.tarea, "semanal");
  assert.equal(semanal.registros[0].entrada.resultado, "error");
});
