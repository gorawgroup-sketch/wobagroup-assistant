/**
 * Vigilante de Seguros — mantiene al día, solo, la situación de las pólizas de WOBA, EWORKS y Footprint.
 *
 * Cada revisión (a diario y a petición en el chat):
 *  1. Lee el banco de Holded (solo lectura, 45 días, todas las cuentas) y el buzón del asistente (solo lectura).
 *  2. Cruza los pagos pendientes del registro con el banco y los da por pagados SOLO con prueba sólida
 *     (ver cruces.ts y cadena.ts: importe exacto, contraparte reconocida y cargo que el saldo del banco refleja).
 *  3. Sigue mirando los pagos recién confirmados por si el banco los devuelve (lo que ha ido fallando en WOBA).
 *  4. Avisa de cargos a aseguradoras que el registro no explica y de correos nuevos de aseguradoras/corredurías.
 *  5. Escribe en el registro lo confirmado (con la prueba en `notas`), refresca Cerebro y devuelve el informe.
 *
 * Lo que NUNCA hace: mover dinero, escribir en Holded, contestar correos ni decidir por Carlos. Una lectura que
 * falla no es un dato: si no pudo leer algo, lo dice en vez de concluir que «no hay nada».
 */
import { formatDateLocal } from "../../utils/dateFormat";
import type { PolizaConFila } from "../polizaRegistroSheet";
import type { Poliza } from "../types";
import { analizarCuentas, claveDeCuenta } from "./cadena";
import type { CorreoSeguro, FuentesCorreo } from "./correos";
import { leerCorreosDeSeguros } from "./correos";
import {
  confirmarPagos,
  detectarCargosAnomalos,
  detectarDevoluciones,
  pagosVigilados,
  type CargoAnomalo,
  type EvaluadorLiquidacion,
  type PagoConfirmado,
  type PagoEnTransito,
} from "./cruces";
import type { EntradaEstado } from "./estadoStore";
import { diasEntre, restarDias } from "./fechas";
import {
  construirInforme,
  construirRespuestaChat,
  describirMovimiento,
  etiquetaPoliza,
  type ContenidoInforme,
  type DevolucionDetectada,
  type Informe,
} from "./informe";
import type { LecturaBancaria } from "./lecturaBancaria";

export const DIAS_BANCO = 45;
export const DIAS_CORREO = 7;
const DIAS_CONSERVAR_CORREOS_VISTOS = 60;
const DIAS_FALLO_PERSISTENTE = 2;

export interface FuentesVigilante {
  ahora(): Date;
  listarPolizas(): Promise<PolizaConFila[]>;
  actualizarPoliza(rowIndex: number, poliza: Poliza): Promise<void>;
  leerBanco(desde: string, hasta: string): Promise<LecturaBancaria>;
  /** null si el correo no está configurado: se avisa en la revisión y se sigue con el banco. */
  correo: FuentesCorreo | null;
  leerEstado(): Promise<Map<string, EntradaEstado>>;
  guardarEstado(pares: Array<{ id: string; version: string }>): Promise<void>;
  borrarEstado(ids: string[]): Promise<void>;
  purgarCorreosVistos(fechaLimite: string): Promise<number>;
  invalidarCerebro(): void;
}

export interface ResultadoVigilante {
  hoy: string;
  /** Solo lo NUEVO desde la última revisión (lo que va a Telegram). */
  contenido: ContenidoInforme;
  /** Informe para Telegram (solo lo nuevo); null si no hay nada que contar. */
  informe: Informe | null;
  /**
   * La situación completa de ahora mismo (lo que sigue en tránsito, los cargos que siguen sin encajar, los últimos
   * correos), no solo lo nuevo: es lo que cuentan el chat y el panel de Cerebro.
   */
  situacion: ContenidoInforme;
  /** Respuesta para el chat: la situación completa de ahora mismo, no solo lo nuevo (siempre responde). */
  respuestaChat: string;
  /** Lo que hay que marcar como ya avisado en cuanto el informe se entregue. */
  clavesAvisadas: Array<{ id: string; version: string }>;
  /** Informe anterior que no llegó a entregarse y hay que reenviar primero. */
  pendienteEnvio: Informe | null;
  escribioRegistro: boolean;
}

