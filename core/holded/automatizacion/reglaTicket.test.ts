import assert from "node:assert/strict";
import test from "node:test";
import { entradaReglaDesdeCompra, evaluarReglaTicket, monedaOriginalDeDescripcion, TOPE_EUR_AUTOMATICO } from "./reglaTicket";
import { escanearReglaTicket, puedeReabrirPorRegla, reiniciarVistosParaPruebas, tasaDeCambio } from "./escaneoTickets";
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

test("tasa de cambio: «1.12» es 1,12 (decimal plano de Holded), no 112; con coma es formato ES", () => {
  assert.equal(tasaDeCambio("1.12"), 1.12);
  assert.equal(tasaDeCambio("3718.16"), 3718.16);
  assert.equal(tasaDeCambio("4000"), 4000);
  assert.equal(tasaDeCambio("1,1378"), 1.1378);
  assert.ok(Number.isNaN(tasaDeCambio(undefined)));
  assert.ok(Number.isNaN(tasaDeCambio("abc")));
});

test("tope de 500 €: un gasto en USD con tasa «1.12» se convierte bien al euro (antes dividía por 112 y el tope nunca saltaba)", async () => {
  reiniciarVistosParaPruebas();
  const almacen = new AlmacenTrabajosMemoria();
  const usd = (id: string, total: string) => compra(id, { currency: "USD", currency_change: "1.12", total });
  const compras = [usd("pequeno", "16,57"), usd("grande", "600,00"), usd("justo", "560,00"), usd("sobre", "561,00")];
  const contactos = { "k-pequeno": { code: "" }, "k-grande": { code: "" }, "k-justo": { code: "" }, "k-sobre": { code: "" } };
  const r = await escanearReglaTicket("Footprint", almacen, { leer: mundo(compras, contactos), simulada: true });
  // 560 USD ÷ 1,12 = 500,00 € (en el tope, entra); 561 USD = 500,89 € y 600 USD = 535,71 € quedan fuera.
  assert.deepEqual(r.candidatos.map((c) => c.id).sort(), ["justo", "pequeno"]);
  assert.equal(r.excluidas, 2);
});

test("la cola vuelve a comprobar las EXCLUSIONES de la regla al procesar: tope de 500 € y NIF/CIF no se convierten aunque el escáner los apuntara", async () => {
  const prev = { ...process.env };
  try {
    process.env.WOBI_HOLDED_TICKETS_MODO = "activo"; process.env.WOBI_HOLDED_TICKETS_EMPRESAS = "WOBA";
    process.env.WOBI_HOLDED_TICKETS_REGLA_MODO = "activo"; process.env.WOBI_HOLDED_TICKETS_REGLA_EMPRESAS = "Footprint";
    const base = { tipo: "ticket" as const, empresa: "Footprint", creadoEn: 1, actualizadoEn: 1, intentos: 0, estado: "solicitado" as const, evidencia: { origen: "regla_auto" } as Record<string, unknown> };
    const almacen = new AlmacenTrabajosMemoria();
    for (const id of ["grande", "conNif", "bueno"]) await almacen.guardar({ ...base, clave: claveTicket("Footprint", id), objetivo: id });
    const compras: Record<string, Record<string, unknown>> = {
      grande: compra("grande", { currency: "USD", currency_change: "1.12", total: "2372,42", payments_total: "2372,42", payments_pending: "0,00", payments_detail: [{ bank_id: "b" }] }),
      conNif: compra("conNif", { currency: "USD", currency_change: "1.12", total: "16,57", payments_total: "16,57", payments_pending: "0,00", payments_detail: [{ bank_id: "b" }] }),
      bueno: compra("bueno", { currency: "USD", currency_change: "1.12", total: "16,57", payments_total: "16,57", payments_pending: "0,00", payments_detail: [{ bank_id: "b" }] }),
    };
    const contactos: Record<string, Record<string, unknown>> = { "k-grande": { code: "" }, "k-conNif": { vat_number: "B63258438" }, "k-bueno": { code: "" } };
    const leer = async (_e: string, ruta: string) => {
      if (ruta === "/purchases") return { items: [], has_more: false };
      if (ruta.endsWith("/attachments")) return { items: [{ id: "a" }] };
      if (ruta.startsWith("/contacts/")) return contactos[decodeURIComponent(ruta.split("/").pop()!)] ?? {};
      return compras[ruta.split("/").pop()!];
    };
    // Para llegar a la comprobación de la regla, la cola tiene que ver el gasto como factura de compra (figura en el listado).
    const leerComoFactura = async (e: string, ruta: string, params?: Record<string, string | undefined>) => {
      if (ruta === "/purchases") return { items: Object.keys(compras).map((id) => ({ id })), has_more: false };
      return leer(e, ruta);
    };
    const r = await procesarColaTickets({ almacen, leer: leerComoFactura });
    const estado = async (id: string) => (await almacen.obtener(claveTicket("Footprint", id)))!;
    assert.equal((await estado("grande")).estado, "omitido");
    assert.match((await estado("grande")).ultimoError ?? "", /ya no lo aprueba.*500/);
    assert.equal((await estado("conNif")).estado, "omitido");
    assert.match((await estado("conNif")).ultimoError ?? "", /NIF\/CIF/);
    // El válido sigue su camino normal (aquí se detiene por falta de navegador, no por la regla).
    assert.notEqual((await estado("bueno")).estado, "omitido");
    assert.ok(r.revisados >= 3);
  } finally { for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k]; Object.assign(process.env, prev); }
});

