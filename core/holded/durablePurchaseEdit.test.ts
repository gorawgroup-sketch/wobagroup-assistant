import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictoEdicionCompraError,
  EdicionCompraInciertaError,
  MAX_EDICIONES_AUTOMATICAS_POR_COMPRA,
  TopeEdicionesAutomaticasError,
  ejecutarEdicionCompraDurable,
  identidadEdicionCompra,
  reconciliarEdicionesCompraPendientes,
  type EstadoEdicionCompra,
  type PreparacionEdicionCompra,
  type RegistroEdicionCompra,
  type RepositorioEdicionesCompra,
  type ResultadoEdicionCompra,
  type TransporteEdicionCompra,
} from "./durablePurchaseEdit";
import { configuracionEdicionesCompraDurables, huellaEstadoCompra, huellaEstadoCompraVersion, coincideEstadoCompraEsperado, edicionCompraSinCambios } from "./write";

interface DocumentoPrueba { id: string; numero: string; }

class RepoMemoria implements RepositorioEdicionesCompra {
  filas = new Map<string, RegistroEdicionCompra>();
  fallarCheckpoint = false;

  async reservar(registro: RegistroEdicionCompra) {
    const existente = this.filas.get(registro.clave);
    if (existente) return { registro: { ...existente }, nuevo: false };
    this.filas.set(registro.clave, { ...registro });
    return { registro: { ...registro }, nuevo: true };
  }
  async obtener(clave: string) { const r = this.filas.get(clave); return r ? { ...r } : undefined; }
  async actualizarPreparada(clave: string, registro: RegistroEdicionCompra) {
    const actual = this.filas.get(clave);
    if (!actual || actual.estado !== "preparada") return undefined;
    const siguiente = { ...actual, ...registro, estado: "preparada" as const };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
  async marcarEditando(clave: string, huellaEsperada: string, verificarTotal: boolean) {
    const actual = this.filas.get(clave);
    if (!actual || actual.estado !== "preparada") return undefined;
    const siguiente = { ...actual, estado: "editando" as const, huellaEsperada, verificarTotal };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
  async marcarPreparada(clave: string) { this.cambiar(clave, ["editando"], "preparada", true); }
  async marcarIncierta(clave: string) { this.cambiar(clave, ["editando"], "incierta"); }
  async marcarVerificada(clave: string) {
    if (this.fallarCheckpoint) throw new Error("Sheets no responde");
    this.cambiar(clave, ["editando", "incierta"], "verificada");
  }
  async listarPendientes() {
    return [...this.filas.values()]
      .filter((r) => r.estado === "editando" || r.estado === "incierta")
      .map((r) => ({ ...r }));
  }
  async contarEdicionesAutomaticas(empresa: string, purchaseId: string, excluirClave: string) {
    return [...this.filas.values()].filter((r) => r.empresa === empresa && r.purchaseId === purchaseId && r.clave !== excluirClave &&
      r.proceso.startsWith("correo_gasto_automatico") && r.estado !== "preparada").length;
  }
  private cambiar(
    clave: string,
    permitidos: EstadoEdicionCompra[],
    estado: EstadoEdicionCompra,
    limpiar = false
  ) {
    const actual = this.filas.get(clave);
    if (!actual || !permitidos.includes(actual.estado)) return undefined;
    const siguiente = {
      ...actual,
      estado,
      ...(limpiar ? { huellaEsperada: undefined, verificarTotal: undefined } : {}),
      actualizadoEn: 500,
    };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
}

function transporte(opciones: { errorEdicion?: unknown; aplicadaInicial?: boolean; sinCambios?: boolean } = {}) {
  let aplicada = opciones.aplicadaInicial ?? false;
  const preparaciones: PreparacionEdicionCompra[] = [];
  const ediciones: PreparacionEdicionCompra[] = [];
  const verificaciones: string[] = [];
  const valor: TransporteEdicionCompra<DocumentoPrueba> & {
    preparaciones: PreparacionEdicionCompra[];
    ediciones: PreparacionEdicionCompra[];
    verificaciones: string[];
    aplicar(): void;
  } = {
    preparaciones,
    ediciones,
    verificaciones,
    async preparar() {
      const preparacion = { huellaEsperada: "huella-final", verificarTotal: true, payload: { numero: "B" }, ...(opciones.sinCambios ? { sinCambios: true } : {}) };
      preparaciones.push(preparacion);
      return preparacion;
    },
    async editar(preparacion) {
      ediciones.push(preparacion);
      if (opciones.errorEdicion) throw opciones.errorEdicion;
      aplicada = true;
    },
    async verificar(registro) {
      verificaciones.push(registro.huellaEsperada ?? "");
      return aplicada && registro.huellaEsperada === "huella-final"
        ? { id: registro.purchaseId, valor: { id: registro.purchaseId, numero: "B" } }
        : undefined;
    },
    aplicar() { aplicada = true; },
  };
  return valor;
}

const CAMBIOS = { numeroDocumento: "B" };

function ejecutar(
  repo: RepoMemoria,
  holded: TransporteEdicionCompra<DocumentoPrueba>,
  cambios: unknown = CAMBIOS,
  ahora = 1
) {
  return ejecutarEdicionCompraDurable(
    "propuesta-edicion:abc", "WOBA", "purchase-1", cambios, "edicion_compra_aprobada", repo, holded, ahora
  );
}

test("una aprobación edita una sola vez y una repetición solo verifica", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  const primero = await ejecutar(repo, holded, CAMBIOS, 1);
  const segundo = await ejecutar(repo, holded, CAMBIOS, 2);
  assert.equal(primero.reutilizado, false);
  assert.equal(segundo.reutilizado, true);
  assert.equal(segundo.resultado.valor.numero, "B");
  assert.equal(holded.ediciones.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "verificada");
});

test("timeout aplicado se recupera por lectura sin repetir PUT", async () => {
  const repo = new RepoMemoria();
  const timeout = new Error("timeout");
  const holded = transporte({ errorEdicion: timeout, aplicadaInicial: true });
  const resultado = await ejecutar(repo, holded);
  assert.equal(resultado.reutilizado, true);
  assert.equal(holded.ediciones.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "verificada");
});

test("timeout no verificable queda incierto y nunca repite PUT", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ errorEdicion: new Error("timeout") });
  await assert.rejects(ejecutar(repo, holded, CAMBIOS, 1), EdicionCompraInciertaError);
  await assert.rejects(ejecutar(repo, holded, CAMBIOS, 2), EdicionCompraInciertaError);
  assert.equal(holded.ediciones.length, 1);
  assert.equal(holded.preparaciones.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "incierta");
});

