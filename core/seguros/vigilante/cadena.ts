/**
 * ¿Ese cargo llegó a aplicarse en la cuenta? — comprobación con la cadena de saldos.
 *
 * Por qué existe (caso real, WOBA, 01/09/2026): Holded mostró dos adeudos domiciliados, «ALLIANZ … −1.016,86 €» y
 * «AEGON … −234,41 €», como cargos normales y hasta «conciliados». Pero el banco los devolvió: ninguno entró en el
 * saldo de la cuenta (el abono de 1.300 € del día siguiente se calculó sobre un saldo que no los incluía) y Acodrid
 * confirmó la devolución un mes después. Un vigilante que diera ese cargo por «pago hecho» habría escondido el impago
 * que dejó la póliza en suspenso. Una devolución así NO deja ningún apunte contrario: lo único que la delata es que
 * el saldo siguiente no encaja con ese cargo.
 *
 * Cada apunte trae el saldo de la cuenta DESPUÉS de él. En una cuenta bien sincronizada, el saldo-antes de un apunte
 * (= su saldo-después menos su importe) es el saldo-después del apunte anterior: los apuntes forman una cadena. Un
 * apunte que no está en la cadena que llega al final de la cuenta —porque otro apunte ocupó su lugar— no se aplicó.
 *
 * Límites, dichos con franqueza:
 *  - Solo sirve en cuentas cuyo saldo-después es de verdad un libro contable. En las cuentas Revolut con tarjetas
 *    (WOBA Main, Footprint Main) los saldos de las compras «pending» no encadenan y casi todo saldría como huérfano:
 *    por eso se mide la fiabilidad de cada cuenta y, si no es fiable, esta comprobación NO se usa.
 *  - Lo último que entra en una cuenta no se puede validar hasta que entra algo después: sale como «en tránsito».
 */
import { restarDias } from "./fechas";
import type { MovimientoBanco } from "./tipos";

export type EstadoLiquidacion = "liquidado" | "en_transito" | "huerfano" | "sin_saldo";

export interface AnalisisCadena {
  estado: Map<string, EstadoLiquidacion>;
  /** true si la cadena de esta cuenta se puede usar para decidir (pocas rupturas en lo ya asentado). */
  fiable: boolean;
  ultimaFecha: string;
}

const centimos = (valor: number): number => Math.round(valor * 100);

/** Cuántos apuntes asentados (de hace más de 3 días) deben existir para poder fiarse de la cadena. */
const MIN_APUNTES_ASENTADOS = 5;
/** Si más de esta fracción de lo asentado no encaja en la cadena, la cuenta no es un libro fiable. */
const MAX_FRACCION_HUERFANOS = 0.15;

export function analizarCadenaDeSaldos(movimientosDeUnaCuenta: MovimientoBanco[]): AnalisisCadena {
  const estado = new Map<string, EstadoLiquidacion>();
  const conSaldo = movimientosDeUnaCuenta.filter((m) => m.saldoTras != null && Number.isFinite(m.saldoTras));
  for (const m of movimientosDeUnaCuenta) if (!conSaldo.includes(m)) estado.set(m.id, "sin_saldo");
  if (conSaldo.length === 0) return { estado, fiable: false, ultimaFecha: "" };

  const saldoAntes = (m: MovimientoBanco) => centimos((m.saldoTras as number) - m.importe);
  const porSaldoAntes = new Map<number, MovimientoBanco[]>();
  const porSaldoTras = new Map<number, MovimientoBanco[]>();
  for (const m of conSaldo) {
    const antes = saldoAntes(m);
    porSaldoAntes.set(antes, [...(porSaldoAntes.get(antes) ?? []), m]);
    const tras = centimos(m.saldoTras as number);
    porSaldoTras.set(tras, [...(porSaldoTras.get(tras) ?? []), m]);
  }
  const sucesores = (m: MovimientoBanco) =>
    (porSaldoAntes.get(centimos(m.saldoTras as number)) ?? []).filter((s) => s.id !== m.id && s.fecha >= m.fecha);
  const antecesores = (s: MovimientoBanco) =>
    (porSaldoTras.get(saldoAntes(s)) ?? []).filter((m) => m.id !== s.id && m.fecha <= s.fecha);

  const ultimaFecha = conSaldo.reduce((mayor, m) => (m.fecha > mayor ? m.fecha : mayor), "");
  const terminales = conSaldo.filter((m) => m.fecha === ultimaFecha && sucesores(m).length === 0);

  // Para cada terminal, todos los apuntes desde los que se llega a él.
  const alcanzan = new Map<string, number>();
  for (const terminal of terminales) {
    const vistos = new Set<string>([terminal.id]);
    const pila = [terminal];
    while (pila.length > 0) {
      const actual = pila.pop() as MovimientoBanco;
      for (const previo of antecesores(actual)) {
        if (vistos.has(previo.id)) continue;
        vistos.add(previo.id);
        pila.push(previo);
      }
    }
    for (const id of vistos) alcanzan.set(id, (alcanzan.get(id) ?? 0) + 1);
  }

  for (const m of conSaldo) {
    const llegan = alcanzan.get(m.id) ?? 0;
    if (terminales.length === 0 || llegan === 0) {
      estado.set(m.id, terminales.length === 0 ? "en_transito" : "huerfano");
    } else if (llegan < terminales.length) {
      estado.set(m.id, "en_transito"); // rama del mismo día que aún no se sabe si es la buena
    } else {
      estado.set(m.id, m.fecha === ultimaFecha && sucesores(m).length === 0 ? "en_transito" : "liquidado");
    }
  }

  const asentados = conSaldo.filter((m) => m.fecha <= restarDias(ultimaFecha, 3));
  const huerfanos = asentados.filter((m) => estado.get(m.id) === "huerfano").length;
  const fiable = asentados.length >= MIN_APUNTES_ASENTADOS && huerfanos / asentados.length <= MAX_FRACCION_HUERFANOS;
  return { estado, fiable, ultimaFecha };
}

/** Agrupa los apuntes por cuenta y analiza cada cuenta por separado. */
export function analizarCuentas(movimientos: MovimientoBanco[]): Map<string, AnalisisCadena> {
  const porCuenta = new Map<string, MovimientoBanco[]>();
  for (const m of movimientos) {
    const clave = `${m.empresa}:${m.cuentaId}`;
    porCuenta.set(clave, [...(porCuenta.get(clave) ?? []), m]);
  }
  return new Map([...porCuenta].map(([clave, lista]) => [clave, analizarCadenaDeSaldos(lista)]));
}

export const claveDeCuenta = (m: MovimientoBanco): string => `${m.empresa}:${m.cuentaId}`;
