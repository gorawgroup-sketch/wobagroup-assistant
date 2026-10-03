import assert from "node:assert/strict";
import test from "node:test";
import { detectarTransferencias, type CuentaTransferencia, type MovimientoTransferencia } from "./deteccion";
import { aMovimiento } from "./lectura";

// Cuentas y descripciones calcadas de los patrones reales vistos en Holded el 03-10-2026 (importes inventados salvo indicación).
const HOY = "2026-10-03";
const cuenta = (id: string, moneda: string, proveedor: string, extra: Partial<CuentaTransferencia> = {}): CuentaTransferencia =>
  ({ id, nombre: id, tipo: "bank", moneda, archivada: false, proveedor, sincronizadaEn: "2026-10-03T14:00:00+00:00", ...extra });
const CUENTAS = [
  cuenta("main", "EUR", "Revolut"), cuenta("pocket", "EUR", "Revolut"), cuenta("usd", "USD", "Revolut"), cuenta("cop", "COP", "Revolut"),
  cuenta("bbva", "EUR", "BBVA"), cuenta("wise-eur", "EUR", "Wise"), cuenta("wise-usd", "USD", "Wise"),
];
let n = 0;
const mov = (cuentaId: string, fecha: string, importe: number, descripcion: string, extra: Partial<MovimientoTransferencia> = {}): MovimientoTransferencia => {
  const moneda = CUENTAS.find((c) => c.id === cuentaId)?.moneda ?? "EUR";
  return { id: `m${++n}`, cuentaId, fecha, importe, moneda, descripcion, estado: "pending", conciliado: 0, ...extra };
};
const detectar = (movs: MovimientoTransferencia[], cuentas = CUENTAS, tasa?: (f: string, a: string, b: string) => number | undefined) =>
  detectarTransferencias("WOBA", cuentas, movs, { hoy: HOY, tasaHistorica: tasa }).propuestas;
const PROPIA_SALE = "To Business Atelier Europa Sl Transferencia Propia Para Pago Sobregiro";
const PROPIA_ENTRA = "Transferencia propia para pago sobregiro TRANSFERENCIAS";

test("transferencia EUR↔EUR exacta entre dos cuentas propias: inequívoca", () => {
  const p = detectar([mov("main", "2026-10-01", -350, PROPIA_SALE), mov("bbva", "2026-10-01", 350, PROPIA_ENTRA)]);
  assert.equal(p.length, 1);
  assert.equal(p[0].tipo, "transferencia");
  assert.equal(p[0].confianza, "automatica");
  assert.equal(p[0].origen.cuenta.id, "main");
  assert.equal(p[0].destino.cuenta.id, "bbva");
  assert.equal(p[0].clave, `WOBA:${p[0].origen.movimiento.id}>${p[0].destino.movimiento.id}`);
});

test("la transferencia admite hasta dos días hábiles entre las dos patas, saltando el fin de semana, y no más", () => {
  // Viernes 25/09 → lunes 28/09 es un día hábil.
  assert.equal(detectar([mov("main", "2026-09-25", -350, PROPIA_SALE), mov("bbva", "2026-09-28", 350, PROPIA_ENTRA)]).length, 1);
  assert.equal(detectar([mov("main", "2026-09-22", -350, PROPIA_SALE), mov("bbva", "2026-09-25", 350, PROPIA_ENTRA)]).length, 0);
});

test("un céntimo de diferencia en la misma moneda no es una transferencia", () => {
  assert.equal(detectar([mov("main", "2026-10-01", -350, PROPIA_SALE), mov("bbva", "2026-10-01", 350.01, PROPIA_ENTRA)]).length, 0);
});

