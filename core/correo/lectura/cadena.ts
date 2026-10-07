/**
 * Lectura de la CADENA de un correo: quién lo escribe de verdad, quién lo reenvió, quién lo originó y cuál es el mensaje
 * nuevo frente al historial citado. Pura: sin red ni IA, probada con formatos reales del buzón de Wobi (Gmail en español e
 * inglés, Outlook, cadenas de respuestas con citas «>», reenvíos dentro de respuestas).
 *
 * Por qué existe: la cabecera «De» de un correo reenviado es quien lo reenvió (casi siempre alguien del grupo), no quien lo
 * originó, y el clasificador recibía el cuerpo entero —citas incluidas— cortado a 8.000 caracteres. 28 de los 40 correos
 * con «Re:/Fwd:» de las últimas semanas eran reenvíos.
 */

export interface Persona { nombre?: string; email?: string }

export interface MensajeEnCadena {
  de: Persona;
  fecha?: string;
  asunto?: string;
  /** «reenvio» (bloque Forwarded message), «original» (Original Message/Outlook), «cita» (On … wrote / El … escribió). */
  origen: "reenvio" | "original" | "cita";
  /** Texto del propio mensaje, hasta el siguiente encabezado de la cadena. */
  texto: string;
}

export interface LecturaCadena {
  /** Quien aparece en la cabecera «De» del correo recibido. */
  cabecera: Persona;
  /** Lo que escribió quien envió ESTE correo (sin el historial citado). En un reenvío, su nota. */
  mensajeNuevo: string;
  /** Mensajes anteriores de la cadena, del más reciente al más antiguo. */
  cadena: MensajeEnCadena[];
  /** Hay un bloque «Forwarded message» / «Mensaje reenviado» (no citado): el correo es un reenvío. */
  esReenvio: boolean;
  /** Persona de la que parte la petición o el documento: el autor del mensaje reenviado más reciente, o la cabecera si no es reenvío. */
  remitenteReal: Persona;
  /** Quien reenvió el correo al buzón (solo si es un reenvío y el autor real es otra persona). */
  reenviadoPor?: Persona;
  /** El autor más antiguo de la cadena que no es el propio buzón. */
  originador: Persona;
}

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const EMAIL_EXACTO = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const BUZON_PROPIO = /^(asistente|admin)@wobagroup\.com$/i;

/**
 * «Admin Asistente <a@b.com<mailto:a@b.com>>», «<x@y.com>», «x@y.com», «Nombre» → { nombre?, email? }.
 * Endurecida (hallazgos de la revisión adversarial del extractor anterior): la dirección es SIEMPRE la que va entre ángulos
 * (o la cadena entera si es una dirección suelta), nunca una subcadena del nombre visible; un nombre que contiene «@» no es
 * un nombre; un ángulo sin cerrar o texto con «<» antes de la dirección es un formato corrupto y no produce email.
 * «Nombre (x@y.com)» sin ángulos tampoco se acepta aquí (las atribuciones de cita tienen su propio camino).
 */
