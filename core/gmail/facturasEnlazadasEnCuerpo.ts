import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraerEnlacesPdf } from "./enlacesFacturaEnCorreo";
import { descargarFacturaEnlazada, DescargaFacturaEnlazadaError } from "../documental/descargarFacturaEnlazada";
import { extraerDatosFactura, type DatosFactura } from "../documental/extractInvoiceData";

// Hallazgo real de la revisión adversarial del PR #247: con 6 enlaces procesados EN SERIE (descarga +
// extracción con IA, cada una con su propio timeout interno de hasta minutos), el peor caso teórico
// llegaba a decenas de minutos reteniendo el candado del buzón (conCoordinadorCorreo) — otros correos
// y botones del mismo buzón quedaban esperando. Dos correcciones: (1) se procesan en PARALELO
// (Promise.allSettled), así el peor caso pasa a ser el del enlace MÁS lento, no la suma de todos; (2)
// un presupuesto de tiempo total para todo el intento — si se agota, se abandona como "no verificado"
// (el correo sigue con su gasto simple de siempre) en vez de esperar indefinidamente. El límite de 4
// enlaces (antes 6) también acota cuántas llamadas reales de IA puede disparar un solo correo.
const MAX_ENLACES_A_INTENTAR = 4;
/** Un céntimo — el redondeo de dos documentos leídos por separado nunca debe superar esto. */
const TOLERANCIA_CENTIMOS = 1;
/** Apaga solo esta capacidad sin tocar el resto de la política de IA (ver .env.example). */
function habilitado(): boolean {
  return (process.env.WOBI_FACTURAS_ENLAZADAS_HABILITADO ?? "true").trim().toLowerCase() !== "false";
}
function presupuestoTotalMs(): number {
  const configurado = Number(process.env.WOBI_FACTURAS_ENLAZADAS_PRESUPUESTO_MS);
  return Number.isFinite(configurado) && configurado > 0 ? configurado : 90_000;
}

export interface FacturaEnlazadaLeida {
  url: string;
  datos: DatosFactura;
}

export type ResultadoFacturasEnlazadas =
  | { verificado: true; leidas: FacturaEnlazadaLeida[]; datosCombinados: DatosFactura }
  // motivo: para dejar rastro en logs, nunca se muestra tal cual al operador.
  | { verificado: false; leidas: FacturaEnlazadaLeida[]; motivo?: string };

/**
 * Caso real (Footprint, 29 sep 2026, Queen Home Apartments — Venecia): un correo reenviado sin
 * ningún adjunto real de Gmail traía 3 facturas como enlaces `.pdf` en el cuerpo, con el remitente
 * pidiendo explícitamente sumarlas contra el total ya mencionado ("259.44€" en el asunto). El
 * extractor de "gasto en el cuerpo" (extraerGastoDeCorreo, ver revisarCorreoNuevo.ts) ya lee ESE
 * importe del texto — esta función solo interviene cuando puede DEMOSTRAR, leyendo las facturas
 * reales, que ese importe es exactamente la suma de ≥2 documentos reales. Si no cuadra, o si
 * cualquier enlace falla, NUNCA se inventa nada: se devuelve `verificado:false` y el llamador sigue
 * exactamente como antes (un único gasto simplificado, sin desglose).
 *
 * Deliberadamente conservador en la parte fiscal: aunque `extraerDatosFactura` sepa leer un desglose
 * de IVA real por línea (ver su propio comentario), este combinado SIEMPRE se trata como recibo
 * simplificado (una sola línea, sin IVA reclamado) — igual que el resto de este camino. El
 * tratamiento fiscal correcto de un IVA extranjero (aquí, italiano al 22%) no es algo que este
 * sistema deba decidir solo; el desglose completo queda en el concepto, visible para quien apruebe.
 */
export interface DependenciasFacturasEnlazadas {
  descargar: (url: string) => Promise<Buffer>;
  extraer: (rutaLocal: string, mimeType: string | undefined, contextoCorreo?: string, nombreArchivo?: string) => Promise<DatosFactura>;
}

const dependenciasReales: DependenciasFacturasEnlazadas = {
  descargar: descargarFacturaEnlazada,
  extraer: extraerDatosFactura,
};

