import assert from "node:assert/strict";
import test from "node:test";
import type { RegistroEdicionCompra } from "../holded/durablePurchaseEdit";
import type { CompraHoldedCruda } from "../holded/write";
import {
  aceptarEstadoActualEdiciones,
  detalleEdicionesInciertas,
  ejecutarSolicitudResolver,
  ErrorResolver,
  esTimeoutDeBloqueo,
  evaluarCoherenciaCompra,
  verificarIncidencia,
  type DependenciasResolver,
} from "./resolverIncidencias";

/** Como el HoldedApiError real: expone el status HTTP como propiedad. */
function noEncontrada(): Error {
  return Object.assign(new Error("Error de la API de Holded (404)"), { status: 404 });
}

const huellaDe = (id: string) => `cuentas-v2:actual-${id}`;
const pedir = (purchaseId: string, empresa = "Footprint", huella = huellaDe(purchaseId)) => ({ empresa, purchaseId, huella });

function registro(clave: string, purchaseId: string, extra: Partial<RegistroEdicionCompra> = {}): RegistroEdicionCompra {
  return {
    clave, proceso: "correo_gasto_automatico_reparar", estado: "incierta", empresa: "Footprint", purchaseId,
    huellaSolicitud: "s", huellaEsperada: "cuentas-v2:vieja", verificarTotal: false,
    creadoEn: 1_000, actualizadoEn: 2_000, ...extra,
  };
}

function compraBuena(id: string, extra: Record<string, unknown> = {}): CompraHoldedCruda {
  return {
    id, contact_id: "c1", contact_name: "Kiwi.com s.r.o.", date: "2026-09-16", currency: "USD", total: "151,00",
    document_number: "2026-56028514", draft: true, tags: ["avion"], payments_total: "151,00", payments_pending: "0,00",
    description: "Tiquete", lines: [{ name: "Vuelo", account: "65e9870a", price: "151,00" }], ...extra,
  } as CompraHoldedCruda;
}

function deps(over: Partial<DependenciasResolver> & { registros?: RegistroEdicionCompra[]; compras?: Record<string, CompraHoldedCruda | Error> } = {}) {
  const cerradas: Array<{ clave: string }> = [];
  const registros = over.registros ?? [];
  const d: DependenciasResolver = {
    reconciliadores: {
      "envios-correo-inciertos": async () => ({ revisados: 0, verificados: 0, inciertos: 0, errores: 0 }),
      "subidas-drive-inciertas": async () => ({ revisadas: 2, verificadas: 2, liberadas: 0, inciertas: 0, errores: 0 }),
      "compras-holded-inciertas": async () => ({ revisadas: 3, verificadas: 1, inciertas: 2, errores: 1 }),
      "ediciones-holded-inciertas": async () => ({ revisadas: 63, verificadas: 0, inciertas: 63, errores: 0 }),
      "adjuntos-holded-inciertos": async () => ({ revisados: 1, verificados: 1, inciertos: 0, errores: 0 }),
      "conciliaciones-holded-inciertas": async () => ({ revisadas: 0, verificadas: 0, revisiones: 0, inciertas: 0, errores: 0 }),
      "contactos-holded-inciertos": async () => ({ revisadas: 0, verificadas: 0, inciertas: 0, ambiguas: 0, errores: 0 }),
    },
    listarInciertas: async () => registros.filter((r) => r.estado === "incierta"),
    leerCompra: async (_empresa, id) => {
      const c = over.compras?.[id];
      if (c instanceof Error) throw c;
      if (!c) throw noEncontrada();
      return c;
    },
    huellaActual: (c) => huellaDe(String(c.id)),
    cerrar: async (clave) => {
      const r = registros.find((x) => x.clave === clave);
      if (!r || r.estado !== "incierta") return false;
      cerradas.push({ clave });
      r.estado = "verificada";
      return true;
    },
    conCoordinacion: (tarea) => tarea(),
  };
  return { d: { ...d, ...over } as DependenciasResolver, cerradas };
}

test("verificar: normaliza los distintos formatos de resumen y explica el resultado en claro", async () => {
  const { d } = deps();
  assert.match((await verificarIncidencia("envios-correo-inciertos", d)).mensaje, /ningún elemento pendiente/);
  assert.match((await verificarIncidencia("subidas-drive-inciertas", d)).mensaje, /Verificados 2 de 2: todo coincide/);
  const compras = await verificarIncidencia("compras-holded-inciertas", d);
  assert.deepEqual([compras.revisadas, compras.verificadas, compras.inciertas, compras.errores], [3, 1, 2, 1]);
  assert.match(compras.mensaje, /2 siguen sin poder confirmarse, 1 dieron error de lectura/);
  const adjuntos = await verificarIncidencia("adjuntos-holded-inciertos", d);
  assert.deepEqual([adjuntos.revisadas, adjuntos.verificadas, adjuntos.inciertas], [1, 1, 0]);
});

