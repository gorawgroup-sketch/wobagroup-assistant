import type { CuentaContable } from "./accounting";

/**
 * Resuelve el texto que escribe una persona («Otros servicios», «62900000») a UNA cuenta real del plan contable de
 * Holded. Nunca adivina: si el texto no identifica una sola cuenta, devuelve las opciones para que la persona aclare.
 */
export type ResultadoCuenta = { ok: true; cuenta: CuentaContable } | { ok: false; motivo: string };

const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const etiqueta = (c: CuentaContable) => `${c.number} ${c.name}`;

export function resolverCuentaContable(plan: readonly CuentaContable[], texto: string): ResultadoCuenta {
  const buscado = normalizar(texto);
  if (!buscado) return { ok: false, motivo: "Falta indicar la cuenta contable (nombre o número)." };
  if (/^\d{4,9}$/.test(buscado)) {
    const porNumero = plan.filter((c) => String(c.number) === buscado);
    return porNumero.length === 1 ? { ok: true, cuenta: porNumero[0] } : { ok: false, motivo: `No existe una cuenta con el número ${buscado} en el plan contable.` };
  }
  const exactas = plan.filter((c) => normalizar(c.name) === buscado);
  if (exactas.length === 1) return { ok: true, cuenta: exactas[0] };
  const candidatas = exactas.length > 1 ? exactas : plan.filter((c) => normalizar(c.name).includes(buscado));
  if (candidatas.length === 1) return { ok: true, cuenta: candidatas[0] };
  if (candidatas.length === 0) return { ok: false, motivo: `No encontré ninguna cuenta contable que se llame «${texto}».` };
  return { ok: false, motivo: `«${texto}» coincide con varias cuentas; indica el número de la correcta: ${candidatas.slice(0, 8).map(etiqueta).join("; ")}` };
}