export function parsearPersona(texto: string): Persona {
  const limpio = texto.replace(/<mailto:[^>]*>/gi, "").replace(/\s+/g, " ").trim();
  const angulos = [...limpio.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)];
  const ultimo = angulos[angulos.length - 1];
  let email: string | undefined;
  let antes = limpio;
  if (ultimo && ultimo.index !== undefined) {
    antes = limpio.slice(0, ultimo.index);
    if (!/[<>]/.test(antes) && EMAIL_EXACTO.test(ultimo[1])) email = ultimo[1].toLowerCase();
  } else if (EMAIL_EXACTO.test(limpio)) {
    email = limpio.toLowerCase(); antes = "";
  }
  if (email === undefined && ultimo) return { nombre: undefined, email: undefined };
  let nombre = antes.replace(/[<>()\[\]"]/g, " ").replace(/\s+/g, " ").trim().replace(/^[,;:\-–—]+|[,;:\-–—]+$/g, "").trim();
  if (nombre.includes("@")) nombre = "";
  return { nombre: nombre || undefined, email };
}

/**
 * Quita la firma y los avisos legales del final de un texto: en un reenvío sin nota, el «mensaje nuevo» era solo la firma de
 * quien reenvía (710 caracteres de logos y aviso de confidencialidad). Solo se corta desde una marca inequívoca de firma
 * hasta el final: un «[image: …]» suelto en medio del mensaje NO cuenta.
 */
export function quitarFirma(texto: string): string {
  const lineas = texto.split("\n");
  const MARCAS = [
    /<#SignatureSanitizer_>/i, /^\s*\[image:\s*WOBA\]\s*$/i, /^-- ?$/, /^\s*(Enviado desde mi|Sent from my)\b/i,
    /^\s*[“"']?The information contained in this message/i, /^\s*go to disclaimer\b/i,
    /^\s*(Este mensaje|La informaci[óo]n contenida en este mensaje)\b.*\b(confidencial|privilegiad)/i,
  ];
  const corte = lineas.findIndex((l) => MARCAS.some((m) => m.test(l)));
  const sinFirma = corte >= 0 ? lineas.slice(0, corte) : lineas;
  return sinFirma.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const quitarCita = (l: string): string => l.replace(/^(?:\s*>)+\s?/, "");
const profundidad = (l: string): number => (/^((?:\s*>)+)/.exec(l)?.[1].match(/>/g) ?? []).length;

const MARCA_REENVIO = /^-{2,}\s*(forwarded message|mensaje reenviado|mensaje original reenviado)\s*-{2,}\s*$/i;
const MARCA_ORIGINAL = /^-{2,}\s*(original message|mensaje original)\s*-{2,}\s*$/i;
const CAMPO = /^\s*(From|De|Von|Da)\s*:\s*(.*)$/i;
const CAMPO_FECHA = /^\s*(Date|Fecha|Enviado|Sent|Envoy[eé]|Datum)\s*:\s*(.*)$/i;
const CAMPO_ASUNTO = /^\s*(Subject|Asunto|Objet|Betreff)\s*:\s*(.*)$/i;
const CAMPO_PARA = /^\s*(To|Para|À|An)\s*:/i;
const ESCRIBIO = /^\s*(?:On|El|Le|Am)\b(.{3,300}?)\b(wrote|escribi[óo]|a [ée]crit|schrieb)\s*:?\s*$/i;
const ESCRIBIO_INICIO = /^\s*(?:On|El|Le|Am)\b[^\n]{3,200}$/i;
const ESCRIBIO_FIN = /^[^\n]{0,120}\b(wrote|escribi[óo]|a [ée]crit|schrieb)\s*:?\s*$/i;
const SEPARADOR_OUTLOOK = /^_{10,}\s*$/;

interface Marca { indice: number; hasta: number; origen: MensajeEnCadena["origen"]; de?: Persona; fecha?: string; asunto?: string }

function personaDeAtribucion(textoAtribucion: string): Persona {
  // «On Tue, Oct 6, 2026 at 10:21 AM Admin Asistente <a@b.com> wrote:» · «El mié, 30 sept 2026 a la(s) 2:34 p.m., Jaquelin Lovey (j@x.com) escribió:»
  const m = EMAIL.exec(textoAtribucion);
  if (!m) return {};
  const antes = textoAtribucion.slice(0, m.index).replace(/<mailto:[^>]*>/gi, "");
  const trozos = antes.split(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?\s?m\.?)?\s*,?\s*(?:\(s\))?/i);
  const candidato = (trozos[trozos.length - 1] ?? antes).replace(/^[\s,;:)\-–—a-z]*?(?=[A-ZÁÉÍÓÚÑ])/, "");
  // La atribución de Gmail escribe «Nombre <x@y>» o «Nombre (x@y)»: se normaliza a ángulos antes de usar el parser estricto.
  const persona = parsearPersona(`${candidato.replace(/[<>()]/g, " ")} <${m[0]}>`);
  return { nombre: persona.nombre && !/^(on|el|le|am)\b/i.test(persona.nombre) ? persona.nombre : undefined, email: persona.email };
}

/** Encuentra los encabezados de mensaje anterior en el texto (ya sin prefijos de cita, con la profundidad guardada aparte). */
function buscarMarcas(lineas: string[]): Marca[] {
  const marcas: Marca[] = [];
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].trim();
    if (MARCA_REENVIO.test(l) || MARCA_ORIGINAL.test(l)) {
      const origen = MARCA_REENVIO.test(l) ? "reenvio" : "original";
      const m: Marca = { indice: i, hasta: i, origen };
      for (let j = i + 1; j <= Math.min(i + 12, lineas.length - 1); j++) {
        const lj = lineas[j];
        if (!lj.trim()) { if (m.de || j > i + 8) break; continue; }
        const campo = CAMPO.exec(lj);
        if (campo && !m.de) { m.de = parsearPersona(campo[2]); m.hasta = j; continue; }
        const fecha = CAMPO_FECHA.exec(lj);
        if (fecha) { m.fecha = fecha[2].trim(); m.hasta = j; continue; }
        const asunto = CAMPO_ASUNTO.exec(lj);
        if (asunto) { m.asunto = asunto[2].trim(); m.hasta = j; continue; }
        if (CAMPO_PARA.test(lj) || /^\s*(Cc|CC|Cco|Bcc)\s*:/.test(lj)) { m.hasta = j; continue; }
        if (m.de) break;
      }
      if (m.de) { marcas.push(m); i = m.hasta; }
      continue;
    }
    // Atribución «On … wrote:» en una o dos líneas.
    const una = ESCRIBIO.exec(l);
    if (una) { marcas.push({ indice: i, hasta: i, origen: "cita", de: personaDeAtribucion(l) }); continue; }
    if (ESCRIBIO_INICIO.test(l) && i + 1 < lineas.length && ESCRIBIO_FIN.test(lineas[i + 1].trim()) && EMAIL.test(l + " " + lineas[i + 1])) {
      marcas.push({ indice: i, hasta: i + 1, origen: "cita", de: personaDeAtribucion(`${l} ${lineas[i + 1].trim()}`) });
      i += 1; continue;
    }
    // Bloque de Outlook en línea: «De: …» seguido de «Enviado/Sent/Fecha: …» tras una raya (o sin ella).
    const campo = CAMPO.exec(lineas[i]);
    if (campo && /^[A-Za-zÁÉÍÓÚáéíóúñ]/.test(campo[2]) || campo && EMAIL.test(campo[2])) {
      const siguientes = lineas.slice(i + 1, i + 5);
      const fechaLinea = siguientes.findIndex((x) => CAMPO_FECHA.test(x));
      const previoRaya = i > 0 && SEPARADOR_OUTLOOK.test(lineas[i - 1].trim());
      if (fechaLinea >= 0 && (previoRaya || siguientes.some((x) => CAMPO_PARA.test(x) || CAMPO_ASUNTO.test(x)))) {
        const m: Marca = { indice: previoRaya ? i - 1 : i, hasta: i + 1 + fechaLinea, origen: "original", de: parsearPersona(campo[2]) };
        for (const x of siguientes) { const a = CAMPO_ASUNTO.exec(x); if (a) m.asunto = a[2].trim(); const f = CAMPO_FECHA.exec(x); if (f) m.fecha = f[2].trim(); }
        marcas.push(m); i = m.hasta;
      }
    }
  }
  return marcas;
}