test("un rechazo 422 vuelve a preparada y permite una propuesta corregida", async () => {
  const repo = new RepoMemoria();
  const rechazo = Object.assign(new Error("fecha bloqueada"), { status: 422 });
  await assert.rejects(ejecutar(repo, transporte({ errorEdicion: rechazo }), CAMBIOS, 1), rechazo);
  assert.equal(repo.filas.values().next().value?.estado, "preparada");

  const resultado = await ejecutar(repo, transporte(), { numeroDocumento: "C" }, 2);
  assert.equal(resultado.resultado.valor.numero, "B");
  assert.equal(repo.filas.values().next().value?.estado, "verificada");
});

test("una escritura que la guardia no dejó salir vuelve a preparada y el reintento edita", async () => {
  const repo = new RepoMemoria();
  const noIniciada = Object.assign(new Error("Coordinación durable no disponible."), { name: "EscrituraHoldedNoIniciadaError" });
  await assert.rejects(ejecutar(repo, transporte({ errorEdicion: noIniciada }), CAMBIOS, 1), noIniciada);
  assert.equal(repo.filas.values().next().value?.estado, "preparada");

  const holded = transporte();
  const resultado = await ejecutar(repo, holded, CAMBIOS, 2);
  assert.equal(resultado.reutilizado, false);
  assert.equal(holded.ediciones.length, 1);
  assert.equal(repo.filas.values().next().value?.estado, "verificada");
});

