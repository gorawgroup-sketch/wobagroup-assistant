import assert from "node:assert/strict";
import test from "node:test";
import { botonesResumen, notaDeRecuento, textoResumen } from "./campanaSoportes";
import type { PersonaCampana } from "./campanaSoportesStore";
import { agruparPorTitular, coincideConPropuestaPendiente, cruzarConBanco, elegirCuentasHolded, type MovimientoBanco } from "./cruceExtracto";
import { esExtractoRevolut, esPagoConTarjeta, parsearCsv, parsearExtractoRevolut, periodoDelExtracto } from "./extractoRevolut";
import { asuntoCorreoSoportes, nombreDePila, redactarCorreoSoportes } from "./redactarCorreoSoportes";
import { empresaDeTexto, pareceCsv } from "./recibirExtracto";
import { coincideNombre } from "./titularesSoportesSheet";

const CABECERA = "Date started (UTC),Date completed (UTC),Date started (Europe/Madrid),Date completed (Europe/Madrid),ID,Type,State,Description,Reference,Payer,Card number,Card label,Card state,Orig currency,Orig amount,Payment currency,Amount,Total amount,Exchange rate,Fee,Fee currency,Balance,Account,International account number,Beneficiary account number,Beneficiary sort code or routing number,Beneficiary IBAN,Beneficiary BIC,Beneficiary name,MCC,Related transaction id,Spend program,Sender account,Sender name,Card references";
const fila = (o: { id: string; tipo?: string; estado?: string; fecha: string; desc: string; payer?: string; tarjeta?: string; orig?: number; origMoneda?: string; total: number; moneda?: string; cuenta?: string }) =>
  `${o.fecha},${o.fecha},${o.fecha},${o.fecha},${o.id},${o.tipo ?? "CARD_PAYMENT"},${o.estado ?? "COMPLETED"},"${o.desc}",,${o.payer ?? ""},${o.tarjeta ?? ""},Etiqueta,ACTIVE,${o.origMoneda ?? "EUR"},${o.orig ?? Math.abs(o.total)},${o.moneda ?? "EUR"},${o.total},${o.total},,0.00,EUR,100.00,${o.cuenta ?? "EUR Main"},,,,,,,,,,,,`;
const csv = (...filas: string[]) => [CABECERA, ...filas].join("\n");

const EXTRACTO = csv(
  fila({ id: "a1", fecha: "2026-10-05", desc: "Uber *trip Help.uber.c", payer: "Ana Prueba Lopez", tarjeta: "516760******5367", total: -26.96 }),
  fila({ id: "a2", fecha: "2026-10-04", desc: "Anthropic", payer: "Carlos Test Gómez", tarjeta: "516760******1816", total: -21.58 }),
  fila({ id: "a3", fecha: "2026-10-03", desc: "Dinero añadido por ACME, SL", tipo: "TOPUP", total: 444.16 }),
  fila({ id: "a4", fecha: "2026-10-02", desc: "Hotel", payer: "Ana Prueba Lopez", tarjeta: "516760******5367", total: -112.87, orig: 364546, origMoneda: "COP" }),
  fila({ id: "a5", fecha: "2026-10-02", desc: "Reembolso", tipo: "CARD_REFUND", payer: "Ana Prueba Lopez", total: 5 }),
  fila({ id: "a6", fecha: "2026-10-01", desc: "Pendiente", estado: "PENDING", payer: "Ana Prueba Lopez", total: -9 }),
);

const mov = (id: string, fecha: string, importe: number, estado: string, extra: Partial<MovimientoBanco> = {}): MovimientoBanco => ({
  id, cuentaId: "c1", cuenta: "Main", fecha, importe, moneda: "EUR", estado, descripcion: "x", ...extra,
});