test("verificar: rechaza cualquier id que no sea una incidencia verificable (nada se ejecuta)", async () => {
  const { d } = deps();
  await assert.rejects(() => verificarIncidencia("gasto-hoy-elevado", d), /no admite verificación/);
  await assert.rejects(() => verificarIncidencia("__proto__", d), /no admite verificación/);
  await assert.rejects(() => verificarIncidencia("constructor", d), /no admite verificación/);
});

test("coherencia: una compra completa pasa; sin proveedor, sin líneas, sin cuenta o con total 0 NO pasa", () => {
  assert.deepEqual(evaluarCoherenciaCompra(compraBuena("a")).problemas, []);
  assert.match(evaluarCoherenciaCompra(compraBuena("a", { contact_id: "" })).problemas.join(), /proveedor/);
  assert.match(evaluarCoherenciaCompra(compraBuena("a", { lines: [] })).problemas.join(), /sin líneas|no tiene líneas/);
  assert.match(evaluarCoherenciaCompra(compraBuena("a", { lines: [{ name: "x", account: "" }] })).problemas.join(), /sin cuenta contable/);
  // Un total ilegible NO pasa; un total 0 o negativo (p. ej. un abono) es solo un aviso.
  assert.match(evaluarCoherenciaCompra(compraBuena("a", { total: "abc" })).problemas.join(), /No se puede leer el total/);
  assert.match(evaluarCoherenciaCompra(compraBuena("a", { total: undefined })).problemas.join(), /No se puede leer el total/);
  const cero = evaluarCoherenciaCompra(compraBuena("a", { total: "0,00" }));
  assert.deepEqual(cero.problemas, []);
  assert.match(cero.avisos.join(), /cero o negativo/);
  assert.match(evaluarCoherenciaCompra(compraBuena("a", { total: "-12,50" })).avisos.join(), /cero o negativo/);
  // "3.380,67" (miles con punto, decimal con coma) se interpreta bien: no es "total cero".
  assert.deepEqual(evaluarCoherenciaCompra(compraBuena("a", { total: "3.380,67" })).problemas, []);
});

test("coherencia: una línea nula o no objeto cuenta como sin cuenta y nunca rompe la lectura", () => {
  const r = evaluarCoherenciaCompra(compraBuena("a", { lines: [null, "x", { name: "ok", account: "65e9870a" }] }));
  assert.match(r.problemas.join(), /2 línea\(s\) sin cuenta contable/);
  assert.equal(r.hechos.lineas, 3);
});

test("coherencia: una moneda distinta de EUR se avisa (no bloquea) y EUR no genera aviso", () => {
  assert.match(evaluarCoherenciaCompra(compraBuena("a", { currency: "usd" })).avisos.join(), /Moneda distinta de EUR \(USD\)/);
  assert.doesNotMatch(evaluarCoherenciaCompra(compraBuena("a", { currency: "eur" })).avisos.join(), /Moneda/);
});

test("coherencia: un borrador sin número o con saldo pendiente es un AVISO informativo, no un bloqueo", () => {
  const r = evaluarCoherenciaCompra(compraBuena("a", { document_number: "00000", payments_pending: "5,40", tags: [] }));
  assert.deepEqual(r.problemas, []);
  assert.ok(r.avisos.length >= 3);
});