test("datos distintos se bloquean si la primera edición quedó incierta", async () => {
  const repo = new RepoMemoria();
  await assert.rejects(ejecutar(repo, transporte({ errorEdicion: new Error("timeout") })), EdicionCompraInciertaError);
  await assert.rejects(ejecutar(repo, transporte(), { numeroDocumento: "C" }, 2), ConflictoEdicionCompraError);
});

test("fallo del checkpoint posterior al PUT no permite un segundo PUT", async () => {
  const repo = new RepoMemoria();
  repo.fallarCheckpoint = true;
  const holded = transporte();
  await assert.rejects(ejecutar(repo, holded, CAMBIOS, 1), EdicionCompraInciertaError);
  await assert.rejects(ejecutar(repo, holded, CAMBIOS, 2), EdicionCompraInciertaError);
  assert.equal(holded.ediciones.length, 1);
});

test("la reconciliación confirma encontrados y conserva el resto sin editar", async () => {
  const repo = new RepoMemoria();
  const a = {
    ...identidadEdicionCompra("a", "WOBA", "purchase-a", CAMBIOS, "test", 1),
    estado: "editando" as const,
    huellaEsperada: "huella-final",
    verificarTotal: true,
  };
  const b = {
    ...identidadEdicionCompra("b", "WOBA", "purchase-b", CAMBIOS, "test", 1),
    estado: "incierta" as const,
    huellaEsperada: "otra",
    verificarTotal: true,
  };
  repo.filas.set(a.clave, a);
  repo.filas.set(b.clave, b);
  const holded = transporte({ aplicadaInicial: true });
  const resumen = await reconciliarEdicionesCompraPendientes(repo, holded.verificar);
  assert.deepEqual(resumen, { revisadas: 2, verificadas: 1, inciertas: 1, errores: 0 });
  assert.equal(repo.filas.get(a.clave)?.estado, "verificada");
  assert.equal(repo.filas.get(b.clave)?.estado, "incierta");
  assert.equal(holded.ediciones.length, 0);
});

test("la identidad es estable y no filtra la aprobación ni los cambios", () => {
  const a = identidadEdicionCompra("propuesta:secreta", "WOBA", "purchase-1", CAMBIOS, "test", 1);
  const b = identidadEdicionCompra("propuesta:secreta", "WOBA", "purchase-1", CAMBIOS, "test", 2);
  const c = identidadEdicionCompra("propuesta:secreta", "EWORKS", "purchase-1", CAMBIOS, "test", 1);
  assert.equal(a.clave, b.clave);
  assert.notEqual(a.clave, c.clave);
  assert.equal(a.clave.includes("secreta"), false);
  assert.equal(a.huellaSolicitud.includes("B"), false);
  assert.throws(() => identidadEdicionCompra("", "WOBA", "purchase-1", CAMBIOS, "test"), /obligatoria/);
});

test("la protección solo se desactiva con false explícito", () => {
  assert.equal(configuracionEdicionesCompraDurables({} as NodeJS.ProcessEnv).habilitado, true);
  assert.equal(
    configuracionEdicionesCompraDurables({ WOBI_HOLDED_EDIT_DURABLE_ENABLED: " false " } as NodeJS.ProcessEnv).habilitado,
    false
  );
  assert.equal(
    configuracionEdicionesCompraDurables({ WOBI_HOLDED_EDIT_DURABLE_ENABLED: "falso" } as NodeJS.ProcessEnv).habilitado,
    true
  );
});

