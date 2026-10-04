import assert from "node:assert/strict";
import test from "node:test";
import { evaluarReglaTicket, TOPE_EUR_AUTOMATICO } from "./reglaTicket";
import { escanearReglaTicket, reiniciarVistosParaPruebas } from "./escaneoTickets";
import { procesarColaTickets, claveTicket } from "./tickets";
import { AlmacenTrabajosMemoria } from "./trabajos";

const base = { moneda: "EUR", totalEUR: 20, tieneNif: false, proveedorConvertidoAntes: false };

test("regla: sin NIF y moneda distinta del euro → ticket (restaurante o taxi en Colombia)", () => {
  assert.equal(evaluarReglaTicket({ ...base, moneda: "COP", totalEUR: 28 }).decision, "ticket");
});
test("regla: sin NIF y de fuera de la UE → ticket (Anthropic, Uber EEUU)", () => {
  assert.equal(evaluarReglaTicket({ ...base, pais: "US" }).decision, "ticket");
});
test("regla: sin NIF, en euros y de la UE o sin señales (correduría de seguros) → revisión, nunca ticket automático", () => {
  assert.equal(evaluarReglaTicket({ ...base, pais: "ES" }).decision, "revisar");
  assert.equal(evaluarReglaTicket({ ...base }).decision, "revisar");
});
test("regla: proveedor ya convertido antes o documento que se declara ticket → ticket", () => {
  assert.equal(evaluarReglaTicket({ ...base, proveedorConvertidoAntes: true }).decision, "ticket");
  assert.equal(evaluarReglaTicket({ ...base, textoEvidencia: "Factura Simplificada nº 12" }).decision, "ticket");
});
test("regla: las exclusiones ganan siempre — con NIF/CIF (factura formal) o por encima del tope", () => {
  assert.equal(evaluarReglaTicket({ ...base, moneda: "COP", tieneNif: true, proveedorConvertidoAntes: true }).decision, "nunca");
  assert.equal(evaluarReglaTicket({ ...base, moneda: "USD", totalEUR: TOPE_EUR_AUTOMATICO + 1, pais: "US" }).decision, "nunca");
  assert.equal(evaluarReglaTicket({ ...base, moneda: "USD", totalEUR: null }).decision, "revisar");
});

const compra = (id: string, extra: Record<string, unknown> = {}) => ({ id, contact_id: `k-${id}`, contact_name: `Prov ${id}`, date: "2026-10-01", currency: "COP", currency_change: "4000", total: "100000,00",
  notes: "[wobi:" + "b".repeat(64) + "]", status: "completed", lines: [{ name: "Cena", account: "a" }], ...extra });
const mundo = (compras: Record<string, unknown>[], contactos: Record<string, unknown>) => async (_e: string, ruta: string) => {
  if (ruta === "/purchases") return { items: compras.map((c) => ({ id: c.id, contact_name: c.contact_name })), has_more: false };
  if (ruta.startsWith("/contacts/")) return contactos[ruta.split("/").pop()!] ?? {};
  return compras.find((c) => ruta.endsWith(String(c.id)))!;
};

test("exploración: registra solo los que son ticket de WOBI; no WOBI, con NIF y dudosos no se registran; es idempotente", async () => {
  reiniciarVistosParaPruebas();
  const almacen = new AlmacenTrabajosMemoria();
  const compras = [compra("t1"), compra("sinMarca", { notes: "a mano" }), compra("conNif"), compra("grande", { total: "9000000,00" }), compra("euros", { currency: "EUR", currency_change: "1.00", total: "40,00" })];
  const contactos = { "k-conNif": { code: "B12345678" }, "k-t1": { code: "" }, "k-grande": { code: "" }, "k-euros": { bill_address: { country_code: "ES" } } };
  const r = await escanearReglaTicket("Footprint", almacen, { leer: mundo(compras, contactos), simulada: true });
  assert.deepEqual(r.candidatos.map((c) => c.id), ["t1"]);
  assert.equal(r.aRevisar, 1); // el de euros sin señales
  assert.equal(r.excluidas, 2); // con NIF y por encima del tope
  const t = await almacen.obtener(claveTicket("Footprint", "t1"));
  assert.equal(t?.estado, "solicitado"); assert.equal(t?.evidencia.origen, "regla_auto"); assert.equal(t?.evidencia.simulada, true);
  assert.equal((await escanearReglaTicket("Footprint", almacen, { leer: mundo(compras, contactos), simulada: true })).candidatos.length, 0);
});