test("el extracto de Revolut se reconoce por sus columnas, no por el nombre", () => {
  assert.equal(esExtractoRevolut(EXTRACTO), true);
  assert.equal(esExtractoRevolut("Fecha,Concepto,Importe\n2026-01-01,Pago,10"), false);
  assert.equal(esExtractoRevolut(""), false);
  assert.equal(pareceCsv("x.CSV", undefined), true);
  assert.equal(pareceCsv("x.pdf", "application/pdf"), false);
  assert.equal(pareceCsv(undefined, "text/csv"), true);
});

test("se leen titular, tarjeta y total; las comillas con comas no rompen las columnas", () => {
  const filas = parsearExtractoRevolut(EXTRACTO);
  assert.equal(filas.length, 6);
  const uber = filas[0];
  assert.equal(uber.titular, "Ana Prueba Lopez");
  assert.equal(uber.tarjeta4, "5367");
  assert.equal(uber.total, -26.96);
  assert.equal(uber.fecha, "2026-10-05");
  assert.equal(filas[2].comercio, "Dinero añadido por ACME, SL");
  assert.deepEqual(parsearCsv('a,"b,c",d\n1,2,3'), [["a", "b,c", "d"], ["1", "2", "3"]]);
  assert.deepEqual(periodoDelExtracto(filas), { desde: "2026-10-01", hasta: "2026-10-05" });
});

test("solo los pagos con tarjeta ya liquidados llevan soporte: ni ingresos, ni reembolsos, ni pendientes", () => {
  const pagos = parsearExtractoRevolut(EXTRACTO).filter(esPagoConTarjeta);
  assert.deepEqual(pagos.map((p) => p.id), ["a1", "a2", "a4"]);
});

test("cruce: conciliado, sin conciliar y aún sin sincronizar se distinguen", () => {
  const pagos = parsearExtractoRevolut(EXTRACTO).filter(esPagoConTarjeta);
  const r = cruzarConBanco(pagos, [
    mov("m1", "2026-10-05", -26.96, "pending"),
    mov("m2", "2026-10-04", -21.58, "reconciled"),
  ]);
  assert.deepEqual(r.map((c) => [c.fila.id, c.estado]), [["a1", "sin_conciliar"], ["a2", "conciliado"], ["a4", "no_sincronizado"]]);
});

test("cruce: «forced_reconciled» cuenta como conciliado y «partial» no se reclama como faltante", () => {
  const pagos = parsearExtractoRevolut(EXTRACTO).filter(esPagoConTarjeta);
  const r = cruzarConBanco(pagos, [mov("m1", "2026-10-05", -26.96, "forced_reconciled"), mov("m4", "2026-10-02", -112.87, "partial")]);
  assert.equal(r[0].estado, "conciliado");
  assert.equal(r[2].estado, "parcial");
});

test("cruce: otra moneda o un importe/fecha lejanos no se emparejan", () => {
  const pagos = parsearExtractoRevolut(EXTRACTO).filter(esPagoConTarjeta).slice(0, 1);
  assert.equal(cruzarConBanco(pagos, [mov("m1", "2026-10-05", -26.96, "pending", { moneda: "USD" })])[0].estado, "no_sincronizado");
  assert.equal(cruzarConBanco(pagos, [mov("m1", "2026-09-20", -26.96, "pending")])[0].estado, "no_sincronizado");
  assert.equal(cruzarConBanco(pagos, [mov("m1", "2026-10-05", 26.96, "pending")])[0].estado, "no_sincronizado");
  assert.equal(cruzarConBanco(pagos, [mov("m1", "2026-10-07", -26.96, "pending")])[0].estado, "sin_conciliar");
});

