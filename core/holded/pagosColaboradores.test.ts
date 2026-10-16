import assert from "node:assert/strict";
import test from "node:test";
import {
  envioDePar, envioDeResto, claveDudoso, clavePar, claveResto, claveRestoAntiguo, emparejarPagosColaboradores, inicioTrimestre, nombraAlProveedor, proponerPagosColaboradores, proveedorDeTransferencia, restosAbiertos,
  type CargoAbierto, type CompraAbierta, type DepsPropuestaColaboradores,
} from "./pagosColaboradores";

const compra = (o: Partial<CompraAbierta> & { id: string; contacto: string; total: number; fecha: string }): CompraAbierta =>
  ({ numero: "1", descripcion: "Monthly fee", pendiente: o.total, moneda: "USD", ...o });
const cargo = (o: Partial<CargoAbierto> & { id: string; descripcion: string; importe: number; fecha: string }): CargoAbierto =>
  ({ cuentaId: "ftg", cuenta: "FTG USD", conciliado: 0, moneda: "USD", estado: "pending", ...o });

test("nombraAlProveedor: dos palabras del nombre, con tildes, orden distinto y una errata", () => {
  assert.equal(nombraAlProveedor("KELLY JOHANNA CORREALES DUCUARA", "To Kelly Ducuara Monthly Fee August"), true);
  assert.equal(nombraAlProveedor("NICOLAS DAVID GOMEZ OSORIO", "To Nicolas David Gpmez Osorio Monthly Fee"), true);
  assert.equal(nombraAlProveedor("Alejandro Flórez López", "To Alejandro Florez Lopez Monthly Fee"), true);
  assert.equal(nombraAlProveedor("KELLY JOHANNA CORREALES DUCUARA", "Uber Pending"), false);
  assert.equal(nombraAlProveedor("Booking Holdings", "To Booking Hotel"), false, "con una sola palabra del nombre no basta");
});

test("proveedorDeTransferencia: deja solo el nombre de la persona", () => {
  assert.equal(proveedorDeTransferencia("To Kelly Ducuara Monthly Fee Sept."), "Kelly Ducuara");
  assert.equal(proveedorDeTransferencia("To Andres Ramirez Honorarios Profesionales August"), "Andres Ramirez");
});

test("un gasto y una transferencia con comisión de 28 USD forman un par con su comisión", () => {
  const { pares, dudosos } = emparejarPagosColaboradores("Footprint",
    [compra({ id: "g1", contacto: "KELLY JOHANNA CORREALES DUCUARA", total: 1750, fecha: "2026-09-30" })],
    [cargo({ id: "m1", descripcion: "To Kelly Ducuara Monthly Fee Sept.", importe: -1777.98, fecha: "2026-10-07" })]);
  assert.equal(dudosos.length, 0);
  assert.equal(pares.length, 1);
  assert.equal(pares[0].comision, 27.98);
});

test("importe exacto en una moneda sin comisión admitida (COP) forma par; con diferencia no", () => {
  const k = (importe: number) => emparejarPagosColaboradores("Footprint",
    [compra({ id: "g", contacto: "YANESSY YOHENIS VELASQUEZ COPETE", total: 4750000, moneda: "COP", fecha: "2026-09-29" })],
    [cargo({ id: "m", descripcion: "To Yanessy Yohenis Velasquez Copete Monthly Fee September", importe, moneda: "COP", fecha: "2026-10-07" })]);
  assert.equal(k(-4750000).pares.length, 1);
  assert.equal(k(-4750000).pares[0].comision, 0);
  assert.equal(k(-4755000).pares.length, 0);
});