test("detalle: agrupa las 63 ediciones por compra y muestra el estado real de cada una", async () => {
  const registros = [
    ...Array.from({ length: 12 }, (_, i) => registro(`k${i}`, "P1", { creadoEn: 1_000 + i, actualizadoEn: 5_000 + i })),
    registro("z1", "P2"),
  ];
  const { d } = deps({ registros, compras: { P1: compraBuena("P1"), P2: new Error("HTTP 500") } });
  const detalle = await detalleEdicionesInciertas(d);
  assert.equal(detalle.totalEdiciones, 13);
  assert.equal(detalle.compras.length, 2);
  const p1 = detalle.compras.find((c) => c.purchaseId === "P1")!;
  assert.equal(p1.ediciones, 12);
  assert.equal(p1.coherente, true);
  assert.equal(p1.cerrable, true);
  assert.equal(p1.huella, huellaDe("P1"));
  assert.equal(p1.hechos?.proveedor, "Kiwi.com s.r.o.");
  assert.match(p1.nota ?? "", /12 veces/);
  assert.match(p1.nota ?? "", /vuelva a reeditarla/, "avisa de que cerrar no evita que el flujo automático la reedite");
  assert.equal(detalle.truncado, 0);
  const p2 = detalle.compras.find((c) => c.purchaseId === "P2")!;
  assert.equal(p2.existe, false);
  assert.equal(p2.eliminada, false, "un error de lectura que no es 404 no equivale a compra eliminada");
  assert.equal(p2.cerrable, false, "una compra que no se puede leer nunca se ofrece como cerrable");
  assert.match(p2.problemas.join(), /No se pudo leer/);
});

test("detalle: una compra que Holded responde 404 se ofrece como cerrable (eliminada) y una incoherente no", async () => {
  const registros = [registro("k1", "P1"), registro("k2", "P2")];
  const { d } = deps({ registros, compras: { P2: compraBuena("P2", { lines: [] }) } });
  const detalle = await detalleEdicionesInciertas(d);
  const p1 = detalle.compras.find((c) => c.purchaseId === "P1")!;
  assert.equal(p1.eliminada, true);
  assert.equal(p1.cerrable, true);
  assert.equal(p1.huella, "eliminada");
  const p2 = detalle.compras.find((c) => c.purchaseId === "P2")!;
  assert.equal(p2.coherente, false);
  assert.equal(p2.cerrable, false);
});

test("detalle: limita a 50 compras (las más recientes) e informa de cuántas quedan fuera", async () => {
  const registros = Array.from({ length: 53 }, (_, i) => registro(`k${i}`, `P${i}`, { actualizadoEn: 10_000 + i }));
  const compras = Object.fromEntries(registros.map((r) => [r.purchaseId, compraBuena(r.purchaseId)]));
  const detalle = await detalleEdicionesInciertas(deps({ registros, compras }).d);
  assert.equal(detalle.compras.length, 50);
  assert.equal(detalle.truncado, 3);
  assert.equal(detalle.totalEdiciones, 53);
  assert.equal(detalle.compras[0].purchaseId, "P52", "las más recientes primero");
  assert.ok(!detalle.compras.some((c) => c.purchaseId === "P0"));
});

test("aceptar: cierra TODAS las ediciones inciertas de una compra coherente, sin tocar las demás", async () => {
  const registros = [registro("k1", "P1"), registro("k2", "P1"), registro("k3", "P1"), registro("otra", "P9")];
  const { d, cerradas } = deps({ registros, compras: { P1: compraBuena("P1"), P9: compraBuena("P9") } });
  const r = await aceptarEstadoActualEdiciones([pedir("P1")], d);
  assert.equal(r.cerradas, 3);
  assert.deepEqual(cerradas.map((c) => c.clave).sort(), ["k1", "k2", "k3"]);
  assert.equal(registros.find((x) => x.clave === "otra")!.estado, "incierta", "no toca compras que no se pidieron");
});

test("aceptar: NO cierra nada si la compra no se puede releer o ya no es coherente", async () => {
  const registros = [registro("k1", "P1"), registro("k2", "P2"), registro("k3", "P3")];
  const { d, cerradas } = deps({
    registros,
    compras: { P1: new Error("HTTP 500"), P2: compraBuena("P2", { lines: [{ name: "x", account: "" }] }), P3: compraBuena("P3") },
  });
  const r = await aceptarEstadoActualEdiciones(
    [pedir("P1"), pedir("P2"), pedir("P3")],
    d
  );
  assert.equal(r.cerradas, 1);
  assert.equal(r.omitidas, 2);
  assert.deepEqual(cerradas.map((c) => c.clave), ["k3"]);
  assert.match(r.compras.find((c) => c.purchaseId === "P1")!.omitida!, /No se pudo releer/);
  assert.match(r.compras.find((c) => c.purchaseId === "P2")!.omitida!, /sin cuenta contable/);
});

test("aceptar: un id inventado, de otra empresa o ya resuelto no hace nada; y no se duplican solicitudes", async () => {
  const registros = [registro("k1", "P1")];
  const { d, cerradas } = deps({ registros, compras: { P1: compraBuena("P1") } });
  const r = await aceptarEstadoActualEdiciones(
    [
      pedir("NO-EXISTE"),
      pedir("P1", "WOBA"),
      pedir("P1"),
      pedir("P1"),
    ],
    d
  );
  assert.equal(r.cerradas, 1);
  assert.equal(cerradas.length, 1);
  assert.equal(r.omitidas, 2);
});

