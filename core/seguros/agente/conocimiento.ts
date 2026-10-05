/**
 * Memoria de Wobi Seguros: lo que el agente sabe y NO está en una póliza ni en una fila del registro — decisiones de
 * Carlos, asuntos que esperan su respuesta, reglas de trabajo, contactos y hechos que cambian cómo interpretar los
 * datos. Es lo que hace al agente independiente: no depende de que alguien le recuerde el contexto en cada pregunta.
 *
 * Vive en la pestaña `_seguros_conocimiento` (mismos primitivos de Sheets que el resto de almacenes). Al estar vacía
 * se siembra con lo ya documentado en docs/wobi-seguros.md y en los correos de Acodrid; a partir de ahí el agente la
 * amplía cuando Carlos le cuenta una decisión nueva (herramienta `recordar`) y retira lo que deja de valer.
 */
import { leerFilas, agregarFila, actualizarFila, type FilaCruda } from "../../google/sheetsKeyValueStore";

export type TipoConocimiento = "decision" | "pendiente_carlos" | "regla" | "contacto" | "hecho";

export const TIPOS_CONOCIMIENTO: readonly TipoConocimiento[] = ["decision", "pendiente_carlos", "regla", "contacto", "hecho"];

export interface EntradaConocimiento {
  id: string;
  tipo: TipoConocimiento;
  texto: string;
  /** De dónde sale (quién lo decidió o qué documento lo dice) y cuándo. */
  fuente: string;
  /** YYYY-MM-DD de la decisión o del hecho. */
  fecha: string;
  vigente: boolean;
}

const TAB_NAME = "_seguros_conocimiento";
const HEADERS = ["id", "tipo", "texto", "fuente", "fecha", "vigente"];
const NUM_COLS = HEADERS.length;

