import assert from "node:assert/strict";
import test from "node:test";
import { aplicarEstados, coincide, ENCABEZADOS, ESTADO_CONCILIADO, ESTADO_PARCIAL, ESTADO_PENDIENTE, fusionarHoja, migrarEsquema } from "./hojaSeguimiento";
import { redactarCorreoSoportes, type CargoCorreo } from "./redactarCorreoSoportes";
import { redactarCorreoSoportesHtml } from "./correoSoportesHtml";

const cargo = (fecha: string, comercio: string, total: number, extra: Partial<CargoCorreo> = {}): CargoCorreo =>
  ({ id: `${fecha}-${comercio}`, fecha, comercio, total: -Math.abs(total), monedaCuenta: "EUR", importeOriginal: Math.abs(total), monedaOriginal: "EUR", tarjeta4: "1766", ...extra });
const fila = (f: Partial<Record<number, string>>): string[] => Array.from({ length: 12 }, (_, i) => f[i] ?? "");
const SIXT = fila({ 0: "2026-09-07", 1: "Sixt Dgnx2fjb2", 2: "189.64", 3: "EUR", 4: "189.64", 5: "EUR", 6: ESTADO_PENDIENTE, 7: "2026-09-14", 8: "2026-10-06", 9: "Simon: la reserva inicial, ignorar", 10: "WOBA: factura 294,40 ya conciliada", 11: "2026-10-09" });

test("un cargo ya en la hoja conserva comentario, respuesta y primera fecha; solo cambian estado y último pedido", () => {
  const r = fusionarHoja([SIXT], [cargo("2026-09-06", "Sixt Dgnx2fjb2", 189.64)], "2026-10-20");
  assert.equal(r.filas.length, 1);
  assert.equal(r.nuevas, 0); assert.equal(r.yaPedidas, 1);
  const f = r.filas[0];
  assert.equal(f[9], "Simon: la reserva inicial, ignorar"); assert.equal(f[10], "WOBA: factura 294,40 ya conciliada");
  assert.equal(f[7], "2026-09-14"); assert.equal(f[8], "2026-10-20"); assert.equal(f[6], ESTADO_PENDIENTE); assert.equal(f[11], "2026-10-20");
});

test("un cargo nuevo se añade al final con primera y última fecha de hoy y sin comentarios", () => {
  const r = fusionarHoja([SIXT], [cargo("2026-10-08", "Café Roma", 4.5)], "2026-10-20");
  assert.equal(r.filas.length, 2); assert.equal(r.nuevas, 1); assert.equal(r.yaPedidas, 0);
  assert.deepEqual(r.filas[1], ["2026-10-08", "Café Roma", "4.5", "EUR", "4.5", "EUR", ESTADO_PENDIENTE, "2026-10-20", "2026-10-20", "", "", "2026-10-20"]);
});

test("la coincidencia tolera 2 días entre extracto y banco, exige mismo importe y moneda, y una fila no se usa dos veces", () => {
  const base = { fecha: "2026-09-07", cargo: 189.64, monedaCuenta: "EUR" };
  assert.equal(coincide(SIXT, { ...base, fecha: "2026-09-09" }), true);
  assert.equal(coincide(SIXT, { ...base, fecha: "2026-09-10" }), false);
  assert.equal(coincide(SIXT, { ...base, cargo: 189.65 }), true, "un céntimo de redondeo no impide reconocer el cargo");
  assert.equal(coincide(SIXT, { ...base, cargo: 189.70 }), false);
  assert.equal(coincide(SIXT, { ...base, monedaCuenta: "USD" }), false);
  const r = fusionarHoja([SIXT], [cargo("2026-09-07", "Sixt", 189.64), cargo("2026-09-07", "Sixt", 189.64)], "2026-10-20");
  assert.equal(r.filas.length, 2, "dos cargos iguales son dos filas, no se pisan");
});

test("no se pisa nada de lo que escribe la persona: solo se tocan columnas de datos al refrescar estados", () => {
  const filas = [SIXT.slice(), fila({ 0: "2026-08-06", 1: "Les Gourmandises", 4: "16.6", 5: "EUR", 6: ESTADO_PENDIENTE, 9: "enviado el 20/09" })];
  const cambios = aplicarEstados(filas, (_f, cargo) => (cargo === 16.6 ? ESTADO_CONCILIADO : undefined), "2026-10-21");
  assert.equal(cambios, 1);
  assert.equal(filas[1][6], ESTADO_CONCILIADO); assert.equal(filas[1][9], "enviado el 20/09"); assert.equal(filas[1][11], "2026-10-21");
  assert.equal(filas[0][6], ESTADO_PENDIENTE, "si Holded no localiza el cargo, la fila no se toca");
  assert.equal(aplicarEstados(filas, () => ESTADO_PARCIAL, "2026-10-22"), 2);
});

test("la primera versión de la hoja (columnas «Requested Sep 14 / Oct 6» con yes) se migra a primera y última fecha sin perder comentarios", () => {
  const viejo = [
    [...ENCABEZADOS.slice(0, 7), "Requested Sep 14", "Requested Oct 6", ...ENCABEZADOS.slice(9)],
    fila({ 0: "2026-09-07", 4: "189.64", 5: "EUR", 7: "yes", 8: "yes", 9: "comentario" }),
    fila({ 0: "2026-10-04", 4: "36.47", 5: "USD", 7: "", 8: "yes" }),
    fila({ 0: "2026-09-13", 4: "17.2", 5: "EUR", 7: "yes", 8: "" }),
  ];
  const n = migrarEsquema(viejo)!;
  assert.deepEqual(n[0], ENCABEZADOS);
  assert.deepEqual([n[1][7], n[1][8], n[1][9]], ["2026-09-14", "2026-10-06", "comentario"]);
  assert.deepEqual([n[2][7], n[2][8]], ["2026-10-06", "2026-10-06"]);
  assert.deepEqual([n[3][7], n[3][8]], ["2026-09-14", "2026-09-14"]);
  assert.equal(migrarEsquema(n), null, "una hoja ya migrada no se toca");
});

test("con hoja compartida el correo ya no pide reenviar lo enviado ni adjunta Excel: da el enlace y dice dónde indicarlo", () => {
  const datos = { titular: "Simon Talloen", empresa: "Footprint", desde: "2026-08-01", hasta: "2026-10-06", cargos: [cargo("2026-10-08", "Café Roma", 4.5)], yaSolicitados: 1, hojaUrl: "https://docs.google.com/spreadsheets/d/abc/edit" };
  for (const texto of [redactarCorreoSoportes(datos), redactarCorreoSoportesHtml(datos)]) {
    assert.ok(texto.includes("https://docs.google.com/spreadsheets/d/abc/edit"));
    assert.ok(!/te agradecemos que los reenvíes/.test(texto), "no se pide reenviar lo ya enviado");
    assert.ok(!/en Excel/.test(texto), "no se menciona un Excel adjunto");
    assert.match(texto, /no hace falta que lo reenvíes/);
    assert.match(texto, /Comment/);
  }
  const sin = redactarCorreoSoportes({ ...datos, hojaUrl: undefined });
  assert.match(sin, /te agradecemos que los reenvíes/);
  assert.match(sin, /en Excel/);
});