test("la regla manda sobre la clasificación provisional del nacimiento del gasto: reabre «dudosa» y «factura declarada» nunca intentadas, y respeta todo lo demás", async () => {
  reiniciarVistosParaPruebas();
  const almacen = new AlmacenTrabajosMemoria();
  const base = { tipo: "ticket" as const, empresa: "Footprint", creadoEn: 1, actualizadoEn: 1 };
  const prov = (id: string, estado: "requiere_intervencion" | "omitido" | "completado" | "fallido", extra: Record<string, unknown> = {}, intentos = 0, ultimoError?: string) =>
    almacen.guardar({ ...base, clave: claveTicket("Footprint", id), objetivo: id, estado, intentos, ultimoError, evidencia: { origen: "recepcion", clasificacion: estado === "omitido" ? "factura" : "revisar", ...extra } });
  await prov("dudosa", "requiere_intervencion", {}, 0, "Clasificación dudosa: pendiente de revisión");
  await prov("facturaDeclarada", "omitido");
  await prov("yaConvertida", "completado", {}, 1);
  await prov("intentada", "requiere_intervencion", {}, 2, "Clasificación dudosa: pendiente de revisión");
  await prov("fallida", "fallido", {}, 3);
  await prov("conNif", "requiere_intervencion", {}, 0, "Clasificación dudosa: pendiente de revisión");
  const ids = ["dudosa", "facturaDeclarada", "yaConvertida", "intentada", "fallida", "conNif", "nueva"];
  const compras = ids.map((id) => compra(id, { currency: "COP", currency_change: "4000", total: "30000,00" }));
  const contactos = Object.fromEntries(ids.map((id) => [`k-${id}`, id === "conNif" ? { vat_number: "B63258438" } : { code: "" }]));
  const r = await escanearReglaTicket("Footprint", almacen, { leer: mundo(compras, contactos), simulada: false });
  assert.deepEqual(r.candidatos.map((c) => c.id).sort(), ["dudosa", "facturaDeclarada", "nueva"]);
  const e = async (id: string) => (await almacen.obtener(claveTicket("Footprint", id)))!;
  for (const id of ["dudosa", "facturaDeclarada"]) {
    assert.equal((await e(id)).estado, "solicitado"); assert.equal((await e(id)).evidencia.origen, "regla_auto");
    assert.equal((await e(id)).evidencia.reabiertoPorRegla, true); assert.equal((await e(id)).ultimoError, undefined);
  }
  assert.equal((await e("yaConvertida")).estado, "completado");
  assert.equal((await e("intentada")).estado, "requiere_intervencion");
  assert.equal((await e("fallida")).estado, "fallido");
  assert.equal((await e("conNif")).estado, "requiere_intervencion", "con NIF/CIF la regla dice «nunca»: no se reabre");
  assert.equal((await e("nueva")).evidencia.origen, "regla_auto");
  // Idempotente: una segunda exploración no vuelve a registrar nada.
  assert.equal((await escanearReglaTicket("Footprint", almacen, { leer: mundo(compras, contactos), simulada: false })).candidatos.length, 0);
});
test("puedeReabrirPorRegla: solo lo provisional y nunca intentado", () => {
  const t = (estado: string, intentos: number, evidencia: Record<string, unknown>, ultimoError?: string) => ({ estado, intentos, ultimoError, evidencia }) as never;
  assert.equal(puedeReabrirPorRegla(t("requiere_intervencion", 0, { origen: "recepcion" }, "Clasificación dudosa: pendiente de revisión")), true);
  assert.equal(puedeReabrirPorRegla(t("omitido", 0, { origen: "recepcion", clasificacion: "factura" })), true);
  assert.equal(puedeReabrirPorRegla(t("omitido", 0, { origen: "recepcion", clasificacion: "ticket" })), false);
  assert.equal(puedeReabrirPorRegla(t("omitido", 1, { origen: "recepcion", clasificacion: "factura" })), false);
  assert.equal(puedeReabrirPorRegla(t("requiere_intervencion", 0, { origen: "regla_auto" }, "Clasificación dudosa")), false);
  assert.equal(puedeReabrirPorRegla(t("requiere_intervencion", 0, { origen: "recepcion" }, "Sin sesión web de Holded")), false);
});