export const CONOCIMIENTO_INICIAL: EntradaConocimiento[] = [
  {
    id: "dec-aegon-fuera-de-alcance", tipo: "decision", fecha: "2026-09-27", vigente: true,
    texto: "Aegon (el seguro de salud que WOBA paga cada mes, unos 234 €) está FUERA del alcance de Wobi Seguros: no se registra ni se avisa de sus cargos.",
    fuente: "Carlos, 27/09/2026 (docs/wobi-seguros.md §13 punto 9)",
  },
  {
    id: "dec-solunion-baja", tipo: "decision", fecha: "2026-09-27", vigente: true,
    texto: "Solunion (seguro de crédito de WOBA) está dado de baja. Un cargo nuevo suyo sería una anomalía que hay que avisar.",
    fuente: "Carlos, 27/09/2026 (§13 punto 10)",
  },
  {
    id: "dec-suramericana-fuera", tipo: "decision", fecha: "2026-09-27", vigente: true,
    texto: "El reintegro de la póliza de Suramericana (Footprint, oficina de Medellín) queda fuera del alcance inicial.",
    fuente: "Carlos, 27/09/2026 (§16)",
  },
  {
    id: "dec-pelayo-calendario-fiscal", tipo: "decision", fecha: "2026-09-27", vigente: true,
    texto: "Los seguros de Pelayo (coche en agosto, moto en mayo y piso en febrero) se avisan por el calendario fiscal (docs/calendario_fiscal.json); no están en el registro de pólizas de Wobi Seguros.",
    fuente: "docs/calendario_fiscal.json y docs/wobi-seguros.md §16",
  },
  {
    id: "dec-viaje-footprint-no", tipo: "decision", fecha: "2026-09-30", vigente: true,
    texto: "No se compra el seguro de viaje anual de Footprint (cotización de 1.524,98 €). Los cargos de IATI son seguros de viaje contratados trayecto a trayecto con tarjeta (unos 310 € en 12 meses): no son una póliza que registrar.",
    fuente: "Carlos, 30/09/2026; cargos verificados en Holded el 05/10/2026",
  },
  {
    id: "dec-hold-transporte-equipos", tipo: "decision", fecha: "2026-09-30", vigente: true,
    texto:
      "Seguro de transporte de pantallas (529,16 €/año, 100.000 € por vehículo) y seguro de equipos electrónicos (4.142,76 €/año, 90.000 € de capital): EN HOLD, congelados por decisión de Carlos. " +
      "No volver a preguntar por ellos hasta que él los retome. Los cotizó Acodrid el 12/08/2026.",
    fuente: "Carlos, 30/09/2026",
  },
  {
    id: "hecho-transporte-desencadenante", tipo: "hecho", fecha: "2026-09-30", vigente: true,
    texto:
      "Antes del primer transporte con medios propios de WOBA (el servicio de entrega y recogida de Rental.co, previsto al terminar el proyecto piloto y sin fecha todavía) hay que tener contratado el seguro de transporte con carga y descarga: Acodrid pide aviso con antelación. " +
      "Carlos pidió que mientras tanto quien transporte tenga los seguros necesarios. Sigue en hold; solo recordarlo cuando haya fecha de lanzamiento del servicio.",
    fuente: "hilo «seguro rentalco», 30/09/2026 (Jaquelin Lovey, Boris Dallafontana y Carlos)",
  },
  {
    id: "pend-excluir-rc-multirriesgo", tipo: "pendiente_carlos", fecha: "2026-09-24", vigente: true,
    texto:
      "Excluir la garantía de RC del multirriesgo de WOBA (Allianz 054239034). Acodrid la propone porque sigue con la facturación antigua (112.431,28 € frente a los 700.000 € actuales) y así no encarece la prima; la RC independiente es la de Markel (023S00453RCG). " +
      "Carlos debe confirmarlo por escrito respondiendo al correo de Acodrid; Wobi no lo decide.",
    fuente: "correo de Acodrid, 24/09/2026",
  },
  {
    id: "pend-firma-suplemento-3-3", tipo: "pendiente_carlos", fecha: "2026-09-24", vigente: true,
    texto: "Devolver a Acodrid firmadas todas las páginas de las condiciones particulares del suplemento 3.3 de la RC de WOBA (Markel 023S00453RCG). No consta que se haya enviado.",
    fuente: "correo de Acodrid, 24/09/2026",
  },
  {
    id: "pend-condiciones-allianz-2026-27", tipo: "pendiente_carlos", fecha: "2026-10-01", vigente: true,
    texto:
      "Faltan las condiciones particulares de la RENOVACIÓN 2026/2027 del multirriesgo de WOBA (Allianz 054239034): se pidieron a Acodrid el 30/09/2026 y el 01/10 llegaron el suplemento nº 2 y las condiciones del suplemento 3.3 de Markel, pero no esas.",
    fuente: "correos de Acodrid, 30/09 y 01/10/2026",
  },
  {
    id: "regla-correos", tipo: "regla", fecha: "2026-09-30", vigente: true,
    texto:
      "Solo se escribe a corredores o aseguradoras cuando Carlos lo pide en ese momento, desde asistente@wobagroup.com, nunca por iniciativa propia. Al pedir un documento a Acodrid se pide solo el documento, sin explicaciones. Wobi Seguros redacta el borrador; no lo envía.",
    fuente: "Carlos, 29 y 30/09/2026",
  },
  {
    id: "regla-dinero", tipo: "regla", fecha: "2026-09-18", vigente: true,
    texto: "Wobi Seguros nunca ejecuta pagos ni transferencias y no escribe en Holded: avisa, prepara y verifica; el pago lo hace una persona.",
    fuente: "docs/wobi-seguros.md §11",
  },
  {
    id: "contacto-acodrid", tipo: "contacto", fecha: "2026-10-01", vigente: true,
    texto:
      "Acodrid Correduría de Seguros (Madrid) gestiona las pólizas de WOBA, EWORKS y Footprint. Jaquelin Lovey, gestora de las pólizas (jaquelin.lovey@acodrid.com); María José Mejía, recibos y justificantes de pago (mjose.mejia@acodrid.com); " +
      "Andrés García Aguado, asesoramiento y cláusulas (andres.g.aguado@acodrid.com); general: acodrid@acodrid.com. Los seguros no generan factura (no hay IVA): el soporte contable es el justificante de pago y el duplicado del recibo.",
    fuente: "correos de Acodrid, 24/09 a 01/10/2026",
  },
  {
    id: "hecho-cuentas-de-cobro", tipo: "hecho", fecha: "2026-10-05", vigente: true,
    texto:
      "Cómo se paga cada póliza. WOBA domicilia en BBVA …6229, una cuenta que suele tener un saldo casi nulo el día 1 de mes (los recibos de Allianz y Aegon del 01/09 se devolvieron); sus pagos manuales salen de Revolut (cuenta Main). " +
      "EWORKS: el mandato de Markel de 2025 nombra Revolut …4606, pero el cobro domiciliado de septiembre de 2026 se hizo en CaixaBank. Footprint paga la RC de Markel desde Revolut.",
    fuente: "Holded y mandatos, verificado el 05/10/2026",
  },
  {
    id: "hecho-suspension-showroom", tipo: "hecho", fecha: "2026-10-01", vigente: true,
    texto:
      "La póliza multirriesgo del showroom de WOBA estuvo en suspenso desde el 01/09/2026 por el recibo devuelto del suplemento nº 2 (aviso directo de Allianz; plazo legal de un mes, hasta ~01/10). " +
      "Se regularizó el 30/09/2026 con la transferencia de 1.306,00 € a Acodrid (289,14 € del suplemento + 1.016,86 € de la 1ª cuota de la renovación). No consta confirmación escrita de que la cobertura quedara rehabilitada sin interrupción.",
    fuente: "correos de Allianz y Acodrid; justificante de Revolut del 30/09/2026",
  },
  {
    id: "hecho-rentalco-rc-cliente", tipo: "hecho", fecha: "2026-09-30", vigente: true,
    texto:
      "Rental.co: las condiciones generales (art. 7) obligan al ARRENDATARIO a tener su propia RC en vigor y subirla a su portal. WOBA cubre su propia actividad de alquiler con el suplemento 3.3 de la RC de Markel (200.000 € de facturación de la actividad nueva).",
    fuente: "hilo «seguro rentalco», 23 a 30/09/2026",
  },
  {
    id: "hecho-checklist-cobertura", tipo: "hecho", fecha: "2026-09-27", vigente: true,
    texto: "Cobertura que Carlos considera necesaria: WOBA = responsabilidad civil + todo riesgo del showroom (accidentes de empleados no es obligatorio por su convenio); EWORKS = responsabilidad civil; Footprint = responsabilidad civil.",
    fuente: "Carlos, 27/09/2026 (§15)",
  },
  {
    id: "hecho-375led", tipo: "hecho", fecha: "2026-09-27", vigente: true,
    texto: "375LED America LLC (entidad de WOBA en EE. UU.): hay histórico de General Liability con Kinsale a través de Bass Underwriters hasta el 13/10/2023; no se sabe si hoy hay póliza. Preguntar a Carlos antes de asumir nada.",
    fuente: "Drive y docs/wobi-seguros.md §13 punto 16",
  },
  {
    id: "hecho-prima-minima-markel", tipo: "hecho", fecha: "2026-10-05", vigente: true,
    texto:
      "La RC de WOBA (Markel 023S00453RCG) tiene prima «mínima y de depósito» (2.012,65 € brutos al año con el suplemento 3.3): puede haber regularización de prima según la facturación; confirmarlo con Acodrid antes de la renovación del 17/04/2027.",
    fuente: "condiciones particulares del suplemento 3.3 (recibidas el 01/10/2026)",
  },
];

