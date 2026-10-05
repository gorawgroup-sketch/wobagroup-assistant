import assert from "node:assert/strict";
import test from "node:test";
import type { PolizaConFila } from "../polizaRegistroSheet";
import type { Poliza } from "../types";
import type { ResumenCorreoCrudo } from "./correos";
import type { EntradaEstado } from "./estadoStore";
import { BBVA_REAL } from "./fixtures/bbvaWoba2026_10_05";
import type { LecturaBancaria } from "./lecturaBancaria";
import type { MovimientoBanco } from "./tipos";
import { ejecutarVigilanteSeguros, type FuentesVigilante } from "./vigilante";

function poliza(parcial: Partial<PolizaConFila> & { id: string }): PolizaConFila {
  return {
    rowIndex: 2, empresa: "WOBA", empresaHolded: "WOBA", aseguradora: "Markel Insurance SE",
    correduria: "Acodrid Correduría de Seguros, S.A.", numeroPoliza: "", tipoCobertura: "Responsabilidad civil general",
    activoAsociado: "", capitalAsegurado: "", moneda: "EUR", franquicia: "", prima: "", periodicidad: "",
    cuentaDeCargo: "", fechaInicioVigencia: "", fechaVencimiento: "", estado: "vigente", estadoPago: "pendiente",
    fuenteExtraccion: "documento", notas: "", rutaDocumento: "", ultimaVerificacion: "", ...parcial,
  };
}

const suplementoMarkel = (extra: Partial<PolizaConFila> = {}) =>
  poliza({ id: "woba_rc_suplemento_3_3", rowIndex: 9, numeroPoliza: "023S00453RCG (Suplemento 3.3)", prima: "323.24", estadoPago: "sin_confirmar", ...extra });

interface Montaje {
  polizas: PolizaConFila[];
  movimientos?: MovimientoBanco[];
  bancoFalla?: boolean;
  correos?: ResumenCorreoCrudo[] | null;
  estado?: Array<[string, string, string?]>;
  hoy?: string;
}

function montar(m: Montaje) {
  const escrituras: Array<{ rowIndex: number; poliza: Poliza }> = [];
  const polizas = m.polizas.map((p) => ({ ...p }));
  const estado = new Map<string, EntradaEstado>(
    (m.estado ?? []).map(([id, version, actualizadoEn], i) => [id, { id, version, actualizadoEn: actualizadoEn ?? "2026-10-05T08:00:00Z", rowIndex: i + 2 }])
  );
  let invalidaciones = 0;
  const hoy = m.hoy ?? "2026-10-05";
  const fuentes: FuentesVigilante = {
    ahora: () => new Date(`${hoy}T12:00:00`),
    listarPolizas: async () => polizas.map((p) => ({ ...p })),
    actualizarPoliza: async (rowIndex, nueva) => {
      escrituras.push({ rowIndex, poliza: nueva });
      const i = polizas.findIndex((p) => p.rowIndex === rowIndex);
      polizas[i] = { ...nueva, rowIndex };
    },
    leerBanco: async (): Promise<LecturaBancaria> => {
      if (m.bancoFalla) throw new Error("Holded 503");
      return { movimientos: m.movimientos ?? [], cuentasLeidas: 3, fallos: [], empresasCompletas: new Set(["WOBA", "EWORKS", "Footprint"]) };
    },
    correo:
      m.correos === null
        ? null
        : {
            buscarMensajes: async () => (m.correos ?? []).map((c) => c.id),
            obtenerResumenCorreo: async (id) => (m.correos ?? []).find((c) => c.id === id) as ResumenCorreoCrudo,
          },
    leerEstado: async () => new Map(estado),
    guardarEstado: async (pares) => {
      for (const { id, version } of pares) estado.set(id, { id, version, actualizadoEn: `${hoy}T08:00:00Z`, rowIndex: estado.size + 2 });
    },
    borrarEstado: async (ids) => { for (const id of ids) estado.delete(id); },
    purgarCorreosVistos: async () => 0,
    invalidarCerebro: () => { invalidaciones++; },
  };
  return { fuentes, escrituras, polizas, estado, invalidaciones: () => invalidaciones };
}

/** Marca como avisado lo que devolvió una revisión, como hace el job tras entregar el informe. */
const marcarAvisado = (estado: Map<string, EntradaEstado>, claves: Array<{ id: string; version: string }>) => {
  for (const { id, version } of claves) estado.set(id, { id, version, actualizadoEn: "2026-10-05T08:00:00Z", rowIndex: estado.size + 2 });
};

// ---------------------------------------------------------------------------------------------------------------
// El caso de hoy (05/10/2026): el adeudo de Markel de 323,24 € aparece en BBVA pero el saldo aún no lo refleja.
// ---------------------------------------------------------------------------------------------------------------

