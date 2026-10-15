import type { Empresa } from "./client";

/**
 * La sincronización bancaria de Holded puede dejar un cargo DUPLICADO: la misma fila (descripción, importe y fecha) una vez ya
 * conciliada y otra «pendiente». Esa copia pendiente no es un cargo libre y nunca debe ofrecerse ni conciliarse. Caso real
 * 14-10-2026 (WOBA Main): Anthropic −21,63 € del 08/10 aparecía dos veces; el gasto del 13/10 se concilió contra la copia
 * fantasma del 08/10 mientras el cargo real del 13/10 (−21,61 €) seguía libre.
 */
export interface MovimientoFirma { description?: string; amount?: string | number; booking_date?: string; status?: string }

const CONCILIADO = new Set(["reconciled", "forced_reconciled"]);

export function firmaMovimiento(m: MovimientoFirma): string {
  return `${(m.description ?? "").trim().toLowerCase()}|${Number(m.amount ?? 0).toFixed(2)}|${String(m.booking_date ?? "").slice(0, 10)}`;
}

/** Firmas de los movimientos ya conciliados de la lista (para detectar sus copias pendientes). */
export function firmasConciliadas(movimientos: MovimientoFirma[]): Set<string> {
  return new Set(movimientos.filter((m) => CONCILIADO.has(String(m.status))).map(firmaMovimiento));
}

/** true si este movimiento pendiente es la copia exacta de otro ya conciliado en la misma lista. */
export function esCopiaPendienteDeConciliado(m: MovimientoFirma, firmas: Set<string>): boolean {
  return !CONCILIADO.has(String(m.status)) && firmas.has(firmaMovimiento(m));
}

// ─── Aviso diario de LOTES de copias (15-10-2026) ───────────────────────────────────────────────────────────────────
// Lo de arriba evita OFRECER la copia pendiente de un conciliado; esto avisa a las personas cuando el banco importa copias de golpe.
/**
 * Aviso diario de COPIAS bancarias en Holded (caso de Carlos, 15-10-2026): el agregador del banco (Bankin'/Afterbanks) reimportó de golpe
 * 16 movimientos de WOBA Main (Revolut) que ya existían. Se concilia uno y la copia queda pendiente. Solo lectura: no concilia, no borra, no
 * crea nada; avisa una sola vez por lote y sin botones.
 *
 * Huella demostrada en el caso real (ver docs/duplicados-bancarios.md):
 *  - mismo día, importe y descripción que otro movimiento de la misma cuenta;
 *  - creado ≥ 6 h DESPUÉS (la fecha de creación son los 4 primeros bytes hex del id de Holded);
 *  - el saldo corrido difiere en una constante que NO es el importe. Si la diferencia fuera el importe serían dos cargos reales seguidos
 *    (p. ej. dos recibos iguales el mismo día): eso nunca se marca;
 *  - llegan en LOTE: al menos 2 pares con el mismo desfase de saldo creados en la misma ventana de 30 minutos. Un caso aislado no se avisa:
 *    sin lote no hay forma fiable de distinguirlo de un segundo cargo real que el banco publicó otro día.
 */
export const HORAS_MINIMAS_ENTRE_ORIGINAL_Y_COPIA = 6;
export const VENTANA_LOTE_MS = 30 * 60_000;
export const MIN_PARES_POR_LOTE = 2;
export const DIAS_AUDITADOS = 45;
const TOLERANCIA_CENTIMOS = 0.005;

export interface MovimientoBancario { id: string; fecha: string; monto: number; descripcion: string; saldo: number; estado: string }
export interface CuentaConMovimientos { empresa: Empresa; cuentaId: string; cuenta: string; movimientos: MovimientoBancario[] }
export interface ParCopia { copiaId: string; originalId: string; fecha: string; monto: number; descripcion: string; estadoCopia: string; estadoOriginal: string }
export interface LoteCopias { clave: string; empresa: Empresa; cuentaId: string; cuenta: string; creadoEn: number; desfaseSaldo: number; pares: ParCopia[] }

const esPendiente = (estado: string): boolean => !CONCILIADO.has(estado);

/** Instante de creación de un id de Holded (ObjectId): segundos desde 1970 en los 4 primeros bytes. NaN si el id no tiene ese formato. */
export function creadoEnDeId(id: string): number {
  return /^[0-9a-f]{24}$/i.test(id) ? Number.parseInt(id.slice(0, 8), 16) * 1000 : Number.NaN;
}

interface Candidato { original: MovimientoBancario; copia: MovimientoBancario; creadoEn: number; desfase: number }