// ---------------------------------------------------------------------------------------------------------------

export interface AlmacenConocimiento {
  leer(): Promise<EntradaConocimiento[]>;
  agregar(entrada: EntradaConocimiento): Promise<void>;
  /** Marca una entrada como ya no vigente; false si no existe. */
  retirar(id: string, motivo: string): Promise<boolean>;
}

function filaAEntrada(fila: FilaCruda): EntradaConocimiento & { rowIndex: number } {
  const [id, tipo, texto, fuente, fecha, vigente] = fila.valores;
  return {
    rowIndex: fila.rowIndex,
    id: id ?? "",
    tipo: (TIPOS_CONOCIMIENTO as readonly string[]).includes(tipo) ? (tipo as TipoConocimiento) : "hecho",
    texto: texto ?? "",
    fuente: fuente ?? "",
    fecha: fecha ?? "",
    vigente: (vigente ?? "").toLowerCase() !== "no",
  };
}

const entradaAFila = (e: EntradaConocimiento): string[] => [e.id, e.tipo, e.texto, e.fuente, e.fecha, e.vigente ? "si" : "no"];

export const almacenConocimientoReal: AlmacenConocimiento = {
  async leer() {
    const filas = await leerFilas(TAB_NAME, NUM_COLS, HEADERS);
    return filas.map(filaAEntrada).filter((e) => e.id).map(({ rowIndex: _rowIndex, ...e }) => e);
  },
  async agregar(entrada) {
    await agregarFila(TAB_NAME, NUM_COLS, HEADERS, entradaAFila(entrada));
  },
  async retirar(id, motivo) {
    const filas = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS)).map(filaAEntrada);
    const fila = filas.find((e) => e.id === id);
    if (!fila) return false;
    const { rowIndex, ...entrada } = fila;
    await actualizarFila(TAB_NAME, rowIndex, NUM_COLS, entradaAFila({ ...entrada, texto: `${entrada.texto} [RETIRADO: ${motivo}]`, vigente: false }));
    return true;
  },
};