test("el adeudo de Markel visto hoy NO se da por pagado: queda en tránsito, el registro no se toca y se avisa una sola vez", async () => {
  const m = montar({ polizas: [suplementoMarkel()], movimientos: BBVA_REAL, correos: [] });
  const r = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(r.contenido.confirmados.length, 0);
  assert.equal(r.contenido.enTransito.length, 1);
  assert.equal(m.escrituras.length, 0);
  assert.equal(m.invalidaciones(), 0);
  assert.match(r.informe?.cuerpo ?? "", /aún no doy por pagados/);
  assert.match(r.informe?.cuerpo ?? "", /323,24/);

  // Segunda revisión sin cambios: nada nuevo que contar.
  marcarAvisado(m.estado, r.clavesAvisadas);
  const otra = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(otra.informe, null);
});

test("al día siguiente, si el saldo sigue por la rama de Markel, el cargo se confirma: se escribe la prueba y se refresca Cerebro", async () => {
  const manana: MovimientoBanco[] = [
    ...BBVA_REAL,
    { empresa: "WOBA", cuentaId: "bbva", cuenta: "BBVA", id: "tel_06_10", fecha: "2026-10-06", descripcion: "TELEFONICA ADEUDO", importe: -20, moneda: "EUR", importeEur: -20, estado: "pending", saldoTras: -419.28 },
  ];
  // El id real del movimiento de Markel está en la prueba que se escribe en `notas`.
  const conIdReal = manana.map((x) => (x.id === "markel_05_10" ? { ...x, id: "6ac321017157b2882d0e5a07" } : x));
  const m = montar({ polizas: [suplementoMarkel()], movimientos: conIdReal, correos: [], hoy: "2026-10-06" });
  const r = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(r.contenido.confirmados.length, 1);
  assert.equal(m.escrituras.length, 1);
  const escrita = m.escrituras[0].poliza;
  assert.equal(escrita.estadoPago, "pagado");
  assert.equal(escrita.ultimaVerificacion, "2026-10-06");
  assert.match(escrita.notas, /COBRADO — comprobado automáticamente/);
  assert.match(escrita.notas, /6ac321017157b2882d0e5a07/);
  assert.ok(escrita.fuenteExtraccion.includes("banco"));
  assert.equal(m.invalidaciones(), 1);
  assert.match(r.informe?.cuerpo ?? "", /Marcada como pagada/);
});