function candidatos(movimientos: readonly MovimientoBancario[]): Candidato[] {
  const grupos = new Map<string, MovimientoBancario[]>();
  for (const m of movimientos) {
    if (!Number.isFinite(m.monto) || !Number.isFinite(m.saldo) || !Number.isFinite(creadoEnDeId(m.id))) continue;
    const clave = firmaMovimiento({ description: m.descripcion, amount: m.monto, booking_date: m.fecha });
    grupos.set(clave, [...(grupos.get(clave) ?? []), m]);
  }
  const salida: Candidato[] = [];
  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;
    const ordenado = [...grupo].sort((a, b) => creadoEnDeId(a.id) - creadoEnDeId(b.id));
    const original = ordenado[0];
    for (const copia of ordenado.slice(1)) {
      const horas = (creadoEnDeId(copia.id) - creadoEnDeId(original.id)) / 3_600_000;
      const desfase = Math.round((copia.saldo - original.saldo) * 100) / 100;
      if (horas < HORAS_MINIMAS_ENTRE_ORIGINAL_Y_COPIA) continue;
      if (Math.abs(Math.abs(desfase) - Math.abs(original.monto)) <= TOLERANCIA_CENTIMOS) continue; // dos cargos reales consecutivos
      if (Math.abs(desfase) <= TOLERANCIA_CENTIMOS) continue;
      salida.push({ original, copia, creadoEn: creadoEnDeId(copia.id), desfase });
    }
  }
  return salida.sort((a, b) => a.creadoEn - b.creadoEn);
}

/** Lotes de copias de UNA cuenta: pares con el mismo desfase de saldo creados en la misma ventana de 30 minutos (mínimo 2 pares). */
export function detectarLotesDeCopias(cuenta: CuentaConMovimientos): LoteCopias[] {
  const lotes: Array<{ inicio: number; desfase: number; items: Candidato[] }> = [];
  for (const c of candidatos(cuenta.movimientos)) {
    const lote = lotes.find((l) => l.desfase === c.desfase && c.creadoEn - l.inicio <= VENTANA_LOTE_MS);
    if (lote) lote.items.push(c);
    else lotes.push({ inicio: c.creadoEn, desfase: c.desfase, items: [c] });
  }
  return lotes
    .filter((l) => l.items.length >= MIN_PARES_POR_LOTE)
    .map((l) => ({
      clave: `${cuenta.empresa}|${cuenta.cuentaId}|${new Date(l.inicio).toISOString().slice(0, 16)}|${l.desfase.toFixed(2)}`,
      empresa: cuenta.empresa, cuentaId: cuenta.cuentaId, cuenta: cuenta.cuenta, creadoEn: l.inicio, desfaseSaldo: l.desfase,
      pares: l.items.map((i) => ({ copiaId: i.copia.id, originalId: i.original.id, fecha: i.copia.fecha.slice(0, 10), monto: i.copia.monto, descripcion: i.copia.descripcion, estadoCopia: i.copia.estado, estadoOriginal: i.original.estado })),
    }));
}

export interface DepsAvisoDuplicados {
  cuentas(): Promise<CuentaConMovimientos[]>;
  yaAvisados(): Promise<Set<string>>;
  marcarAvisados(claves: string[]): Promise<void>;
  avisar(texto: string): Promise<void>;
  /** Solo calcula y devuelve; no avisa ni marca nada. */
  simular?: boolean;
}
export interface ResultadoAvisoDuplicados { lotes: LoteCopias[]; nuevos: LoteCopias[]; cuentasRevisadas: number; simulado: boolean }

export async function avisarDuplicadosBancarios(deps: DepsAvisoDuplicados): Promise<ResultadoAvisoDuplicados> {
  const cuentas = await deps.cuentas();
  const lotes = cuentas.flatMap(detectarLotesDeCopias);
  const avisados = await deps.yaAvisados();
  const nuevos = lotes.filter((l) => !avisados.has(l.clave));
  if (!deps.simular && nuevos.length > 0) {
    await deps.avisar(textoAvisoDuplicados(nuevos));
    await deps.marcarAvisados(nuevos.map((l) => l.clave));
  }
  return { lotes, nuevos, cuentasRevisadas: cuentas.length, simulado: Boolean(deps.simular) };
}

const euros = (n: number): string => n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const horaMadrid = (ms: number): string => new Date(ms).toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function textoAvisoDuplicados(lotes: readonly LoteCopias[]): string {
  const partes = ["🔎 Posibles movimientos DUPLICADOS que llegaron del banco (solo lectura, no he tocado nada):"];
  for (const l of lotes.slice(0, 5)) {
    const pendientes = l.pares.filter((p) => esPendiente(p.estadoCopia));
    const conciliadas = l.pares.length - pendientes.length;
    partes.push(
      "",
      `• ${l.empresa} · ${l.cuenta}: ${l.pares.length} copias importadas a la vez el ${horaMadrid(l.creadoEn)} (hora de Madrid). Su saldo corrido difiere del original en ${euros(l.desfaseSaldo)} €, que no es el importe de ningún movimiento.`,
      `  Pendientes de conciliar: ${pendientes.length} (suman ${euros(pendientes.reduce((s, p) => s + p.monto, 0))} €)${conciliadas > 0 ? `; ya conciliadas por Holded: ${conciliadas}, revisar que no consuman dos veces el mismo pago` : ""}.`,
      ...pendientes.slice(0, 6).map((p) => `  – ${p.fecha} · ${euros(p.monto)} € · ${p.descripcion || "sin descripción"}`),
      ...(pendientes.length > 6 ? [`  – y ${pendientes.length - 6} más`] : []),
    );
  }
  if (lotes.length > 5) partes.push("", `…y ${lotes.length - 5} lotes más.`);
  partes.push("", "Vienen del banco conectado a Holded, no de Wobi (nuestro sistema solo concilia movimientos que ya existen). Concilia el original, no la copia, y dime cómo quieres limpiarlas. Este aviso no se repite para el mismo lote.");
  return partes.join("\n");
}
