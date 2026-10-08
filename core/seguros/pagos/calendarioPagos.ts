/**
 * Orquestación diaria del calendario de pagos de seguros. Sin IA. Hace tres cosas, con las dependencias inyectadas (se prueba con falsas):
 *  1. pone en el calendario de Carlos el evento de cada pago (3 días antes, a las 9:00) y retira el de los pagos ya cerrados;
 *  2. decide qué pagos tocan avisar hoy y comprueba la caja de su cuenta de cargo;
 *  3. arma el mensaje de Telegram (uno solo). Quien llama lo envía y después marca los avisos como enviados (al menos una vez).
 */
import type { Empresa } from "../../holded/client";
import { diasEntre } from "../vigilante/fechas";
import type { Informe } from "../vigilante/informe";
import { construirInformePagos, merecePorCaja, nivelQueToca, type AvisoPago } from "./aviso";
import { evaluarCaja, type CuentaCaja } from "./caja";
import { eventoDePago, fechaDelEvento } from "./eventoCalendario";
import { HORIZONTE_EVENTOS_DIAS, type PagoSeguro, type PagoSeguroConFila } from "./tipos";

export interface DepsCalendarioPagos {
  hoy(): string;
  leerPagos(): Promise<PagoSeguroConFila[]>;
  actualizar(pago: PagoSeguroConFila, cambios: Partial<PagoSeguro>): Promise<PagoSeguroConFila>;
  /** null = no se pudieron leer las cuentas de la empresa (no es «sin cuentas»). */
  cuentas(empresa: Empresa): Promise<CuentaCaja[] | null>;
  /** id del evento creado, o null si el calendario no está disponible (se reintenta mañana). */
  crearEvento(evento: ReturnType<typeof eventoDePago>): Promise<string | null>;
  borrarEvento(eventoId: string): Promise<void>;
}

export interface ResultadoCalendarioPagos {
  hoy: string;
  eventosCreados: number;
  eventosRetirados: number;
  avisos: AvisoPago[];
  informe: Informe | null;
  advertencias: string[];
}

export async function prepararCalendarioPagos(deps: DepsCalendarioPagos): Promise<ResultadoCalendarioPagos> {
  const hoy = deps.hoy();
  const advertencias: string[] = [];
  let pagos = await deps.leerPagos();
  let eventosCreados = 0;
  let eventosRetirados = 0;

  const reemplazar = (nuevo: PagoSeguroConFila) => { pagos = pagos.map((p) => (p.id === nuevo.id ? nuevo : p)); };

  // 1) Eventos de calendario: uno por pago previsto (el día del evento, hoy o futuro) y fuera los de pagos ya cerrados.
  for (const p of pagos.filter((x) => x.estado === "previsto" && !x.eventoCalendarId && diasEntre(hoy, x.fecha) <= HORIZONTE_EVENTOS_DIAS && diasEntre(hoy, fechaDelEvento(x)) >= 0)) {
    const id = await deps.crearEvento(eventoDePago(p));
    if (!id) { advertencias.push(`No pude crear el evento de calendario de «${p.concepto}» (${p.fecha}); se reintenta mañana.`); continue; }
    reemplazar(await deps.actualizar(p, { eventoCalendarId: id }));
    eventosCreados++;
  }
  for (const p of pagos.filter((x) => x.estado !== "previsto" && x.eventoCalendarId)) {
    await deps.borrarEvento(p.eventoCalendarId);
    reemplazar(await deps.actualizar(p, { eventoCalendarId: "" }));
    eventosRetirados++;
  }

  // 2) Avisos de hoy con la comprobación de caja (las cuentas de cada empresa se leen una sola vez).
  const candidatos = pagos.map((p) => ({ pago: p, toca: nivelQueToca(p, hoy) })).filter((x): x is { pago: PagoSeguroConFila; toca: NonNullable<ReturnType<typeof nivelQueToca>> } => x.toca !== null);
  const cuentasPorEmpresa = new Map<Empresa, CuentaCaja[] | null>();
  for (const { pago } of candidatos) {
    if (cuentasPorEmpresa.has(pago.empresa)) continue;
    let cuentas: CuentaCaja[] | null = null;
    try { cuentas = await deps.cuentas(pago.empresa); } catch (error) {
      advertencias.push(`No pude leer las cuentas de ${pago.empresa} en Holded: ${error instanceof Error ? error.message : String(error)}`);
    }
    cuentasPorEmpresa.set(pago.empresa, cuentas);
  }
  const avisos: AvisoPago[] = [];
  for (const { pago, toca } of candidatos) {
    const caja = evaluarCaja(pago, pagos, cuentasPorEmpresa.get(pago.empresa) ?? null, hoy);
    if (merecePorCaja(toca.nivel, caja)) avisos.push({ pago, dias: toca.dias, nivel: toca.nivel, caja });
  }
  return { hoy, eventosCreados, eventosRetirados, avisos, informe: construirInformePagos(avisos, hoy), advertencias };
}

/** Tras entregar el mensaje: deja constancia del aviso en cada pago (así no se repite). */
export async function marcarAvisosEnviados(deps: Pick<DepsCalendarioPagos, "actualizar">, avisos: AvisoPago[]): Promise<void> {
  for (const a of avisos) {
    const previos = a.pago.avisos.split(",").map((s) => s.trim()).filter(Boolean);
    if (!previos.includes(a.nivel)) await deps.actualizar(a.pago as PagoSeguroConFila, { avisos: [...previos, a.nivel].join(",") });
  }
}