test("dos meses del mismo colaborador (Andrés) se emparejan por orden de fecha", () => {
  const { pares, dudosos } = emparejarPagosColaboradores("Footprint",
    [compra({ id: "sep", contacto: "ANDRÉS MAURICIO RAMÍREZ NOVA", total: 1000, fecha: "2026-09-29" }), compra({ id: "ago", contacto: "ANDRÉS MAURICIO RAMÍREZ NOVA", total: 1000, fecha: "2026-08-29" })],
    [cargo({ id: "oct", descripcion: "To Andres Ramirez Honorarios Profesionales Sept", importe: -1027.98, fecha: "2026-10-07" }), cargo({ id: "sept", descripcion: "To Andres Ramirez Honorarios Profesionales August", importe: -1028.98, fecha: "2026-09-11" })]);
  assert.equal(dudosos.length, 0);
  assert.deepEqual(pares.map((p) => [p.compra.id, p.cargo.id]).sort(), [["ago", "sept"], ["sep", "oct"]]);
});

test("dos gastos para un solo cargo, o gastos y cargos que no cuadran en número, quedan como dudosos y no se propone nada", () => {
  const { pares, dudosos } = emparejarPagosColaboradores("Footprint",
    [compra({ id: "a", contacto: "JORGE GERARDO JACOME MUÑOZ", total: 3500, fecha: "2026-08-29" }), compra({ id: "b", contacto: "JORGE GERARDO JACOME MUÑOZ", total: 3500, fecha: "2026-09-30" })],
    [cargo({ id: "m", descripcion: "To Jorge Jacome Monthly Fee", importe: -3528.83, fecha: "2026-10-07" })]);
  assert.equal(pares.length, 0);
  assert.equal(dudosos.length, 1);
  assert.match(dudosos[0].motivo, /2 gasto\(s\)[\s\S]*1 transferencia/);
});

test("importes distintos de personas distintas no se cruzan; un gasto con pagos, una moneda distinta o un cargo que no es transferencia, tampoco", () => {
  const g = compra({ id: "g", contacto: "KELLY JOHANNA CORREALES DUCUARA", total: 1750, fecha: "2026-09-30" });
  const m = cargo({ id: "m", descripcion: "To Kelly Ducuara Monthly Fee Sept.", importe: -1777.98, fecha: "2026-10-07" });
  assert.equal(emparejarPagosColaboradores("Footprint", [g], [m]).pares.length, 1);
  assert.equal(emparejarPagosColaboradores("Footprint", [{ ...g, pendiente: 100 }], [m]).pares.length, 0, "ya tiene pagos");
  assert.equal(emparejarPagosColaboradores("Footprint", [{ ...g, moneda: "EUR" }], [{ ...m, moneda: "EUR" }]).pares.length, 0, "euros: lo cubre el buscador de cargos exactos");
  assert.equal(emparejarPagosColaboradores("Footprint", [g], [{ ...m, moneda: "COP" }]).pares.length, 0);
  assert.equal(emparejarPagosColaboradores("Footprint", [g], [{ ...m, descripcion: "Kelly Ducuara Monthly Fee Sept." }]).pares.length, 0, "no es una transferencia «To …»");
  assert.equal(emparejarPagosColaboradores("Footprint", [g], [{ ...m, importe: -1700 }]).pares.length, 0, "cargo menor que el gasto");
  assert.equal(emparejarPagosColaboradores("Footprint", [g], [{ ...m, importe: -1830 }]).pares.length, 0, "comisión fuera de lo razonable");
  assert.equal(emparejarPagosColaboradores("Footprint", [g], [{ ...m, estado: "partial" }]).pares.length, 0);
  assert.equal(emparejarPagosColaboradores("Footprint", [g], [{ ...m, fecha: "2027-04-01" }]).pares.length, 0, "demasiado lejos en el tiempo");
});