test("la huella compara formatos reales de Holded sin exponer los valores", () => {
  const esperada = huellaEstadoCompra(
    {
      id: "purchase-1",
      document_number: "F-100",
      date: "2026-09-11",
      due_date: null,
      currency: "usd",
      currency_change: 1.16,
      contact_id: "contact-1",
      design_id: null,
      total: 1234.56,
      lines: [{}, {}],
    },
    true
  );
  const releida = huellaEstadoCompra(
    {
      id: "purchase-1",
      document_number: "F-100",
      date: "2026-09-11",
      due_date: "",
      currency: "USD",
      currency_change: "1.16",
      contact_id: "contact-1",
      design_id: "",
      total: "1.234,56",
      lines: [{ name: "A" }, { name: "B" }],
    },
    true
  );
  const alterada = huellaEstadoCompra(
    {
      id: "purchase-1",
      document_number: "F-100",
      date: "2026-09-11",
      currency: "USD",
      currency_change: "1.16",
      contact_id: "contact-1",
      total: "1.235,56",
      lines: [{}, {}],
    },
    true
  );
  assert.equal(esperada, releida);
  assert.notEqual(esperada, alterada);
  assert.equal(esperada.includes("F-100"), false);
});

test("la huella de una corrección contable verifica cada cuenta sin romper huellas anteriores", () => {
  const base = {
    id: "purchase-1",
    document_number: "1313",
    date: "2026-09-11",
    currency: "EUR",
    currency_change: "1.00",
    contact_id: "contact-1",
    total: "2.200,00",
    lines: [{ name: "Consulting Service", account: "profesionales" }],
  };
  const cuentaDistinta = {
    ...base,
    lines: [{ name: "Consulting Service", account: "woba-services" }],
  };

  // Compatibilidad: las ediciones antiguas siguen usando exactamente la
  // huella histórica, que deliberadamente no incluía el detalle de cuenta.
  assert.equal(huellaEstadoCompra(base, true), huellaEstadoCompra(cuentaDistinta, true));

  const esperada = huellaEstadoCompra(base, true, true);
  assert.match(esperada, /^cuentas-v3:[a-f0-9]{64}$/);
  assert.notEqual(esperada, huellaEstadoCompra(cuentaDistinta, true, true));
  assert.equal(esperada.includes("profesionales"), false);
});

test("la huella contable acepta el orden de tags que devuelve Holded", () => {
  const base = {
    id: "purchase-1", document_number: "1", date: "2026-09-11", currency: "EUR",
    contact_id: "contact-1", total: 10, tags: ["Viaje", "Persona"],
    lines: [{ name: "Gasto", account: "viajes", tags: ["Proyecto", "Persona"] }],
  };
  const reordenada = {
    ...base, tags: ["persona", "viaje"],
    lines: [{ ...base.lines[0], tags: ["persona", "proyecto"] }],
  };
  assert.equal(huellaEstadoCompra(base, true, true), huellaEstadoCompra(reordenada, true, true));
});

test("la huella distingue la reparación de USD a EUR y la tasa aplicada", () => {
  const usd = {
    id: "purchase-anthropic",
    document_number: "2599-9467-0883",
    date: "2026-09-11",
    currency: "USD",
    currency_change: "1.16",
    contact_id: "anthropic",
    total: "20,88",
    lines: [{ name: "Anthropic", price: "20,88" }],
  };
  const eur = { ...usd, currency: "EUR", currency_change: 1 };
  assert.notEqual(huellaEstadoCompra(usd, true), huellaEstadoCompra(eur, true));
});


