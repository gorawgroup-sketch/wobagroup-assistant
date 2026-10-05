import assert from "node:assert/strict";
import test from "node:test";
import { construirInforme, construirRespuestaChat, describirMovimiento, type ContenidoInforme } from "./informe";
import type { MovimientoBanco } from "./tipos";

const vacio: ContenidoInforme = {
  hoy: "2026-10-05", devoluciones: [], confirmados: [], enTransito: [], cargos: [], correos: [], ambiguos: [], sinPago: [],
  advertencias: [], fallosPersistentes: [],
};

const markel: MovimientoBanco = {
  empresa: "WOBA", cuentaId: "bbva", cuenta: "BBVA", id: "6ac321017157b2882d0e5a07", fecha: "2026-10-05",
  descripcion: "N 2026275001954588 Markel Insurance SE ADEUDO A SU CARGO", importe: -323.24, moneda: "EUR", importeEur: -323.24, estado: "pending", saldoTras: -399.28,
};

test("un movimiento se describe con importe en formato español, día, cuenta y concepto", () => {
  assert.equal(describirMovimiento(markel), "-323,24 € el 05/10 en BBVA («N 2026275001954588 Markel Insurance SE ADEUDO A SU CARGO»)");
});

test("un movimiento en otra divisa muestra también el equivalente en euros", () => {
  const usd: MovimientoBanco = { ...markel, moneda: "USD", importe: -76.89, importeEur: -65.97, cuenta: "FTG USD", descripcion: "Iati Colombia" };
  assert.match(describirMovimiento(usd), /-76,89 USD \(≈ -65,97 €\)/);
});

test("sin novedades el vigilante calla (no hay informe), pero el chat sí responde", () => {
  assert.equal(construirInforme(vacio), null);
  assert.match(construirRespuestaChat(vacio), /sin novedades/);
});

test("las advertencias de lectura solas no justifican un mensaje, pero un fallo que lleva días sí", () => {
  assert.equal(construirInforme({ ...vacio, advertencias: ["No pude leer el banco de Holded: 503"] }), null);
  const persistente = construirInforme({ ...vacio, fallosPersistentes: ["La lectura del banco de Holded lleva 2 días sin poder leerse."] });
  assert.match(persistente?.cuerpo ?? "", /lleva 2 días/);
});

test("el título lleva la fecha y el cuerpo termina remitiendo a Cerebro", () => {
  const informe = construirInforme({ ...vacio, ambiguos: [{ poliza: { rowIndex: 2, id: "p", empresa: "WOBA", empresaHolded: "WOBA", aseguradora: "", correduria: "", numeroPoliza: "", tipoCobertura: "RC", activoAsociado: "", capitalAsegurado: "", moneda: "EUR", franquicia: "", prima: "323.24", periodicidad: "", cuentaDeCargo: "", fechaInicioVigencia: "", fechaVencimiento: "", estado: "vigente", estadoPago: "pendiente", fuenteExtraccion: "", notas: "", rutaDocumento: "", ultimaVerificacion: "" }, motivo: "hay 2 cargos posibles", candidatos: [markel] }] });
  assert.equal(informe?.titulo, "🛡️ Seguros — novedades del 05/10");
  assert.match(informe?.cuerpo ?? "", /Detalle completo en Cerebro/);
  assert.match(informe?.cuerpo ?? "", /Confírmalo tú/);
});
