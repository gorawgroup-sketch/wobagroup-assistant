import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraerEnlacesPdf } from "./enlacesFacturaEnCorreo";
import { descargarFacturaEnlazada, DescargaFacturaEnlazadaError } from "../documental/descargarFacturaEnlazada";
import { extraerDatosFactura, type DatosFactura } from "../documental/extractInvoiceData";

const MAX_ENLACES_A_INTENTAR = 6;
/** Un céntimo — el redondeo de dos documentos leídos por separado nunca debe superar esto. */
const TOLERANCIA_CENTIMOS = 1;

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
  const enlaces = extraerEnlacesPdf(html ?? "").slice(0, MAX_ENLACES_A_INTENTAR);
  if (enlaces.length < 2) return { verificado: false, motivo: "menos de 2 enlaces a PDF en el cuerpo", leidas: [] };

  const carpeta = await mkdtemp(join(tmpdir(), "wobi-factura-enlazada-"));
  const leidas: FacturaEnlazadaLeida[] = [];
  try {
    for (const enlace of enlaces) {
      try {
        const bytes = await deps.descargar(enlace.url);
        const nombre = `${leidas.length}.pdf`;
        const rutaLocal = join(carpeta, nombre);
        await writeFile(rutaLocal, bytes);
        const datos = await deps.extraer(rutaLocal, "application/pdf", contextoCorreo, enlace.texto || nombre);
        if (datos.esFacturaOGasto) leidas.push({ url: enlace.url, datos });
      } catch (error) {
        // Un enlace roto/lento/no-PDF no invalida el resto — solo reduce la evidencia disponible.
        console.error("[facturasEnlazadasEnCuerpo] No se pudo leer un enlace (se ignora, no bloquea el resto):", {
          url: enlace.url,
          error: error instanceof DescargaFacturaEnlazadaError || error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await rm(carpeta, { recursive: true, force: true }).catch(() => undefined);
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
  const personaAsociada = gastoDetectado.personaAsociada ?? leidas.find(l => l.datos.personaAsociada)?.datos.personaAsociada;
  const contextoDeViaje = gastoDetectado.contextoDeViaje || leidas.some(l => l.datos.contextoDeViaje);
  // El cuerpo del correo suele decir el importe pero no siempre la fecha (Carlos, caso real: "no
  // reconoce la fecha"); las facturas reales sí la traen impresa. Solo se rellena, nunca se
  // contradice, y solo si TODAS coinciden — si difieren, mejor dejarla en blanco que adivinar cuál.
  const fechasFacturas = new Set(leidas.map(l => l.datos.fecha).filter(Boolean));
  const fecha = gastoDetectado.fecha || (fechasFacturas.size === 1 ? [...fechasFacturas][0] : gastoDetectado.fecha);

  const datosCombinados: DatosFactura = {
    ...gastoDetectado,
    numeroDocumento: numerosDocumento ?? gastoDetectado.numeroDocumento,
    personaAsociada,
    contextoDeViaje,
    fecha,
    confianza: confianzaCombinada,
    concepto: `${gastoDetectado.concepto} — ${leidas.length} facturas enlazadas verificadas por su suma: ${desglose}`,
    razon: `${gastoDetectado.razon ?? ""} [Importe verificado leyendo ${leidas.length} facturas enlazadas en el cuerpo del correo; su suma exacta coincide con el importe indicado.]`.trim(),
  };

  return { verificado: true, leidas, datosCombinados };
}
