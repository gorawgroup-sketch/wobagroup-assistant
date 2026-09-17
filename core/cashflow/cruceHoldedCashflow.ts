import { createHash } from "node:crypto";
import { fetchDetalleRegistros, obtenerUltimaVerificacionEstructura, type DetalleRegistro } from "../google/cashflowSheet";
import {
  listBankMovements,
  listTreasuryAccounts,
  type BankMovement,
  type TreasuryAccount,
} from "../holded/client";
import { obtenerComprasDelDia, type CompraDelDia } from "../holded/write";
import { montosCercanos } from "../utils/montos";
import { palabrasDe, palabrasParecidas } from "../utils/textoParecido";

export type EmpresaCashflowCruce = "WOBA" | "EWORKS";
export type TipoMovimientoCruce = "ingreso" | "gasto";

const CATEGORIAS_EJECUCION = new Set([
  "INGRESOS",
  "PAGOS_PROYECTOS",
  "PAGOS_EXTRAS",
  "GASTOS_FIJOS",
  "GASTOS_CONSULTORES_MES_ACTUAL",
  "GASTOS_CONSULTORES_PROXIMO_MES",
  "IMPUESTOS_POR_PAGAR",
  "APLAZAMIENTO_IMPUESTOS",
]);

const RE_CONVERSION_MONEDA = /^converted\s+\S+\s+to\s+\S+/i;
const RE_CUENTA_PROPIA = /business\s+atelier\s+europa/i;
const PALABRAS_GENERICAS_CRUCE = new Set([
  "pago", "pagos", "compra", "compras", "gasto", "gastos", "factura", "recibo",
  "hotel", "viaje", "viajes", "pending", "pendiente", "trip", "servicio", "servicios",
  "cuota", "cuotas", "tarjeta", "card", "debit", "credit", "banco", "bank", "transfer",
  "transferencia", "online", "merchant", "main", "expense", "expenses", "restaurante",
  "restaurant", "taxi", "fijo", "fijos", "mensual", "septiembre",
]);

export interface FilaCashflowCruce {
  id: string;
  empresa?: EmpresaCashflowCruce;
  fila?: number;
  categoria: string;
  descripcion: string;
  semana: string;
  valorEur: number;
  tipo: TipoMovimientoCruce;
}

export interface MovimientoHoldedCruce {
  id: string;
  empresa: EmpresaCashflowCruce;
  accountId: string;
  cuenta: string;
  descripcion: string;
  fecha: string;
  valorEur: number;
  valorNativo: number;
  moneda: string;
  estado?: string;
  enPeriodo: boolean;
  toleranciaEur: number;
}

export interface CoincidenciaCashflowHolded {
  fila: FilaCashflowCruce;
  /** Primer movimiento, conservado para consumidores anteriores. */
  movimiento: MovimientoHoldedCruce;
  /** Uno normalmente; varios cuando el cashflow consolida cargos iguales. */
  movimientos: MovimientoHoldedCruce[];
  criterio: "proveedor_importe_fecha" | "importe_fecha_unico" | "proveedor_total_agrupado";
}

export interface AmbiguedadCashflowHolded {
  fila?: FilaCashflowCruce;
  movimiento?: MovimientoHoldedCruce;
  alternativas: string[];
  motivo: string;
}

export interface ResultadoCruceCashflowHolded {
  empresa: EmpresaCashflowCruce;
  semana: string;
  desde: string;
  hasta: string;
  desdeBancos: string;
  hastaBancos: string;
  coincidencias: CoincidenciaCashflowHolded[];
  filasSinMovimiento: FilaCashflowCruce[];
  movimientosSinCashflow: MovimientoHoldedCruce[];
  ambiguos: AmbiguedadCashflowHolded[];
  filasSinEmpresa: FilaCashflowCruce[];
  problemasCobertura: string[];
}

export interface ResultadoCruceCashflowGastosHolded {
  empresa: EmpresaCashflowCruce;
  semana: string;
  desde: string;
  hasta: string;
  coincidencias: CoincidenciaCashflowHolded[];
  filasSinGastoHolded: FilaCashflowCruce[];
  gastosHoldedSinCashflow: MovimientoHoldedCruce[];
  ambiguos: AmbiguedadCashflowHolded[];
  filasSinEmpresa: FilaCashflowCruce[];
  gastosNoComparables: CompraDelDia[];
  problemasCobertura: string[];
}

export interface AtribucionFilaSinEmpresa {
  fila: FilaCashflowCruce;
  movimiento: MovimientoHoldedCruce;
  empresa: EmpresaCashflowCruce;
  criterio: "proveedor_importe_unico" | "importe_unico_global";
}

export interface ResolucionFilasSinEmpresa {
  atribuciones: AtribucionFilaSinEmpresa[];
  filasSinResolver: FilaCashflowCruce[];
  movimientosResueltos: Set<string>;
}