test("cruce: dos cargos gemelos con el mismo titular se emparejan uno a uno, sin reutilizar el movimiento", () => {
  const e = csv(
    fila({ id: "g1", fecha: "2026-10-05", desc: "Uber", payer: "Ana Prueba", total: -10 }),
    fila({ id: "g2", fecha: "2026-10-05", desc: "Uber", payer: "Ana Prueba", total: -10 }),
  );
  const pagos = parsearExtractoRevolut(e);
  const r = cruzarConBanco(pagos, [mov("m1", "2026-10-05", -10, "pending"), mov("m2", "2026-10-05", -10, "reconciled")]);
  assert.deepEqual(r.map((c) => c.estado).sort(), ["conciliado", "sin_conciliar"]);
  const solo = cruzarConBanco(pagos, [mov("m1", "2026-10-05", -10, "pending")]);
  assert.deepEqual(solo.map((c) => c.estado).sort(), ["no_sincronizado", "sin_conciliar"]);
});

test("cruce: gemelos de titulares distintos con estados distintos son ambiguos y no se reclaman a ciegas", () => {
  const e = csv(
    fila({ id: "g1", fecha: "2026-10-05", desc: "Uber", payer: "Ana Prueba", total: -10 }),
    fila({ id: "g2", fecha: "2026-10-05", desc: "Uber", payer: "Luis Otro", total: -10 }),
  );
  const r = cruzarConBanco(parsearExtractoRevolut(e), [mov("m1", "2026-10-05", -10, "pending"), mov("m2", "2026-10-05", -10, "reconciled")]);
  assert.deepEqual(r.map((c) => c.estado), ["ambiguo", "ambiguo"]);
});

test("un recibo que ya espera aprobación en el chat no se vuelve a pedir", () => {
  const [c] = cruzarConBanco(parsearExtractoRevolut(EXTRACTO).filter(esPagoConTarjeta).slice(0, 1), [mov("m1", "2026-10-05", -26.96, "pending")]);
  assert.equal(coincideConPropuestaPendiente(c, [{ proveedor: "Uber", monto: 26.96, moneda: "EUR", fecha: "2026-10-05" }]), true);
  assert.equal(coincideConPropuestaPendiente(c, [{ proveedor: "Uber", monto: 26.97, moneda: "EUR", fecha: "2026-10-05" }]), false);
  assert.equal(coincideConPropuestaPendiente(c, [{ proveedor: "Uber", monto: 26.96, moneda: "EUR", fecha: "2026-08-01" }]), false);
});

test("se agrupa por persona y los cargos sin titular quedan aparte", () => {
  const pagos = parsearExtractoRevolut(csv(
    fila({ id: "1", fecha: "2026-10-05", desc: "A", payer: "Ana Prueba", total: -1 }),
    fila({ id: "2", fecha: "2026-10-05", desc: "B", payer: "ANA  prueba", total: -2 }),
    fila({ id: "3", fecha: "2026-10-05", desc: "C", payer: "", total: -3 }),
    fila({ id: "4", fecha: "2026-10-05", desc: "D", payer: "Luis Ñandú", total: -4 }),
  ));
  const grupos = agruparPorTitular(pagos.map((fila) => ({ fila, estado: "sin_conciliar" as const })));
  assert.deepEqual(grupos.map((g) => [g.titular, g.cargos.length]), [["Ana Prueba", 2], ["(sin titular)", 1], ["Luis Ñandú", 1]]);
});

test("la cuenta del extracto se asocia a la cuenta de Holded por nombre, sin el código de moneda", () => {
  const cuentas = [{ name: "BBVA" }, { name: "Main", currency: "EUR" }, { name: "Pocket EUR", currency: "EUR" }, { name: "Pocket USD", currency: "USD" }, { name: "Emoney EUR", currency: "EUR" }];
  assert.deepEqual(elegirCuentasHolded("EUR Main", cuentas).map((c) => c.name), ["Main"]);
  assert.deepEqual(elegirCuentasHolded("USD Pocket", cuentas).map((c) => c.name), ["Pocket USD"]);
  assert.deepEqual(elegirCuentasHolded("EUR Pocket", cuentas).map((c) => c.name), ["Pocket EUR"]);
  assert.deepEqual(elegirCuentasHolded("Revolut Main EUR", [{ name: "Revolut Main EUR", currency: "EUR" }, { name: "FTG USD", currency: "USD" }]).map((c) => c.name), ["Revolut Main EUR"]);
  assert.deepEqual(elegirCuentasHolded("USD Main", [{ name: "FTG USD", currency: "USD" }, { name: "Otra", currency: "EUR" }]).map((c) => c.name), ["FTG USD"]);
});