// ---------------------------------------------------------------------------------------------------------------

const camposPoliza = (p: PolizaConFila): Poliza => {
  const { rowIndex: _rowIndex, ...poliza } = p;
  return poliza;
};

function conFuenteBanco(fuente: string): string {
  return fuente.split("+").includes("banco") ? fuente : [fuente, "banco"].filter(Boolean).join("+");
}

function notaConfirmacion(c: PagoConfirmado, hoy: string): string {
  const cubre = c.consolidado ? ` Un solo pago que cubre ${c.polizas.length} recibos (${c.polizas.map((p) => `${etiquetaPoliza(p)} ${p.prima} €`).join(" + ")}).` : "";
  return `✅ COBRADO — comprobado automáticamente en Holded el ${hoy}: ${describirMovimiento(c.movimiento)}.${cubre} Movimiento ${c.movimiento.id}.`;
}

function notaDevolucion(d: DevolucionDetectada["devolucion"], hoy: string): string {
  const pago = describirMovimiento(d.vigilado.movimiento);
  const causa = d.entrada
    ? `entró ${describirMovimiento(d.entrada)}`
    : "el saldo del banco ya no refleja el cargo (sin apunte contrario, como los adeudos del 01/09)";
  return `↩️ DEVOLUCIÓN PROBABLE (${hoy}): el pago de ${pago} parece devuelto — ${causa}. Vuelve a estar PENDIENTE de pago. Movimiento ${d.vigilado.movimiento.id}.`;
}

function claveTransito(t: PagoEnTransito): string {
  return `transito:${t.polizas.map((p) => p.id).join("+")}:${t.movimiento.id}`;
}

// ---------------------------------------------------------------------------------------------------------------