export async function verificarFacturasEnlazadasEnCuerpo(
  html: string | undefined,
  gastoDetectado: DatosFactura,
  contextoCorreo?: string,
  deps: DependenciasFacturasEnlazadas = dependenciasReales
): Promise<ResultadoFacturasEnlazadas> {
  if (!habilitado()) return { verificado: false, motivo: "capacidad deshabilitada por configuración", leidas: [] };
  const enlaces = extraerEnlacesPdf(html ?? "").slice(0, MAX_ENLACES_A_INTENTAR);
  if (enlaces.length < 2) return { verificado: false, motivo: "menos de 2 enlaces a PDF en el cuerpo", leidas: [] };

  const carpeta = await mkdtemp(join(tmpdir(), "wobi-factura-enlazada-"));
  const leerUno = async (enlace: { url: string; texto: string }, indice: number): Promise<FacturaEnlazadaLeida | undefined> => {
    try {
      const bytes = await deps.descargar(enlace.url);
      const rutaLocal = join(carpeta, `${indice}.pdf`);
      await writeFile(rutaLocal, bytes);
      const datos = await deps.extraer(rutaLocal, "application/pdf", contextoCorreo, enlace.texto || `${indice}.pdf`);
      return datos.esFacturaOGasto ? { url: enlace.url, datos } : undefined;
    } catch (error) {
      // Un enlace roto/lento/no-PDF no invalida el resto — solo reduce la evidencia disponible.
      console.error("[facturasEnlazadasEnCuerpo] No se pudo leer un enlace (se ignora, no bloquea el resto):", {
        url: enlace.url,
        error: error instanceof DescargaFacturaEnlazadaError || error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  let leidas: FacturaEnlazadaLeida[];
  let agotoElPresupuesto = false;
  try {
    // En paralelo (no en serie): el peor caso pasa a ser el del enlace más lento, no la suma de todos.
    // Si el presupuesto total se agota, se sigue con lo que ya haya llegado — nunca se espera sin límite
    // reteniendo el candado del buzón; lo que siga en vuelo en segundo plano se descarta sin efecto (su
    // escritura a `carpeta`, ya borrada, falla en silencio, capturada por el try/catch de `leerUno`).
    const tiempoLimite = new Promise<"tiempo_agotado">(resolve => setTimeout(() => resolve("tiempo_agotado"), presupuestoTotalMs()).unref());
    const resultado = await Promise.race([
      Promise.allSettled(enlaces.map(leerUno)).then(rs => rs.flatMap(r => r.status === "fulfilled" && r.value ? [r.value] : [])),
      tiempoLimite,
    ]);
    if (resultado === "tiempo_agotado") { agotoElPresupuesto = true; leidas = []; }
    else leidas = resultado;
  } finally {
    await rm(carpeta, { recursive: true, force: true }).catch(() => undefined);
  }
  if (agotoElPresupuesto) {
    return { verificado: false, motivo: `se agotó el presupuesto de ${presupuestoTotalMs() / 1000}s antes de leer los enlaces`, leidas: [] };
  }

  if (leidas.length < 2) {
    return { verificado: false, motivo: `solo ${leidas.length} de ${enlaces.length} enlaces resultaron ser facturas legibles`, leidas };
  }

  const monedas = new Set(leidas.map(l => l.datos.moneda.toUpperCase().trim()));
  if (monedas.size > 1) {
    return { verificado: false, motivo: `las facturas enlazadas están en monedas distintas (${[...monedas].join(", ")})`, leidas };
  }
  const monedaComun = [...monedas][0];
  if (monedaComun !== gastoDetectado.moneda.toUpperCase().trim()) {
    return { verificado: false, motivo: "la moneda de las facturas enlazadas no coincide con la del correo", leidas };
  }

  const sumaCentimos = leidas.reduce((acc, l) => acc + Math.round(l.datos.monto * 100), 0);
  const esperadoCentimos = Math.round(gastoDetectado.monto * 100);
  if (Math.abs(sumaCentimos - esperadoCentimos) > TOLERANCIA_CENTIMOS) {
    return {
      verificado: false,
      motivo: `la suma de las facturas enlazadas (${(sumaCentimos / 100).toFixed(2)}) no cuadra con el importe ya detectado (${gastoDetectado.monto.toFixed(2)})`,
      leidas,
    };
  }

  const desglose = leidas
    .map(l => `${l.datos.numeroDocumento || "(sin número)"}: ${l.datos.monto.toFixed(2)} ${l.datos.moneda}${l.datos.concepto ? ` — ${l.datos.concepto}` : ""}`)
    .join("; ");
  const numerosDocumento = leidas.map(l => l.datos.numeroDocumento).filter(Boolean).join(" + ") || undefined;
  // La confianza combinada nunca puede superar la del eslabón más débil.
  const ordenConfianza = { alta: 2, media: 1, baja: 0 } as const;
  const confianzaCombinada = leidas.reduce<DatosFactura["confianza"]>(
    (min, l) => (ordenConfianza[l.datos.confianza] < ordenConfianza[min] ? l.datos.confianza : min),
    "alta"
  );
  // Hallazgo real de la revisión adversarial del PR #247: si las facturas leídas traen personas
  // DISTINTAS entre sí, quedarse con "la primera que la mencione" resuelve el conflicto en silencio
  // — mismo criterio que ya se usa abajo para la fecha: solo se rellena cuando TODAS coinciden.
  const personasFacturas = new Set(leidas.map(l => l.datos.personaAsociada).filter(Boolean));
  const personaAsociada = gastoDetectado.personaAsociada ?? (personasFacturas.size === 1 ? [...personasFacturas][0] : undefined);
  const contextoDeViaje = gastoDetectado.contextoDeViaje || leidas.some(l => l.datos.contextoDeViaje);
  // El cuerpo del correo suele decir el importe pero no siempre la fecha (Carlos, caso real: "no
  // reconoce la fecha"); las facturas reales sí la traen impresa. Solo se rellena, nunca se
  // contradice, y solo si TODAS coinciden — si difieren, mejor dejarla en blanco que adivinar cuál.
  const fechasFacturas = new Set(leidas.map(l => l.datos.fecha).filter(Boolean));
  const fecha = gastoDetectado.fecha || (fechasFacturas.size === 1 ? [...fechasFacturas][0] : gastoDetectado.fecha);
  // La empresa nunca se cambia sola a partir de lo leído en un PDF de un tercero — demasiado
  // sensible para decidirlo aquí — pero si discrepa de lo ya detectado en el cuerpo, se deja
  // constancia visible para quien apruebe, en vez de perder esa señal en silencio.
  const empresasFacturas = new Set(leidas.map(l => l.datos.empresaProbable).filter(Boolean));
  const notaEmpresa = empresasFacturas.size && ![...empresasFacturas].every(e => e === gastoDetectado.empresaProbable)
    ? ` ⚠️ Alguna factura enlazada sugiere otra empresa (${[...empresasFacturas].join("/")}) — verificar antes de aprobar.`
    : "";

  const datosCombinados: DatosFactura = {
    ...gastoDetectado,
    numeroDocumento: numerosDocumento ?? gastoDetectado.numeroDocumento,
    personaAsociada,
    contextoDeViaje,
    fecha,
    confianza: confianzaCombinada,
    concepto: `${gastoDetectado.concepto} — ${leidas.length} facturas enlazadas cuya suma coincide con el importe: ${desglose}.${notaEmpresa}`,
    // Deliberadamente no dice "verificado" a secas: solo se comprobó que la suma de lo leído en los
    // PDFs enlazados coincide con el importe que el propio correo ya afirmaba — ambos pueden venir
    // del mismo remitente, así que esto demuestra coherencia interna, no que el gasto sea real. El
    // botón de aprobación sigue siendo quien decide, con el desglose completo a la vista.
    razon: `${gastoDetectado.razon ?? ""} [La suma de ${leidas.length} facturas enlazadas en el cuerpo del correo coincide exacta con el importe ya detectado; no es una fuente independiente del mismo correo.]`.trim(),
  };

  return { verificado: true, leidas, datosCombinados };
}