test("restosAbiertos: solo transferencias conciliadas en parte con un resto de comisión (≤ 10 %)", () => {
  const parcial = cargo({ id: "p", descripcion: "To Nicolas David Gomez Monthly Fee", importe: -1503, conciliado: 1483.24, estado: "partial", fecha: "2026-10-07" });
  const r = restosAbiertos("Footprint", [parcial, { ...parcial, id: "x", descripcion: "Go Rent A Car" }, { ...parcial, id: "y", conciliado: 355.13 }, { ...parcial, id: "z", estado: "pending" }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resto, 19.76);
  assert.equal(r[0].proveedor, "Nicolas David Gomez");
});

test("inicioTrimestre: el primer día del trimestre natural", () => {
  assert.equal(inicioTrimestre(Date.parse("2026-10-16T10:00:00Z")), "2026-10-01");
  assert.equal(inicioTrimestre(Date.parse("2026-09-30T10:00:00Z")), "2026-07-01");
  assert.equal(inicioTrimestre(Date.parse("2027-01-02T10:00:00Z")), "2027-01-01");
});

function deps(o: Partial<DepsPropuestaColaboradores> = {}) {
  const log = { avisos: [] as string[], pares: [] as string[], restos: [] as string[], marcadas: [] as string[] };
  const g = compra({ id: "g", contacto: "KELLY JOHANNA CORREALES DUCUARA", total: 1750, fecha: "2026-09-30" });
  const m = cargo({ id: "m", descripcion: "To Kelly Ducuara Monthly Fee Sept.", importe: -1777.98, fecha: "2026-10-07" });
  const d: DepsPropuestaColaboradores = {
    empresas: ["Footprint"], leerCompras: async () => [g], leerCargos: async () => [m], yaPropuestas: async () => new Map(),
    marcarPropuestas: async (c) => { log.marcadas.push(...c); },
    proponerPar: async (p) => { log.pares.push(p.compra.id); return { ok: true, motivo: "" }; }, proponerResto: async (x) => { log.restos.push(x.cargo.id); return { ok: true, motivo: "" }; },
    avisar: async (t) => { log.avisos.push(t); }, ahora: () => Date.parse("2026-10-16T10:30:00Z"), ...o,
  };
  return { d, log, g, m };
}

test("propone el par, lo marca al instante, avisa después y no lo repite al día siguiente", async () => {
  const { d, log, g, m } = deps();
  const r = await proponerPagosColaboradores(d);
  assert.equal(r.pares.length, 1);
  assert.deepEqual(log.pares, ["g"]);
  assert.equal(log.avisos.length, 1);
  assert.match(log.avisos[0], /te mandé 1 propuesta\(s\) con su botón; no se concilia nada hasta que lo pulses/);
  assert.deepEqual(log.marcadas, [`par:g|ftg/m`]);
  const ayer = Date.parse("2026-10-15T10:30:00Z");
  const dos = deps({ yaPropuestas: async () => new Map([[clavePar({ empresa: "Footprint", compra: g, cargo: m, comision: 27.98 }), ayer]]) });
  const r2 = await proponerPagosColaboradores(dos.d);
  assert.equal(r2.pares.length, 0);
  assert.equal(dos.log.avisos.length, 0, "sin novedades no escribe a nadie");
  const hace8 = deps({ yaPropuestas: async () => new Map([[clavePar({ empresa: "Footprint", compra: g, cargo: m, comision: 27.98 }), Date.parse("2026-10-08T10:00:00Z")]]) });
  assert.equal((await proponerPagosColaboradores(hace8.d)).pares.length, 1, "pasada la ventana de 7 días se vuelve a proponer");
});

test("simulación: no avisa, no propone y no marca nada", async () => {
  const { d, log } = deps({ simular: true });
  const r = await proponerPagosColaboradores(d);
  assert.equal(r.simulado, true);
  assert.equal(r.pares.length, 1);
  assert.deepEqual([log.avisos.length, log.pares.length, log.marcadas.length], [0, 0, 0]);
});

test("si la pregunta no salió, el aviso lo dice con su motivo, se marca para no repetirlo cada día y un error al proponer no tumba el resto", async () => {
  const a = deps({ proponerPar: async () => ({ ok: false, motivo: "el cargo no está libre" }) });
  const ra = await proponerPagosColaboradores(a.d);
  assert.equal(ra.fallos.length, 1);
  assert.match(a.log.avisos[0], /No pude proponer \(1\)[\s\S]*no pude proponerlo: el cargo no está libre/);
  assert.doesNotMatch(a.log.avisos[0], /te mandé/);
  assert.deepEqual(a.log.marcadas, ["par:g|ftg/m"], "el fallo se marca tras avisar: no vuelve a salir cada día");
  const b = deps({ proponerPar: async () => { throw new Error("Telegram caído"); } });
  const rb = await proponerPagosColaboradores(b.d);
  assert.equal(rb.fallos.length, 1);
  assert.match(b.log.avisos[0], /Telegram caído/);
});

test("si falla el aviso, lo ya enviado queda marcado (no se duplica mañana) y lo informativo se reintenta", async () => {
  const { d, log } = deps({ avisar: async () => { throw new Error("Telegram caído"); } });
  const r = await proponerPagosColaboradores(d);
  assert.equal(r.enviados.length, 1);
  assert.deepEqual(log.marcadas, ["par:g|ftg/m"]);
  const dud = deps({ leerCompras: async () => [], leerCargos: async () => [], avisar: async () => { throw new Error("x"); }, empresas: ["WOBA"] });
  dud.d.leerCompras = async () => { throw new Error("Holded 502"); };
  const rd = await proponerPagosColaboradores(dud.d);
  assert.deepEqual(rd.empresasConError, ["WOBA"]);
  assert.deepEqual(dud.log.marcadas, []);
});

test("un fallo al leer una empresa no tumba las demás, no se toma como «sin pares» y se avisa", async () => {
  const { d, log } = deps({ empresas: ["WOBA", "Footprint"], leerCompras: async (e) => { if (e === "WOBA") throw new Error("Holded 502"); return [compra({ id: "g", contacto: "KELLY JOHANNA CORREALES DUCUARA", total: 1750, fecha: "2026-09-30" })]; } });
  const r = await proponerPagosColaboradores(d);
  assert.deepEqual(r.empresasConError, ["WOBA"]);
  assert.equal(r.pares.length, 1);
  assert.match(log.avisos[0], /No pude leer Holded de: WOBA/);
});

test("restos: los del trimestre actual se proponen con botón; los de trimestres anteriores solo se listan una vez al mes", async () => {
  const nuevo = cargo({ id: "n", descripcion: "To Andres Ramirez Honorarios Sept", importe: -1027.98, conciliado: 988.83, estado: "partial", fecha: "2026-10-07" });
  const viejo = cargo({ id: "v", descripcion: "To Kelly Ducuara Monthly Fee August", importe: -1778.98, conciliado: 1752.87, estado: "partial", fecha: "2026-09-11" });
  const { d, log } = deps({ leerCompras: async () => [], leerCargos: async () => [nuevo, viejo] });
  const r = await proponerPagosColaboradores(d);
  assert.deepEqual(log.restos, ["n"]);
  assert.equal(r.restosAManoOCerrados.length, 1);
  assert.match(log.avisos[0], /trimestres anteriores[\s\S]*ajústalos a mano/);
  assert.ok(log.marcadas.includes(claveResto(r.restosPropuestos[0])) && log.marcadas.includes(claveRestoAntiguo(r.restosAManoOCerrados[0])));
  const hace10 = Date.parse("2026-10-06T10:00:00Z");
  const otra = deps({ leerCompras: async () => [], leerCargos: async () => [viejo], yaPropuestas: async () => new Map([[claveRestoAntiguo(r.restosAManoOCerrados[0]), hace10]]) });
  assert.equal((await proponerPagosColaboradores(otra.d)).restosAManoOCerrados.length, 0, "lo informativo no se repite antes de 30 días");
});

test("los dudosos se avisan una vez y no se proponen", async () => {
  const gs = [compra({ id: "a", contacto: "JORGE GERARDO JACOME MUÑOZ", total: 3500, fecha: "2026-08-29" }), compra({ id: "b", contacto: "JORGE GERARDO JACOME MUÑOZ", total: 3500, fecha: "2026-09-30" })];
  const ms = [cargo({ id: "m", descripcion: "To Jorge Jacome Monthly Fee", importe: -3528.83, fecha: "2026-10-07" })];
  const { d, log } = deps({ leerCompras: async () => gs, leerCargos: async () => ms });
  const r = await proponerPagosColaboradores(d);
  assert.equal(log.pares.length, 0);
  assert.match(log.avisos[0], /Dudosos \(1\), no propongo nada/);
  assert.ok(log.marcadas.includes(claveDudoso(r.dudosos[0])));
});

test("revisión: fecha ilegible, gasto lejano, concepto como nombre y fechas empatadas no producen pares", () => {
  const g = compra({ id: "g", contacto: "KELLY JOHANNA CORREALES DUCUARA", total: 1750, fecha: "2026-09-30" });
  const m = cargo({ id: "m", descripcion: "To Kelly Ducuara Monthly Fee Sept.", importe: -1777.98, fecha: "2026-10-07" });
  assert.equal(emparejarPagosColaboradores("Footprint", [{ ...g, fecha: "" }], [m]).pares.length, 0, "fecha ilegible");
  assert.equal(emparejarPagosColaboradores("Footprint", [g], [{ ...m, fecha: "" }]).pares.length, 0);
  assert.equal(emparejarPagosColaboradores("Footprint", [{ ...g, fecha: "2026-05-01" }], [m]).pares.length, 0, "gasto de hace más de 45 días");
  assert.equal(nombraAlProveedor("Monthly Fee Services", "To Kelly Monthly Fee Sept"), false, "los conceptos no cuentan como nombre");
  assert.equal(nombraAlProveedor("Maria Garcia Lopez Ruiz", "To Maria Garcia Monthly Fee"), true);
  assert.equal(nombraAlProveedor("Maria Garcia Lopez Ruiz Soto", "To Maria Garcia Monthly Fee"), false, "menos de la mitad del nombre");
  const empate = emparejarPagosColaboradores("Footprint",
    [{ ...g, id: "a", total: 1750 }, { ...g, id: "b", total: 1760 }],
    [m, { ...m, id: "m2", importe: -1787.98 }]);
  assert.equal(empate.pares.length, 0, "dos gastos con la misma fecha: el orden sería arbitrario");
  assert.equal(empate.dudosos.length, 1);
});

test("datos reales de Footprint del 16-10-2026: encuentra exactamente los 9 pares demostrados y nada más", () => {
  const C = (id: string, contacto: string, numero: string, total: number, fecha: string, moneda = "USD", pendiente = total) => compra({ id, contacto, numero, total, fecha, moneda, pendiente });
  const compras = [
    C("hiking", "Alejandro Flórez López", "A", 52000, "2026-10-07", "COP", 52006.23), C("ale08", "Alejandro Flórez López", "08", 1673.76, "2026-08-29"),
    C("and14", "ANDRÉS MAURICIO RAMÍREZ NOVA", "14", 1000, "2026-09-29"), C("and13", "ANDRÉS MAURICIO RAMÍREZ NOVA", "13", 1000, "2026-08-29"),
    C("dav", "DAVID ANDRES SUAREZ RUIZ", "082601", 466.67, "2026-08-29", "USD", 466.66), C("jor", "JORGE GERARDO JACOME MUÑOZ", "JJ-2026-08-Fixed", 3500, "2026-08-29"),
    C("jc12", "Juan Camilo Salazar Gonzalez", "12", 942.66, "2026-09-08"), C("jc11", "Juan Camilo Salazar Gonzalez", "11", 2000, "2026-08-29"),
    C("kq3", "KELLY JOHANNA CORREALES DUCUARA", "074 -2", 11643.67, "2026-10-16"), C("k073", "KELLY JOHANNA CORREALES DUCUARA", "073", 1750, "2026-08-29"),
    C("h101", "Madrid Hotel 101 Spain Management, S.L.U.", "50808", 242.19, "2026-09-11", "EUR"), C("nq3", "NICOLAS DAVID GOMEZ OSORIO", "NG-000012", 5586.26, "2026-10-15"),
    C("sym2", "SYMBIOSIS CONSULTANCY", "26700008", 7500, "2026-09-01", "EUR"), C("sym1", "SYMBIOSIS CONSULTANCY", "26700007", 7500, "2026-08-12", "EUR"),
    C("yan", "YANESSY YOHENIS VELASQUEZ COPETE", "30", 4750000, "2026-09-29", "COP", 4750004.55),
  ];
  const M = (id: string, descripcion: string, importe: number, fecha: string, extra: Partial<CargoAbierto> = {}) => cargo({ id, descripcion, importe, fecha, ...extra });
  const cargos = [
    M("kel", "To Kelly Ducuara Monthly Fee August", -1778.98, "2026-09-11"), M("dav", "To David Suarez Monthly Fee Partial August", -495.65, "2026-09-11"),
    M("and", "To Andres Ramirez Honorarios Profesionales August", -1028.98, "2026-09-11"), M("ale", "To Alejandro Florez Lopez Monthly Fee August", -1702.75, "2026-09-11"),
    M("jc11", "To Juan Camilo Salazar Gonzalez Monthly Fee August", -2004, "2026-09-11"), M("jc12", "To Juan Camilo Salazar Gonzalez Comisiones Commissionig S", -944.55, "2026-09-11"),
    M("jor", "To Jorge Jacome Monthly Fee", -3528.83, "2026-09-16"), M("and2", "To Andres Ramirez Honorarios Profesionales Sept", -1027.98, "2026-10-07"),
    M("yan", "To Yanessy Yohenis Velasquez Copete Monthly Fee September", -4750000, "2026-10-07", { moneda: "COP", cuentaId: "col" }),
    M("go", "Go Rent A Car", -744.87, "2026-09-25", { estado: "partial", conciliado: 355.13 }), M("ub", "Uber Pending", -9.95, "2026-09-25"), M("ope", "Openai *chatgpt Subscr", -96.68, "2026-10-04"),
    M("hot", "Hotel At Booking.com", -202.82, "2026-10-10"),
  ];
  const { pares, dudosos } = emparejarPagosColaboradores("Footprint", compras, cargos);
  assert.deepEqual(dudosos, []);
  assert.deepEqual(pares.map((p) => `${p.compra.id}>${p.cargo.id}`).sort(), ["ale08>ale", "and13>and", "and14>and2", "dav>dav", "jc11>jc11", "jc12>jc12", "jor>jor", "k073>kel", "yan>yan"]);
  assert.equal(restosAbiertos("Footprint", cargos).length, 0, "Go Rent A Car no es una transferencia a colaborador");
});

test("envioDePar/envioDeResto: solo la pregunta realmente publicada cuenta como enviada", () => {
  const ok = "Preparé la conciliación elegida por el usuario: KELLY — 1750.00 USD ↔ «x». Ya le mandé por Telegram el botón «Conciliar con #1» — todavía falta que lo pulse; no digas que ya quedó conciliado. (esperando_eleccion)";
  assert.equal(envioDePar(ok).ok, true);
  assert.equal(envioDePar(ok.replace("esperando_eleccion", "fallida")).ok, false, "Telegram o Sheets fallaron al publicar");
  assert.equal(envioDePar("No se puede preparar el par: el cargo no está libre.").ok, false);
  assert.equal(envioDeResto("Te mostré la propuesta con su botón; no se ha escrito nada en Holded todavía.").ok, true);
  assert.equal(envioDeResto("No propongo registrar el resto: el cargo ya figura conciliado (reconciled): no queda resto.").ok, false);
});