test("la empresa sale del texto o del nombre del archivo, y solo si es una", () => {
  assert.equal(empresaDeTexto("transacciones de WOBA revolut", "transaction-statement.csv"), "WOBA");
  assert.equal(empresaDeTexto(undefined, "Footprint transaction-statement.csv"), "Footprint");
  assert.equal(empresaDeTexto("extracto EWORKS"), "EWORKS");
  assert.equal(empresaDeTexto("WOBA y Footprint"), undefined);
  assert.equal(empresaDeTexto("asistente@wobagroup.com"), undefined);
  assert.equal(empresaDeTexto("extracto"), undefined);
});

test("el directorio solo se acepta con al menos dos palabras en común", () => {
  assert.equal(coincideNombre("Carlos Alberto Gonzalez Guerrero", "Carlos Gonzalez"), true);
  assert.equal(coincideNombre("Carlos Alberto Gonzalez Guerrero", "Carlos"), false);
  assert.equal(coincideNombre("Ana Prueba Lopez", "Ana Otra"), false);
  assert.equal(coincideNombre("Álvaro Núñez", "alvaro nunez"), true);
});

const cargo = (o: Partial<{ id: string; fecha: string; comercio: string; total: number; monedaCuenta: string; importeOriginal: number; monedaOriginal: string; tarjeta4: string }>) => ({
  id: "1", fecha: "2026-10-05", comercio: "Uber *trip", total: -26.96, monedaCuenta: "EUR", importeOriginal: 26.96, monedaOriginal: "EUR", tarjeta4: "5367", ...o,
});

test("el correo es uno por persona, nunca suma monedas distintas y pide los soportes al buzón de Wobi", () => {
  const texto = redactarCorreoSoportes({
    titular: "ANA prueba lopez", empresa: "WOBA", desde: "2026-09-01", hasta: "2026-10-06",
    cargos: [cargo({}), cargo({ id: "2", comercio: "Hotel", total: -112.87, importeOriginal: 364546, monedaOriginal: "COP" }), cargo({ id: "3", comercio: "Vercel", total: -20, monedaCuenta: "USD", monedaOriginal: "USD", importeOriginal: 20 })],
  });
  assert.match(texto, /^Hola, Ana:/);
  assert.match(texto, /asistente@wobagroup\.com/);
  assert.match(texto, /mejorar la conciliación de gastos y estabilizar la contabilidad mensual/);
  assert.match(texto, /Si ya los habías enviado y te los pedimos de nuevo/);
  assert.match(texto, /Esto no debería volver a pasar/);
  assert.match(texto, /05\/10\/2026 · Uber \*trip · 26,96 EUR · tarjeta ···5367/);
  assert.match(texto, /364\.546,00 COP en el comercio/);
  assert.match(texto, /Total de 3 cargos: 139,83 EUR \+ 20,00 USD\./);
  assert.doesNotMatch(texto, /159,83/);
  assert.match(asuntoCorreoSoportes({ empresa: "WOBA", desde: "2026-09-01", hasta: "2026-10-06" }), /^WOBA · Soportes pendientes .* \(01\/09\/2026 – 06\/10\/2026\)$/);
  assert.equal(nombreDePila("  yessenia carolina"), "Yessenia");
});

test("un recordatorio lo dice y un solo cargo va en singular", () => {
  const t = redactarCorreoSoportes({ titular: "Ana P", empresa: "WOBA", desde: "2026-09-01", hasta: "2026-10-06", cargos: [cargo({})], yaSolicitados: 1 });
  assert.match(t, /Todos estos cargos ya te los habíamos pedido antes/);
  assert.match(t, /Total de 1 cargo:/);
});