// Caso real (WOBA, 16/09/2026): el mismo día y por el mismo importe entraron una transferencia propia y un préstamo de eWorks.
test("mismo importe y fecha, pero la otra parte es otra sociedad del grupo: no es transferencia propia", () => {
  const propia = mov("bbva", "2026-09-16", 1900, "Transferencia propia para descuentos TRANSFERENCIAS BUSINESS ATELIER E");
  const prestamo = mov("pocket", "2026-09-16", 1900, "From Compania De Proyectos Eworks Sl. Prestamo");
  const p = detectar([mov("main", "2026-09-16", -1900, "To Business Atelier Europa Sl Transferencia Propia Para Descuentos"), propia, prestamo]);
  assert.equal(p.length, 1);
  assert.equal(p[0].destino.movimiento.id, propia.id);
  assert.equal(p[0].confianza, "automatica");
});

// Caso real (WOBA, 01/10/2026): cobro de «Business Atelier Agency» por el mismo importe que una transferencia propia.
test("«Business Atelier Agency» no es Business Atelier Europa: su cobro no se empareja con una salida propia", () => {
  const p = detectar([
    mov("bbva", "2026-09-30", -6000, "Business atelier europa TRANSFERENCIAS BUSINESS ATELIER EUROPA S.L."),
    mov("main", "2026-10-01", 6000, "Payment From Business Atelier Agency Service Evento Feria"),
  ]);
  assert.equal(p.length, 0);
});

test("falsos positivos de la auditoría: Seguridad Social frente a un cobro en USD, y cargos de tarjeta frente a devoluciones", () => {
  assert.equal(detectar([
    mov("main", "2026-09-30", -2640, "Tesoreria General De La Seguridad Social"),
    mov("usd", "2026-09-30", 3000, "Payment From Cliente Internacional Inc", { equivalenteEur: 2641 }),
  ]).length, 0);
  assert.equal(detectar([mov("main", "2026-09-12", -12.5, "Uber Trip"), mov("pocket", "2026-09-12", 12.5, "Refund Uber Trip")]).length, 0);
});

test("conversión USD→EUR declarada por el banco en las dos patas, con valoración de Holded dentro del 1 %: inequívoca", () => {
  const p = detectar([
    mov("usd", "2026-09-21", -19501.84, "Exchanged To Eur Main", { equivalenteEur: -16995.07 }),
    mov("main", "2026-09-21", 17000, "Exchanged To Eur Main"),
  ], CUENTAS, () => 0.8715);
  assert.equal(p.length, 1);
  assert.equal(p[0].tipo, "conversion");
  assert.equal(p[0].confianza, "automatica");
  assert.equal(p[0].tasaImplicita?.toFixed(4), "0.8717");
  assert.equal(p[0].diferenciaEur, 4.93);
  assert.ok((p[0].diferenciaPct ?? 9) < 0.1);
});

test("conversión EUR→USD y la coletilla de comisión de Wise no impiden reconocer el cambio", () => {
  const eurUsd = detectar([mov("main", "2026-09-02", -433.96, "Exchanged To Usd Main Dollars"), mov("usd", "2026-09-02", 500, "Exchanged To Usd Main Dollars", { equivalenteEur: 431.85 })]);
  assert.equal(eurUsd[0]?.confianza, "automatica");
  assert.equal(eurUsd[0]?.diferenciaEur, -2.11);
  const wise = detectar([mov("wise-usd", "2026-09-30", -2991.32, "Converted Usd To Eur (fee: Usd)", { equivalenteEur: -2639.84 }), mov("wise-eur", "2026-09-30", 2635.64, "Converted Usd To Eur")]);
  assert.equal(wise[0]?.tipo, "conversion");
  assert.equal(wise[0]?.confianza, "automatica");
});

test("USD→COP sin tasa histórica: vale con descripción explícita, mismo día, mismo banco y valoración de Holded", () => {
  const patas = (fechaDestino: string) => [
    mov("usd", "2026-09-11", -1531.63, "Exchanged To Cop Colombia", { equivalenteEur: -1319.79 }),
    mov("cop", fechaDestino, 4750000, "Exchanged To Cop Colombia", { equivalenteEur: 1320.5 }),
  ];
  assert.equal(detectar(patas("2026-09-11"))[0]?.confianza, "automatica");
  assert.equal(detectar(patas("2026-09-12"))[0]?.confianza, "revision");
});

