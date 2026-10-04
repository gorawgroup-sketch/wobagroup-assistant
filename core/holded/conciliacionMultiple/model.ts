import type { Empresa } from "../client";

export interface ReferenciaMovimiento { accountId: string; movementId: string; fecha: string }
export interface MovimientoExacto extends ReferenciaMovimiento {
  descripcion: string;
  cuenta: string;
  moneda: string;
  centimos: number; // negativo: salida bancaria
  conciliadoCentimos: number;
  estado: string;
}
export interface PagoExacto { id: string; centimos: number; accountId: string; fecha: string }
export interface CompraExacta {
  id: string;
  proveedorId: string;
  cuentasContables: string[];
  proveedor: string;
  numero: string;
  fecha: string;
  moneda: string;
  totalCentimos: number;
  pagadoCentimos: number;
  pendienteCentimos: number;
  pagos: PagoExacto[];
  estado: string;
  borrador: boolean;
}
export interface PlanConciliacion {
  id: string;
  empresa: Empresa;
  chatId: number;
  creadoEn: number;
  compra: CompraExacta;
  movimientos: MovimientoExacto[];
  motivo: string;
  estado: "propuesto" | "ejecutando" | "completado" | "cancelado" | "rechazado" | "incierto";
  verificados: string[];
  pagosVerificados: Array<{ movimiento: string; pago: PagoExacto; pendienteCentimos: number }>;
  enVuelo?: string;
  aprobadoPor?: number;
  detalle?: string;
}
export interface PuertoHolded {
  validarClasificacion(empresa: Empresa, compraId: string): Promise<void>;
  compra(empresa: Empresa, id: string): Promise<CompraExacta>;
  movimiento(empresa: Empresa, ref: ReferenciaMovimiento): Promise<MovimientoExacto>;
  conciliar(empresa: Empresa, ref: ReferenciaMovimiento, compraId: string): Promise<void>;
}
export interface StorePlanes {
  listar(): Promise<PlanConciliacion[]>;
  guardar(plan: PlanConciliacion): Promise<void>;
}
export const TTL_PLAN = 24 * 60 * 60 * 1000;
export const claveMovimiento = (m: ReferenciaMovimiento): string => `${m.accountId}/${m.movementId}`;
export const mutexConciliacion = (empresa: Empresa): string => `holded:conciliacion:${empresa}`;

