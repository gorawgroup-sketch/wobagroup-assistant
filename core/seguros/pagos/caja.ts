/**
 * Comprobación de caja (docs/wobi-seguros.md §6.2): ¿hay saldo en la cuenta de cargo para el pago que viene? Pura: recibe las cuentas ya
 * leídas de Holded. Nunca mueve dinero ni propone un traspaso: dice si alcanza, cuánto falta y qué otras cuentas de la empresa tienen
 * saldo, y la decisión es de la persona. Un dato dudoso (cuenta no encontrada, saldo ausente, lectura fallida) se dice como «no
 * comprobable», nunca como «alcanza» ni como «no alcanza» (un fallo de Holded no es un dato). Una cuenta con saldo NEGATIVO es otro caso:
 * el dato es cierto (es el saldo que da el banco) pero no dice si queda crédito, y se dice como «descubierto».
 */
import type { PagoSeguro } from "./tipos";

export interface CuentaCaja {
  nombre: string;
  moneda: string;
  saldo: number;
  tipo?: string;
  archivada?: boolean;
}

export interface OtraCuenta {
  nombre: string;
  saldo: number;
}

export type ResultadoCaja =
  | { estado: "alcanza"; cuenta: string; saldo: number; necesario: number; sobra: number }
  | { estado: "no_alcanza"; cuenta: string; saldo: number; necesario: number; faltan: number; otras: OtraCuenta[] }
  | { estado: "descubierto"; cuenta: string; saldo: number; necesario: number }
  | { estado: "no_comprobable"; motivo: string; necesario: number };

const normalizar = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** La cuenta de Holded que corresponde al nombre anotado en el pago: activa, de la misma moneda, no pasarela y única. */
export function resolverCuenta(cuentaDeCargo: string, moneda: string, cuentas: CuentaCaja[]): { cuenta: CuentaCaja } | { motivo: string } {
  const objetivo = normalizar(cuentaDeCargo);
  if (!objetivo) return { motivo: "el pago no tiene anotada la cuenta de cargo" };
  const candidatas = cuentas.filter(
    (c) => !c.archivada && c.tipo !== "gateway" && c.moneda.toUpperCase() === moneda.toUpperCase() && normalizar(c.nombre) === objetivo
  );
  if (candidatas.length === 1) return { cuenta: candidatas[0] };
  if (candidatas.length === 0) return { motivo: `no encuentro en Holded una cuenta activa en ${moneda} llamada «${cuentaDeCargo}»` };
  return { motivo: `hay varias cuentas activas en ${moneda} llamadas «${cuentaDeCargo}»` };
}

/** Lo que va a salir de la misma cuenta hasta la fecha de este pago (inclusive): este pago y los previstos antes que él desde hoy. */
export function necesarioEnLaCuenta(pago: PagoSeguro, pagos: PagoSeguro[], hoy: string): number {
  const objetivo = normalizar(pago.cuentaDeCargo);
  const suma = pagos
    .filter((p) => p.estado === "previsto" && p.empresa === pago.empresa && p.moneda === pago.moneda && normalizar(p.cuentaDeCargo) === objetivo && p.fecha >= hoy && p.fecha <= pago.fecha)
    .reduce((acc, p) => acc + p.importe, 0);
  return Math.round(suma * 100) / 100;
}

/**
 * `cuentas` null = no se pudieron leer las cuentas de la empresa en Holded.
 * Un saldo negativo no se interpreta como «no alcanza» ni como «alcanza»: se dice «descubierto» con el saldo tal cual y sin afirmar nada
 * sobre el crédito disponible, que Holded no da. Caso real (EWORKS): «CAIXA BANK EWORKS» figura en −20.281,34 € y es el saldo del propio
 * banco (comprobado en su cadena de saldos el 08-10-2026); los recibos de Markel se cobran igual con la cuenta en negativo.
 */
export function evaluarCaja(pago: PagoSeguro, pagos: PagoSeguro[], cuentas: CuentaCaja[] | null, hoy: string): ResultadoCaja {
  const necesario = necesarioEnLaCuenta(pago, pagos, hoy);
  if (cuentas === null) return { estado: "no_comprobable", motivo: `no pude leer las cuentas de ${pago.empresa} en Holded`, necesario };
  const resuelta = resolverCuenta(pago.cuentaDeCargo, pago.moneda, cuentas);
  if ("motivo" in resuelta) return { estado: "no_comprobable", motivo: resuelta.motivo, necesario };
  const { cuenta } = resuelta;
  if (!Number.isFinite(cuenta.saldo)) return { estado: "no_comprobable", motivo: `Holded no da el saldo de «${cuenta.nombre.trim()}»`, necesario };
  if (cuenta.saldo < 0) return { estado: "descubierto", cuenta: cuenta.nombre.trim(), saldo: cuenta.saldo, necesario };
  const nombre = cuenta.nombre.trim();
  if (cuenta.saldo >= necesario) return { estado: "alcanza", cuenta: nombre, saldo: cuenta.saldo, necesario, sobra: Math.round((cuenta.saldo - necesario) * 100) / 100 };
  const faltan = Math.round((necesario - cuenta.saldo) * 100) / 100;
  const otras = cuentas
    .filter((c) => !c.archivada && c.tipo === "bank" && c.moneda.toUpperCase() === pago.moneda.toUpperCase() && c !== cuenta && c.saldo >= faltan)
    .sort((a, b) => b.saldo - a.saldo)
    .slice(0, 2)
    .map((c) => ({ nombre: c.nombre.trim(), saldo: c.saldo }));
  return { estado: "no_alcanza", cuenta: nombre, saldo: cuenta.saldo, necesario, faltan, otras };
}