const persona = (o: Partial<PersonaCampana>): PersonaCampana => ({
  rowIndex: 2, campana: "abcd1234", indice: 0, chatId: 1, messageId: 9, empresa: "WOBA", desde: "2026-09-01", hasta: "2026-10-06",
  titular: "Ana Prueba Lopez", email: "ana@x.com", fuenteEmail: "confirmado", seleccionado: true, estado: "pendiente", yaSolicitados: 0, creadoEn: 1,
  cargos: [cargo({})], nota: "Analicé el extracto.", sugerencias: "", ...o,
});

test("el resumen muestra una casilla por persona y avisa de quién no tiene email", () => {
  const ps = [persona({}), persona({ indice: 1, titular: "Luis Otro", email: "", fuenteEmail: "", seleccionado: false, nota: "" }), persona({ indice: 2, titular: "Boris D", email: "b@x.com", fuenteEmail: "directorio", seleccionado: false, nota: "" })];
  const t = textoResumen(ps);
  assert.match(t, /☑ Ana Prueba Lopez — 1 cargo · 26,96 EUR/);
  assert.match(t, /☐ Luis Otro/);
  assert.match(t, /sin email: escríbeme «el correo de Luis Otro es …»/);
  assert.match(t, /b@x\.com \(del directorio, confírmalo\)/);
  const botones = botonesResumen(ps).flat();
  assert.ok(botones.some((b) => b.text.startsWith("📤 Enviar 1 correo")));
  assert.ok(!botones.some((b) => b.callback_data === "sop_t:abcd1234:1"), "sin email no hay casilla");
  assert.ok(botones.every((b) => Buffer.byteLength(b.callback_data ?? "") <= 64));
});

test("tras enviar, la persona queda marcada y su casilla desaparece", () => {
  const ps = [persona({ estado: "enviado" })];
  assert.match(textoResumen(ps), /📤 Ana Prueba Lopez.*ENVIADO/s);
  assert.deepEqual(botonesResumen(ps), []);
});

test("el recuento explica cada grupo para que Carlos vea qué se dejó fuera y por qué", () => {
  const nota = notaDeRecuento({
    desde: "2026-09-01", hasta: "2026-10-06",
    cargos: [
      { estado: "no_sincronizado", fila: { fecha: "2026-10-05", comercio: "Uber   *trip", total: -12.99, monedaCuenta: "EUR" } as never },
      { estado: "no_sincronizado", fila: { fecha: "2026-09-11", comercio: "Uber   *trip", total: -10.96, monedaCuenta: "EUR" } as never },
    ],
    paraPedir: [{} as never, {} as never], cuentasSinResolver: ["USD Pocket"],
    recuento: { pagosConTarjeta: 39, conciliados: 30, parciales: 1, noSincronizados: 3, ambiguos: 1, conPropuestaPendiente: 2, pedidosRecientemente: 1, otrosMovimientos: 32 },
  }, "extracto.csv");
  assert.match(nota, /39 pagos con tarjeta/);
  assert.match(nota, /30 ya tienen su soporte conciliado/);
  assert.match(nota, /2 siguen sin conciliar/);
  assert.match(nota, /2 ya llegaron y esperan tu aprobación/);
  assert.match(nota, /1 aún no aparecen en Bancos de Holded/);
  assert.match(nota, /1 de hace más de 10 días no tienen en Holded un movimiento con ese mismo importe.*11\/09\/2026 Uber \*trip 10,96 EUR/);
  assert.match(nota, /No encontré en Holded la cuenta «USD Pocket»/);
});

import { decidirEmpresa } from "./recibirExtracto";
import { pareceDeOtraEmpresa } from "./campanaSoportes";
import { COMANDOS_MENU } from "../telegram/menuComandos";