test("si en cambio el saldo sigue por la otra rama, el cargo se considera devuelto y NO se marca pagado", async () => {
  const manana: MovimientoBanco[] = [
    ...BBVA_REAL,
    { empresa: "WOBA", cuentaId: "bbva", cuenta: "BBVA", id: "tel_06_10", fecha: "2026-10-06", descripcion: "TELEFONICA ADEUDO", importe: -20, moneda: "EUR", importeEur: -20, estado: "pending", saldoTras: 784.85 },
  ];
  const m = montar({ polizas: [suplementoMarkel()], movimientos: manana, correos: [], hoy: "2026-10-06", estado: [["transito:woba_rc_suplemento_3_3:markel_05_10", "en_transito|fiable"]] });
  const r = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(r.contenido.confirmados.length, 0);
  assert.equal(m.escrituras.length, 0);
  assert.equal(r.contenido.enTransito.length, 1);
  assert.match(r.informe?.cuerpo ?? "", /probablemente se devolvió/);
  // No se cuenta además como «cargo que no encaja»: ya está dicho en el bloque del recibo pendiente.
  assert.equal(r.contenido.cargos.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Una transferencia nuestra que paga varios recibos (los 1.306,00 € de Acodrid) en una cuenta Revolut sin cadena fiable.
// ---------------------------------------------------------------------------------------------------------------

test("una transferencia a Acodrid desde Revolut paga la renovación y el suplemento de Allianz: se marcan los dos recibos", async () => {
  const renovacion = poliza({ id: "woba_showroom_2026_2027", rowIndex: 12, aseguradora: "Allianz, Compañía de Seguros y Reaseguros, S.A.", prima: "1016.86" });
  const suplemento = poliza({ id: "woba_showroom_complemento_2026_2027", rowIndex: 4, aseguradora: "Allianz, Compañía de Seguros y Reaseguros, S.A.", prima: "289.14" });
  const ruido: MovimientoBanco[] = Array.from({ length: 12 }, (_, i) => ({
    empresa: "WOBA", cuentaId: "main", cuenta: "Main", id: `compra_${i}`, fecha: `2026-09-${String(10 + i).padStart(2, "0")}`,
    descripcion: `Compra ${i}`, importe: -(i + 1), moneda: "EUR", importeEur: -(i + 1), estado: "reconciled", saldoTras: 900 + ((i * 53) % 400),
  }));
  const transferencia: MovimientoBanco = {
    empresa: "WOBA", cuentaId: "main", cuenta: "Main", id: "6abe302ee953c890b8019160", fecha: "2026-09-30",
    descripcion: "To Correduria De Seguros Acodrid S A Poliza", importe: -1306, moneda: "EUR", importeEur: -1306, estado: "reconciled", saldoTras: 1152.79,
  };
  const m = montar({ polizas: [renovacion, suplemento], movimientos: [...ruido, transferencia], correos: [] });
  const r = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(r.contenido.confirmados.length, 1);
  assert.equal(r.contenido.confirmados[0].consolidado, true);
  assert.equal(m.escrituras.length, 2);
  assert.ok(m.escrituras.every((e) => e.poliza.estadoPago === "pagado"));
  assert.match(m.escrituras[0].poliza.notas, /Un solo pago que cubre 2 recibos/);
});

test("si alguien edita la póliza entre la lectura y la escritura (ya no está pendiente), no se pisa su cambio", async () => {
  const renovacion = poliza({ id: "woba_showroom_2026_2027", rowIndex: 12, aseguradora: "Allianz", prima: "1016.86" });
  const transferencia: MovimientoBanco = {
    empresa: "WOBA", cuentaId: "main", cuenta: "Main", id: "tr1", fecha: "2026-09-30",
    descripcion: "To Correduria De Seguros Acodrid S A Poliza", importe: -1016.86, moneda: "EUR", importeEur: -1016.86, estado: "reconciled", saldoTras: null,
  };
  const m = montar({ polizas: [renovacion], movimientos: [transferencia], correos: [] });
  let lecturas = 0;
  const original = m.fuentes.listarPolizas;
  m.fuentes.listarPolizas = async () => {
    lecturas++;
    const filas = await original();
    return lecturas >= 2 ? filas.map((p) => ({ ...p, estadoPago: "pagado" as const })) : filas;
  };
  const r = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(m.escrituras.length, 0);
  assert.equal(r.contenido.confirmados.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------

test("un pago ya marcado que el banco deja de reflejar vuelve a «pendiente» y se avisa una sola vez", async () => {
  const pagada = suplementoMarkel({ estadoPago: "pagado", notas: "✅ COBRADO … Movimiento 6ac321017157b2882d0e5a07." });
  const manana: MovimientoBanco[] = [
    ...BBVA_REAL.map((x) => (x.id === "markel_05_10" ? { ...x, id: "6ac321017157b2882d0e5a07" } : x)),
    { empresa: "WOBA", cuentaId: "bbva", cuenta: "BBVA", id: "tel_06_10", fecha: "2026-10-06", descripcion: "TELEFONICA ADEUDO", importe: -20, moneda: "EUR", importeEur: -20, estado: "pending", saldoTras: 784.85 },
  ];
  const m = montar({ polizas: [pagada], movimientos: manana, correos: [], hoy: "2026-10-06" });
  const r = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(r.contenido.devoluciones.length, 1);
  assert.equal(r.contenido.devoluciones[0].revertida, true);
  assert.equal(m.escrituras[0].poliza.estadoPago, "pendiente");
  assert.match(m.escrituras[0].poliza.notas, /DEVOLUCIÓN PROBABLE/);
  assert.match(r.informe?.cuerpo ?? "", /He devuelto la póliza a «pendiente»/);

  marcarAvisado(m.estado, r.clavesAvisadas);
  const otra = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(otra.contenido.devoluciones.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------

const correoUrgente: ResumenCorreoCrudo = {
  id: "1a0f286089852088", threadId: "t1", de: "Jaquelin Lovey <jaquelin.lovey@acodrid.com>",
  asunto: "URGENTE -- RECIBOS PENDIENTES DE PÓLIZA 54239034.2 (MULTIRRIESGO)", fecha: "Wed, 30 Sep 2026 13:34:19 +0000",
  extracto: "no podemos volver a pasar al cobro el recibo", adjuntos: [],
};

test("la primera revisión da por conocido lo que ya hay en el buzón y no avisa; los correos posteriores sí", async () => {
  const m = montar({ polizas: [], correos: [correoUrgente] });
  const primera = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(primera.contenido.correos.length, 0);
  assert.equal(primera.informe, null);
  assert.ok(m.estado.has("__inicio__:correo"));
  assert.ok(m.estado.has("correo:1a0f286089852088"));

  const nuevo: ResumenCorreoCrudo = { ...correoUrgente, id: "1a1000000000aaaa", asunto: "Suplemento 4 de la póliza RC", fecha: "Tue, 6 Oct 2026 09:00:00 +0000", adjuntos: [{ filename: "Suplemento 4.pdf" }] };
  const m2 = montar({ polizas: [], correos: [correoUrgente, nuevo], estado: [["__inicio__:correo", "2026-10-05"], ["correo:1a0f286089852088", "visto"]], hoy: "2026-10-06" });
  const segunda = await ejecutarVigilanteSeguros(m2.fuentes);
  assert.equal(segunda.contenido.correos.length, 1);
  assert.match(segunda.informe?.cuerpo ?? "", /Suplemento 4 de la póliza RC/);
  assert.deepEqual(segunda.clavesAvisadas, [{ id: "correo:1a1000000000aaaa", version: "visto" }]);
});

test("un correo ajeno (no es de una aseguradora ni de una correduría) no se cuenta", async () => {
  const ajeno: ResumenCorreoCrudo = { ...correoUrgente, id: "x1", de: "Kelly <kelly@footprint.global>", asunto: "Uber" };
  const m = montar({ polizas: [], correos: [ajeno], estado: [["__inicio__:correo", "2026-10-05"]], hoy: "2026-10-06" });
  const r = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(r.contenido.correos.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------

test("si Holded falla, la revisión no se cae ni concluye nada: lo dice, y a los 2 días lo avisa por sí solo", async () => {
  const dia1 = montar({ polizas: [suplementoMarkel()], bancoFalla: true, correos: [], hoy: "2026-10-05" });
  const r1 = await ejecutarVigilanteSeguros(dia1.fuentes);
  assert.equal(r1.informe, null);
  assert.match(r1.contenido.advertencias.join(" "), /No pude leer el banco de Holded/);
  assert.equal(r1.contenido.sinPago.length, 0);
  assert.equal(dia1.estado.get("fallo:banco")?.version, "2026-10-05");

  const dia3 = montar({ polizas: [suplementoMarkel()], bancoFalla: true, correos: [], hoy: "2026-10-07", estado: [["fallo:banco", "2026-10-05"]] });
  const r3 = await ejecutarVigilanteSeguros(dia3.fuentes);
  assert.equal(r3.contenido.fallosPersistentes.length, 1);
  assert.match(r3.informe?.cuerpo ?? "", /lleva 2 días sin poder leerse/);
});

test("cuando Holded vuelve a responder, se olvida el fallo", async () => {
  const m = montar({ polizas: [], movimientos: [], correos: [], estado: [["fallo:banco", "2026-10-05"]], hoy: "2026-10-06" });
  await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(m.estado.has("fallo:banco"), false);
});

test("sin buzón configurado la revisión sigue con el banco y lo advierte", async () => {
  const m = montar({ polizas: [], correos: null });
  const r = await ejecutarVigilanteSeguros(m.fuentes);
  assert.match(r.contenido.advertencias.join(" "), /correo del asistente no está configurado/);
});

test("en modo simulación (aplicar: false) no se escribe nada en el registro", async () => {
  const transferencia: MovimientoBanco = {
    empresa: "WOBA", cuentaId: "main", cuenta: "Main", id: "tr1", fecha: "2026-09-30",
    descripcion: "To Markel Insurance Se Recibo", importe: -323.24, moneda: "EUR", importeEur: -323.24, estado: "reconciled", saldoTras: null,
  };
  const m = montar({ polizas: [suplementoMarkel()], movimientos: [transferencia], correos: [] });
  await ejecutarVigilanteSeguros(m.fuentes, { aplicar: false });
  assert.equal(m.escrituras.length, 0);
});

test("la respuesta de chat siempre responde, también sin novedades, y cuenta lo que sigue en tránsito aunque ya se hubiera avisado", async () => {
  const m = montar({ polizas: [suplementoMarkel()], movimientos: BBVA_REAL, correos: [], estado: [["transito:woba_rc_suplemento_3_3:markel_05_10", "en_transito|fiable"]] });
  const r = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(r.informe, null); // ya avisado → Telegram calla
  assert.match(r.respuestaChat, /aún no doy por pagados/); // pero el chat cuenta la situación de ahora

  const vacio = montar({ polizas: [], correos: [] });
  assert.match((await ejecutarVigilanteSeguros(vacio.fuentes)).respuestaChat, /sin novedades/);
});

test("la situación completa conserva el cargo en tránsito ya avisado (Telegram calla, el panel de Cerebro no puede olvidarlo)", async () => {
  const m = montar({ polizas: [suplementoMarkel()], movimientos: BBVA_REAL, correos: [] });
  const primera = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(primera.contenido.enTransito.length, 1);
  assert.equal(primera.situacion.enTransito.length, 1);

  marcarAvisado(m.estado, primera.clavesAvisadas);
  const segunda = await ejecutarVigilanteSeguros(m.fuentes);
  assert.equal(segunda.contenido.enTransito.length, 0, "lo nuevo: nada");
  assert.equal(segunda.situacion.enTransito.length, 1, "la situación: el cargo sigue sin confirmar");
  assert.match(segunda.situacion.enTransito[0].motivo, /saldo|banco/i);
});