const mismaPersona = (a: Persona, b: Persona): boolean =>
  !!a.email && !!b.email ? a.email === b.email : !!a.nombre && !!b.nombre && a.nombre.toLowerCase() === b.nombre.toLowerCase();
const esBuzon = (p: Persona): boolean => !!p.email && BUZON_PROPIO.test(p.email);

export function leerCadena(deCabecera: string, cuerpo: string): LecturaCadena {
  const cabecera = parsearPersona(deCabecera);
  const crudo = cuerpo.replace(/\r/g, "").split("\n");
  // Cada línea queda sin sus «>» y se recuerda su profundidad: la cadena puede venir citada entera.
  const lineas = crudo.map(quitarCita);
  const marcas = buscarMarcas(lineas);

  const primera = marcas[0];
  const mensajeNuevo = quitarFirma((primera ? lineas.slice(0, primera.indice) : lineas)
    .filter((_, i) => profundidad(crudo[i]) === 0).join("\n").replace(/\n{3,}/g, "\n\n").trim());

  const cadena: MensajeEnCadena[] = marcas.map((m, k) => {
    const fin = k + 1 < marcas.length ? marcas[k + 1].indice : lineas.length;
    return { de: m.de ?? {}, fecha: m.fecha, asunto: m.asunto, origen: m.origen, texto: lineas.slice(m.hasta + 1, fin).join("\n").replace(/\n{3,}/g, "\n\n").trim() };
  });

  // Reenvío = hay un bloque de reenvío al nivel superior (no citado) antes de cualquier atribución de cita.
  const marcaReenvio = marcas.find((m) => m.origen === "reenvio" && profundidad(crudo[m.indice]) === 0);
  const esReenvio = !!marcaReenvio;

  const autores = cadena.map((m) => m.de).filter((p) => p.email || p.nombre);
  const noBuzon = autores.filter((p) => !esBuzon(p));
  const reenviador = cabecera;
  let remitenteReal: Persona = cabecera;
  if (esReenvio) {
    const candidato = noBuzon.find((p) => !mismaPersona(p, reenviador));
    if (candidato) remitenteReal = { nombre: candidato.nombre, email: candidato.email };
  }
  const originador = noBuzon.length ? noBuzon[noBuzon.length - 1] : cabecera;
  const reenviadoPor = esReenvio && !mismaPersona(remitenteReal, reenviador) ? reenviador : undefined;
  return { cabecera, mensajeNuevo, cadena, esReenvio, remitenteReal, reenviadoPor, originador };
}

export const describirPersona = (p: Persona): string =>
  p.nombre && p.email ? `${p.nombre} <${p.email}>` : p.email ?? p.nombre ?? "(desconocido)";

export interface RemitenteOriginalReenvio { nombre?: string; email: string }

/** Compatibilidad con el camino de «correo puntual»: el remitente real del contenido reenviado, si es un reenvío con dirección. */
export function remitenteOriginalDeReenvio(deCabecera: string, cuerpo: string): RemitenteOriginalReenvio | undefined {
  const l = leerCadena(deCabecera, cuerpo);
  return l.esReenvio && l.remitenteReal.email && l.reenviadoPor ? { nombre: l.remitenteReal.nombre, email: l.remitenteReal.email } : undefined;
}