test("SIMULACIÓN de la regla: los casos registrados NO se procesan ni tocan Holded; con la regla activa y empresa en alcance, sí", async () => {
  const prev = { ...process.env };
  try {
    reiniciarVistosParaPruebas();
    process.env.WOBI_HOLDED_TICKETS_MODO = "activo"; process.env.WOBI_HOLDED_TICKETS_EMPRESAS = "WOBA";
    process.env.WOBI_HOLDED_TICKETS_REGLA_MODO = "simulacion"; process.env.WOBI_HOLDED_TICKETS_REGLA_EMPRESAS = "Footprint";
    const almacen = new AlmacenTrabajosMemoria();
    await escanearReglaTicket("Footprint", almacen, { leer: mundo([compra("t1")], { "k-t1": { code: "" } }), simulada: true });
    let lecturas = 0;
    const leerEspia = async () => { lecturas++; throw new Error("no debería leerse"); };
    const r = await procesarColaTickets({ almacen, leer: leerEspia });
    assert.equal(r.revisados, 0); assert.equal(lecturas, 0);
    assert.equal((await almacen.obtener(claveTicket("Footprint", "t1")))?.estado, "solicitado");
    process.env.WOBI_HOLDED_TICKETS_REGLA_MODO = "activo";
    await procesarColaTickets({ almacen, leer: async () => { lecturas++; throw Object.assign(new Error("503"), { status: 503 }); } });
    assert.ok(lecturas > 0); // con la regla activa, el caso entra en la cola y se intenta
  } finally { for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k]; Object.assign(process.env, prev); }
});

test("lista aprobada: la aprobación escrita de Carlos manda sobre una clasificación dudosa que nunca se intentó; respeta cualquier otro estado", async () => {
  const { registrarCasoAprobado } = await import("./tickets");
  const almacen = new AlmacenTrabajosMemoria();
  assert.equal(await registrarCasoAprobado(almacen, "Footprint", "n1"), "creado");
  const base = { tipo: "ticket" as const, empresa: "Footprint", creadoEn: 1, actualizadoEn: 1, evidencia: { origen: "recepcion" } as Record<string, unknown> };
  await almacen.guardar({ ...base, clave: claveTicket("Footprint", "dudoso"), objetivo: "dudoso", estado: "requiere_intervencion", intentos: 0, ultimoError: "Clasificación dudosa: pendiente de revisión" });
  await almacen.guardar({ ...base, clave: claveTicket("Footprint", "hecho"), objetivo: "hecho", estado: "completado", intentos: 1 });
  await almacen.guardar({ ...base, clave: claveTicket("Footprint", "intentado"), objetivo: "intentado", estado: "requiere_intervencion", intentos: 2, ultimoError: "Clasificación dudosa: pendiente de revisión" });
  assert.equal(await registrarCasoAprobado(almacen, "Footprint", "dudoso"), "reabierto");
  assert.equal((await almacen.obtener(claveTicket("Footprint", "dudoso")))?.estado, "solicitado");
  assert.equal((await almacen.obtener(claveTicket("Footprint", "dudoso")))?.evidencia.origen, "lista_aprobada");
  assert.equal(await registrarCasoAprobado(almacen, "Footprint", "hecho"), "existente");
  assert.equal(await registrarCasoAprobado(almacen, "Footprint", "intentado"), "existente");
});

test("botones: un gasto dudoso se registra UNA vez a la espera de Carlos; «Convertir» lo pasa a la cola, «No es ticket» lo cierra; no se vuelve a preguntar", async () => {
  const { registrarDudoso, aprobarDudoso, rechazarDudoso, reanudarDisyuntor } = await import("./decisionesTickets");
  const almacen = new AlmacenTrabajosMemoria();
  const a = "6abf7e24b0a79d7d54045e45", b = "6abfbede7b93a80707000b6d";
  assert.equal(await registrarDudoso(almacen, { empresa: "WOBA", id: a, proveedor: "X", motivos: ["sin señal"] }), true);
  assert.equal(await registrarDudoso(almacen, { empresa: "WOBA", id: a, proveedor: "X", motivos: ["sin señal"] }), false); // no se pregunta dos veces
  await registrarDudoso(almacen, { empresa: "WOBA", id: b, proveedor: "Y", motivos: [] });
  assert.equal(await aprobarDudoso(almacen, "WOBA", a), "aprobado");
  const t = await almacen.obtener(claveTicket("WOBA", a));
  assert.equal(t?.estado, "solicitado"); assert.equal(t?.evidencia.aprobadoPorCarlos, true);
  assert.equal(await aprobarDudoso(almacen, "WOBA", a), "ya_resuelto"); // doble pulsación: inocua
  assert.equal(await rechazarDudoso(almacen, "WOBA", b), "rechazado");
  assert.equal((await almacen.obtener(claveTicket("WOBA", b)))?.estado, "omitido");
  assert.equal(await aprobarDudoso(almacen, "WOBA", "inexistente"), "no_encontrado");
  // reanudar tras el disyuntor: los casos con cambios inesperados quedan revisados y el contador vuelve a cero
  await almacen.guardar({ clave: claveTicket("Footprint", "d1"), tipo: "ticket", empresa: "Footprint", objetivo: "d1", estado: "requiere_intervencion", intentos: 1, creadoEn: Date.now(), actualizadoEn: Date.now(), evidencia: { camposCambiados: ["total"] } });
  assert.equal(await reanudarDisyuntor(almacen), 1);
  assert.equal(await reanudarDisyuntor(almacen), 0);
});

test("botones: las decisiones del chat son acciones sensibles (solo superadministrador)", async () => {
  const { esAccionSensible } = await import("../../telegram/authorizedUsersSheet");
  for (const d of ["tktregla_ok:WOBA:6abf7e24b0a79d7d54045e45", "tktregla_no:Footprint:6abf7e24b0a79d7d54045e45", "tktdis_reanudar"]) assert.equal(esAccionSensible(d), true, d);
});
