import assert from "node:assert/strict";
import test from "node:test";
import { construirInformePagos, merecePorCaja, nivelQueToca, type AvisoPago } from "./aviso";
import type { ResultadoCaja } from "./caja";
import { pago } from "./pruebas";

test("el aviso toca la primera vez que faltan de 1 a 3 días (aunque el trabajo no corriera el día 3); el día del cargo y los lejanos no", () => {
  const p = pago({ fecha: "2027-03-01" });
  assert.deepEqual(nivelQueToca(p, "2027-02-26"), { nivel: "d3", dias: 3 });
  assert.deepEqual(nivelQueToca(p, "2027-02-27"), { nivel: "d3", dias: 2 }, "si el día 3 no corrió, el primer aviso sale cuando toca");
  assert.deepEqual(nivelQueToca(p, "2027-02-28"), { nivel: "d3", dias: 1 });
  assert.equal(nivelQueToca(p, "2027-02-25"), null, "a 4 días todavía no");
  assert.equal(nivelQueToca(p, "2027-03-01"), null, "el día del cargo lo vigila el vigilante, no este aviso");
  assert.equal(nivelQueToca(p, "2027-03-02"), null, "vencido: tampoco");
});

test("tras el aviso del día 3 no se repite, salvo un recordatorio el día antes", () => {
  const avisado = pago({ fecha: "2027-03-01", avisos: "d3" });
  assert.equal(nivelQueToca(avisado, "2027-02-26"), null);
  assert.equal(nivelQueToca(avisado, "2027-02-27"), null);
  assert.deepEqual(nivelQueToca(avisado, "2027-02-28"), { nivel: "d1", dias: 1 });
  assert.equal(nivelQueToca(pago({ fecha: "2027-03-01", avisos: "d3,d1" }), "2027-02-28"), null);
});

test("los pagos que no están previstos (pagados, devueltos, cancelados) no se avisan", () => {
  for (const estado of ["pagado", "devuelto", "cancelado"] as const) assert.equal(nivelQueToca(pago({ estado, fecha: "2027-03-01" }), "2027-02-27"), null, estado);
});

test("el recordatorio del día antes solo se envía si la caja sigue sin alcanzar o sin poder comprobarse", () => {
  const alcanza: ResultadoCaja = { estado: "alcanza", cuenta: "BBVA", saldo: 2000, necesario: 955, sobra: 1045 };
  const noAlcanza: ResultadoCaja = { estado: "no_alcanza", cuenta: "BBVA", saldo: 100, necesario: 955, faltan: 855, otras: [] };
  const dudoso: ResultadoCaja = { estado: "no_comprobable", motivo: "x", necesario: 955 };
  const descubierto: ResultadoCaja = { estado: "descubierto", cuenta: "CAIXA BANK EWORKS", saldo: -20281.34, necesario: 840.74 };
  assert.equal(merecePorCaja("d3", alcanza), true, "el aviso a 3 días se envía siempre: es el recordatorio del pago");
  assert.equal(merecePorCaja("d3", descubierto), true);
  assert.equal(merecePorCaja("d1", descubierto), false, "una cuenta en descubierto lo está siempre: el «d3» ya lo dijo y repetirlo sería ruido");
  assert.equal(merecePorCaja("d1", alcanza), false);
  assert.equal(merecePorCaja("d1", noAlcanza), true);
  assert.equal(merecePorCaja("d1", dudoso), true);
});

const aviso = (parcial: Partial<AvisoPago> & Pick<AvisoPago, "caja">): AvisoPago => ({ pago: pago(), dias: 3, nivel: "d3", ...parcial });

test("el mensaje junta los pagos de hoy en uno, con la comprobación de caja, lo estimado y las otras cuentas con saldo", () => {
  const informe = construirInformePagos(
    [
      aviso({ pago: pago({ empresa: "EWORKS", fecha: "2027-02-27", importe: 840.74, cuentaDeCargo: "CAIXA BANK EWORKS", concepto: "RC Markel 025S00287RCG — 1.ª cuota", id: "e" }), dias: 3,
        caja: { estado: "descubierto", cuenta: "CAIXA BANK EWORKS", saldo: -20281.34, necesario: 840.74 } }),
      aviso({ caja: { estado: "no_alcanza", cuenta: "BBVA", saldo: 654.81, necesario: 1244.14, faltan: 589.33, otras: [{ nombre: "Main", saldo: 4097.45 }] } }),
    ],
    "2027-02-26"
  );
  assert.ok(informe);
  assert.match(informe.titulo, /^⚠️ Seguros — pagos de los próximos 3 días \(26\/02\)/);
  const lineas = informe.cuerpo.split("\n");
  assert.match(lineas[0], /\*\*27\/02\*\* \(en 3 días\) · \[EWORKS\] RC Markel 025S00287RCG — 1\.ª cuota · 840,74 € \(estimado\) · adeudo en «CAIXA BANK EWORKS»/);
  assert.match(lineas[1], /ℹ️ cuenta en descubierto: «CAIXA BANK EWORKS» figura en -20\.281,34 € \(es el saldo que da el banco\)\. No sé cuánto crédito queda disponible, así que no puedo asegurar el cargo de 840,74 €: comprueba el límite de la cuenta antes de esa fecha\./);
  assert.match(informe.cuerpo, /\*\*01\/03\*\* \(en 3 días\) · \[WOBA\] Allianz showroom 054239034/);
  assert.match(informe.cuerpo, /⚠️ NO alcanza: «BBVA» tiene 654,81 € y salen 1\.244,14 € \(faltan 589,33 €\)\. Otras cuentas con saldo: Main 4\.097,45 €\./);
  assert.match(informe.cuerpo, /No muevo dinero: si hace falta traspasar, decídelo tú/);
});

test("si todo alcanza el aviso es tranquilo (🛡️); una transferencia se dice «transferencia tuya» y mañana se escribe «mañana»", () => {
  const informe = construirInformePagos(
    [aviso({ pago: pago({ forma: "transferencia", estimado: false }), dias: 1, caja: { estado: "alcanza", cuenta: "BBVA", saldo: 3000, necesario: 955, sobra: 2045 } })],
    "2027-02-28"
  );
  assert.ok(informe);
  assert.match(informe.titulo, /^🛡️/);
  assert.match(informe.cuerpo, /\(mañana\)/);
  assert.match(informe.cuerpo, /transferencia tuya en «BBVA»/);
  assert.doesNotMatch(informe.cuerpo.split("\n")[0], /estimado/);
  assert.match(informe.cuerpo, /✅ alcanza: saldo de «BBVA» 3\.000,00 €; tras los cargos de seguros previstos quedarían 2\.045,00 €\./);
  assert.equal(construirInformePagos([], "2027-02-28"), null);
});