function claveMovimientoLocal(movimiento: MovimientoHoldedCruce): string {
  return `${movimiento.accountId}:${movimiento.id}`;
}

export function claveMovimientoGlobal(movimiento: MovimientoHoldedCruce): string {
  return `${movimiento.empresa}:${claveMovimientoLocal(movimiento)}`;
}

/**
 * Dependencias de lectura inyectables para probar el recorrido completo sin tocar Sheets ni Holded.
 * Producción usa las implementaciones reales; los tests pueden reproducir snapshots omitidos o
 * cuentas archivadas de forma determinista.
 */
export interface FuentesCruceCashflowHolded {
  fetchDetalleRegistros: typeof fetchDetalleRegistros;
  obtenerUltimaVerificacionEstructura: typeof obtenerUltimaVerificacionEstructura;
  listTreasuryAccounts: typeof listTreasuryAccounts;
  listBankMovements: typeof listBankMovements;
}

export interface OpcionesCruceCashflowHolded {
  /** Relee residuos antes de afirmar cashflow→banco. Se omite en consultas exclusivas banco→cashflow. */
  confirmarAusencias?: boolean;
}

const FUENTES_CRUCE_REALES: FuentesCruceCashflowHolded = {
  fetchDetalleRegistros,
  obtenerUltimaVerificacionEstructura,
  listTreasuryAccounts,
  listBankMovements,
};

interface Arista {
  fila: FilaCashflowCruce;
  movimiento: MovimientoHoldedCruce;
  puntaje: number;
  textoFuerte: boolean;
}

interface GrupoMovimientos {
  id: string;
  movimientos: MovimientoHoldedCruce[];
  totalAbs: number;
  descripcion: string;
  empresa: EmpresaCashflowCruce;
  tipo: TipoMovimientoCruce;
  toleranciaEur: number;
}

export function parsearImporteCashflow(valor: string): number {
  const original = String(valor ?? "").trim();
  if (!original) return 0;
  const negativoPorParentesis = /^\(.*\)$/.test(original);
  let limpio = original.replace(/[^0-9,.-]/g, "").replace(/-/g, "");
  const ultimoPunto = limpio.lastIndexOf(".");
  const ultimaComa = limpio.lastIndexOf(",");

  if (ultimoPunto >= 0 && ultimaComa >= 0) {
    const decimal = ultimoPunto > ultimaComa ? "." : ",";
    const miles = decimal === "." ? "," : ".";
    limpio = limpio.split(miles).join("");
    if (decimal === ",") limpio = limpio.replace(",", ".");
  } else if (ultimaComa >= 0) {
    const decimales = limpio.length - ultimaComa - 1;
    limpio = decimales > 0 && decimales <= 2 ? limpio.replace(",", ".") : limpio.replace(/,/g, "");
  } else if (ultimoPunto >= 0) {
    const decimales = limpio.length - ultimoPunto - 1;
    if (decimales === 3 && /^\d{1,3}(?:\.\d{3})+$/.test(limpio)) limpio = limpio.replace(/\./g, "");
  }

  const numero = Number(limpio);
  if (!Number.isFinite(numero)) return 0;
  return negativoPorParentesis || original.includes("-") ? -numero : numero;
}

function valorEnEuros(movimiento: BankMovement, monedaCuenta?: string): number | undefined {
  const moneda = String(movimiento.currency ?? monedaCuenta ?? "EUR").toUpperCase();
  // Nunca se puede asumir que 1 USD/GBP/... equivale a 1 EUR. Para divisa extranjera Holded debe
  // entregar el importe contable convertido; si no lo hace, el informe completo queda bloqueado.
  if (moneda !== "EUR") {
    if (movimiento.accounting_amount == null) return undefined;
    if (movimiento.accounting_currency && String(movimiento.accounting_currency).toUpperCase() !== "EUR") {
      return undefined;
    }
    const contable = Number(movimiento.accounting_amount);
    return Number.isFinite(contable) ? contable : undefined;
  }
  const importe = Number(movimiento.amount ?? 0);
  return Number.isFinite(importe) ? importe : undefined;
}

function idSinteticoMovimiento(
  cuentaId: string,
  movimiento: BankMovement,
  descripcion: string,
  fecha: string,
  moneda: string,
  ocurrencias: Map<string, number>
): string {
  const base = [
    cuentaId,
    fecha,
    moneda,
    String(movimiento.amount ?? ""),
    String(movimiento.accounting_amount ?? ""),
    normalizarTexto(descripcion),
    String(movimiento.status ?? ""),
  ].join("|");
  const numero = (ocurrencias.get(base) ?? 0) + 1;
  ocurrencias.set(base, numero);
  // El ordinal preserva cargos idénticos reales; la huella estable evita duplicarlos si Holded cambia
  // el orden entre la primera y la segunda lectura.
  return `synthetic:${createHash("sha256").update(base).digest("hex").slice(0, 20)}:${numero}`;
}

