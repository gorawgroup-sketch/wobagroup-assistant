/**
 * Clasificación ticket / factura / revisar de un documento al recibirlo. Se decide UNA vez, con las señales del propio
 * documento, y se guarda con su evidencia. Reglas (pedido de Carlos): jamás se llama «ticket» a un documento solo
 * porque falte el número de factura u otro dato; ante la duda, «revisar» (cola de revisión nocturna).
 */
export type TipoDocumento = "ticket" | "factura" | "revisar";

export interface SenalesDocumento {
  proveedor: string;
  numeroDocumento?: string;
  /** El extractor lo marca true «ante la duda» (sirve para decidir IVA deducible): por sí solo NO prueba que sea ticket. */
  reciboSimplificado?: boolean;
  /** Texto libre del documento/correo que el extractor devolvió (concepto, razón…). */
  textoEvidencia?: string;
  /** El documento muestra NIF/CIF/VAT del comprador (empresa del grupo) impreso. */
  identificaComprador?: boolean;
}

export interface ClasificacionDocumento { tipo: TipoDocumento; motivos: string[]; senales: Record<string, unknown> }

const TITULO_TICKET = /\b(ticket|tique|tiquet|factura\s+simplificada|recibo\s+simplificado|simplified\s+(invoice|receipt)|till\s+receipt|boleta)\b/i;
const TITULO_FACTURA = /\b(factura\s+(?:n[ºo°.]|n[úu]mero|completa)|invoice\s+(?:no|number|#)|tax\s+invoice|rechnung)/i;

export function clasificarDocumento(s: SenalesDocumento): ClasificacionDocumento {
  const texto = s.textoEvidencia ?? "";
  const tituloTicket = TITULO_TICKET.test(texto);
  const tituloFactura = TITULO_FACTURA.test(texto);
  const senales = { reciboSimplificado: s.reciboSimplificado ?? null, tieneNumero: Boolean(s.numeroDocumento),
    identificaComprador: s.identificaComprador ?? null, tituloTicket, tituloFactura };

  // Una factura completa a nombre de la empresa es factura, aunque el extractor dudara.
  if (s.identificaComprador === true && !tituloTicket) return { tipo: "factura", motivos: ["identifica al comprador con sus datos fiscales"], senales };
  // Ticket SOLO con señal positiva: el documento se declara ticket/simplificado Y no identifica al comprador.
  if (tituloTicket && s.identificaComprador !== true && !tituloFactura) {
    return { tipo: "ticket", motivos: ["el documento se declara ticket/factura simplificada", "no identifica al comprador"], senales };
  }
  if (tituloFactura && s.identificaComprador !== false && !s.reciboSimplificado) {
    return { tipo: "factura", motivos: ["el documento se declara factura con número"], senales };
  }
  const motivos = ["señales insuficientes o contradictorias"];
  if (!s.numeroDocumento) motivos.push("falta el número, pero eso por sí solo no basta para llamarlo ticket");
  if (s.reciboSimplificado) motivos.push("el extractor lo marcó simplificado (puede ser solo por duda fiscal)");
  return { tipo: "revisar", motivos, senales };
}