test("descripción vacía devuelta por Holded confirma líneas nuevas sin ocultar cambios contables", () => {
  const propuesta = { id: "tax-payment", document_number: "TAX-1", date: "2026-09-21",
    currency: "EUR", total: "137,62", contact_id: "aeat",
    lines: [{ name: "Sanción tributaria", type: "product", units: 1, price: 137.62, taxes: [], account: "excepcionales" }] };
  const leida = { ...propuesta, lines: [{ ...propuesta.lines[0], description: "" }] };
  assert.equal(huellaEstadoCompra(propuesta, true, true), huellaEstadoCompra(leida, true, true));
  for (const version of [1, 2, 3] as const) {
    const esperada = huellaEstadoCompraVersion(propuesta, true, version);
    assert.equal(coincideEstadoCompraEsperado(leida, esperada, true), true);
    for (const cambio of [{ account: "otros-servicios" }, { price: 138 }, { taxes: ["p_iva_invsuj"] }, { description: "Texto distinto" }]) {
      assert.equal(coincideEstadoCompraEsperado({ ...leida, lines: [{ ...leida.lines[0], ...cambio }] }, esperada, true), false);
    }
    assert.equal(coincideEstadoCompraEsperado({ ...leida, contact_id: "otro" }, esperada, true), false);
    assert.equal(coincideEstadoCompraEsperado({ ...leida, total: "138,00" }, esperada, true), false);
  }
});


/* ───────── PUT duplica adjuntos: sin cambios no se escribe, y la automatización tiene tope ───────── */

const ejecutarComo = (repo: RepoMemoria, holded: TransporteEdicionCompra<DocumentoPrueba>, clave: string, proceso: string, compra = "purchase-1") =>
  ejecutarEdicionCompraDurable(clave, "Footprint", compra, CAMBIOS, proceso, repo, holded, 1);

test("si el documento YA está como se pide NO se hace PUT (cada PUT duplica sus adjuntos) y queda verificada", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ aplicadaInicial: true, sinCambios: true });
  const r = await ejecutarComo(repo, holded, "reparar:1", "correo_gasto_automatico_reparar");
  assert.equal(holded.ediciones.length, 0, "ningún PUT");
  assert.equal(r.sinPut, true); assert.equal(r.reutilizado, false);
  assert.equal([...repo.filas.values()][0].estado, "verificada");
});

test("si «sin cambios» fuera un error de cálculo y el documento NO está como se pide, no se da por verificada: queda incierta", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ aplicadaInicial: false, sinCambios: true });
  await assert.rejects(() => ejecutarComo(repo, holded, "reparar:2", "correo_gasto_automatico_reparar"), EdicionCompraInciertaError);
  assert.equal(holded.ediciones.length, 0);
});

test("TOPE: una automatización no hace más de %d PUT sobre la misma compra, aunque cambie la versión de la política".replace("%d", String(MAX_EDICIONES_AUTOMATICAS_POR_COMPRA)), async () => {
  const repo = new RepoMemoria();
  const registros: string[] = [];
  for (let i = 1; i <= MAX_EDICIONES_AUTOMATICAS_POR_COMPRA; i++) {
    const h = transporte(); await ejecutarComo(repo, h, `correo-auto-reparar:op:v${i}`, "correo_gasto_automatico_reparar"); registros.push(`v${i}`);
    assert.equal(h.ediciones.length, 1);
  }
  const bloqueada = transporte();
  await assert.rejects(() => ejecutarComo(repo, bloqueada, "correo-auto-reparar:op:v99", "correo_gasto_automatico_reparar"), TopeEdicionesAutomaticasError);
  assert.equal(bloqueada.ediciones.length, 0, "el PUT ni se intenta");
  // Lo cerrado a mano sigue contando: es el mismo PUT.
  const humano = transporte();
  await assert.rejects(() => ejecutarComo(repo, humano, "correo-auto-reparar:op:v100", "correo_gasto_automatico_reparar|cierre_revision_humana"), TopeEdicionesAutomaticasError);
  assert.equal(registros.length, MAX_EDICIONES_AUTOMATICAS_POR_COMPRA);
});

