import type { LecturaEmpresa } from "./lectura";
import type { PropuestaTransferencia } from "./deteccion";

/** Texto del informe de observación: qué se conciliaría y por qué. No ejecuta nada. */

const n = (v: number, decimales = 2) => {
  const [e, d] = Math.abs(v).toFixed(decimales).split(".");
  return `${v < 0 ? "-" : ""}${e.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}${d ? `,${d}` : ""}`;
};
const fecha = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
const ETIQUETA = { automatica: "✅ Inequívoca", revision: "🟡 Revisar", bloqueada: "⛔ Bloqueada" } as const;

export function describirPropuesta(p: PropuestaTransferencia): string {
  const o = p.origen, d = p.destino;
  const cabecera = `${ETIQUETA[p.confianza]} · ${fecha(p.fecha)} · ${p.tipo === "conversion" ? "Conversión" : "Transferencia"}: ` +
    `${o.cuenta.nombre} ${n(o.movimiento.importe, o.movimiento.moneda === "COP" ? 0 : 2)} ${o.movimiento.moneda} → ` +
    `${d.cuenta.nombre} +${n(d.movimiento.importe, d.movimiento.moneda === "COP" ? 0 : 2)} ${d.movimiento.moneda}`;
  const cambio = p.tipo === "conversion"
    ? `\n   Tasa aplicada ${p.tasaImplicita?.toFixed(4)}${p.tasaHistorica ? ` · del día ${p.tasaHistorica.toFixed(4)}` : " · sin tasa histórica"}` +
      `${p.diferenciaPct !== undefined ? ` · diferencia ${p.diferenciaPct.toFixed(2)} %` : ""}` +
      `${p.diferenciaEur !== undefined ? ` (${p.diferenciaEur >= 0 ? "+" : ""}${n(p.diferenciaEur)} EUR)` : ""}`
    : "";
  return `${cabecera}${cambio}\n   Sale: «${o.movimiento.descripcion.trim().slice(0, 70)}»\n   Entra: «${d.movimiento.descripcion.trim().slice(0, 70)}»` +
    (p.confianza === "automatica" ? "" : `\n   Motivo: ${p.motivos[p.motivos.length - 1]}`);
}

export function informeObservacion(lecturas: LecturaEmpresa[]): string {
  const bloques = lecturas.map((l) => {
    const cuenta = (c: "automatica" | "revision" | "bloqueada") => l.propuestas.filter((p) => p.confianza === c).length;
    const excluidas = l.cuentasExcluidas.filter((x) => !x.cuenta.archivada && x.cuenta.tipo === "bank");
    return [
      `══ ${l.empresa} — ${l.propuestas.length} operación(es) interna(s) detectada(s): ${cuenta("automatica")} inequívoca(s), ${cuenta("revision")} para revisar, ${cuenta("bloqueada")} bloqueada(s)`,
      ...l.propuestas.map(describirPropuesta),
      ...(excluidas.length ? [`Cuentas bancarias fuera de la detección: ${excluidas.map((x) => `${x.cuenta.nombre} (${x.motivo})`).join("; ")}`] : []),
    ].join("\n");
  });
  return `OBSERVACIÓN — transferencias internas y conversiones (no se ha escrito nada en Holded)\n\n${bloques.join("\n\n")}`;
}
