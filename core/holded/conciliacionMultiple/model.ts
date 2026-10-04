import type { Empresa } from "../client";

export interface ReferenciaMovimiento { accountId: string; movementId: string; fecha: string }
export interface MovimientoExacto extends ReferenciaMovimiento {
  descripcion: string;
  cuenta: string;
  moneda: string;
  centimos: number; // negativo: salida bancaria
  conciliadoCentimos: number;
  estado: string;
  /** Equivalente en EUR que Holded asigna al movimiento (accounting_amount, en valor absoluto). Solo se exige en compras en divisa. */
  contableCentimos?: number;
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
  /** Compra tal como estaba al preparar el plan (la de `compra` se renueva al reanudar un lote detenido). */
  compraInicial?: CompraExacta;
  /** Conciliación PARCIAL pedida: se concilian solo estos cargos y el resto del saldo de la compra queda abierto a propósito. */
  parcial?: boolean;
  /** Cierre del residuo de redondeo de una compra en divisa (pago «Ajustar cambio de divisa», ver write.ts). */
  ajusteCambio?: { estado: string; montoCentimos: number; motivo: string };
}
export interface ResultadoCierreResiduo { estado: "sin_residuo" | "aplicado" | "ya_aplicado" | "requiere_revision" | "incierto"; montoCentimos: number; motivo: string }
export interface PuertoHolded {
  validarClasificacion(empresa: Empresa, compraId: string): Promise<void>;
  compra(empresa: Empresa, id: string): Promise<CompraExacta>;
  movimiento(empresa: Empresa, ref: ReferenciaMovimiento): Promise<MovimientoExacto>;
  conciliar(empresa: Empresa, ref: ReferenciaMovimiento, compraId: string): Promise<void>;
  /** Solo compras en divisa: cierra el residuo de redondeo (≤ margen) con el ajuste de cambio durable. `ancla` identifica el lote. */
  cerrarResiduoCambio(empresa: Empresa, compraId: string, ancla: ReferenciaMovimiento): Promise<ResultadoCierreResiduo>;
}
export interface StorePlanes {
  listar(): Promise<PlanConciliacion[]>;
  guardar(plan: PlanConciliacion): Promise<void>;
}
/** Compra en una divisa distinta del EUR: Holded paga en EUR a su tasa y redondea cada pago, así que los saldos nativos no suman al céntimo. */
export const esDivisaExtranjera = (c: Pick<CompraExacta, "moneda">): boolean => c.moneda !== "EUR";
/** Mismo margen de redondeo que write.ts (margenResiduoConversion): min(1, max(0,02, 0,5 % del total)), en céntimos. Una prueba fija la igualdad. */
export function margenResiduoCentimos(totalCentimos: number): number {
  return Math.round(Math.min(1, Math.max(0.02, (Math.abs(totalCentimos) / 100) * 0.005)) * 100);
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
  // Monedas permitidas por entorno (EUR por defecto): write.ts documenta una incidencia real de aplicación incorrecta de FX en Holded.
  // Una moneda distinta solo se enciende de forma explícita (WOBI_CONCILIACION_MULTIPLE_MONEDAS="EUR,USD") y SIN conversión: la
  // compra, la cuenta y todos los movimientos deben estar en esa misma moneda (se comprueba más abajo y en el adaptador).
  const permitidas = (process.env.WOBI_CONCILIACION_MULTIPLE_MONEDAS ?? "EUR").split(",").map((m) => m.trim().toUpperCase()).filter(Boolean);
  if (!permitidas.includes(c.moneda)) throw new Error(`La conciliación múltiple no está habilitada para ${c.moneda}; hoy solo: ${permitidas.join(", ")}. Otras monedas requieren validar antes la liquidación de Holded.`);
  if (!["pending", "partial", "completed"].includes(c.estado)) throw new Error("Compra cancelada o con estado desconocido.");
  if (!Array.isArray(c.cuentasContables) || c.cuentasContables.length !== 1 || !c.cuentasContables[0]) throw new Error("Cuenta contable no identificada o múltiple; requiere revisión.");
  if (!c.id || !c.proveedorId) throw new Error("La compra no tiene identidad y proveedor verificables.");
  for (const n of [c.totalCentimos, c.pagadoCentimos, c.pendienteCentimos]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Saldo de compra inválido.");
  }
  if (esDivisaExtranjera(c)) {
    // Holded expone pagado/pendiente en la divisa del documento a partir de pagos en EUR redondeados: cuadran solo dentro del margen de redondeo.
    if (c.totalCentimos <= 0 || Math.abs(c.pagadoCentimos + c.pendienteCentimos - c.totalCentimos) > margenResiduoCentimos(c.totalCentimos)) {
      throw new Error("Total, pagos y saldo pendiente de la compra no cuadran ni dentro del margen de redondeo de la divisa.");
    }
  } else if (c.totalCentimos <= 0 || BigInt(c.pagadoCentimos) + BigInt(c.pendienteCentimos) !== BigInt(c.totalCentimos)) {
    throw new Error("Total, pagos y saldo pendiente de la compra no cuadran exactamente.");
  }
  const ids = new Set<string>();
  let suma = 0n;
  for (const p of c.pagos) {
    if (!p.id || ids.has(p.id) || !Number.isSafeInteger(p.centimos) || p.centimos <= 0) throw new Error("Detalle de pagos inválido.");
    ids.add(p.id);
    suma += BigInt(p.centimos);
  }
  // En divisa los pagos van en EUR y el pagado en la divisa del documento: no son comparables al céntimo.
  if (!esDivisaExtranjera(c) && suma !== BigInt(c.pagadoCentimos)) throw new Error("El detalle de pagos no coincide con el total pagado.");
}
/** `recuperacion`: se reanuda un lote detenido; puede quedar un solo movimiento. */
export function validarSeleccion(c: CompraExacta, movimientos: MovimientoExacto[], opciones: { recuperacion?: boolean; parcial?: boolean } = {}): void {
  validarCompra(c);
  // Una compra que YA tiene pagos puede completarse con un solo cargo; una parcial, también (deja el resto abierto).
  const minimo = opciones.recuperacion || opciones.parcial || c.pagos.length > 0 ? 1 : 2;
  if (movimientos.length < minimo || movimientos.length > 20) throw new Error("Selecciona entre 2 y 20 movimientos identificados.");
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
    if (esDivisaExtranjera(c) && !(Number.isSafeInteger(m.contableCentimos) && (m.contableCentimos as number) > 0)) {
      throw new Error("Holded no informa el equivalente en EUR de un movimiento; no se puede verificar su pago en una compra en divisa.");
    }
    suma -= BigInt(m.centimos);
  }
  if (opciones.parcial) {
    // Parcial: los cargos tienen que sumar MENOS que el saldo (si suman todo, no es parcial) y dejar un resto que no sea redondeo.
    const resto = c.pendienteCentimos - Number(suma);
    if (resto <= margenResiduoCentimos(c.totalCentimos)) {
      throw new Error(`Los cargos (${importe(Number(suma))}) cubren todo el saldo (${importe(c.pendienteCentimos)} ${c.moneda}): no es una conciliación parcial. Usa la conciliación normal.`);
    }
    return;
  }
  // Con pagos previos en divisa el saldo ya arrastra el redondeo de Holded: se compara dentro del margen; en cualquier otro caso, exacto.
  if (esDivisaExtranjera(c) && c.pagos.length > 0) {
    const margen = margenResiduoCentimos(c.totalCentimos);
    if (Math.abs(Number(suma) - c.pendienteCentimos) > margen) {
      throw new Error(`La suma (${importe(Number(suma))}) no coincide con el saldo pendiente (${importe(c.pendienteCentimos)} ${c.moneda}) ni dentro del margen de redondeo.`);
    }
    return;
  }
  if (suma !== BigInt(c.pendienteCentimos)) {
    throw new Error(`La suma (${importe(Number(suma))}) debe coincidir exactamente con el saldo pendiente (${importe(c.pendienteCentimos)} ${c.moneda}).`);
  }
}
export function reservaActiva(p: PlanConciliacion, ahora = Date.now()): boolean {
  if (p.estado === "cancelado" || p.estado === "rechazado") return false;
  // Un plan completado y verificado ya no reserva nada: sus cargos están conciliados (no se pueden reutilizar) y una
  // compra parcial debe poder completarse después con otro plan.
  if (p.estado === "completado") return false;
  return p.estado !== "propuesto" || ahora - p.creadoEn <= TTL_PLAN;
}
export function resumenPlan(p: PlanConciliacion): string {
  const hechos = p.movimientos.filter((m) => p.verificados.includes(claveMovimiento(m)));
  const restantes = p.movimientos.filter((m) => !p.verificados.includes(claveMovimiento(m)));
  const linea = (m: MovimientoExacto, i: number) => `${i + 1}. ${m.fecha} | ${importe(m.centimos)} ${m.moneda} | ${m.cuenta}\n${m.descripcion}\n[${claveMovimiento(m)}]`;
  const suma = restantes.reduce((t, m) => t - m.centimos, 0);
  const diferencia = suma - p.compra.pendienteCentimos;
  return `Conciliación múltiple — ${p.empresa}\nProveedor: ${p.compra.proveedor}\n` +
    `Compra ${p.compra.numero || "sin número"} [${p.compra.id}] — ${p.compra.fecha}\n` +
    `Cuenta contable: ${p.compra.cuentasContables.join(", ")}\nTotal: ${importe(p.compra.totalCentimos)} ${p.compra.moneda}; pagado: ${importe(p.compra.pagadoCentimos)} ${p.compra.moneda}\n` +
    `Saldo a conciliar: ${importe(p.compra.pendienteCentimos)} ${p.compra.moneda}\n\n` +
    (hechos.length ? `Ya conciliados y verificados en Holded:\n${hechos.map(linea).join("\n")}\n\nPor conciliar ahora:\n` : "") +
    restantes.map(linea).join("\n") +
    (p.parcial ? `\n\nCONCILIACIÓN PARCIAL: se concilian ${importe(suma)} ${p.compra.moneda} y quedan ${importe(p.compra.pendienteCentimos - suma)} ${p.compra.moneda} ABIERTOS a propósito, a la espera de su cargo.` : "") +
    `\n\nSuma de cargos: ${importe(suma)} ${p.compra.moneda}. Diferencia: ${importe(diferencia)} ${p.compra.moneda}` +
    (esDivisaExtranjera(p.compra) && diferencia !== 0 ? " (redondeo de Holded al convertir a EUR; se cierra con el ajuste de cambio)" : "") +
    (esDivisaExtranjera(p.compra) ? `.\nCada pago se verifica contra su equivalente en EUR (${restantes.map((m) => importe(m.contableCentimos ?? 0)).join(" + ")} EUR).` : ".") +
    `\nMotivo: ${p.motivo}\nPlan: ${p.id}`;
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