/* ───────── Caso real 08-10-2026 (Footprint): restaurantes y taxis de México/Colombia sin convertir y sin pregunta ───────── */

const provisional = (id: string) => ({
  clave: claveTicket("Footprint", id), tipo: "ticket" as const, empresa: "Footprint", objetivo: id, estado: "requiere_intervencion" as const, intentos: 0,
  creadoEn: 1, actualizadoEn: 1, ultimoError: "Clasificación dudosa: pendiente de revisión",
  evidencia: { proveedor: `Prov ${id}`, clasificacion: "revisar", motivos: ["sin evidencia"], origen: "recepcion" } as Record<string, unknown>,
});
// Gasto ya en EUR (se convirtió al crearlo); la descripción deja escrita la moneda del recibo, como hace WOBI.
const enEuros = (id: string, descripcion = "Almuerzo restaurante — 6 oct 2026") => compra(id, { currency: "EUR", currency_change: "1.00", total: "8,92", description: descripcion });
const sinNif = (id: string) => ({ [`k-${id}`]: { code: "" } });

test("regla: un recibo original fuera del euro (MXN) con el gasto ya en EUR es señal de ticket; en euros no; con NIF o por encima del tope nunca", () => {
  assert.equal(evaluarReglaTicket({ ...base, monedaOriginal: "MXN" }).decision, "ticket");
  assert.match(evaluarReglaTicket({ ...base, monedaOriginal: "mxn" }).motivos.join(" "), /recibo original en MXN/);
  assert.equal(evaluarReglaTicket({ ...base, monedaOriginal: "EUR" }).decision, "revisar");
  assert.equal(evaluarReglaTicket({ ...base, monedaOriginal: "COP", tieneNif: true }).decision, "nunca");
  assert.equal(evaluarReglaTicket({ ...base, monedaOriginal: "COP", totalEUR: TOPE_EUR_AUTOMATICO + 1 }).decision, "nunca");
});

test("la moneda del recibo se lee de la frase que WOBI deja en la descripción del gasto", () => {
  assert.equal(monedaOriginalDeDescripcion("Almuerzo — 6 oct 2026 (180 MXN, comprobante en MXN)"), "MXN");
  assert.equal(monedaOriginalDeDescripcion("Pedido Rappi — Medellín — 1 oct 2026 (53300 COP, comprobante en COP)"), "COP");
  assert.equal(monedaOriginalDeDescripcion("Hospedaje (200 USD, Comprobante en usd)"), "USD");
  assert.equal(monedaOriginalDeDescripcion("Tiquete aéreo LATAM — reservado vía Booking.com"), undefined);
  assert.equal(monedaOriginalDeDescripcion(undefined), undefined);
  const e = entradaReglaDesdeCompra({ currency: "EUR", currency_change: "1.00", total: "8,92", description: "Café — (85 MXN, comprobante en MXN)" }, { code: "" }, false);
  assert.equal(e.monedaOriginal, "MXN");
});