/** Aritmética entera, sin redondear, sin tolerancia y sin Number(raw) sobre texto ambiguo. */
export function centimos(raw: unknown, admiteFormatoES = false): number {
  if (typeof raw !== "number" && typeof raw !== "string") throw new Error("Importe ausente o inválido.");
  let texto = String(raw);
  if (admiteFormatoES && texto.includes(",")) {
    if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(texto)) throw new Error("Importe ES inválido.");
    texto = texto.replace(/\./g, "").replace(",", ".");
  }
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(texto)) throw new Error("Importe inválido o con precisión superior a céntimos.");
  const negativo = texto.startsWith("-");
  const [entero, decimal = ""] = texto.replace(/^-/, "").split(".");
  const n = BigInt(entero) * 100n + BigInt(decimal.padEnd(2, "0"));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Importe fuera del rango seguro.");
  return Number(negativo ? -n : n);
}
export function importe(n: number): string {
  if (!Number.isSafeInteger(n)) throw new Error("Importe interno inválido.");
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
export function validarReferencia(ref: ReferenciaMovimiento): void {
  for (const id of [ref.accountId, ref.movementId]) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Falta un identificador bancario válido.");
  }
  if (typeof ref.fecha !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ref.fecha) ||
      !Number.isFinite(Date.parse(ref.fecha)) || new Date(ref.fecha).toISOString().slice(0, 10) !== ref.fecha) {
    throw new Error("Fecha bancaria inválida (YYYY-MM-DD).");
  }
}
export function validarCompra(c: CompraExacta): void {
  // EUR inicialmente: write.ts documenta una incidencia real de aplicación incorrecta de FX en Holded.
  if (c.moneda !== "EUR") throw new Error("La conciliación múltiple requiere EUR; las otras monedas requieren validar antes la liquidación de Holded.");
  if (c.borrador || !["pending", "partial", "completed"].includes(c.estado)) throw new Error("Compra no contabilizada, cancelada o con estado desconocido.");
  if (!Array.isArray(c.cuentasContables) || c.cuentasContables.length !== 1 || !c.cuentasContables[0]) throw new Error("Cuenta contable no identificada o múltiple; requiere revisión.");
  if (!c.id || !c.proveedorId) throw new Error("La compra no tiene identidad y proveedor verificables.");
  for (const n of [c.totalCentimos, c.pagadoCentimos, c.pendienteCentimos]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Saldo de compra inválido.");
  }
  if (c.totalCentimos <= 0 || BigInt(c.pagadoCentimos) + BigInt(c.pendienteCentimos) !== BigInt(c.totalCentimos)) {
    throw new Error("Total, pagos y saldo pendiente de la compra no cuadran exactamente.");
  }
  const ids = new Set<string>();
  let suma = 0n;
  for (const p of c.pagos) {
    if (!p.id || ids.has(p.id) || !Number.isSafeInteger(p.centimos) || p.centimos <= 0) throw new Error("Detalle de pagos inválido.");
    ids.add(p.id);
    suma += BigInt(p.centimos);
  }
  if (suma !== BigInt(c.pagadoCentimos)) throw new Error("El detalle de pagos no coincide con el total pagado.");
}
export function validarSeleccion(c: CompraExacta, movimientos: MovimientoExacto[]): void {
  validarCompra(c);
  if (movimientos.length < 2 || movimientos.length > 20) throw new Error("Selecciona entre 2 y 20 movimientos identificados.");
  if (c.pendienteCentimos <= 0) throw new Error("La compra no tiene saldo pendiente.");
  const ids = new Set<string>();
  let suma = 0n;
  for (const m of movimientos) {
    validarReferencia(m);
    // Repetir un id en otra cuenta tampoco puede inflar la suma.
    if (ids.has(m.movementId)) throw new Error("Hay movimientos duplicados en la selección.");
    ids.add(m.movementId);
    if (m.moneda !== c.moneda) throw new Error("Las monedas no coinciden.");
    if (!Number.isSafeInteger(m.centimos) || m.centimos >= 0) throw new Error("Solo se aceptan cargos bancarios con importe exacto.");
    if (m.estado !== "pending" || m.conciliadoCentimos !== 0) throw new Error("Un movimiento ya está conciliado, es parcial o tiene estado desconocido.");
    suma -= BigInt(m.centimos);
  }
  if (suma !== BigInt(c.pendienteCentimos)) {
    throw new Error(`La suma (${importe(Number(suma))}) debe coincidir exactamente con el saldo pendiente (${importe(c.pendienteCentimos)} EUR).`);
  }
}
export function reservaActiva(p: PlanConciliacion, ahora = Date.now()): boolean {
  if (p.estado === "cancelado" || p.estado === "rechazado") return false;
  return p.estado !== "propuesto" || ahora - p.creadoEn <= TTL_PLAN;
}
export function resumenPlan(p: PlanConciliacion): string {
  return `Conciliación múltiple — ${p.empresa}\nProveedor: ${p.compra.proveedor}\n` +
    `Compra ${p.compra.numero || "sin número"} [${p.compra.id}] — ${p.compra.fecha}\n` +
    `Cuenta contable: ${p.compra.cuentasContables.join(", ")}\nTotal: ${importe(p.compra.totalCentimos)} EUR; pagado: ${importe(p.compra.pagadoCentimos)} EUR\n` +
    `Saldo a conciliar: ${importe(p.compra.pendienteCentimos)} EUR\n\n` +
    p.movimientos.map((m, i) => `${i + 1}. ${m.fecha} | ${importe(m.centimos)} EUR | ${m.cuenta}\n${m.descripcion}\n[${claveMovimiento(m)}]`).join("\n") +
    `\n\nSuma de cargos: ${importe(p.compra.pendienteCentimos)} EUR. Diferencia: 0.00 EUR.\nMotivo: ${p.motivo}\nPlan: ${p.id}`;
}

export function estadoPlan(p: PlanConciliacion): string {
  const exito = p.estado === "completado";
  return `${exito ? "✅" : "ℹ️"} Plan ${p.id}: ${p.estado}.\n` +
    `Movimientos verificados: ${p.verificados.length}/${p.movimientos.length}.\n` +
    (p.verificados.length ? `Verificados: ${p.verificados.join(", ")}\n` : "") +
    (p.enVuelo ? `Enviado o en vuelo, sin verificación confirmada: ${p.enVuelo}.\n` : "") +
    (p.detalle ?? "Pendiente de aprobación; todavía no se ha conciliado.") +
    (p.estado === "ejecutando" || p.estado === "incierto" ? "\nNo volver a enviar ni dar por resuelto. Requiere revisión del registro y de Holded." : "");
}