function fechaIso(valor: string | undefined): string {
  return String(valor ?? "").slice(0, 10);
}

function desplazarFecha(fecha: string, dias: number): string {
  const valor = new Date(`${fecha}T12:00:00Z`);
  valor.setUTCDate(valor.getUTCDate() + dias);
  return valor.toISOString().slice(0, 10);
}

function normalizarTexto(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function puntajeTexto(fila: string, banco: string): number {
  const a = normalizarTexto(fila);
  const b = normalizarTexto(banco);
  if (!a || !b) return 0;
  const palabrasA = palabrasDe(a, 4).filter(
    (palabra) => !PALABRAS_GENERICAS_CRUCE.has(palabra) && !/^\d+$/.test(palabra)
  );
  const palabrasB = palabrasDe(b, 4).filter(
    (palabra) => !PALABRAS_GENERICAS_CRUCE.has(palabra) && !/^\d+$/.test(palabra)
  );
  const coincidencias = palabrasA.filter((pa) => palabrasB.some((pb) => palabrasParecidas(pa, pb))).length;
  // Una frase genérica idéntica ("pago", "hotel", "viaje") no identifica al proveedor. Exactitud y
  // contención solo son evidencia fuerte cuando comparten al menos un token distintivo.
  if (coincidencias > 0 && a === b) return 60;
  if (coincidencias > 0 && a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return 45;
  if (coincidencias >= 2) return 35 + Math.min(coincidencias, 5);
  if (coincidencias === 1) return 20;
  return 0;
}

function construirAristas(filas: FilaCashflowCruce[], movimientos: MovimientoHoldedCruce[]): Arista[] {
  const aristas: Arista[] = [];
  for (const fila of filas) {
    for (const movimiento of movimientos) {
      if (fila.empresa !== movimiento.empresa || fila.tipo !== (movimiento.valorEur > 0 ? "ingreso" : "gasto")) continue;
      if (!montosCercanos(Math.abs(fila.valorEur), Math.abs(movimiento.valorEur), movimiento.toleranciaEur)) continue;
      const texto = puntajeTexto(fila.descripcion, movimiento.descripcion);
      aristas.push({
        fila,
        movimiento,
        puntaje: texto + (movimiento.enPeriodo ? 10 : 5),
        textoFuerte: texto >= 20,
      });
    }
  }
  return aristas;
}

function construirGruposMovimientos(movimientos: MovimientoHoldedCruce[]): GrupoMovimientos[] {
  const grupos = new Map<string, MovimientoHoldedCruce[]>();
  for (const movimiento of movimientos) {
    const tipo: TipoMovimientoCruce = movimiento.valorEur > 0 ? "ingreso" : "gasto";
    const clave = `${movimiento.empresa}|${tipo}|${normalizarTexto(movimiento.descripcion)}`;
    const grupo = grupos.get(clave);
    if (grupo) grupo.push(movimiento);
    else grupos.set(clave, [movimiento]);
  }

  return [...grupos.entries()]
    .filter(([, grupo]) => grupo.length > 1)
    .map(([id, grupo]) => ({
      id,
      movimientos: grupo,
      totalAbs: grupo.reduce((total, movimiento) => total + Math.abs(movimiento.valorEur), 0),
      descripcion: grupo[0].descripcion,
      empresa: grupo[0].empresa,
      tipo: grupo[0].valorEur > 0 ? "ingreso" : "gasto",
      toleranciaEur: Math.max(...grupo.map((movimiento) => movimiento.toleranciaEur)),
    }));
}

/**
 * Asigna filas y movimientos uno a uno. Una coincidencia solo se acepta si
 * es la mejor alternativa inequívoca en ambos sentidos. Los empates quedan
 * visibles como ambiguos; nunca se resuelven por orden de paginación.
 */
export function cruzarListasUnoAUno(
  filas: FilaCashflowCruce[],
  movimientos: MovimientoHoldedCruce[]
): Pick<ResultadoCruceCashflowHolded, "coincidencias" | "filasSinMovimiento" | "movimientosSinCashflow" | "ambiguos"> {
  let pendientesFilas = [...filas];
  let pendientesMovimientos = [...movimientos];
  const coincidencias: CoincidenciaCashflowHolded[] = [];
  const ambiguos: AmbiguedadCashflowHolded[] = [];

  while (true) {
    const aristas = construirAristas(pendientesFilas, pendientesMovimientos);
    const aceptadas: Arista[] = [];

    for (const arista of aristas) {
      const deFila = aristas.filter((a) => a.fila.id === arista.fila.id).sort((a, b) => b.puntaje - a.puntaje);
      const claveArista = claveMovimientoLocal(arista.movimiento);
      const deMovimiento = aristas.filter((a) => claveMovimientoLocal(a.movimiento) === claveArista).sort((a, b) => b.puntaje - a.puntaje);
      const mejorFilaUnico =
        (deFila[0]?.movimiento ? claveMovimientoLocal(deFila[0].movimiento) : "") === claveArista &&
        deFila[1]?.puntaje !== arista.puntaje;
      const mejorMovimientoUnico = deMovimiento[0]?.fila.id === arista.fila.id && deMovimiento[1]?.puntaje !== arista.puntaje;
      // Un importe único NO identifica por sí solo a un proveedor. El caso real S37 demostró que
      // hacerlo oculta errores cuando hay importes iguales en empresas/cuentas distintas. Sin
      // evidencia textual suficiente se conserva como ambiguo, nunca como coincidencia confirmada.
      if (mejorFilaUnico && mejorMovimientoUnico && arista.textoFuerte) aceptadas.push(arista);
    }

    if (aceptadas.length === 0) break;
    const filasUsadas = new Set<string>();
    const movimientosUsados = new Set<string>();
    for (const arista of aceptadas.sort((a, b) => b.puntaje - a.puntaje)) {
      const clave = claveMovimientoLocal(arista.movimiento);
      if (filasUsadas.has(arista.fila.id) || movimientosUsados.has(clave)) continue;
      filasUsadas.add(arista.fila.id);
      movimientosUsados.add(clave);
      coincidencias.push({
        fila: arista.fila,
        movimiento: arista.movimiento,
        movimientos: [arista.movimiento],
        criterio: arista.textoFuerte ? "proveedor_importe_fecha" : "importe_fecha_unico",
      });
    }
    pendientesFilas = pendientesFilas.filter((fila) => !filasUsadas.has(fila.id));
    pendientesMovimientos = pendientesMovimientos.filter((movimiento) => !movimientosUsados.has(claveMovimientoLocal(movimiento)));
  }

  // Algunos proveedores (por ejemplo, varias compras de Amazon) se
  // consolidan en una sola fila del cashflow. Solo aceptamos el total si el
  // proveedor es coherente y la combinación grupo↔fila es inequívoca en
  // ambos sentidos. No se prueban combinaciones arbitrarias: eso sería
  // costoso y podría fabricar coincidencias por casualidad.
  while (true) {
    const grupos = construirGruposMovimientos(pendientesMovimientos);
    const candidatos = grupos.flatMap((grupo) =>
      pendientesFilas
        .filter(
          (fila) =>
            fila.empresa === grupo.empresa &&
            fila.tipo === grupo.tipo &&
            montosCercanos(Math.abs(fila.valorEur), grupo.totalAbs, grupo.toleranciaEur) &&
            puntajeTexto(fila.descripcion, grupo.descripcion) >= 20
        )
        .map((fila) => ({ grupo, fila }))
    );

    const aceptada = candidatos.find(({ grupo, fila }) => {
      const filasDelGrupo = candidatos.filter((c) => c.grupo.id === grupo.id);
      const gruposDeFila = candidatos.filter((c) => c.fila.id === fila.id);
      return filasDelGrupo.length === 1 && gruposDeFila.length === 1;
    });
    if (!aceptada) break;

    coincidencias.push({
      fila: aceptada.fila,
      movimiento: aceptada.grupo.movimientos[0],
      movimientos: aceptada.grupo.movimientos,
      criterio: "proveedor_total_agrupado",
    });
    const idsGrupo = new Set(aceptada.grupo.movimientos.map(claveMovimientoLocal));
    pendientesFilas = pendientesFilas.filter((fila) => fila.id !== aceptada.fila.id);
    pendientesMovimientos = pendientesMovimientos.filter((movimiento) => !idsGrupo.has(claveMovimientoLocal(movimiento)));
  }

  const aristasRestantes = construirAristas(pendientesFilas, pendientesMovimientos);
  const gruposRestantes = construirGruposMovimientos(pendientesMovimientos);
  const candidatosGrupoRestantes = gruposRestantes.flatMap((grupo) =>
    pendientesFilas
      .filter(
        (fila) =>
          fila.empresa === grupo.empresa &&
          fila.tipo === grupo.tipo &&
          montosCercanos(Math.abs(fila.valorEur), grupo.totalAbs, grupo.toleranciaEur) &&
          puntajeTexto(fila.descripcion, grupo.descripcion) >= 20
      )
      .map((fila) => ({ grupo, fila }))
  );
  const filasAmbiguas = new Set([
    ...aristasRestantes.map((a) => a.fila.id),
    ...candidatosGrupoRestantes.map((c) => c.fila.id),
  ]);
  const movimientosAmbiguos = new Set([
    ...aristasRestantes.map((a) => claveMovimientoLocal(a.movimiento)),
    ...candidatosGrupoRestantes.flatMap((c) => c.grupo.movimientos.map(claveMovimientoLocal)),
  ]);

  for (const fila of pendientesFilas.filter((f) => filasAmbiguas.has(f.id))) {
    ambiguos.push({
      fila,
      alternativas: [
        ...aristasRestantes.filter((a) => a.fila.id === fila.id).map((a) => claveMovimientoLocal(a.movimiento)),
        ...candidatosGrupoRestantes
          .filter((c) => c.fila.id === fila.id)
          .map((c) => c.grupo.movimientos.map(claveMovimientoLocal).join("+")),
      ],
      motivo: "Hay más de un movimiento compatible o la evidencia de proveedor no permite elegir uno sin riesgo.",
    });
  }
  const movimientosYaExplicados = new Set(
    ambiguos.flatMap((caso) => (caso.fila ? caso.alternativas.flatMap((alternativa) => alternativa.split("+")) : []))
  );
  for (const movimiento of pendientesMovimientos.filter(
    (m) => movimientosAmbiguos.has(claveMovimientoLocal(m)) && !movimientosYaExplicados.has(claveMovimientoLocal(m)) && m.enPeriodo
  )) {
    ambiguos.push({
      movimiento,
      alternativas: aristasRestantes
        .filter((a) => claveMovimientoLocal(a.movimiento) === claveMovimientoLocal(movimiento))
        .map((a) => a.fila.id),
      motivo: "Hay más de una fila compatible o la evidencia del cashflow no permite elegir una sin riesgo.",
    });
  }

  return {
    coincidencias,
    filasSinMovimiento: pendientesFilas.filter((fila) => !filasAmbiguas.has(fila.id)),
    movimientosSinCashflow: pendientesMovimientos.filter(
      (movimiento) => movimiento.enPeriodo && !movimientosAmbiguos.has(claveMovimientoLocal(movimiento))
    ),
    ambiguos,
  };
}

/**
 * Resuelve filas antiguas sin EMPRESA únicamente con evidencia bancaria
 * global de WOBA y EWORKS. La decisión se toma sobre ambas empresas a la
 * vez: una coincidencia por monto en WOBA no es "única" si también existe
 * una candidata en EWORKS. Así el vacío histórico no vuelve a duplicarse ni
 * queda permanentemente inutilizable cuando el banco sí demuestra su dueño.
 */
export function resolverFilasSinEmpresaGlobal(
  resultados: Array<Pick<ResultadoCruceCashflowHolded, "filasSinEmpresa" | "ambiguos">>
): ResolucionFilasSinEmpresa {
  const filasPorId = new Map<string, FilaCashflowCruce>();
  for (const resultado of resultados) {
    for (const fila of resultado.filasSinEmpresa) filasPorId.set(fila.id, fila);
  }
  let filas = [...filasPorId.values()];

  const movimientosPorId = new Map<string, MovimientoHoldedCruce>();
  for (const resultado of resultados) {
    for (const caso of resultado.ambiguos) {
      if (!caso.movimiento || !caso.motivo.includes("no tiene EMPRESA")) continue;
      movimientosPorId.set(claveMovimientoGlobal(caso.movimiento), caso.movimiento);
    }
  }
  let movimientos = [...movimientosPorId.values()];
  const atribuciones: AtribucionFilaSinEmpresa[] = [];

  while (true) {
    const aristas = filas.flatMap((fila) =>
      movimientos
        .filter(
          (movimiento) =>
            fila.tipo === (movimiento.valorEur > 0 ? "ingreso" : "gasto") &&
            montosCercanos(Math.abs(fila.valorEur), Math.abs(movimiento.valorEur), movimiento.toleranciaEur)
        )
        .map((movimiento) => {
          const texto = puntajeTexto(fila.descripcion, movimiento.descripcion);
          return { fila, movimiento, texto, puntaje: texto + (movimiento.enPeriodo ? 10 : 5) };
        })
    );

    const aceptada = aristas.find((arista) => {
      const deFila = aristas.filter((item) => item.fila.id === arista.fila.id).sort((a, b) => b.puntaje - a.puntaje);
      const claveMovimiento = claveMovimientoGlobal(arista.movimiento);
      const deMovimiento = aristas
        .filter((item) => claveMovimientoGlobal(item.movimiento) === claveMovimiento)
        .sort((a, b) => b.puntaje - a.puntaje);
      const mejorFilaUnico =
        (deFila[0]?.movimiento ? claveMovimientoGlobal(deFila[0].movimiento) : "") === claveMovimiento &&
        deFila[1]?.puntaje !== arista.puntaje;
      const mejorMovimientoUnico = deMovimiento[0]?.fila.id === arista.fila.id && deMovimiento[1]?.puntaje !== arista.puntaje;
      return mejorFilaUnico && mejorMovimientoUnico && arista.texto >= 20;
    });
    if (!aceptada) break;

    atribuciones.push({
      fila: aceptada.fila,
      movimiento: aceptada.movimiento,
      empresa: aceptada.movimiento.empresa,
      criterio: aceptada.texto >= 20 ? "proveedor_importe_unico" : "importe_unico_global",
    });
    filas = filas.filter((fila) => fila.id !== aceptada.fila.id);
    movimientos = movimientos.filter(
      (movimiento) =>
        claveMovimientoGlobal(movimiento) !== claveMovimientoGlobal(aceptada.movimiento)
    );
  }

  return {
    atribuciones,
    filasSinResolver: filas,
    movimientosResueltos: new Set(
      atribuciones.map(({ movimiento }) => claveMovimientoGlobal(movimiento))
    ),
  };
}

/**
 * Segundo eje del informe: documentos de gasto (/purchases) frente al
 * cashflow. Los documentos no EUR se separan porque su total nativo no se
 * puede comparar honestamente contra un cashflow en EUR sin una tasa o pago
 * enlazado; nunca se fuerza paridad 1:1.
 */
export async function generarCruceCashflowGastosHolded(
  empresa: EmpresaCashflowCruce,
  semana: string,
  desde: string,
  hasta: string
): Promise<ResultadoCruceCashflowGastosHolded> {
  const registros = await fetchDetalleRegistros();
  const problemasCobertura = obtenerUltimaVerificacionEstructura().map((p) => `[${p.bloque}] ${p.detalle}`);
  const filasSemana = registros
    .map(convertirFila)
    .filter(
      (fila): fila is FilaCashflowCruce =>
        fila !== null && fila.semana === semana.toUpperCase() && fila.tipo === "gasto"
    );
  const filasSinEmpresa = filasSemana.filter((fila) => fila.empresa === undefined);
  const filasEmpresa = filasSemana.filter((fila) => fila.empresa === empresa);
  const compras = await obtenerComprasDelDia(empresa, desde, hasta);
  if (compras.length >= 300) {
    problemasCobertura.push(
      `Holded alcanzó el límite de 300 gastos en ${empresa}; el informe de documentos no se declara completo.`
    );
  }

  const gastosNoComparables = compras.filter(
    (compra) => compra.moneda !== "EUR" || !Number.isFinite(compra.total) || compra.total === 0
  );
  const documentos: MovimientoHoldedCruce[] = compras
    .filter((compra) => compra.moneda === "EUR" && Number.isFinite(compra.total) && compra.total !== 0)
    .map((compra) => ({
      id: compra.id,
      empresa,
      accountId: "purchases",
      cuenta: "Gastos de Holded",
      descripcion: [compra.contactName, compra.descripcion, ...compra.nombresLinea].filter(Boolean).join(" · "),
      fecha: fechaIso(compra.fecha),
      valorEur: -Math.abs(compra.total),
      valorNativo: compra.total,
      moneda: compra.moneda,
      estado: compra.pagosPendiente > 0.01 ? "pendiente_pago" : "pagado",
      enPeriodo: true,
      toleranciaEur: 0.01,
    }));

  const cruce = cruzarListasUnoAUno(filasEmpresa, documentos);
  const documentosYaAsignados = new Set(cruce.coincidencias.flatMap((c) => c.movimientos.map(claveMovimientoLocal)));
  const documentosDisponibles = documentos.filter((documento) => !documentosYaAsignados.has(claveMovimientoLocal(documento)));
  const filasSinEmpresaComoCandidatas = filasSinEmpresa.map((fila) => ({ ...fila, empresa }));
  const aristasSinEmpresa = construirAristas(filasSinEmpresaComoCandidatas, documentosDisponibles);
  const documentosBloqueados = new Set(aristasSinEmpresa.map((arista) => claveMovimientoLocal(arista.movimiento)));
  const ambiguos = [
    ...cruce.ambiguos,
    ...documentosDisponibles
      .filter((documento) => documentosBloqueados.has(claveMovimientoLocal(documento)))
      .map((documento): AmbiguedadCashflowHolded => ({
        movimiento: documento,
        alternativas: aristasSinEmpresa
          .filter((arista) => claveMovimientoLocal(arista.movimiento) === claveMovimientoLocal(documento))
          .map((arista) => arista.fila.id),
        motivo:
          "El gasto puede corresponder a una fila del cashflow que no tiene EMPRESA; no se atribuye ni se declara ausente hasta completar o demostrar ese dato.",
      })),
  ];

  return {
    empresa,
    semana: semana.toUpperCase(),
    desde,
    hasta,
    coincidencias: cruce.coincidencias,
    filasSinGastoHolded: cruce.filasSinMovimiento,
    gastosHoldedSinCashflow: cruce.movimientosSinCashflow.filter(
      (documento) => !documentosBloqueados.has(claveMovimientoLocal(documento))
    ),
    ambiguos,
    filasSinEmpresa,
    gastosNoComparables,
    problemasCobertura,
  };
}

function convertirFila(registro: DetalleRegistro, indice: number): FilaCashflowCruce | null {
  if (!CATEGORIAS_EJECUCION.has(registro.categoria)) return null;
  const valor = parsearImporteCashflow(registro.valor);
  if (!Number.isFinite(valor) || valor === 0) return null;
  return {
    id: `${registro.categoria}:${registro.fila ?? indice}`,
    empresa: registro.empresa,
    fila: registro.fila,
    categoria: registro.categoria,
    descripcion: registro.concepto || registro.cliente || registro.proyecto || "(sin descripción)",
    semana: registro.semana.toUpperCase(),
    valorEur: Math.abs(valor),
    tipo: registro.categoria === "INGRESOS" ? "ingreso" : "gasto",
  };
}

function esMovimientoInterno(descripcion: string): boolean {
  return RE_CONVERSION_MONEDA.test(descripcion) || RE_CUENTA_PROPIA.test(descripcion);
}

export async function generarCruceCashflowHolded(
  empresa: EmpresaCashflowCruce,
  semana: string,
  desde: string,
  hasta: string,
  hoy = new Date(),
  fuentesParciales: Partial<FuentesCruceCashflowHolded> = {},
  opciones: OpcionesCruceCashflowHolded = {}
): Promise<ResultadoCruceCashflowHolded> {
  const fuentes: FuentesCruceCashflowHolded = { ...FUENTES_CRUCE_REALES, ...fuentesParciales };
  const registros = await fuentes.fetchDetalleRegistros();
  const problemasCobertura = fuentes
    .obtenerUltimaVerificacionEstructura()
    .map((p) => `[${p.bloque}] ${p.detalle}`);
  const filasSemana = registros
    .map(convertirFila)
    .filter((fila): fila is FilaCashflowCruce => fila !== null && fila.semana === semana.toUpperCase());
  const filasSinEmpresa = filasSemana.filter((fila) => fila.empresa === undefined);
  const filasEmpresa = filasSemana.filter((fila) => fila.empresa === empresa);

  const desdeBancos = desplazarFecha(desde, -2);
  const limiteConGracia = desplazarFecha(hasta, 3);
  const hoyIso = hoy.toISOString().slice(0, 10);
  const hastaBancos = limiteConGracia < hoyIso ? limiteConGracia : hoyIso;
  // Una cuenta archivada puede contener justamente el pago histórico que se está auditando. Excluirla
  // convierte un cambio administrativo posterior en un falso "no salió del banco". Se consultan todas
  // las cuentas devueltas por Holded; solo se descartan entradas sin id, que no son consultables.
  let cuentas: TreasuryAccount[] = [];
  let falloListadoCuentas = false;
  try {
    cuentas = (await fuentes.listTreasuryAccounts(empresa)).filter(
      (cuenta): cuenta is TreasuryAccount => typeof cuenta.id === "string" && cuenta.id.trim().length > 0
    );
  } catch (error) {
    falloListadoCuentas = true;
    const detalle = error instanceof Error ? error.message : String(error);
    problemasCobertura.push(`Falló la lectura de cuentas de tesorería de ${empresa}: ${detalle}`);
  }
  if (cuentas.length === 0 && !falloListadoCuentas) {
    problemasCobertura.push(
      `Holded no devolvió ninguna cuenta de tesorería para ${empresa}; no se puede afirmar que falte una salida bancaria.`
    );
  }

  const leerSnapshot = async (): Promise<MovimientoHoldedCruce[]> => {
    const snapshot: MovimientoHoldedCruce[] = [];
    for (const cuenta of cuentas) {
      let leidos: BankMovement[];
      try {
        leidos = await fuentes.listBankMovements(empresa, cuenta.id, desdeBancos, hastaBancos);
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        problemasCobertura.push(
          `Falló la lectura de la cuenta ${cuenta.name ?? cuenta.id} (${cuenta.id}): ${detalle}`
        );
        continue;
      }
      const ocurrenciasSinId = new Map<string, number>();
      let noComparablesPorDivisa = 0;
      if (leidos.length >= 200) {
        problemasCobertura.push(
          `La cuenta ${cuenta.name ?? cuenta.id} devolvió 200 movimientos; Holded pudo truncar la consulta y el informe no se declara completo.`
        );
      }
      leidos.forEach((movimiento) => {
        const descripcion = movimiento.description ?? "(sin descripción)";
        if (esMovimientoInterno(descripcion)) return;
        const moneda = String(movimiento.currency ?? cuenta.currency ?? "EUR").toUpperCase();
        const valorEur = valorEnEuros(movimiento, cuenta.currency);
        if (valorEur === undefined) {
          noComparablesPorDivisa += 1;
          return;
        }
        if (valorEur === 0) return;
        const fecha = fechaIso(movimiento.booking_date);
        snapshot.push({
          id:
            movimiento.id ||
            idSinteticoMovimiento(cuenta.id, movimiento, descripcion, fecha, moneda, ocurrenciasSinId),
          empresa,
          accountId: cuenta.id,
          cuenta: cuenta.name ?? cuenta.id,
          descripcion,
          fecha,
          valorEur,
          valorNativo: Number(movimiento.amount ?? 0),
          moneda,
          estado: movimiento.status,
          enPeriodo: fecha >= desde && fecha <= hasta,
          toleranciaEur: moneda === "EUR" ? 0.01 : 0.05,
        });
      });
      if (noComparablesPorDivisa > 0) {
        problemasCobertura.push(
          `${noComparablesPorDivisa} movimiento(s) en divisa extranjera de ${cuenta.name ?? cuenta.id} no traen importe contable en EUR; no se emiten conclusiones de ausencia.`
        );
      }
    }
    return snapshot;
  };

  const primerSnapshot = await leerSnapshot();
  let movimientos = primerSnapshot;
  let cruce = cruzarListasUnoAUno(filasEmpresa, movimientos);

  // Una ausencia es una conclusión negativa y exige más evidencia que una coincidencia positiva.
  // Solo si el primer snapshot deja residuos hacemos una segunda lectura fresca (costo bajo y acotado).
  // Un movimiento visto en cualquiera de las dos lecturas existe; unir ambos snapshots evita que una
  // omisión transitoria de Holded vuelva a convertirse en un falso impago. Si la validación falla, el
  // informe queda INCOMPLETO y el formateador se niega a emitir conclusiones de ausencia.
  if (
    (opciones.confirmarAusencias ?? true) &&
    cruce.filasSinMovimiento.length > 0 &&
    cuentas.length > 0 &&
    problemasCobertura.length === 0
  ) {
    try {
      const segundoSnapshot = await leerSnapshot();
      const porId = new Map<string, MovimientoHoldedCruce>();
      for (const movimiento of [...primerSnapshot, ...segundoSnapshot]) {
        porId.set(`${movimiento.accountId}:${movimiento.id}`, movimiento);
      }
      movimientos = [...porId.values()];
      cruce = cruzarListasUnoAUno(filasEmpresa, movimientos);
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      problemasCobertura.push(
        `Falló la segunda lectura obligatoria para confirmar ausencias en ${empresa}: ${detalle}`
      );
    }
  }

  // Una fila antigua sin EMPRESA no prueba pertenencia a ninguna compañía,
  // pero tampoco puede ignorarse y convertir su cargo compatible en un falso
  // "falta registrar". Esos casos se retiran de las afirmaciones definitivas y
  // se publican como ambiguos hasta completar la empresa en el cashflow.
  const movimientosYaAsignados = new Set(cruce.coincidencias.flatMap((c) => c.movimientos.map(claveMovimientoLocal)));
  const movimientosDisponibles = movimientos.filter((m) => !movimientosYaAsignados.has(claveMovimientoLocal(m)));
  const filasSinEmpresaComoCandidatas = filasSinEmpresa.map((fila) => ({ ...fila, empresa }));
  const aristasSinEmpresa = construirAristas(filasSinEmpresaComoCandidatas, movimientosDisponibles);
  const movimientosBloqueados = new Set(aristasSinEmpresa.map((a) => claveMovimientoLocal(a.movimiento)));
  const ambiguos = [
    ...cruce.ambiguos,
    ...movimientosDisponibles
      .filter((movimiento) => movimiento.enPeriodo && movimientosBloqueados.has(claveMovimientoLocal(movimiento)))
      .map((movimiento): AmbiguedadCashflowHolded => ({
        movimiento,
        alternativas: aristasSinEmpresa
          .filter((a) => claveMovimientoLocal(a.movimiento) === claveMovimientoLocal(movimiento))
          .map((a) => a.fila.id),
        motivo: "El importe puede corresponder a una fila del cashflow que no tiene EMPRESA; no se atribuye ni se declara ausente hasta completar ese dato.",
      })),
  ];

  return {
    empresa,
    semana: semana.toUpperCase(),
    desde,
    hasta,
    desdeBancos,
    hastaBancos,
    ...cruce,
    movimientosSinCashflow: cruce.movimientosSinCashflow.filter((m) => !movimientosBloqueados.has(claveMovimientoLocal(m))),
    ambiguos,
    filasSinEmpresa,
    problemasCobertura,
  };
}