test("diferencia de cambio: hasta 1 % inequívoca, hasta 3 % a revisión, por encima bloqueada", () => {
  const con = (entra: number) => detectar([
    mov("usd", "2026-09-21", -1150, "Exchanged To Eur Main", { equivalenteEur: -1000 }), mov("main", "2026-09-21", entra, "Exchanged To Eur Main"),
  ])[0]?.confianza;
  assert.equal(con(1009), "automatica");
  assert.equal(con(1025), "revision");
  assert.equal(con(1040), "bloqueada");
});

test("la tasa del día también cuenta: un cambio lejos del mercado no es automático aunque Holded lo valore igual", () => {
  const patas = [mov("usd", "2026-09-21", -1150, "Exchanged To Eur Main", { equivalenteEur: -1000 }), mov("main", "2026-09-21", 1000, "Exchanged To Eur Main")];
  assert.equal(detectar(patas, CUENTAS, () => 0.87)[0]?.confianza, "automatica");
  assert.equal(detectar(patas, CUENTAS, () => 0.85)[0]?.confianza, "revision");
  assert.equal(detectar(patas, CUENTAS, () => 0.8)[0]?.confianza, "bloqueada");
});

test("sin valoración en EUR de Holded o entre bancos distintos, la conversión va a revisión", () => {
  assert.equal(detectar([mov("usd", "2026-09-21", -1150, "Exchanged To Eur Main"), mov("main", "2026-09-21", 1000, "Exchanged To Eur Main")])[0]?.confianza, "revision");
  assert.equal(detectar([
    mov("wise-usd", "2026-09-21", -1150, "Exchanged To Eur Main", { equivalenteEur: -1000 }), mov("main", "2026-09-21", 1000, "Exchanged To Eur Main"),
  ])[0]?.confianza, "revision");
});

test("una conversión exige la misma descripción en las dos patas y que la moneda declarada sea la de destino", () => {
  assert.equal(detectar([mov("usd", "2026-09-29", -6806.86, "Exchanged To Eur Euro Savings", { equivalenteEur: -5992 }), mov("main", "2026-09-29", 6010, "To Eur Main")]).length, 0);
  assert.equal(detectar([mov("usd", "2026-09-29", -1150, "Exchanged To Gbp Main", { equivalenteEur: -1000 }), mov("main", "2026-09-29", 1000, "Exchanged To Gbp Main")]).length, 0);
});

// Caso real (Footprint, 29/09/2026): conversión a Pocket y, después, traspaso de Pocket a Main con 10 € más.
test("cadena conversión + transferencia: dos operaciones separadas, sin inventar los 10 € de diferencia", () => {
  const p = detectar([
    mov("usd", "2026-09-29", -6806.86, "Exchanged To Eur Euro Savings", { equivalenteEur: -5992 }),
    mov("pocket", "2026-09-29", 6000, "Exchanged To Eur Euro Savings"),
    mov("pocket", "2026-09-29", -6010, "To Eur Main"),
    mov("main", "2026-09-29", 6010, "To Eur Main"),
  ]);
  assert.deepEqual(p.map((x) => [x.tipo, x.origen.cuenta.id, x.destino.cuenta.id, x.confianza]), [
    ["conversion", "usd", "pocket", "automatica"],
    ["transferencia", "pocket", "main", "automatica"],
  ]);
  assert.equal(p[0].destino.movimiento.importe, 6000);
  assert.equal(p[1].origen.movimiento.importe, -6010);
});