test("aceptar: valida la entrada (vacía o demasiado grande)", async () => {
  const { d } = deps();
  await assert.rejects(() => aceptarEstadoActualEdiciones([], d), /al menos una compra/);
  await assert.rejects(
    () => aceptarEstadoActualEdiciones(Array.from({ length: 51 }, (_, i) => pedir(`P${i}`)), d),
    /Máximo 50/
  );
});

test("solicitud POST: valida antes de ejecutar (faltan campos, acción desconocida, aceptar sin confirmar o sobre otra recomendación)", async () => {
  const { d, cerradas } = deps({ registros: [registro("k1", "P1")], compras: { P1: compraBuena("P1") } });
  const compras = [pedir("P1")];
  assert.equal((await ejecutarSolicitudResolver(null, d)).status, 400);
  assert.equal((await ejecutarSolicitudResolver({ id: "x" }, d)).status, 400);
  assert.equal((await ejecutarSolicitudResolver({ id: "ediciones-holded-inciertas", accion: "borrar" }, d)).status, 400);
  const sinConfirmar = await ejecutarSolicitudResolver({ id: "ediciones-holded-inciertas", accion: "aceptar", compras }, d);
  assert.equal(sinConfirmar.status, 400);
  assert.match(sinConfirmar.cuerpo.error ?? "", /confirmación explícita/);
  const confirmarTexto = await ejecutarSolicitudResolver({ id: "ediciones-holded-inciertas", accion: "aceptar", confirmar: "true", compras }, d);
  assert.equal(confirmarTexto.status, 400, "solo el booleano true cuenta como confirmación");
  const otra = await ejecutarSolicitudResolver({ id: "compras-holded-inciertas", accion: "aceptar", confirmar: true, compras }, d);
  assert.equal(otra.status, 400);
  assert.match(otra.cuerpo.error ?? "", /no admite aceptar/);
  assert.equal(cerradas.length, 0, "ninguna solicitud inválida cerró nada");
});

test("solicitud POST: verificar y aceptar válidos devuelven 200 y ejecutan; los errores internos no filtran detalles", async () => {
  const { d, cerradas } = deps({ registros: [registro("k1", "P1")], compras: { P1: compraBuena("P1") } });
  const v = await ejecutarSolicitudResolver({ id: "ediciones-holded-inciertas", accion: "verificar" }, d);
  assert.equal(v.status, 200);
  const a = await ejecutarSolicitudResolver(
    { id: "ediciones-holded-inciertas", accion: "aceptar", confirmar: true, compras: [pedir("P1"), { basura: 1 }, "x", { empresa: "Footprint", purchaseId: "P1" }] },
    d
  );
  assert.equal(a.status, 200);
  assert.equal(cerradas.length, 1);

  const roto = deps({
    reconciliadores: {
      ...deps().d.reconciliadores,
      "ediciones-holded-inciertas": async () => { throw new Error("secreto: token abc123 en la URL interna"); },
    },
  });
  const e = await ejecutarSolicitudResolver({ id: "ediciones-holded-inciertas", accion: "verificar" }, roto.d);
  assert.equal(e.status, 500);
  assert.doesNotMatch(e.cuerpo.error ?? "", /secreto|abc123/);
  const noVerificable = await ejecutarSolicitudResolver({ id: "gasto-hoy-elevado", accion: "verificar" }, d);
  assert.equal(noVerificable.status, 400);
});

test("aceptar: si la compra cambió desde que se revisó (otra huella) NO se cierra nada", async () => {
  const registros = [registro("k1", "P1"), registro("k2", "P2")];
  const { d, cerradas } = deps({ registros, compras: { P1: compraBuena("P1"), P2: compraBuena("P2") } });
  const r = await aceptarEstadoActualEdiciones([pedir("P1", "Footprint", "cuentas-v2:la-que-se-vio"), pedir("P2")], d);
  assert.equal(r.cerradas, 1);
  assert.deepEqual(cerradas.map((c) => c.clave), ["k2"]);
  assert.match(r.compras.find((c) => c.purchaseId === "P1")!.omitida!, /cambió desde que la revisaste/);
  assert.equal(registros[0].estado, "incierta");
});