test("la empresa se decide: texto del archivo, luego /soportes, luego el IBAN ya conocido", () => {
  assert.deepEqual(decidirEmpresa("EWORKS", "WOBA", []), { empresa: "EWORKS", origen: "texto" });
  assert.deepEqual(decidirEmpresa(undefined, "WOBA", []), { empresa: "WOBA", origen: "comando" });
  assert.deepEqual(decidirEmpresa(undefined, undefined, ["Footprint"]), { empresa: "Footprint", origen: "iban" });
  assert.deepEqual(decidirEmpresa(undefined, undefined, []), { error: "sin_empresa" });
});

test("un extracto de una cuenta ya conocida de otra empresa no se analiza", () => {
  assert.deepEqual(decidirEmpresa(undefined, "WOBA", ["EWORKS"]), { error: "iban_de_otra", conocida: "EWORKS", pedida: "WOBA" });
  assert.deepEqual(decidirEmpresa("WOBA", undefined, ["Footprint"]), { error: "iban_de_otra", conocida: "Footprint", pedida: "WOBA" });
  assert.deepEqual(decidirEmpresa("WOBA", undefined, ["WOBA", "EWORKS"]), { error: "iban_mezclado" });
  assert.deepEqual(decidirEmpresa("WOBA", undefined, ["WOBA"]), { empresa: "WOBA", origen: "texto" });
});

test("si casi nada del extracto aparece en Holded de la empresa elegida, se frena", () => {
  const r = (pagosConTarjeta: number, noSincronizados: number) => ({ recuento: { pagosConTarjeta, noSincronizados } as never });
  assert.equal(pareceDeOtraEmpresa(r(39, 3)), false);
  assert.equal(pareceDeOtraEmpresa(r(39, 35)), true);
  assert.equal(pareceDeOtraEmpresa(r(4, 4)), false, "con tan pocos pagos no se puede concluir");
  assert.equal(pareceDeOtraEmpresa(r(10, 7)), false, "30 % emparejado es el límite");
  assert.equal(pareceDeOtraEmpresa(r(10, 8)), true);
});

test("el comando está en el menú", () => {
  assert.ok(COMANDOS_MENU.some((c) => c.command === "soportes"));
});

import ExcelJS from "exceljs";
import { direccionesDeHeader, encajaConPersona } from "./direccionesEnBuzon";
import { decidirEmailTitular } from "./emailTitular";
import { esTitularEmpresa } from "./cruceExtracto";
import { generarSeguimientoXlsx, redactarCorreoSoportesHtml, tablaCargosHtml } from "./correoSoportesHtml";

test("las direcciones de un header se leen con y sin nombre, y con comas dentro de comillas", () => {
  assert.deepEqual(direccionesDeHeader('Alberto Comolli <Alberto@WobaGroup.com>, "Gonzalez, Carlos" <carlos@x.com>, solo@y.org'), [
    { nombre: "Alberto Comolli", email: "alberto@wobagroup.com" },
    { nombre: "Gonzalez, Carlos", email: "carlos@x.com" },
    { nombre: "", email: "solo@y.org" },
  ]);
  assert.deepEqual(direccionesDeHeader(""), []);
});

test("una dirección encaja con la persona solo con dos palabras en común (nombre visto o parte local)", () => {
  assert.equal(encajaConPersona("Nuria Coral Ortiz Herranz", "Nuria Ortiz", "nuria.ortiz@footprint.global"), true);
  assert.equal(encajaConPersona("Nicolas David Gomez Osorio", "Nicolás Gómez", "nicolas.gomez@footprint.global"), true);
  assert.equal(encajaConPersona("Kelly Johanna Correales Ducuara", "Kelly J. Correales Ducuara", "kelly@footprint.global"), true);
  assert.equal(encajaConPersona("Juan Camilo Salazar Gonzalez", "Juan Pérez", "juan@x.com"), false);
  assert.equal(encajaConPersona("Alberto Comolli", "Alberto Otro", "alberto@x.com"), false);
});