test("TOPE: no afecta a otra compra, a una edición aprobada por una persona, ni a una repetición sin cambios", async () => {
  const repo = new RepoMemoria();
  for (let i = 1; i <= MAX_EDICIONES_AUTOMATICAS_POR_COMPRA; i++) await ejecutarComo(repo, transporte(), `a:${i}`, "correo_gasto_automatico_reparar");
  const otra = transporte(); await ejecutarComo(repo, otra, "b:1", "correo_gasto_automatico_reparar", "purchase-2"); assert.equal(otra.ediciones.length, 1);
  const aprobada = transporte(); await ejecutarComo(repo, aprobada, "c:1", "edicion_compra_aprobada"); assert.equal(aprobada.ediciones.length, 1, "la decisión de una persona no la limita el tope");
  const sinCambios = transporte({ aplicadaInicial: true, sinCambios: true });
  const r = await ejecutarComo(repo, sinCambios, "a:99", "correo_gasto_automatico_reparar");
  assert.equal(r.sinPut, true, "sin PUT no hay nada que limitar");
});

test("edicionCompraSinCambios: el estado real de la compra de Ahorramas (32.768 adjuntos) se reconoce como «sin cambios» y cualquier diferencia real no", () => {
  const actual = {
    id: "6aafc4da82a59b46bc0dfbae", document_number: "S107307/0044052", contact_id: "67a09e0275818fabe203d290", date: "2026-09-09", due_date: null,
    currency: "EUR", currency_change: "1.00", total: "7,60", tags: ["alimentacion", "simontalloen"], description: "Compra supermercado Ahorramas", notes: "WOBI_AUTO:69bd889d",
    lines: [{ name: "Compra supermercado Ahorramas", type: "product", description: "", price: "7,60", units: "1,00", discount: "0,00", tax: "0", taxes: [], tags: ["alimentacion", "simontalloen"], account: "65e9870a00c67a51a4049616", retention: "0,00", product_id: null, sku: null, project_id: null, unit_type: null }],
  } as never;
  const igual = { ...(actual as object), lines: [{ name: "Compra supermercado Ahorramas", type: "product", price: 7.6, units: 1, taxes: [], tags: ["simontalloen", "alimentacion"], account: "65e9870a00c67a51a4049616" }] } as never;
  assert.equal(edicionCompraSinCambios(actual, igual), true);
  const cambios: Array<[string, Record<string, unknown>]> = [
    ["importe", { total: "8,60", lines: [{ name: "Compra supermercado Ahorramas", type: "product", price: 8.6, units: 1, taxes: [], tags: ["alimentacion", "simontalloen"], account: "65e9870a00c67a51a4049616" }] }],
    ["cuenta contable", { lines: [{ name: "Compra supermercado Ahorramas", type: "product", price: 7.6, units: 1, taxes: [], tags: ["alimentacion", "simontalloen"], account: "otra" }] }],
    ["etiquetas", { tags: ["alimentacion"], lines: [{ name: "Compra supermercado Ahorramas", type: "product", price: 7.6, units: 1, taxes: [], tags: ["alimentacion"], account: "65e9870a00c67a51a4049616" }] }],
    ["proveedor", { contact_id: "otro" }], ["fecha", { date: "2026-09-10" }], ["moneda", { currency: "USD" }], ["número", { document_number: "X" }],
    ["impuestos", { lines: [{ name: "Compra supermercado Ahorramas", type: "product", price: 7.6, units: 1, taxes: ["s_iva_10"], tags: ["alimentacion", "simontalloen"], account: "65e9870a00c67a51a4049616" }] }],
  ];
  for (const [nombre, c] of cambios) assert.equal(edicionCompraSinCambios(actual, { ...(igual as object), ...c } as never), false, nombre);
});


test("si preparar() se niega (compra con adjuntos duplicados o lectura de adjuntos fallida) NO hay PUT y el registro sigue preparado: nada que reconciliar", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  holded.preparar = async () => { throw new Error("La compra ya tiene 4 adjuntos"); };
  await assert.rejects(() => ejecutarComo(repo, holded, "operador:1", "edicion_compra_aprobada"), /ya tiene 4 adjuntos/);
  assert.equal(holded.ediciones.length, 0);
  assert.equal([...repo.filas.values()][0].estado, "preparada");
});
