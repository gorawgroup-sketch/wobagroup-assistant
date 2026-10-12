import { leerFilas, agregarFila } from "../google/sheetsKeyValueStore";
export type Proveedor = "openai" | "anthropic";
const HEADERS = ["proveedor", "saldoUSD", "verificadoEn", "registradoEn", "umbralUSD"];
const USO_HEADERS = ["fecha", "chatId", "modelo", "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "costoUSD", "proceso", "autenticacion", "ejecucionId", "llamadaNumero", "costoEquivalenteSuscripcionUSD", "gastoRealApiUSD"];
export const FUENTES = { openai: "https://platform.openai.com/settings/organization/billing/overview", anthropic: "https://platform.claude.com/settings/billing" };
export interface Observacion { proveedor: Proveedor; saldoUSD: number; verificadoEn: string; umbralUSD: number }
export function validarObservacion(body: unknown, ahora = new Date()): Observacion {
  const b = body as Partial<Observacion> | null;
  if (!b || !["openai", "anthropic"].includes(String(b.proveedor)) || typeof b.saldoUSD !== "number" || !Number.isFinite(b.saldoUSD) || b.saldoUSD < 0 || typeof b.umbralUSD !== "number" || !Number.isFinite(b.umbralUSD) || b.umbralUSD <= 0 || typeof b.verificadoEn !== "string" || !Number.isFinite(Date.parse(b.verificadoEn)) || Date.parse(b.verificadoEn) > ahora.getTime()) throw new Error("Saldo, proveedor, umbral o fecha inválidos");
  return { proveedor: b.proveedor as Proveedor, saldoUSD: b.saldoUSD, umbralUSD: b.umbralUSD, verificadoEn: new Date(b.verificadoEn).toISOString() };
}
export function evaluarSaldo(proveedor: Proveedor, observacion: Observacion | null, consumoUSD: number | null, ahora = new Date()) {
  const estimadoUSD = observacion && consumoUSD !== null ? Math.max(0, observacion.saldoUSD - consumoUSD) : null;
  const antiguo = observacion ? ahora.getTime() - Date.parse(observacion.verificadoEn) > 86400000 : true;
  const umbralUSD = observacion?.umbralUSD ?? 5;
  const estado = estimadoUSD !== null && estimadoUSD <= 1 ? "critico" : estimadoUSD !== null && estimadoUSD <= umbralUSD ? "bajo" : !observacion || antiguo || consumoUSD === null ? "verificar" : "normal";
  return { proveedor, fuente: FUENTES[proveedor], saldoConfirmadoUSD: observacion?.saldoUSD ?? null, verificadoEn: observacion?.verificadoEn ?? null, estimadoUSD, consumoDesdeLecturaUSD: consumoUSD, umbralUSD, lecturaAntigua: antiguo, estado };
}
export type SaldoApi = ReturnType<typeof evaluarSaldo>;
export async function registrarSaldo(observacion: Observacion) {
  await agregarFila("_saldos_api", HEADERS.length, HEADERS, [observacion.proveedor, observacion.saldoUSD, observacion.verificadoEn, new Date().toISOString(), observacion.umbralUSD]);
}
export async function obtenerSaldosApi(ahora = new Date()): Promise<SaldoApi[]> {
  const [lecturas, uso] = await Promise.all([
    leerFilas("_saldos_api", HEADERS.length, HEADERS).catch(() => null),
    leerFilas("_costos_ia", USO_HEADERS.length, USO_HEADERS).catch(() => null),
  ]);
  return (["openai", "anthropic"] as Proveedor[]).map(proveedor => {
    let observacion: Observacion | null = null;
    for (const { valores: v } of lecturas ?? []) {
      if (v[0] !== proveedor || v[1] === "" || v[4] === "") continue;
      try {
        const candidata = validarObservacion({ proveedor, saldoUSD: Number(v[1]), verificadoEn: v[2], umbralUSD: Number(v[4]) }, ahora);
        if (!observacion || candidata.verificadoEn >= observacion.verificadoEn) observacion = candidata;
      } catch { /* Una fila inválida no demuestra saldo cero. */ }
    }
    let consumo: number | null = uso && observacion ? 0 : null;
    for (const { valores: v } of uso ?? []) {
      if (v[9] !== `${proveedor}_api_key` || !observacion) continue;
      const fecha = Date.parse(v[0]);
      if (!Number.isFinite(fecha)) { consumo = null; break; }
      if (fecha <= Date.parse(observacion.verificadoEn) || fecha > ahora.getTime()) continue;
      const importe = v[13]?.trim() ? Number(v[13]) : Number.NaN;
      if (!Number.isFinite(importe) || importe < 0) { consumo = null; break; }
      if (consumo !== null) consumo += importe;
    }
    return evaluarSaldo(proveedor, observacion, consumo, ahora);
  });
}