const dir = (email: string, fuerte = true, extra = {}) => ({ email, fuerte, nombreVisto: "", comoRemitente: 3, comoDestinatario: 0, ...extra });

test("el email se decide: una sola dirección segura, o varias para elegir, o solo sugerencias", () => {
  assert.deepEqual(decidirEmailTitular([], [dir("kelly@footprint.global")]), { tipo: "resuelto", email: "kelly@footprint.global", fuente: "buzon" });
  assert.deepEqual(decidirEmailTitular(["nuria.ortiz@footprint.global"], [dir("nuria.ortiz@footprint.global")]), { tipo: "resuelto", email: "nuria.ortiz@footprint.global", fuente: "directorio" });
  assert.deepEqual(decidirEmailTitular([], []), { tipo: "nada" });
  assert.deepEqual(decidirEmailTitular([], [dir("alberto@x.com", false)]), { tipo: "sugerencias", candidatos: ["alberto@x.com"] });
});

test("con dos direcciones se elige la del dominio de la empresa; si no hay una sola, se ofrecen todas", () => {
  const dos = [dir("alberto@wobagroup.com"), dir("alberto@footprint.global")];
  assert.deepEqual(decidirEmailTitular([], dos, "footprint.global"), { tipo: "resuelto", email: "alberto@footprint.global", fuente: "buzon" });
  assert.deepEqual(decidirEmailTitular([], dos, "wobagroup.com"), { tipo: "resuelto", email: "alberto@wobagroup.com", fuente: "buzon" });
  assert.deepEqual(decidirEmailTitular([], dos), { tipo: "varios", candidatos: ["alberto@wobagroup.com", "alberto@footprint.global"] });
  const simon = decidirEmailTitular(["s.talloen@gmail.com"], [dir("s.talloen@gmail.com"), dir("simon@footprint.global")]);
  assert.equal(simon.tipo, "varios", "dos direcciones sin preferencia de dominio no se deciden solas");
});

test("una sociedad no es una persona a quien escribir", () => {
  assert.equal(esTitularEmpresa("BUSINESS FOOTPRINT EU, SOCIEDAD LIMITADA"), true);
  assert.equal(esTitularEmpresa("Acme Holdings LLC"), true);
  for (const n of ["Kelly Johanna Correales Ducuara", "Jorge Gerardo Jácome Muñoz", "Juan Camilo Salazar Gonzalez", "Yessenia Carolina Dos Prazeres Ferreira", "Alejandro Florez Lopez", "Simon Talloen"]) {
    assert.equal(esTitularEmpresa(n), false, n);
  }
});

test("el resumen muestra las direcciones posibles cuando no hay una segura, y ofrece marcar a todos", () => {
  const ps = [
    persona({ email: "ana@x.com", fuenteEmail: "buzon", seleccionado: false }),
    persona({ indice: 1, titular: "Simon Talloen", email: "", fuenteEmail: "", seleccionado: false, sugerencias: "s.talloen@gmail.com, simon@footprint.global", nota: "" }),
    persona({ indice: 2, titular: "BUSINESS FOOTPRINT EU, SOCIEDAD LIMITADA", email: "", fuenteEmail: "", seleccionado: false, estado: "omitido", nota: "" }),
  ];
  const t = textoResumen(ps);
  assert.match(t, /ana@x\.com \(del buzón de Wobi, confírmalo\)/);
  assert.match(t, /sin email seguro\. Posibles: s\.talloen@gmail\.com, simon@footprint\.global/);
  assert.match(t, /tarjeta de empresa, no de una persona/);
  assert.ok(botonesResumen(ps).flat().some((b) => b.callback_data === "sop_m:abcd1234"));
});