test("un dudoso que ya traía registro provisional AHORA se pregunta (antes la pregunta no llegaba nunca), una sola vez, y el botón lo puede atender", async () => {
  reiniciarVistosParaPruebas();
  const almacen = new AlmacenTrabajosMemoria();
  await almacen.guardar(provisional("duda"));
  const leer = mundo([enEuros("duda")], sinNif("duda"));
  const r = await escanearReglaTicket("Footprint", almacen, { leer, simulada: false });
  assert.deepEqual(r.dudosos.map((d) => d.id), ["duda"]);
  const t = await almacen.obtener(claveTicket("Footprint", "duda"));
  assert.equal(t?.evidencia.origen, "regla_revisar");
  assert.equal(t?.estado, "requiere_intervencion");
  assert.equal(t?.intentos, 0);
  // Una sola vez: tras reiniciar la memoria del proceso (despliegue) no vuelve a preguntar.
  reiniciarVistosParaPruebas();
  assert.equal((await escanearReglaTicket("Footprint", almacen, { leer, simulada: false })).dudosos.length, 0);
  // Y la decisión del botón funciona sobre ese registro.
  const { aprobarDudoso } = await import("./decisionesTickets");
  assert.equal(await aprobarDudoso(almacen, "Footprint", "duda"), "aprobado");
  assert.equal((await almacen.obtener(claveTicket("Footprint", "duda")))?.estado, "solicitado");
});

test("recibos en MXN/COP convertidos a EUR pasan a la cola solos, sin preguntar; el que no tiene señal sigue preguntándose", async () => {
  reiniciarVistosParaPruebas();
  const almacen = new AlmacenTrabajosMemoria();
  for (const id of ["cnidos", "rappi", "booking"]) await almacen.guardar(provisional(id));
  const compras = [
    enEuros("cnidos", "Almuerzo restaurante Cnidos y Rifados, Ciudad de México — 6 oct 2026 (180 MXN, comprobante en MXN)"),
    enEuros("rappi", "Pedido Rappi — Poke Laureles, Medellín, Colombia — 1 oct 2026 (53300 COP, comprobante en COP)"),
    enEuros("booking", "Tiquete aéreo LATAM LA4400 — Bogotá → Miami — reservado vía Booking.com"),
  ];
  const contactos = { ...sinNif("cnidos"), ...sinNif("rappi"), ...sinNif("booking") };
  const r = await escanearReglaTicket("Footprint", almacen, { leer: mundo(compras, contactos), simulada: false });
  assert.deepEqual(r.candidatos.map((c) => c.id).sort(), ["cnidos", "rappi"]);
  assert.deepEqual(r.dudosos.map((d) => d.id), ["booking"]);
  const t = await almacen.obtener(claveTicket("Footprint", "cnidos"));
  assert.equal(t?.estado, "solicitado"); assert.equal(t?.evidencia.origen, "regla_auto");
  assert.match(String(t?.evidencia.motivos), /recibo original en MXN/);
});

test("el recibo en otra moneda no salta las exclusiones: con NIF del proveedor o por encima de 500 € no se convierte", async () => {
  reiniciarVistosParaPruebas();
  const almacen = new AlmacenTrabajosMemoria();
  const compras = [
    enEuros("conNif", "Cena (180 MXN, comprobante en MXN)"),
    compra("grande", { currency: "EUR", currency_change: "1.00", total: "900,00", description: "Hotel (18000 MXN, comprobante en MXN)" }),
  ];
  const r = await escanearReglaTicket("Footprint", almacen, { leer: mundo(compras, { "k-conNif": { code: "B12345678" }, "k-grande": { code: "" } }), simulada: false });
  assert.equal(r.candidatos.length, 0);
  assert.equal(r.excluidas, 2);
});