export async function ejecutarVigilanteSeguros(
  fuentes: FuentesVigilante,
  opciones: { aplicar?: boolean } = {}
): Promise<ResultadoVigilante> {
  const aplicar = opciones.aplicar !== false;
  const hoy = formatDateLocal(fuentes.ahora());

  const polizas = await fuentes.listarPolizas();
  const estado = await fuentes.leerEstado();

  const advertencias: string[] = [];
  const fallosPersistentes: string[] = [];
  const clavesAvisadas: Array<{ id: string; version: string }> = [];
  const estadoInterno: Array<{ id: string; version: string }> = [];
  const aBorrar: string[] = [];

  /** Una lectura que falla un día es una advertencia; si lleva DIAS_FALLO_PERSISTENTE días, es un aviso por sí sola (una vez al día). */
  const seguirFallo = (fuente: "banco" | "correo", fallo: boolean, nombre: string) => {
    const id = `fallo:${fuente}`;
    const previo = estado.get(id);
    if (!fallo) {
      if (previo) aBorrar.push(id);
      return;
    }
    if (!previo) {
      estadoInterno.push({ id, version: hoy });
      return;
    }
    const dias = diasEntre(previo.version, hoy);
    const avisoHoy = `aviso_fallo:${fuente}:${hoy}`;
    if (dias >= DIAS_FALLO_PERSISTENTE && !estado.has(avisoHoy)) {
      fallosPersistentes.push(`${nombre} lleva ${dias} días sin poder leerse: el vigilante no está viendo esa parte de la situación.`);
      clavesAvisadas.push({ id: avisoHoy, version: "avisado" });
    }
  };

  // 1) Banco -----------------------------------------------------------------------------------------------------
  let lectura: LecturaBancaria | null = null;
  try {
    lectura = await fuentes.leerBanco(restarDias(hoy, DIAS_BANCO), hoy);
  } catch (error) {
    advertencias.push(`No pude leer el banco de Holded: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const f of lectura?.fallos ?? []) {
    advertencias.push(`No pude leer ${f.cuenta === "(todas)" ? "las cuentas" : `la cuenta ${f.cuenta}`} de ${f.empresa} en Holded (${f.error.slice(0, 140)}).`);
  }
  seguirFallo("banco", lectura == null || lectura.fallos.length > 0, "La lectura del banco de Holded");
  const movimientos = lectura?.movimientos ?? [];

  const cadenas = analizarCuentas(movimientos);
  const evaluar: EvaluadorLiquidacion = (m) => {
    const cadena = cadenas.get(claveDeCuenta(m));
    return { estado: cadena?.estado.get(m.id) ?? "sin_saldo", cuentaFiable: cadena?.fiable ?? false };
  };

  const confirmacion = confirmarPagos(polizas, movimientos, hoy, evaluar);
  const vigilados = pagosVigilados(polizas, movimientos, hoy);
  const devolucionesBrutas = detectarDevoluciones(vigilados, movimientos, evaluar);
  // Un cargo que encaja con un recibo pendiente ya se cuenta como «en tránsito»: no se repite además como «cargo que no encaja».
  const idsEnTransito = new Set(confirmacion.enTransito.map((t) => t.movimiento.id));
  const anomalos = detectarCargosAnomalos(polizas, movimientos, hoy, evaluar).filter(
    (a) => !(a.tipo === "no_aplicado" && idsEnTransito.has(a.movimiento.id))
  );

  // 2) Correo ----------------------------------------------------------------------------------------------------
  let correos: CorreoSeguro[] = [];
  let correoLeido = false;
  if (fuentes.correo) {
    try {
      correos = await leerCorreosDeSeguros(restarDias(hoy, DIAS_CORREO), fuentes.correo);
      correoLeido = true;
    } catch (error) {
      advertencias.push(`No pude leer el correo del asistente: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    advertencias.push("El correo del asistente no está configurado en este entorno.");
  }
  seguirFallo("correo", fuentes.correo != null && !correoLeido, "La lectura del correo del asistente");

  // 3) Qué es nuevo ----------------------------------------------------------------------------------------------
  let correosNuevos = correos.filter((c) => !estado.has(`correo:${c.id}`));
  if (correoLeido && !estado.has("__inicio__:correo")) {
    // Primera revisión: lo que ya hay en el buzón se da por conocido (Carlos ya lo ha visto); solo avisan los correos futuros.
    estadoInterno.push({ id: "__inicio__:correo", version: hoy }, ...correosNuevos.map((c) => ({ id: `correo:${c.id}`, version: "visto" })));
    correosNuevos = [];
  } else {
    for (const c of correosNuevos) clavesAvisadas.push({ id: `correo:${c.id}`, version: "visto" });
  }

  const enTransitoNuevos = confirmacion.enTransito.filter((t) => {
    const v = evaluar(t.movimiento);
    const version = `${v.estado}|${v.cuentaFiable ? "fiable" : "sin_cadena"}`;
    if (estado.get(claveTransito(t))?.version === version) return false;
    clavesAvisadas.push({ id: claveTransito(t), version });
    return true;
  });

  const cargosNuevos: CargoAnomalo[] = anomalos.filter((c) => {
    if (estado.has(c.claveAviso)) return false;
    clavesAvisadas.push({ id: c.claveAviso, version: "avisado" });
    return true;
  });

  const ambiguos = confirmacion.ambiguos.filter((a) => {
    const id = `ambiguo:${a.poliza.id}:${a.candidatos.map((c) => c.id).join("+")}`;
    if (estado.has(id)) return false;
    clavesAvisadas.push({ id, version: "avisado" });
    return true;
  });

  // 4) Escribir en el registro lo confirmado ---------------------------------------------------------------------
  let escribioRegistro = false;
  const confirmadosEscritos: PagoConfirmado[] = [];
  const devoluciones: DevolucionDetectada[] = [];

  const hayQueEscribir =
    aplicar && (confirmacion.confirmados.length > 0 || devolucionesBrutas.some((d) => d.certeza === "probable"));
  // Se relee el registro justo antes de escribir: la fila se reescribe entera y alguien puede haberla editado hace un momento.
  const frescas = hayQueEscribir ? new Map((await fuentes.listarPolizas()).map((p) => [p.id, p])) : new Map<string, PolizaConFila>();

  for (const pago of confirmacion.confirmados) {
    if (!aplicar) { confirmadosEscritos.push(pago); continue; }
    let todasEscritas = true;
    for (const original of pago.polizas) {
      const actual = frescas.get(original.id);
      if (!actual || (actual.estadoPago !== "pendiente" && actual.estadoPago !== "sin_confirmar")) { todasEscritas = false; continue; }
      try {
        await fuentes.actualizarPoliza(actual.rowIndex, {
          ...camposPoliza(actual),
          estadoPago: "pagado",
          ultimaVerificacion: hoy,
          fuenteExtraccion: conFuenteBanco(actual.fuenteExtraccion),
          notas: `${notaConfirmacion(pago, hoy)}${actual.notas ? ` || ${actual.notas}` : ""}`,
        });
        escribioRegistro = true;
      } catch (error) {
        todasEscritas = false;
        advertencias.push(`No pude actualizar ${etiquetaPoliza(original)} en el registro: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (todasEscritas) confirmadosEscritos.push(pago);
  }

  for (const d of devolucionesBrutas) {
    const id = `devolucion:${d.vigilado.poliza.id}:${d.vigilado.movimiento.id}`;
    if (estado.has(id)) continue;
    let revertida = false;
    if (aplicar && d.certeza === "probable") {
      const actual = frescas.get(d.vigilado.poliza.id);
      if (actual && actual.estadoPago === "pagado" && actual.notas.includes(d.vigilado.movimiento.id)) {
        try {
          await fuentes.actualizarPoliza(actual.rowIndex, {
            ...camposPoliza(actual),
            estadoPago: "pendiente",
            ultimaVerificacion: hoy,
            notas: `${notaDevolucion(d, hoy)}${actual.notas ? ` || ${actual.notas}` : ""}`,
          });
          revertida = true;
          escribioRegistro = true;
        } catch (error) {
          advertencias.push(`No pude devolver ${etiquetaPoliza(actual)} a «pendiente»: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    devoluciones.push({ devolucion: d, revertida });
    clavesAvisadas.push({ id, version: "avisado" });
  }

  if (escribioRegistro) {
    try { fuentes.invalidarCerebro(); } catch (error) { console.error("[vigilanteSeguros] No se pudo refrescar Cerebro (no crítico):", error); }
  }

  // 5) Informe -----------------------------------------------------------------------------------------------------
  const empresasCompletas: Set<string> = lectura?.empresasCompletas ?? new Set<string>();
  const sinPago = confirmacion.sinPago.filter((p) => empresasCompletas.has(p.empresaHolded));
  const contenido: ContenidoInforme = {
    hoy,
    devoluciones,
    confirmados: confirmadosEscritos,
    enTransito: enTransitoNuevos,
    cargos: cargosNuevos,
    correos: correosNuevos,
    ambiguos,
    sinPago,
    advertencias,
    fallosPersistentes,
  };
  // Para el chat se cuenta la situación de ahora mismo, no solo lo nuevo: quien pregunta «¿qué hay?» quiere verlo todo.
  const contenidoCompleto: ContenidoInforme = {
    ...contenido,
    enTransito: confirmacion.enTransito,
    cargos: anomalos,
    correos: correos.slice(-8),
    ambiguos: confirmacion.ambiguos,
  };

  // Mantenimiento de la memoria: lo interno se guarda siempre; lo caducado se borra.
  try {
    await fuentes.guardarEstado(estadoInterno);
    if (aBorrar.length > 0) await fuentes.borrarEstado(aBorrar);
    await fuentes.purgarCorreosVistos(restarDias(hoy, DIAS_CONSERVAR_CORREOS_VISTOS));
  } catch (error) {
    console.error("[vigilanteSeguros] Error guardando la memoria interna (no crítico):", error);
  }

  let pendienteEnvio: Informe | null = null;
  const crudo = estado.get("pendiente_envio")?.version;
  if (crudo) {
    try {
      const parsed = JSON.parse(crudo) as Informe;
      if (parsed?.titulo && parsed?.cuerpo) pendienteEnvio = parsed;
    } catch { /* un pendiente ilegible se descarta en el job */ }
  }

  return {
    hoy,
    contenido,
    informe: construirInforme(contenido),
    situacion: contenidoCompleto,
    respuestaChat: construirRespuestaChat(contenidoCompleto, !aplicar),
    clavesAvisadas,
    pendienteEnvio,
    escribioRegistro,
  };
}