const DATOS = {
  titular: "Simon Talloen", empresa: "Footprint", desde: "2026-08-01", hasta: "2026-10-06",
  cargos: [
    cargo({ id: "2", fecha: "2026-10-05", comercio: "Airbnb * <Hm25>", total: -386, monedaCuenta: "USD", importeOriginal: 339.2, monedaOriginal: "EUR", tarjeta4: "1766" }),
    cargo({ id: "1", fecha: "2026-10-02", comercio: "Tienda D1   Manila", total: -10.33, importeOriginal: 38360, monedaOriginal: "COP", tarjeta4: "1766" }),
  ],
};

test("el correo lleva un cuadro HTML ordenado por fecha, con totales por moneda y sin colar HTML del comercio", () => {
  const tabla = tablaCargosHtml(DATOS);
  assert.match(tabla, /<th[^>]*>Nº<\/th>.*Fecha.*Comercio.*Importe cargado.*Importe en el comercio.*Tarjeta.*Soporte/s);
  assert.ok(tabla.indexOf("Tienda D1 Manila") < tabla.indexOf("Airbnb"), "orden por fecha");
  assert.match(tabla, /Airbnb \* &lt;Hm25&gt;/);
  assert.match(tabla, /386,00 USD/);
  assert.match(tabla, /38\.360,00 COP/);
  assert.match(tabla, /Total EUR/);
  assert.match(tabla, /Total USD/);
  assert.match(tabla, /☐ Pendiente/);
  const html = redactarCorreoSoportesHtml(DATOS);
  assert.match(html, /Hola, Simon:/);
  assert.match(html, /mailto:asistente@wobagroup\.com/);
  assert.match(html, /solo para tu propio control/);
  assert.ok(html.split("\n").every((l) => l.length < 900), "líneas cortas para el MIME");
});

test("la hoja de seguimiento trae la misma lista, importes numéricos, estado desplegable y totales", async () => {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(await generarSeguimientoXlsx(DATOS) as never);
  const hoja = libro.getWorksheet("Soportes pendientes")!;
  assert.deepEqual((hoja.getRow(1).values as unknown[]).slice(1, 12), ["Nº", "Fecha", "Comercio", "Importe cargado", "Moneda", "Importe en el comercio", "Moneda comercio", "Tarjeta", "Estado del soporte", "Fecha en que lo enviaste", "Comentarios"]);
  assert.equal(hoja.getCell("C2").value, "Tienda D1 Manila");
  assert.equal(hoja.getCell("D2").value, 10.33);
  assert.equal(hoja.getCell("I2").value, "Pendiente");
  assert.match(String(hoja.getCell("I2").dataValidation.formulae?.[0]), /No lo reconozco/);
  assert.equal(hoja.getCell("F3").value, 339.2);
  const total = hoja.getRow(5);
  assert.equal(total.getCell(3).value, "Total EUR");
  assert.match(String((total.getCell(4).value as { formula: string }).formula), /SUMIF\(E2:E3,"EUR",D2:D3\)/);
});

import { construirMimeConAdjuntos } from "../gmail/client";

test("el MIME lleva texto plano + HTML con la tabla + la hoja adjunta, y ninguna línea pasa de 998 caracteres", async () => {
  const mime = construirMimeConAdjuntos({
    to: "a@b.com", asunto: "Soportes", cuerpo: redactarCorreoSoportes(DATOS), cuerpoHtml: redactarCorreoSoportesHtml(DATOS),
    messageIdPropio: "<x@y>", adjuntos: [{ filename: "s.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: await generarSeguimientoXlsx(DATOS) }],
  }).toString("utf-8");
  assert.match(mime, /Content-Type: multipart\/mixed/);
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(mime, /Content-Type: text\/html; charset="UTF-8"/);
  assert.match(mime, /<table /);
  assert.match(mime, /filename="s\.xlsx"/);
  assert.ok(mime.split(/\r?\n/).every((l) => l.length <= 998));
});