test("aceptar: una compra eliminada en Holded se cierra solo si se pidió como eliminada; si reaparece, no", async () => {
  const registros = [registro("k1", "P1"), registro("k2", "P2")];
  const { d, cerradas } = deps({ registros, compras: { P2: compraBuena("P2") } });
  const r = await aceptarEstadoActualEdiciones([pedir("P1", "Footprint", "eliminada"), pedir("P2", "Footprint", "eliminada")], d);
  assert.equal(r.cerradas, 1);
  assert.deepEqual(cerradas.map((c) => c.clave), ["k1"]);
  assert.match(r.compras.find((c) => c.purchaseId === "P2")!.omitida!, /cambió/);
});

test("aceptar: un fallo al escribir el ledger de una compra no aborta las demás y se informa", async () => {
  const registros = [registro("k1", "P1"), registro("k2", "P1"), registro("k3", "P2")];
  const base = deps({ registros, compras: { P1: compraBuena("P1"), P2: compraBuena("P2") } });
  let llamadas = 0;
  const d: DependenciasResolver = {
    ...base.d,
    cerrar: async (clave) => {
      llamadas++;
      if (clave === "k2") throw new Error("Quota exceeded");
      return base.d.cerrar(clave);
    },
  };
  const r = await aceptarEstadoActualEdiciones([pedir("P1"), pedir("P2")], d);
  assert.equal(llamadas, 3);
  assert.equal(r.cerradas, 2, "k1 y k3 sí se cerraron");
  assert.equal(r.omitidas, 1);
  const p1 = r.compras.find((c) => c.purchaseId === "P1")!;
  assert.equal(p1.cerradas, 1);
  assert.match(p1.omitida!, /error temporal/);
  assert.doesNotMatch(p1.omitida!, /Quota/);
});

test("coordinación: si hay una revisión de correo en curso responde 409 y no ejecuta ni verifica ni cierra nada", async () => {
  const base = deps({ registros: [registro("k1", "P1")], compras: { P1: compraBuena("P1") } });
  const d: DependenciasResolver = {
    ...base.d,
    conCoordinacion: async () => {
      throw new ErrorResolver(409, "Hay una revisión de correo en curso.");
    },
  };
  const a = await ejecutarSolicitudResolver({ id: "ediciones-holded-inciertas", accion: "aceptar", confirmar: true, compras: [pedir("P1")] }, d);
  assert.equal(a.status, 409);
  assert.match(a.cuerpo.error ?? "", /en curso/);
  const v = await ejecutarSolicitudResolver({ id: "ediciones-holded-inciertas", accion: "verificar" }, d);
  assert.equal(v.status, 409);
  assert.equal(base.cerradas.length, 0);
});

test("coordinación: reconoce el timeout de bloqueo de PostgreSQL y nada más", () => {
  assert.equal(esTimeoutDeBloqueo(Object.assign(new Error("x"), { code: "55P03" })), true);
  assert.equal(esTimeoutDeBloqueo(new Error("canceling statement due to lock timeout")), true);
  assert.equal(esTimeoutDeBloqueo(new Error("Quota exceeded")), false);
  assert.equal(esTimeoutDeBloqueo(null), false);
});

test("verificar: no da por bueno un resumen con revisiones manuales o ambiguas y cuenta las liberadas aparte", async () => {
  const base = deps();
  const conRev: DependenciasResolver = {
    ...base.d,
    reconciliadores: {
      ...base.d.reconciliadores,
      "conciliaciones-holded-inciertas": async () => ({ revisadas: 4, verificadas: 3, revisiones: 1, inciertas: 0, errores: 0 }),
      "contactos-holded-inciertos": async () => ({ revisadas: 2, verificadas: 1, inciertas: 0, ambiguas: 1, errores: 0 }),
      "subidas-drive-inciertas": async () => ({ revisadas: 3, verificadas: 2, liberadas: 1, inciertas: 0, errores: 0 }),
    },
  };
  const conc = await verificarIncidencia("conciliaciones-holded-inciertas", conRev);
  assert.equal(conc.pendientesRevision, 1);
  assert.match(conc.mensaje, /1 requieren revisión manual/);
  assert.doesNotMatch(conc.mensaje, /todo coincide/);
  const cont = await verificarIncidencia("contactos-holded-inciertos", conRev);
  assert.match(cont.mensaje, /1 requieren revisión manual/);
  const drive = await verificarIncidencia("subidas-drive-inciertas", conRev);
  assert.match(drive.mensaje, /todo coincide.*1 más se liberaron/);
});