test("dos candidatos para un mismo movimiento: todas las parejas implicadas se bloquean y ninguno se usa dos veces", () => {
  const p = detectar([
    mov("main", "2026-10-01", -350, PROPIA_SALE),
    mov("bbva", "2026-10-01", 350, PROPIA_ENTRA),
    mov("wise-eur", "2026-10-01", 350, "Received Money From Business Atelier Europa SL"),
  ]);
  assert.equal(p.length, 2);
  assert.ok(p.every((x) => x.confianza === "bloqueada"));
  assert.match(p[0].motivos[p[0].motivos.length - 1], /Ambiguo/);
  // Dos transferencias iguales el mismo día también son ambiguas entre sí.
  const dobles = detectar([
    mov("main", "2026-10-01", -350, PROPIA_SALE), mov("main", "2026-10-01", -350, PROPIA_SALE),
    mov("bbva", "2026-10-01", 350, PROPIA_ENTRA), mov("bbva", "2026-10-01", 350, PROPIA_ENTRA),
  ]);
  assert.equal(dobles.length, 4);
  assert.ok(dobles.every((x) => x.confianza === "bloqueada"));
});

test("un movimiento ya conciliado, parcial o que no está pendiente no participa", () => {
  const sale = () => mov("main", "2026-10-01", -350, PROPIA_SALE);
  assert.equal(detectar([sale(), mov("bbva", "2026-10-01", 350, PROPIA_ENTRA, { estado: "reconciled", conciliado: 350 })]).length, 0);
  assert.equal(detectar([sale(), mov("bbva", "2026-10-01", 350, PROPIA_ENTRA, { estado: "forced_reconciled" })]).length, 0);
  assert.equal(detectar([sale(), mov("bbva", "2026-10-01", 350, PROPIA_ENTRA, { estado: "pending", conciliado: 100 })]).length, 0);
});

test("cuentas archivadas, sin sincronización reciente o que no son bancarias quedan fuera y se dice por qué", () => {
  const movs = () => [mov("main", "2026-10-01", -350, PROPIA_SALE), mov("bbva", "2026-10-01", 350, PROPIA_ENTRA)];
  const con = (extra: Partial<CuentaTransferencia>) => detectarTransferencias("WOBA", [CUENTAS[0], { ...CUENTAS[4], ...extra }], movs(), { hoy: HOY });
  assert.equal(con({ archivada: true }).propuestas.length, 0);
  assert.equal(con({ tipo: "gateway" }).propuestas.length, 0);
  assert.equal(con({ tipo: "card" }).propuestas.length, 0);
  const vieja = con({ sincronizadaEn: "2026-03-03T08:37:23+00:00" });
  assert.equal(vieja.propuestas.length, 0);
  assert.match(vieja.cuentasExcluidas[0].motivo, /sin sincronizar desde el 2026-03-03/);
  assert.equal(con({ sincronizadaEn: undefined }).propuestas.length, 0);
});

test("los movimientos de otra empresa no se cruzan: su nombre no es el de la sociedad que se analiza", () => {
  // La misma pareja, analizada como Footprint: «Business Atelier Europa» no es Business Footprint EU.
  const movs = [mov("main", "2026-10-01", -350, "To Business Atelier Europa Sl"), mov("bbva", "2026-10-01", 350, "Payment From Business Atelier Europa S.l.")];
  assert.equal(detectarTransferencias("Footprint", CUENTAS, movs, { hoy: HOY }).propuestas.length, 0);
  assert.equal(detectarTransferencias("WOBA", CUENTAS, movs, { hoy: HOY }).propuestas.length, 1);
});

test("un movimiento de Holded sin id, importe o fecha no se convierte: no se adivina nada sobre él", () => {
  assert.equal(aMovimiento("main", "EUR", { id: "x", amount: "abc", booking_date: "2026-10-01" }), undefined);
  assert.equal(aMovimiento("main", "EUR", { amount: "-5.00", booking_date: "2026-10-01" }), undefined);
  assert.deepEqual(aMovimiento("usd", "USD", { id: "x", amount: "-900.00", accounting_amount: "-792.26", booking_date: "2026-09-29T00:00:00+00:00", status: "pending", reconciled_amount: "0.00", description: "Exchanged To Eur Main" }),
    { id: "x", cuentaId: "usd", fecha: "2026-09-29", importe: -900, moneda: "USD", equivalenteEur: -792.26, descripcion: "Exchanged To Eur Main", estado: "pending", conciliado: 0 });
});