let sembrando: Promise<void> | null = null;

/** Lee la memoria; si está vacía (primer uso) la siembra con lo ya documentado. La siembra es idempotente por id. */
export async function leerConocimiento(almacen: AlmacenConocimiento = almacenConocimientoReal): Promise<EntradaConocimiento[]> {
  const actual = await almacen.leer();
  if (actual.length > 0) return actual;
  if (!sembrando) {
    sembrando = (async () => {
      const ahora = await almacen.leer();
      const existentes = new Set(ahora.map((e) => e.id));
      for (const entrada of CONOCIMIENTO_INICIAL) if (!existentes.has(entrada.id)) await almacen.agregar(entrada);
    })().finally(() => { sembrando = null; });
  }
  await sembrando;
  return almacen.leer();
}

/** Identificador estable y legible para una entrada nueva que añade el agente. */
export function idConocimientoNuevo(tipo: TipoConocimiento, texto: string, fecha: string): string {
  let hash = 0;
  for (const c of `${tipo}|${texto}`) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return `k-${fecha.replace(/-/g, "")}-${hash.toString(36).slice(0, 6)}`;
}

export async function agregarConocimiento(
  entrada: Omit<EntradaConocimiento, "id" | "vigente">,
  almacen: AlmacenConocimiento = almacenConocimientoReal
): Promise<EntradaConocimiento> {
  const completa: EntradaConocimiento = { ...entrada, id: idConocimientoNuevo(entrada.tipo, entrada.texto, entrada.fecha), vigente: true };
  const existentes = await leerConocimiento(almacen);
  if (existentes.some((e) => e.id === completa.id && e.vigente)) return completa; // ya estaba: idempotente
  await almacen.agregar(completa);
  return completa;
}

const ETIQUETA_TIPO: Record<TipoConocimiento, string> = {
  decision: "Decisiones de Carlos",
  pendiente_carlos: "Esperando respuesta o acción de Carlos",
  regla: "Reglas de trabajo",
  contacto: "Contactos",
  hecho: "Hechos a tener presentes",
};

/** La memoria vigente, agrupada por tipo, lista para el dossier del agente. */
export function formatearConocimiento(entradas: EntradaConocimiento[]): string {
  const vigentes = entradas.filter((e) => e.vigente);
  const bloques: string[] = [];
  for (const tipo of TIPOS_CONOCIMIENTO) {
    const delTipo = vigentes.filter((e) => e.tipo === tipo);
    if (delTipo.length === 0) continue;
    bloques.push(`${ETIQUETA_TIPO[tipo]}:\n${delTipo.map((e) => `- [${e.id}] ${e.texto} (${e.fuente})`).join("\n")}`);
  }
  return bloques.join("\n\n");
}
