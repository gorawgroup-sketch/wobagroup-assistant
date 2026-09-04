import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { estaConciliado, type Empresa } from "./client";
import { formatDateLocal } from "../utils/dateFormat";
import { buscarAliasProveedor } from "../gastos/proveedorAliasSheet";
import { montosCercanos } from "../utils/montos";
import { textosParecidos } from "../utils/textoParecido";
import { registrarUsoIA } from "../claude/costTracking";
import { transcribirParaCaptura } from "../documental/transcribeForCapture";

const HOLDED_API_BASE = "https://api.holded.com/api/v2";

/**
 * Cliente de escritura de Holded, separado del de solo lectura (client.ts):
 * usa una API key distinta (HOLDED_API_KEY_WRITE_*), generada con permiso
 * de escritura acotado al módulo de Contabilidad/Compras — la key de
 * lectura no tiene ese permiso a propósito (principio de menor privilegio,
 * mismo patrón que los clientes de Google separados por lectura/escritura).
 *
 * Verificado en vivo antes de construir sobre esto: el endpoint real para
 * crear un gasto es POST /api/v2/purchases (no /invoicing/v1/documents/...
 * como sugiere documentación de terceros desactualizada — ese endpoint
 * devuelve "Invalid key" sin importar la key usada).
 */
const ENV_VAR_WRITE_POR_EMPRESA: Record<Empresa, string> = {
  WOBA: "HOLDED_API_KEY_WRITE_WOBA",
  EWORKS: "HOLDED_API_KEY_WRITE_EWORKS",
  // La key de Footprint (a diferencia de WOBA/EWORKS) vino con permiso de
  // lectura Y escritura en una sola credencial — se reutiliza el mismo
  // valor para ambos roles (HOLDED_API_KEY_FOOTPRINT en client.ts), pero el
  // código mantiene la separación read/write de todas formas.
  Footprint: "HOLDED_API_KEY_WRITE_FOOTPRINT",
};

function getWriteApiKey(empresa: Empresa): string {
  const envVar = ENV_VAR_WRITE_POR_EMPRESA[empresa];
  const key = process.env[envVar];
  if (!key) {
    throw new Error(`Falta la variable de entorno ${envVar}`);
  }
  return key;
}

async function holdedWriteCall(
  empresa: Empresa,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown
): Promise<unknown> {
  const apiKey = getWriteApiKey(empresa);

  const response = await fetch(`${HOLDED_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Error de la API de Holded (${response.status}) para ${empresa}: ${errBody}`);
  }

  return response.json();
}

export interface HoldedContact {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Quita acentos, mayúsculas, y puntuación de razón social (comas, puntos de
 * abreviatura, espacios repetidos). Sin esto, "OCEAN FACILITY SERVICES, S.A."
 * (como lo lee la extracción de factura) nunca hacía match por substring con
 * "OCEAN FACILITY SERVICES SA." (como está el contacto real en Holded) —
 * verificado en vivo, causaba falsos "no encontré el proveedor".
 */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_PAGINAS_CONTACTOS = 20;

/** Trae TODOS los contactos de Holded (paginado) — base compartida de buscarContactoHolded y buscarContactosParecidos. */
async function obtenerTodosLosContactos(empresa: Empresa): Promise<HoldedContact[]> {
  const contactos: HoldedContact[] = [];
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS_CONTACTOS; pagina++) {
    const path = `/contacts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = (await holdedWriteCall(empresa, "GET", path)) as {
      items?: HoldedContact[];
      cursor?: string;
      has_more?: boolean;
    };

    contactos.push(...(data.items ?? []));

    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return contactos;
}

// Nunca aceptar un match de buscarContactoHolded que dependa SOLO de una
// palabra compartida por más de esta cantidad de contactos reales — ver
// comentario en compartenPalabraDistintiva.
const MAX_CONTACTOS_COMPARTIENDO_PALABRA = 2;

/**
 * true si `objetivo` y `candidatoNombre` comparten alguna palabra (5+
 * caracteres) que sea DISTINTIVA dentro de la lista real de contactos —
 * nunca alcanza con una palabra genérica del rubro que muchos contactos no
 * relacionados también tienen. Bug real encontrado en vivo: un ticket de
 * taxi en México (proveedor real impreso: "Taxistas Agremiados para el
 * Servicio de Transportación") quedó asignado al contacto "CONSORCIO
 * REGIONAL DE TRANSPORTES DE MADRID" — geográfica y comercialmente sin
 * ninguna relación — solo porque ambos comparten la palabra "transporte",
 * que en la lista real de contactos aparece en varias empresas de
 * transporte no relacionadas entre sí. Para CONTACTOS (a diferencia de
 * otros usos de textosParecidos, donde el candidato ya viene acotado y el
 * costo de un falso positivo es bajo) el estándar tiene que ser más alto:
 * asignar el proveedor equivocado a un gasto real es un error de
 * bookkeeping — pedido explícito de Carlos: "si no tienes seguridad, lo
 * dejas sin contacto o preguntas".
 */
/**
 * Puntúa cuánto de DISTINTIVO hay en el match entre objetivo y candidato —
 * suma la longitud de cada palabra del objetivo (5+ caracteres) que (a)
 * aparece parecida en el candidato Y (b) es realmente distintiva (la
 * comparten pocos contactos reales, ver MAX_CONTACTOS_COMPARTIENDO_PALABRA).
 * 0 si ninguna palabra compartida es distintiva.
 *
 * Bug real encontrado en vivo (segunda vuelta del mismo problema): con un
 * solo booleano "¿hay AL MENOS una palabra distintiva?", buscarContactoHolded
 * usaba .find() y se quedaba con el PRIMER candidato que pasara, sin
 * importar si otro candidato tenía una coincidencia mucho más fuerte — caso
 * real: buscando "INTERMODALIDAD DE LEVANTE SA", "GASTRO LEVANTE" (solo
 * comparte "levante") ganaba por orden de aparición aunque "INTERMODALIDAD
 * DE LEVANTE SA" comparte TANTO "intermodalidad" (palabra muy específica)
 * COMO "levante". Puntuar por fuerza total (no solo boolean) y comparar
 * entre TODOS los candidatos arregla esto.
 *
 * Bug real encontrado en vivo (tercera vuelta): el conteo de "¿cuántos
 * contactos comparten esta palabra?" reutilizaba palabrasParecidas, el
 * mismo matcher de prefijo corto (5 caracteres) pensado para tolerar typos
 * de OCR en la detección de candidatos. Para una palabra larga como
 * "intermodalidad" eso genera falsos positivos masivos: "INTERNATIONAL",
 * "INTERAMERI", "INTERURBANOS", "Intermarche" y otros 13 contactos reales
 * no relacionados comparten el prefijo "inter", así que "intermodalidad"
 * aparecía como compartida por 17 contactos y se descartaba como no
 * distintiva — dejando a "INTERMODALIDAD DE LEVANTE SA" empatada en score
 * con "GASTRO LEVANTE" (ambas solo por "levante") en vez de ganar con
 * claridad. El conteo de distintividad usa un prefijo más largo
 * (palabrasParecidasEstricto) que solo tolera variantes cortas reales
 * (plural/singular), no colisiones de prefijo entre palabras largas y no
 * relacionadas.
 *
 * Segundo ajuste dentro del mismo caso real: incluso con prefijo largo,
 * "intermodalidad" (14) seguía "compartida" con "INTER RAPIDISIMO S.A"
 * porque la palabra candidata ahí es solo "inter" (5 caracteres) — el
 * prefijo efectivo queda acotado por la palabra MÁS CORTA, así que comparar
 * contra una palabra corta siempre "coincide" aunque la palabra larga no
 * tenga relación real. Exigir que la palabra más corta de las dos tenga un
 * largo mínimo razonable (6) antes de contarla como colisión evita esto sin
 * perder la tolerancia a variantes reales (plural/singular) entre palabras
 * de largo similar.
 */
function palabrasParecidasEstricto(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 6) return false;
  const prefijo = Math.min(8, minLen);
  return a.slice(0, prefijo) === b.slice(0, prefijo);
}

function puntuarDistintividad(objetivo: string, candidatoNombre: string, todosLosNombres: string[]): number {
  const palabrasObjetivo = normalizar(objetivo)
    .split(" ")
    .filter((p) => p.length >= 5);
  const palabrasCandidato = normalizar(candidatoNombre)
    .split(" ")
    .filter((p) => p.length >= 3);

  let score = 0;
  for (const po of palabrasObjetivo) {
    if (!palabrasCandidato.some((pc) => palabrasParecidas(po, pc))) continue;

    const contactosQueComparten = todosLosNombres.filter((otro) =>
      normalizar(otro)
        .split(" ")
        .some((p) => p.length >= 3 && palabrasParecidasEstricto(po, p))
    ).length;

    if (contactosQueComparten <= MAX_CONTACTOS_COMPARTIENDO_PALABRA) {
      score += po.length;
    }
  }
  return score;
}

/**
 * Busca un contacto de Holded por nombre (coincidencia parcial, insensible a
 * mayúsculas/acentos/puntuación). Primero revisa el alias aprendido (ver
 * proveedorAliasSheet.ts) — un nombre que el usuario ya confirmó
 * manualmente antes para este proveedor+empresa — y si no hay, pagina los
 * contactos reales de Holded (el parámetro `name` no filtra en el servidor)
 * y filtra localmente. Nunca inventa un contact_id: si no encuentra
 * coincidencia (o la única coincidencia depende de una palabra demasiado
 * genérica, ver compartenPalabraDistintiva), devuelve undefined — el
 * llamador cae al flujo de alternativas (buscarContactosParecidos) en vez
 * de asignar un contacto sin verificar.
 */
export async function buscarContactoHolded(empresa: Empresa, nombre: string): Promise<HoldedContact | undefined> {
  const alias = await buscarAliasProveedor(empresa, nombre).catch(() => undefined);
  if (alias) return { id: alias.contactId, name: alias.contactName };

  const contactos = await obtenerTodosLosContactos(empresa);
  const conNombre = contactos.filter((c): c is HoldedContact & { name: string } => typeof c.name === "string");
  const todosLosNombres = conNombre.map((c) => c.name);

  // textosParecidos, no un substring simple — mismo bug real que
  // buscarGastoSimilar: un nombre comercial ("Booking.com") nunca es
  // substring de la razón social real del contacto en Holded ("BOOKING
  // HOLDINGS Inc. (Booking)") ni al revés. Antes esto solo se salvaba
  // cuando ya existía un alias aprendido de antes — para un proveedor
  // nuevo sin alias, fallaba en silencio.
  const candidatos = conNombre.filter((c) => textosParecidos(nombre, c.name));
  if (candidatos.length === 0) return undefined;

  const puntuados = candidatos
    .map((c) => ({ contacto: c, score: puntuarDistintividad(nombre, c.name, todosLosNombres) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (puntuados.length === 0) return undefined;
  // Empate real entre el mejor y el segundo mejor -> ambiguo de verdad,
  // mejor no adivinar (cae a buscarContactosParecidos para preguntar).
  if (puntuados.length > 1 && puntuados[0].score === puntuados[1].score) return undefined;

  return puntuados[0].contacto;
}

/**
 * Dos palabras se consideran "la misma" para efectos de nombre parecido si
 * son iguales, o si comparten un prefijo largo — cubre plural/singular
 * ("facilities"/"facility") y variantes cortas ("oceana"/"ocean") sin
 * exigir coincidencia exacta, que es justo lo que falla cuando el nombre
 * viene de una extracción de factura con OCR/lectura imprecisa.
 */
function palabrasParecidas(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  const prefijo = Math.min(5, minLen);
  return a.slice(0, prefijo) === b.slice(0, prefijo);
}

/**
 * Cuando buscarContactoHolded no encuentra nada, ofrece alternativas por
 * nombre parecido en vez de solo decir "no lo encontré": compara por
 * palabras en común (ej. "Ocean Facility" con "OCEAN FACILITY SERVICES SA."
 * comparte "ocean" y "facility") en vez de exigir substring completo. El
 * puntaje pesa por longitud de palabra coincidente (no solo cuenta), para
 * que "facility"/"ocean" (específicas) pesen más que "sa"/"sl"/"service"
 * (genéricas y compartidas por muchos contactos). Nunca decide sola — solo
 * devuelve candidatos para que el usuario elija.
 */
export async function buscarContactosParecidos(empresa: Empresa, nombre: string, limite = 5): Promise<HoldedContact[]> {
  const palabrasObjetivo = normalizar(nombre)
    .split(" ")
    .filter((p) => p.length >= 3);
  if (palabrasObjetivo.length === 0) return [];

  const contactos = await obtenerTodosLosContactos(empresa);

  const puntuados = contactos
    .map((c) => {
      if (typeof c.name !== "string") return { contacto: c, score: 0 };
      const palabrasCandidato = normalizar(c.name)
        .split(" ")
        .filter((p) => p.length >= 3);
      const score = palabrasObjetivo
        .filter((po) => palabrasCandidato.some((pc) => palabrasParecidas(po, pc)))
        .reduce((suma, p) => suma + p.length, 0);
      return { contacto: c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return puntuados.slice(0, limite).map((x) => x.contacto);
}

export interface PurchaseCandidato {
  id: string;
  contactName: string;
  fecha: string;
  total: number;
  descripcion: string;
}

/** Los importes de /purchases vienen como string en formato ES ("1.234,56"). */
function parsearMontoHolded(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const normalizado = raw.replace(/\./g, "").replace(",", ".");
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Los importes de /treasury/.../bank-movements vienen en formato decimal
 * normal ("-3.77"), NO en formato ES como /purchases — verificado en vivo
 * (bug encontrado: usar parsearMontoHolded aquí convertía "-3.77" en -377,
 * porque interpretaba el punto como separador de miles). No confundir los
 * dos parsers aunque ambos "parseen un monto de Holded".
 */
function parsearMontoMovimiento(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Los gastos de Holded (y el cashflow) siempre están en EUR, pero una
 * cuenta bancaria puede operar en otra divisa (USD, GBP...) — `amount`
 * viene en la divisa nativa de la cuenta, no en EUR. Cuando `currency` no
 * es EUR, Holded ya trae el equivalente en `accounting_amount` — mismo
 * ajuste que se verificó en vivo para revisarHoldedVsCashflow.ts (pedido
 * explícito de Carlos, con capturas de Holded mostrando el valor nativo
 * arriba y el equivalente en EUR justo debajo). Sin esto, buscar un
 * movimiento parecido para conciliar un gasto en EUR contra una cuenta en
 * USD nunca encontraba nada, aunque el movimiento sí existiera.
 */
function montoEnEuros(mov: { amount?: string | number; currency?: string; accounting_amount?: string | number | null }): number {
  const monedaNativa = (mov.currency ?? "EUR").toUpperCase();
  if (monedaNativa !== "EUR" && mov.accounting_amount != null) {
    const convertido = parsearMontoMovimiento(mov.accounting_amount);
    if (Number.isFinite(convertido)) return convertido;
  }
  return parsearMontoMovimiento(mov.amount);
}

const TOLERANCIA_MONTO = 0.01;
const VENTANA_DIAS_BUSQUEDA = 10;
const MAX_PAGINAS_PURCHASES = 10;

/**
 * Busca gastos YA existentes en Holded que podrían corresponder a una
 * factura entrante — mismo proveedor (coincidencia parcial), monto dentro de
 * ±0.01, y fecha dentro de una ventana de ±10 días. Nunca decide un match
 * "aceptable" por sí sola: devuelve TODOS los candidatos razonables para que
 * el usuario confirme cuál es (o ninguno, si no hay), igual que
 * buscarContactoHolded nunca inventa un contact_id.
 */
export async function buscarGastoSimilar(
  empresa: Empresa,
  criterios: { proveedor: string; monto: number; fecha: string }
): Promise<PurchaseCandidato[]> {
  const fechaBase = new Date(criterios.fecha);

  const desde = new Date(fechaBase);
  desde.setDate(desde.getDate() - VENTANA_DIAS_BUSQUEDA);
  const hasta = new Date(fechaBase);
  hasta.setDate(hasta.getDate() + VENTANA_DIAS_BUSQUEDA);

  const candidatos: PurchaseCandidato[] = [];
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS_PURCHASES; pagina++) {
    const params = new URLSearchParams({
      limit: "100",
      start_date: formatDateLocal(desde),
      end_date: formatDateLocal(hasta),
    });
    if (cursor) params.set("cursor", cursor);

    const data = (await holdedWriteCall(empresa, "GET", `/purchases?${params.toString()}`)) as {
      items?: Array<{ id: string; contact_name?: string; date?: string; total?: string; description?: string }>;
      cursor?: string;
      has_more?: boolean;
    };

    for (const item of data.items ?? []) {
      if (!item.contact_name) continue;
      // textosParecidos, no un substring simple — bug real encontrado en
      // vivo: "Booking.com" (nombre comercial, como lo lee la extracción de
      // la factura) nunca es substring de "BOOKING HOLDINGS Inc. (Booking)"
      // (razón social real del contacto en Holded) ni al revés, así que
      // esta comprobación de "¿ya existe este gasto?" fallaba SIEMPRE para
      // ese caso real — arriesgando crear un gasto DUPLICADO en vez de
      // detectar el que ya existía.
      if (!textosParecidos(criterios.proveedor, item.contact_name)) continue;
      const total = parsearMontoHolded(item.total);
      if (!Number.isFinite(total) || !montosCercanos(total, criterios.monto, TOLERANCIA_MONTO)) continue;

      candidatos.push({
        id: item.id,
        contactName: item.contact_name,
        fecha: item.date ?? "",
        total,
        descripcion: item.description ?? "",
      });
    }

    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return candidatos;
}

/**
 * Cuando ni buscarContactoHolded ni buscarContactosParecidos encuentran nada
 * por nombre, esta es la segunda vía de alternativas: gastos YA registrados
 * en Holded con el MISMO importe (± tolerancia) en una ventana de fechas más
 * amplia, sin filtrar por proveedor — puede ser que la misma factura ya se
 * haya cargado bajo un nombre de contacto distinto al que leyó la extracción.
 * Deduplica por proveedor (se queda con el más reciente de cada uno).
 */
export async function buscarComprasPorMonto(
  empresa: Empresa,
  monto: number,
  fecha: string,
  ventanaDias = 15
): Promise<PurchaseCandidato[]> {
  const fechaBase = new Date(fecha);
  const desde = new Date(fechaBase);
  desde.setDate(desde.getDate() - ventanaDias);
  const hasta = new Date(fechaBase);
  hasta.setDate(hasta.getDate() + ventanaDias);

  const porProveedor = new Map<string, PurchaseCandidato>();
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS_PURCHASES; pagina++) {
    const params = new URLSearchParams({
      limit: "100",
      start_date: formatDateLocal(desde),
      end_date: formatDateLocal(hasta),
    });
    if (cursor) params.set("cursor", cursor);

    const data = (await holdedWriteCall(empresa, "GET", `/purchases?${params.toString()}`)) as {
      items?: Array<{ id: string; contact_name?: string; date?: string; total?: string; description?: string }>;
      cursor?: string;
      has_more?: boolean;
    };

    for (const item of data.items ?? []) {
      if (!item.contact_name) continue;
      const total = parsearMontoHolded(item.total);
      if (!Number.isFinite(total) || !montosCercanos(total, monto, TOLERANCIA_MONTO)) continue;

      const clave = normalizar(item.contact_name);
      const existente = porProveedor.get(clave);
      if (existente && existente.fecha >= (item.date ?? "")) continue;

      porProveedor.set(clave, {
        id: item.id,
        contactName: item.contact_name,
        fecha: item.date ?? "",
        total,
        descripcion: item.description ?? "",
      });
    }

    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return Array.from(porProveedor.values());
}

export interface DocumentoHoldedEstado {
  id: string;
  tipo: "gasto" | "ingreso";
  documentNumber: string;
  contactName: string;
  fecha: string;
  dueDate?: string;
  total: number;
  pagado: number;
  pendiente: number;
  status: string;
  draft: boolean;
  tags: string[];
  /** true si tiene al menos un comprobante adjunto en Holded — undefined si no se pudo verificar. */
  tieneComprobante?: boolean;
  /** true si este resultado vino de la segunda pasada (solo monto, sin match de nombre) — ver buscarDocumentosHolded. */
  coincidenciaSoloPorMonto: boolean;
  /**
   * true si NO coincidió por nombre de contacto, sino porque el texto
   * buscado aparece en una línea de producto/concepto del documento — ver
   * `lineaCoincidente`. Caso real que motivó esto: Alberto preguntó "¿a qué
   * proveedor le compramos lo último de Logitech?" — "Logitech" es una
   * marca, no necesariamente el nombre del contacto en Holded (se pudo
   * comprar vía Amazon, un distribuidor, etc.), así que buscar solo por
   * contact_name daba un falso negativo aunque la compra sí estuviera
   * registrada. El endpoint de LISTA de Holded ya trae `lines[].name` sin
   * necesitar una llamada aparte por documento (confirmado en
   * recolectarLineasConCuenta, más abajo), así que este chequeo es gratis.
   */
  coincidenciaPorLinea?: boolean;
  /** La línea de producto/concepto que matcheó, cuando coincidenciaPorLinea es true. */
  lineaCoincidente?: string;
}

// Más ancha que VENTANA_DIAS_BUSQUEDA (10 días, pensada para matchear un
// movimiento bancario recién llegado): acá se busca si una factura YA
// EXISTE en Holded aunque no se haya pagado, y esas facturas suelen tener
// fecha de bastante antes de cuando se pregunta por ellas (ej. servicio de
// junio con vencimiento en agosto, factura de limpieza del mes anterior).
const VENTANA_DIAS_BUSQUEDA_DOCUMENTOS = 120;
const TOLERANCIA_MONTO_DOCUMENTO = 1;
const MAX_PAGINAS_BUSQUEDA_DOCUMENTOS = 15;

async function buscarEnEndpointDocumentos(
  empresa: Empresa,
  path: "/purchases" | "/invoices",
  tipo: "gasto" | "ingreso",
  // undefined = no filtra por nombre, solo por monto (ver segunda pasada en buscarDocumentosHolded).
  contactoObjetivo: string | undefined,
  monto: number | undefined,
  desde: string,
  hasta: string
): Promise<DocumentoHoldedEstado[]> {
  const resultados: DocumentoHoldedEstado[] = [];
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS_BUSQUEDA_DOCUMENTOS; pagina++) {
    const params = new URLSearchParams({ limit: "100", start_date: desde, end_date: hasta });
    if (cursor) params.set("cursor", cursor);

    const data = (await holdedWriteCall(empresa, "GET", `${path}?${params.toString()}`)) as {
      items?: Array<{
        id: string;
        document_number?: string | null;
        contact_name?: string;
        date?: string;
        due_date?: string;
        total?: string;
        status?: string;
        payments_total?: string;
        payments_pending?: string;
        draft?: boolean;
        tags?: string[];
        lines?: Array<{ name?: string }>;
      }>;
      cursor?: string;
      has_more?: boolean;
    };

    for (const item of data.items ?? []) {
      if (!item.contact_name) continue;

      let coincidenciaPorLinea = false;
      let lineaCoincidente: string | undefined;

      if (contactoObjetivo && !textosParecidos(contactoObjetivo, item.contact_name)) {
        // No coincide el nombre del contacto — antes de descartar, revisa si
        // el texto buscado aparece en alguna línea de producto/concepto (ej.
        // "Logitech" comprado vía Amazon: el contacto es "Amazon", no
        // "Logitech", pero la línea sí lo menciona). El endpoint de lista ya
        // trae `lines[].name`, así que no hace falta una llamada aparte.
        const lineaMatch = (item.lines ?? []).find((l) => l.name && textosParecidos(contactoObjetivo, l.name));
        if (!lineaMatch) continue;
        coincidenciaPorLinea = true;
        lineaCoincidente = lineaMatch.name;
      }

      const total = parsearMontoHolded(item.total);
      if (monto !== undefined && Number.isFinite(total) && !montosCercanos(total, monto, TOLERANCIA_MONTO_DOCUMENTO)) {
        continue;
      }
      // Sin nombre Y sin monto no hay ningún criterio real de búsqueda — no debería llegar acá (buscarDocumentosHolded ya lo evita), pero por si acaso no se lista todo el histórico.
      if (!contactoObjetivo && monto === undefined) continue;

      resultados.push({
        id: item.id,
        tipo,
        documentNumber: item.document_number ?? "(borrador)",
        contactName: item.contact_name,
        fecha: item.date ?? "",
        dueDate: item.due_date,
        total,
        pagado: parsearMontoHolded(item.payments_total),
        pendiente: parsearMontoHolded(item.payments_pending),
        status: item.status ?? "desconocido",
        draft: item.draft ?? false,
        tags: item.tags ?? [],
        coincidenciaSoloPorMonto: !contactoObjetivo,
        coincidenciaPorLinea,
        lineaCoincidente,
      });
    }

    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return resultados;
}

/**
 * Busca facturas YA CARGADAS en Holded (gastos vía /purchases, ingresos vía
 * /invoices) que coincidan con un proveedor/cliente (nombre parecido) y,
 * opcionalmente, un monto — pensado para responder "¿ya está registrada
 * esta factura en Holded, aunque no se haya pagado?" en vez de asumir que
 * si no hay movimiento bancario todavía, la factura tampoco existe. Nace de
 * un caso real: dos gastos del cashflow (limpieza, restaurante) sin salida
 * bancaria — verificado en vivo que AMBOS ya estaban cargados en Holded
 * como facturas "pending" (payments_pending > 0), no faltaba registrarlos,
 * solo pagarlos.
 *
 * Si la búsqueda por nombre no encuentra nada Y se dio un monto, hace una
 * segunda pasada SOLO por monto (sin filtrar nombre) — el texto que llega
 * acá suele ser la categoría genérica del cashflow ("Limpieza",
 * "Restaurante"), no el nombre real del contacto en Holded ("OCEAN
 * FACILITY SERVICES SA.", "ADEL RESTAURACION SL."), así que exigir
 * coincidencia de nombre habría dejado esto sin encontrar nada en el caso
 * real que motivó esta herramienta.
 */
export async function buscarDocumentosHolded(
  empresa: Empresa,
  criterios: { contacto: string; monto?: number; tipo?: "gasto" | "ingreso" | "ambos"; dias?: number }
): Promise<DocumentoHoldedEstado[]> {
  const dias = criterios.dias && criterios.dias > 0 ? criterios.dias : VENTANA_DIAS_BUSQUEDA_DOCUMENTOS;
  const ahora = new Date();
  const desde = new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000);
  // Bug real encontrado en vivo (2026-09-03): "hasta" era HOY sin ningún
  // margen hacia adelante — un billete de avión comprado hoy para un vuelo
  // del 20 de octubre (fecha del documento = fecha del viaje, no de la
  // compra) quedaba INVISIBLE para esta búsqueda (Holded filtra
  // start_date/end_date server-side), aunque la compra sí existiera y
  // estuviera bien registrada. Cualquier documento con fecha futura
  // (viajes reservados con antelación, suscripciones facturadas por
  // adelantado, depósitos) tenía el mismo problema — se ensancha la
  // ventana simétricamente hacia adelante, mismo número de días que hacia
  // atrás.
  const hasta = new Date(ahora.getTime() + dias * 24 * 60 * 60 * 1000);
  const desdeStr = formatDateLocal(desde);
  const hastaStr = formatDateLocal(hasta);

  const tipo = criterios.tipo ?? "ambos";
  const paths: Array<{ path: "/purchases" | "/invoices"; tipoDoc: "gasto" | "ingreso" }> = [];
  if (tipo === "gasto" || tipo === "ambos") paths.push({ path: "/purchases", tipoDoc: "gasto" });
  if (tipo === "ingreso" || tipo === "ambos") paths.push({ path: "/invoices", tipoDoc: "ingreso" });

  const porNombre = (
    await Promise.all(
      paths.map((p) =>
        buscarEnEndpointDocumentos(empresa, p.path, p.tipoDoc, criterios.contacto, criterios.monto, desdeStr, hastaStr)
      )
    )
  ).flat();

  if (porNombre.length > 0 || criterios.monto === undefined) return verificarComprobantes(empresa, porNombre);

  const porMonto = (
    await Promise.all(
      paths.map((p) =>
        buscarEnEndpointDocumentos(empresa, p.path, p.tipoDoc, undefined, criterios.monto, desdeStr, hastaStr)
      )
    )
  ).flat();
  return verificarComprobantes(empresa, porMonto);
}

/**
 * Añade tieneComprobante a cada resultado tipo "gasto" (los ingresos no
 * pasan por el flujo de adjuntar comprobante de este sistema, se dejan sin
 * verificar) — pensado para responder "¿este gasto ya quedó bien montado?"
 * con la misma precisión que se usa al crear/revisar un gasto, no solo si
 * existe. Acotado a los resultados YA filtrados (unos pocos), nunca escanea
 * todo Holded.
 */
async function verificarComprobantes(empresa: Empresa, resultados: DocumentoHoldedEstado[]): Promise<DocumentoHoldedEstado[]> {
  await Promise.all(
    resultados.map(async (r) => {
      if (r.tipo !== "gasto") return;
      try {
        const attachments = (await holdedWriteCall(empresa, "GET", `/purchases/${r.id}/attachments`)) as { items?: unknown[] };
        r.tieneComprobante = (attachments.items ?? []).length > 0;
      } catch (error) {
        console.error(`[write] Error verificando comprobante de ${r.id} (no crítico):`, error);
      }
    })
  );
  return resultados;
}

// Pedido explícito de Carlos: además del nombre de quien hizo el gasto
// (personaAsociada, ver extractInvoiceData.ts), el tag debe reflejar la
// naturaleza real de ESTE gasto en concreto — alimentación, o transporte
// con su medio específico (taxi/tren/avión) — a partir de palabras clave
// del concepto/proveedor, no del promedio histórico de tags de la cuenta
// contable (que mezcla nombres de personas con categorías sin relación
// real con el gasto concreto — bug real: un viaje en Uber terminó con tag
// "alimentacion" solo porque esa cuenta contable históricamente acumulaba
// ese tag en otras líneas). Los nombres "alimentacion"/"transporte" son
// los mismos ya vistos en uso real en Holded (verificado en vivo).
const PALABRAS_ALIMENTACION = ["restaurante", "almuerzo", "desayuno", "cena", "comida", "cafeteria", "brunch"];
const PALABRAS_TAXI = ["taxi", "uber", "cabify", "bolt", "freenow"];
const PALABRAS_TREN = ["tren", "renfe", "eurostar", "sncf", "trenitalia", "ouigo", "avanza"];
const PALABRAS_AVION = [
  "vuelo",
  "aerolinea",
  "boarding",
  "iberia",
  "klm",
  "ryanair",
  "easyjet",
  "air europa",
  "vueling",
  "lufthansa",
  "avianca",
  "latam",
  "emirates",
  "qatar airways",
  "american airlines",
];

function contienePalabraClave(texto: string, palabras: string[]): boolean {
  const t = normalizar(texto);
  return palabras.some((p) => t.includes(normalizar(p)));
}

/**
 * Detecta tags de categoría a partir de la naturaleza real de ESTE gasto
 * (concepto + proveedor tal como se leyeron de la factura) — nunca decide
 * "a ciegas": si no reconoce ninguna palabra clave, no agrega ningún tag de
 * categoría en vez de inventar uno.
 */
export function inferirTagsCategoria(concepto: string, proveedor: string): string[] {
  const texto = `${concepto} ${proveedor}`;

  if (contienePalabraClave(texto, PALABRAS_TAXI)) return ["transporte", "taxi"];
  if (contienePalabraClave(texto, PALABRAS_TREN)) return ["transporte", "tren"];
  if (contienePalabraClave(texto, PALABRAS_AVION)) return ["transporte", "avion"];
  if (contienePalabraClave(texto, PALABRAS_ALIMENTACION)) return ["alimentacion"];

  return [];
}

export interface CuentaSugerida {
  accountId: string;
  tags: string[];
  ejemplo: string;
  aprendidoDe: "proveedor" | "concepto" | "ia";
}

interface LineaConCuenta {
  contactName: string;
  descripcion: string;
  lineName: string;
  account: string;
  tags: string[];
}

const MAX_PAGINAS_CUENTAS = 10;
// 5+ caracteres (no 4) a propósito, igual que textosParecidos — bug real
// encontrado en vivo: con el umbral en 4, palabras genéricas cortas
// (ej. "real", "cargo") de un concepto sintético coincidían por azar con
// líneas de compra totalmente ajenas (una factura de suscripción de
// Holded), llevando a una cuenta contable sin ninguna relación real.
const PALABRAS_IGNORADAS_CONCEPTO = new Set(["para", "desde", "sobre", "hasta", "todavía", "documento", "adjunto", "generado"]);

function palabrasSignificativas(texto: string): string[] {
  return normalizar(texto)
    .split(/\s+/)
    .filter((p) => p.length >= 5 && !PALABRAS_IGNORADAS_CONCEPTO.has(p));
}

async function recolectarLineasConCuenta(empresa: Empresa): Promise<LineaConCuenta[]> {
  const lineas: LineaConCuenta[] = [];
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS_CUENTAS; pagina++) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);

    const data = (await holdedWriteCall(empresa, "GET", `/purchases?${params.toString()}`)) as {
      items?: Array<{
        contact_name?: string;
        description?: string;
        tags?: string[];
        lines?: Array<{ name?: string; account?: string }>;
      }>;
      cursor?: string;
      has_more?: boolean;
    };

    for (const item of data.items ?? []) {
      for (const line of item.lines ?? []) {
        if (!line.account) continue;
        lineas.push({
          contactName: item.contact_name ?? "",
          descripcion: item.description ?? "",
          lineName: line.name ?? "",
          account: line.account,
          tags: item.tags ?? [],
        });
      }
    }

    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return lineas;
}

function construirSugerenciaDesdeCoincidencias(
  matches: LineaConCuenta[],
  origen: CuentaSugerida["aprendidoDe"]
): CuentaSugerida | undefined {
  if (matches.length === 0) return undefined;

  const conteo = new Map<string, number>();
  for (const m of matches) conteo.set(m.account, (conteo.get(m.account) ?? 0) + 1);
  const cuentaGanadora = Array.from(conteo.entries()).sort((a, b) => b[1] - a[1])[0][0];

  const delGrupo = matches.filter((m) => m.account === cuentaGanadora);
  const tagsFrecuentes = new Map<string, number>();
  for (const m of delGrupo) for (const t of m.tags) tagsFrecuentes.set(t, (tagsFrecuentes.get(t) ?? 0) + 1);
  const tags = Array.from(tagsFrecuentes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);

  const ejemplo = delGrupo.find((m) => m.lineName || m.descripcion);

  return { accountId: cuentaGanadora, tags, ejemplo: ejemplo ? ejemplo.lineName || ejemplo.descripcion : "", aprendidoDe: origen };
}

/**
 * Cuando varias cuentas candidatas empatan o no hay un ganador claro por
 * palabras clave, le pide a Claude que elija la más adecuada ENTRE esas
 * candidatas reales (nunca inventa una cuenta nueva) — pedido explícito de
 * Carlos: "usa el modelo IA que se requiera para que esto sea preciso".
 */
async function elegirCuentaConIA(
  criterios: { proveedor: string; concepto: string },
  candidatos: LineaConCuenta[]
): Promise<CuentaSugerida | undefined> {
  const porCuenta = new Map<string, LineaConCuenta[]>();
  for (const c of candidatos) {
    const arr = porCuenta.get(c.account) ?? [];
    if (arr.length < 3) arr.push(c);
    porCuenta.set(c.account, arr);
  }
  const opciones = Array.from(porCuenta.entries()).slice(0, 6);
  if (opciones.length < 2) return undefined;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;

  try {
    const anthropic = new Anthropic({ apiKey });
    const listado = opciones
      .map(
        ([accountId, ejemplos], i) =>
          `${i + 1}. cuenta "${accountId}" — ejemplos ya registrados: ${ejemplos
            .map((e) => `"${e.lineName || e.descripcion}"`)
            .join(", ")}`
      )
      .join("\n");

    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 20,
      messages: [
        {
          role: "user",
          content:
            `Gasto nuevo — proveedor: "${criterios.proveedor}", concepto: "${criterios.concepto}". ` +
            `¿Cuál de estas cuentas contables (identificadas solo por ejemplos reales ya registrados en Holded) ` +
            `es la más adecuada para este gasto? Responde SOLO con el número de la opción, o "0" si ninguna encaja bien.\n\n${listado}`,
        },
      ],
    });

    // Bug real: esta llamada real a Claude nunca se registraba en
    // _costos_ia — el gasto real de elegir cuenta contable no aparecía.
    registrarUsoIA(undefined, "claude-sonnet-5", response.usage).catch((error) =>
      console.error("[write] Error registrando uso de IA:", error)
    );

    const textBlock = response.content.find((b) => b.type === "text");
    const numero = textBlock && textBlock.type === "text" ? parseInt(textBlock.text.trim(), 10) : NaN;
    if (!Number.isFinite(numero) || numero < 1 || numero > opciones.length) return undefined;

    const [accountId, ejemplos] = opciones[numero - 1];
    return {
      accountId,
      tags: [],
      ejemplo: ejemplos[0]?.lineName || ejemplos[0]?.descripcion || "",
      aprendidoDe: "ia",
    };
  } catch (error) {
    console.error("[write] Error eligiendo cuenta contable con IA (no crítico):", error);
    return undefined;
  }
}

/**
 * Busca qué cuenta contable de Holded ya se usa en compras reales
 * parecidas — por proveedor o por palabras clave del concepto — para no
 * dejar que Holded caiga en su cuenta genérica por defecto en gastos que
 * ya tienen una categoría real establecida (ej. "Gastos de viaje" para
 * vuelos/hoteles/taxis, en vez de "Otros servicios"). Caso real que
 * motivó esto: una factura de Booking.com (Footprint) se creó sin cuenta
 * ni tags — verificado en vivo que Footprint ya tiene 159 líneas reales de
 * gastos de viaje (KLM, Uber, hoteles, Booking.com, incluyendo vuelos del
 * mismo colaborador) todas bajo la MISMA cuenta contable.
 *
 * Holded no expone un endpoint público para listar el plan de cuentas
 * (verificado en vivo: /accounting/accounts, /expenseaccounts,
 * /chartofaccounts — todos 404 o devuelven el HTML del front, no datos) —
 * así que la única fuente confiable es lo que YA está en uso real. Nunca
 * inventa un id de cuenta.
 *
 * 1) Si hay compras del MISMO proveedor (nombre parecido), usa la cuenta
 *    más frecuente entre esas — caso fuerte y determinístico.
 * 2) Si no, busca por palabras clave del concepto compartidas con líneas
 *    ya registradas. Si de ahí salen varias cuentas candidatas distintas
 *    sin un proveedor que desempate, se le pide a Claude que elija
 *    (elegirCuentaConIA) en vez de quedarse con la primera por azar.
 * 3) Si no hay ninguna coincidencia razonable, devuelve undefined — Holded
 *    usa su cuenta por defecto, igual que antes de esta función existir.
 */
export async function inferirCuentaGasto(
  empresa: Empresa,
  criterios: { proveedor: string; concepto: string }
): Promise<CuentaSugerida | undefined> {
  const lineas = await recolectarLineasConCuenta(empresa);
  if (lineas.length === 0) return undefined;

  // textosParecidos (no un simple includes/substring) — bug real encontrado
  // en vivo: "Booking.com" (como lo lee la extracción de la factura) nunca
  // matcheaba por substring contra "BOOKING HOLDINGS Inc. (Booking)" (el
  // nombre real del contacto en Holded), así que el match por proveedor
  // fallaba SIEMPRE para ese caso real y caía al fallback de concepto/IA,
  // menos confiable. Mismo criterio ya usado en el resto del sistema para
  // razón social vs. nombre comercial.
  const porNombre = criterios.proveedor.trim()
    ? lineas.filter((l) => l.contactName && textosParecidos(criterios.proveedor, l.contactName))
    : [];

  const sugeridoPorNombre = construirSugerenciaDesdeCoincidencias(porNombre, "proveedor");
  if (sugeridoPorNombre) return sugeridoPorNombre;

  const palabrasConcepto = palabrasSignificativas(criterios.concepto);
  if (palabrasConcepto.length === 0) return undefined;

  const porConcepto = lineas.filter((l) => {
    const texto = normalizar(`${l.descripcion} ${l.lineName}`);
    return palabrasConcepto.some((p) => texto.includes(p));
  });

  const cuentasDistintas = new Set(porConcepto.map((m) => m.account));
  if (cuentasDistintas.size > 1) {
    const viaIA = await elegirCuentaConIA(criterios, porConcepto);
    if (viaIA) return viaIA;
  }

  return construirSugerenciaDesdeCoincidencias(porConcepto, "concepto");
}

export interface GastoSinComprobante {
  id: string;
  contactName: string;
  total: number;
  fecha: string;
  descripcion: string;
  tags: string[];
}

const MAX_GASTOS_A_REVISAR = 150;

/**
 * Busca gastos en un rango de fechas que NO tienen ningún comprobante
 * adjunto en Holded (GET /purchases/{id}/attachments vacío). Verificado en
 * vivo contra datos reales: de 60 gastos de WOBA, 59 tenían adjunto y 1 no
 * — el mecanismo (list + N llamadas a /attachments) funciona y distingue
 * ambos casos correctamente. Si `tags` trae el nombre de una persona (ej.
 * "proyectosimon"), es la única pista disponible de quién debe el
 * comprobante — la mayoría de los gastos no traen esa etiqueta.
 */
export async function buscarGastosSinComprobante(
  empresa: Empresa,
  desde: string,
  hasta: string
): Promise<{ sinComprobante: GastoSinComprobante[]; totalRevisados: number; limiteAlcanzado: boolean }> {
  const revisados: Array<{ id: string; contact_name?: string; date?: string; total?: string; description?: string; tags?: string[] }> = [];
  let cursor: string | undefined;
  let limiteAlcanzado = false;

  while (revisados.length < MAX_GASTOS_A_REVISAR) {
    const params = new URLSearchParams({ limit: "100", start_date: desde, end_date: hasta });
    if (cursor) params.set("cursor", cursor);

    const data = (await holdedWriteCall(empresa, "GET", `/purchases?${params.toString()}`)) as {
      items?: Array<{ id: string; contact_name?: string; date?: string; total?: string; description?: string; tags?: string[] }>;
      cursor?: string;
      has_more?: boolean;
    };

    for (const item of data.items ?? []) {
      if (revisados.length >= MAX_GASTOS_A_REVISAR) {
        limiteAlcanzado = true;
        break;
      }
      revisados.push(item);
    }

    if (limiteAlcanzado || !data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  const sinComprobante: GastoSinComprobante[] = [];

  for (const item of revisados) {
    const attachments = (await holdedWriteCall(empresa, "GET", `/purchases/${item.id}/attachments`)) as {
      items?: unknown[];
    };
    if ((attachments.items ?? []).length === 0) {
      sinComprobante.push({
        id: item.id,
        contactName: item.contact_name ?? "(sin proveedor)",
        total: parsearMontoHolded(item.total),
        fecha: item.date ?? "",
        descripcion: item.description ?? "",
        tags: item.tags ?? [],
      });
    }
  }

  return { sinComprobante, totalRevisados: revisados.length, limiteAlcanzado };
}

const MAX_GASTOS_A_REVISAR_ETIQUETA = 2000;

export type GastoConEtiqueta = GastoSinComprobante;

/**
 * Pedido explícito de Carlos, tras un caso real: pidió los gastos de viaje de una persona en
 * Footprint "busca el hashtag que debe estar como Jorge o como Jácome" — investigué a mano (script
 * descartable) y encontré que el hashtag SÍ existía ("jorge", en minúsculas, sin "jácome"), pero
 * Wobi no tenía ninguna herramienta para buscarlo — solo podía listar TODO un rango de fechas
 * (consultar_movimientos_holded) o buscar un documento puntual por monto/fecha, nada por etiqueta.
 * Esta función cierra ese hueco: recorre /purchases paginado en un rango de fechas y filtra por
 * coincidencia EXACTA (normalizada: sin acentos, minúsculas) contra las etiquetas del documento —
 * las etiquetas de Holded son la única pista fiable de a quién/qué corresponde un gasto genérico
 * (mismo principio que buscarGastosSinComprobante, arriba).
 */
export async function buscarGastosPorEtiquetaHolded(
  empresa: Empresa,
  etiqueta: string,
  desde: string,
  hasta: string
): Promise<{ resultados: GastoConEtiqueta[]; totalRevisados: number; limiteAlcanzado: boolean }> {
  const etiquetaNorm = normalizar(etiqueta);
  const revisados: Array<{ id: string; contact_name?: string; date?: string; total?: string; description?: string; tags?: string[] }> = [];
  let cursor: string | undefined;
  let limiteAlcanzado = false;

  while (revisados.length < MAX_GASTOS_A_REVISAR_ETIQUETA) {
    const params = new URLSearchParams({ limit: "100", start_date: desde, end_date: hasta });
    if (cursor) params.set("cursor", cursor);

    const data = (await holdedWriteCall(empresa, "GET", `/purchases?${params.toString()}`)) as {
      items?: Array<{ id: string; contact_name?: string; date?: string; total?: string; description?: string; tags?: string[] }>;
      cursor?: string;
      has_more?: boolean;
    };

    for (const item of data.items ?? []) {
      if (revisados.length >= MAX_GASTOS_A_REVISAR_ETIQUETA) {
        limiteAlcanzado = true;
        break;
      }
      revisados.push(item);
    }

    if (limiteAlcanzado || !data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  const resultados: GastoConEtiqueta[] = revisados
    .filter((item) => (item.tags ?? []).some((t) => normalizar(t) === etiquetaNorm))
    .map((item) => ({
      id: item.id,
      contactName: item.contact_name ?? "(sin proveedor)",
      total: parsearMontoHolded(item.total),
      fecha: item.date ?? "",
      descripcion: item.description ?? "",
      tags: item.tags ?? [],
    }));

  return { resultados, totalRevisados: revisados.length, limiteAlcanzado };
}

/**
 * Descarga y lee (transcribe con Claude vision, ver transcribirParaCaptura) todos los adjuntos de
 * un gasto/compra ya existente en Holded — mismo hueco encontrado junto con
 * buscarGastosPorEtiquetaHolded: Wobi podía SABER que un gasto tiene un adjunto
 * (GET /purchases/{id}/attachments, ya usado en buscarGastosSinComprobante) pero no tenía forma de
 * leer su CONTENIDO real, solo el nombre del archivo. Verificado en vivo: el endpoint de descarga es
 * GET /purchases/{id}/attachments/{filename} (el "id" que devuelve la lista de adjuntos es en
 * realidad el nombre de archivo, no un id opaco) — devuelve el binario directo (application/pdf o
 * imagen), no JSON.
 */
export async function leerAdjuntosCompraHolded(
  empresa: Empresa,
  purchaseId: string
): Promise<Array<{ nombreArchivo: string; contenido: string }>> {
  const apiKey = getWriteApiKey(empresa);
  const attachments = (await holdedWriteCall(empresa, "GET", `/purchases/${purchaseId}/attachments`)) as {
    items?: Array<{ id: string }>;
  };
  const nombres = (attachments.items ?? []).map((a) => a.id);
  if (nombres.length === 0) return [];

  const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");
  await mkdir(UPLOADS_DIR, { recursive: true });

  const resultados: Array<{ nombreArchivo: string; contenido: string }> = [];

  for (const nombreArchivo of nombres) {
    let rutaLocal: string | undefined;
    try {
      const response = await fetch(
        `${HOLDED_API_BASE}/purchases/${purchaseId}/attachments/${encodeURIComponent(nombreArchivo)}`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      if (!response.ok) {
        resultados.push({ nombreArchivo, contenido: `(No se pudo descargar: HTTP ${response.status})` });
        continue;
      }
      // Solo el tipo MIME, sin parámetros (ej. "; charset=...") — mimeADocumentBlock compara con
      // igualdad estricta ("application/pdf"), así que un sufijo inesperado lo haría fallar aunque
      // el archivo sí fuera un PDF/imagen soportado.
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
      const bytes = Buffer.from(await response.arrayBuffer());
      rutaLocal = join(UPLOADS_DIR, `${Date.now()}_${nombreArchivo.replace(/[^\w.\-]+/g, "_")}`);
      await writeFile(rutaLocal, bytes);

      const contenido = await transcribirParaCaptura(
        rutaLocal,
        contentType,
        `Adjunto de un gasto ya registrado en Holded (${empresa}, compra ${purchaseId}).`
      );
      resultados.push({ nombreArchivo, contenido });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resultados.push({ nombreArchivo, contenido: `(Error leyendo el adjunto: ${message})` });
    } finally {
      if (rutaLocal) await unlink(rutaLocal).catch(() => {});
    }
  }

  return resultados;
}

/**
 * Cuenta los documentos de compra (gastos/facturas) creados en Holded en los
 * últimos `dias` días (por `date`, no por fecha de creación en el sistema).
 * Nota: cuenta TODO lo que hay en Holded en ese rango, no solo lo que
 * gestionó el asistente — Holded no distingue un gasto creado por el bot de
 * uno cargado a mano por el equipo, no hay ninguna etiqueta que los separe.
 */
export async function contarFacturasRecientes(empresa: Empresa, dias: number): Promise<number> {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);

  let total = 0;
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS_PURCHASES; pagina++) {
    const params = new URLSearchParams({
      limit: "100",
      start_date: formatDateLocal(desde),
      end_date: formatDateLocal(hasta),
    });
    if (cursor) params.set("cursor", cursor);

    const data = (await holdedWriteCall(empresa, "GET", `/purchases?${params.toString()}`)) as {
      items?: unknown[];
      cursor?: string;
      has_more?: boolean;
    };

    total += (data.items ?? []).length;
    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return total;
}

/**
 * Adjunta un comprobante (PDF/imagen) a un gasto ya existente en Holded
 * (POST /purchases/{id}/attachments, multipart). Verificado en vivo: un
 * cuerpo JSON vacío devuelve "File not found", confirmando que este
 * endpoint espera un archivo real, no JSON.
 */
export async function adjuntarComprobanteHolded(empresa: Empresa, purchaseId: string, rutaLocal: string, nombreArchivo: string, mimeType: string | undefined): Promise<void> {
  const apiKey = getWriteApiKey(empresa);
  const bytes = await readFile(rutaLocal);

  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: mimeType || "application/octet-stream" }), nombreArchivo);

  const response = await fetch(`${HOLDED_API_BASE}/purchases/${purchaseId}/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Error adjuntando comprobante en Holded (${response.status}) para ${empresa}: ${errBody}`);
  }
}

export interface TaxCatalogEntry {
  key: string;
  amount: number;
}

const catalogoImpuestosCache = new Map<Empresa, TaxCatalogEntry[]>();

/**
 * Catálogo real de códigos de impuesto de Holded (GET /taxes, filtrado a
 * compras). Se consulta en vez de adivinar un código — verificado en vivo
 * que mandar el key real (ej. "p_iva_21") calcula correctamente el IVA de
 * la línea (probado: 10€ base + p_iva_21 → tax 2,10€, total 12,10€).
 * Cacheado en memoria por empresa (el catálogo no cambia en caliente).
 */
export async function obtenerCatalogoImpuestos(empresa: Empresa): Promise<TaxCatalogEntry[]> {
  const cached = catalogoImpuestosCache.get(empresa);
  if (cached) return cached;

  const data = (await holdedWriteCall(empresa, "GET", "/taxes")) as {
    items?: Array<{ key?: string; amount?: string | number; scope?: string; type?: string }>;
  };

  const catalogo = (data.items ?? [])
    .filter((t) => t.scope === "purchases" && t.type !== "group" && t.key)
    .map((t) => ({ key: t.key as string, amount: Number(t.amount) || 0 }));

  catalogoImpuestosCache.set(empresa, catalogo);
  return catalogo;
}

/**
 * Mapea un porcentaje de IVA (leído de una factura, ej. 21 o 7.5) al código
 * real más plausible del catálogo — prefiere el código "plano" p_iva_XX
 * (el caso normal) y si no existe, cualquier código con ese mismo
 * porcentaje. Nunca inventa un key que no esté en el catálogo real; si no
 * encuentra nada, devuelve undefined (la línea queda sin taxes, 0% neto).
 */
export function mapearPorcentajeATaxKey(catalogo: TaxCatalogEntry[], pct: number): string | undefined {
  const claveDirecta = `p_iva_${String(pct).replace(".", "")}`;
  const directo = catalogo.find((t) => t.key === claveDirecta);
  if (directo) return directo.key;

  return catalogo.find((t) => t.amount === pct)?.key;
}

/**
 * Bug real encontrado en vivo: una factura de alquiler de nave con
 * retención de IRPF (19%) se registró en Holded SIN la retención — el
 * total quedó en base+IVA (4.090,60€) en vez del "Total a Ingresar" real
 * (3.448,28€), aunque la conciliación bancaria sí había usado el monto
 * correcto. Holded modela la retención como un código de impuesto más
 * (verificado en vivo contra /taxes: "p_ret_19" con amount=-19, junto a
 * variantes por tipo de retención — "p_retrent_19" para alquileres/rentas
 * de inmuebles, que tributan en un modelo de Hacienda distinto al de
 * retenciones de servicios profesionales) — se puede pasar en el mismo
 * array `taxes` que el IVA, sumando ambos efectos en la misma línea.
 * `concepto` decide la familia de código (alquiler vs. genérica) por
 * palabras clave — no hay forma de saberlo del porcentaje solo, que es
 * igual (19%) en varios tipos de retención distintos.
 */
export function mapearRetencionATaxKey(catalogo: TaxCatalogEntry[], pct: number, concepto: string): string | undefined {
  const esAlquiler = /alquiler|arrendamiento|\brenta\b/i.test(concepto);
  const familias = esAlquiler ? ["p_retrent_", "p_ret_"] : ["p_ret_", "p_retrent_"];

  for (const prefijo of familias) {
    const claveDirecta = `${prefijo}${String(Math.round(pct)).replace(".", "")}`;
    const directo = catalogo.find((t) => t.key === claveDirecta);
    if (directo) return directo.key;
  }

  return catalogo.find((t) => t.amount === -pct)?.key;
}

export interface LineaGastoHolded {
  concepto: string;
  base: number;
  tipoIvaPct: number;
  /** Porcentaje de retención de IRPF de esta línea (ver mapearRetencionATaxKey) — 0/undefined si no aplica. */
  retencionPct?: number;
}

export interface NuevoGastoHolded {
  contactId: string;
  fecha: string; // YYYY-MM-DD
  descripcion: string;
  lineas: LineaGastoHolded[];
  /** Cuenta contable real de Holded a asignar (ver inferirCuentaGasto) — si no se da, Holded usa su cuenta por defecto. */
  cuentaId?: string;
  /** Tags del documento (ej. ["avion","transporte"]) — ver inferirCuentaGasto. */
  tags?: string[];
  /**
   * Moneda ISO 4217 del documento (ej. "USD") — si no se da, Holded usa el
   * default de la organización (EUR). Verificado en la documentación real
   * de Holded (developers.holded.com): /purchases SÍ acepta un campo
   * `currency` para crear el documento en una moneda distinta a EUR — el
   * supuesto anterior de que solo soportaba EUR era incorrecto. Pedido
   * explícito de Carlos: un gasto puede necesitar conciliarse en USD (no
   * solo EUR) si la tarjeta/cuenta real que lo pagó está en USD — en ese
   * caso el gasto debe crearse en USD, no forzarlo a EUR.
   */
  moneda?: string;
  /**
   * Pedido explícito de Carlos: "Número de documento" debe quedar
   * diligenciado con el número real de la factura/recibo cuando se conoce
   * — NUNCA un número inventado. Mismo campo que ya se lee de vuelta en
   * buscarEnEndpointDocumentos/consultarEstadoFacturaHolded
   * (`document_number`, confirmado real ahí contra datos reales de
   * Holded) — se usa el mismo nombre para escribir.
   *
   * Pedido explícito de Carlos, tras un caso real (recibo de Uber, viaje en
   * Ciudad de México — un recibo de trayecto, sin ningún folio/número de
   * documento visible en ningún lado): antes, cuando no se identificaba
   * ninguno, este campo simplemente se omitía y Holded lo dejaba en blanco
   * — "recuerda que si no lo identificas en el anexo lo rellenas con
   * 00000". Ahora crearGastoHolded (más abajo) siempre manda algo: el
   * número real si se identificó, o el placeholder literal "00000" si no
   * — nunca deja el campo vacío, mismo criterio que el contacto
   * placeholder "PROVEEDOR SIN IDENTIFICAR" cuando no hay proveedor real.
   */
  numeroDocumento?: string;
}

/**
 * Se lanza cuando no se encontró el contacto por nombre exacto/parecido, para
 * que quien la capture pueda ofrecer alternativas (nombre parecido, o
 * facturas ya registradas con el mismo importe) en vez de solo fallar — ver
 * manejarContactoNoEncontrado en gastoCallbackHandler.ts.
 */
export class ContactoNoEncontradoError extends Error {
  constructor(public proveedorBuscado: string, public empresa: Empresa) {
    super(`No se encontró el proveedor "${proveedorBuscado}" en los contactos de Holded (${empresa}).`);
    this.name = "ContactoNoEncontradoError";
  }
}

/**
 * Crea un documento de gasto/compra en Holded (POST /v2/purchases), con el
 * desglose de IVA real por línea. Solo debe invocarse tras aprobación
 * explícita del usuario por botón — nunca automáticamente. Queda como
 * borrador/pendiente en Holded (no contabilizado en firme), tal como se
 * comportó en la prueba en vivo.
 */
/**
 * Holded bloquea crear/editar documentos con fecha dentro de un periodo
 * contable ya cerrado (ej. tras presentar el IVA de ese periodo) — devuelve
 * 422 con detail "This date has been locked". Verificado en vivo con una
 * factura real (Booking.com, Footprint, fecha del vuelo 2025-09-06):
 * Holded rechazó la creación con exactamente ese error. Antes esto se le
 * mostraba a Carlos como el JSON crudo del error — ahora se detecta
 * específicamente para poder ofrecer reintentar con otra fecha en vez de
 * solo mostrar un error técnico sin salida.
 */
export class FechaBloqueadaError extends Error {
  constructor(public readonly fecha: string) {
    super(`La fecha ${fecha} corresponde a un periodo contable cerrado/bloqueado en Holded.`);
    this.name = "FechaBloqueadaError";
  }
}

export async function crearGastoHolded(empresa: Empresa, gasto: NuevoGastoHolded): Promise<{ id: string }> {
  const catalogo = await obtenerCatalogoImpuestos(empresa);

  const items = gasto.lineas.map((linea) => {
    const taxKey = mapearPorcentajeATaxKey(catalogo, linea.tipoIvaPct);
    const retencionKey =
      linea.retencionPct && linea.retencionPct > 0
        ? mapearRetencionATaxKey(catalogo, linea.retencionPct, linea.concepto || gasto.descripcion)
        : undefined;
    const taxes = [taxKey, retencionKey].filter((k): k is string => Boolean(k));
    return {
      name: linea.concepto || gasto.descripcion,
      units: 1,
      price: linea.base,
      tax: 0,
      taxes,
      ...(gasto.cuentaId ? { account: gasto.cuentaId } : {}),
    };
  });

  let data: { id?: string };
  try {
    data = (await holdedWriteCall(empresa, "POST", "/purchases", {
      contact_id: gasto.contactId,
      date: gasto.fecha,
      description: gasto.descripcion,
      items,
      ...(gasto.tags && gasto.tags.length > 0 ? { tags: gasto.tags } : {}),
      ...(gasto.moneda ? { currency: gasto.moneda } : {}),
      // Bug real de gravedad alta encontrado en vivo (2026-09-03, gasto de
      // "Santo Suadero", Footprint): el campo que de verdad acepta POST
      // /purchases para el número de documento es "number", NO
      // "document_number" (ese es el nombre que Holded usa al DEVOLVER el
      // dato en un GET, pero no el que espera al crear/actualizar — mismo
      // desajuste ya confirmado en vivo para PUT /purchases/{id}, ver
      // editarCompraHolded). "document_number" es un campo desconocido para
      // Holded que se ignora en silencio (sin error) — así que NINGÚN gasto
      // creado por este sistema hasta ahora quedó con su número de
      // documento real, sin importar que se hubiera extraído correctamente
      // ni que se mandara "00000" de placeholder.
      number: gasto.numeroDocumento || "00000",
    })) as { id?: string };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/date has been locked/i.test(message)) {
      throw new FechaBloqueadaError(gasto.fecha);
    }
    throw error;
  }

  if (!data.id) {
    throw new Error("Holded no devolvió un id para el gasto creado.");
  }

  return { id: data.id };
}

/**
 * Pedido explícito de Carlos, tras un caso real (un gasto de McDonald's ya
 * creado en Holded con el monto y el número de documento mal): "necesito que
 * hagas lo que dices que no puedes hacer" — hasta ahora, un gasto YA creado
 * en Holded solo podía corregirse a mano en la web de Holded, o borrarse y
 * recrearse desde cero (perdiendo el id real y cualquier conciliación ya
 * hecha contra él). Verificado en vivo contra la documentación real de
 * Holded (developers.holded.com → PUT /api/v2/purchases/{id}): el endpoint
 * de actualización hace un REEMPLAZO COMPLETO del documento — "Reemplaza
 * todos los campos editables de una factura de compra existente" — así que
 * NUNCA se puede mandar solo el campo que cambia; hay que releer el
 * documento entero primero y reenviar TODAS sus líneas tal cual, con el
 * cambio ya aplicado encima. Sin esto, corregir por ejemplo solo el número
 * de documento borraría sin querer el resto de las líneas.
 */
/**
 * Se lanza SOLO cuando el PUT ya se envió y Holded respondió 200 OK, pero la
 * relectura posterior no muestra el resultado esperado — a diferencia de un
 * error ANTES del PUT (red, id inválido), acá el documento SÍ pudo haber
 * cambiado (parcialmente o de forma inesperada). Quien la capture nunca debe
 * decir "no se tocó nada" — debe decir que hace falta revisar Holded a mano.
 */
export class EdicionNoVerificadaError extends Error {
  constructor(message: string, public readonly purchaseId: string) {
    super(message);
    this.name = "EdicionNoVerificadaError";
  }
}

export interface LineaCompraHoldedCruda {
  line_id?: string;
  name?: string;
  type?: string;
  description?: string | null;
  product_id?: string | null;
  units?: string | number | null;
  price?: string | number | null;
  discount?: string | number | null;
  tax?: string | number;
  taxes?: string[] | null;
  tags?: string[];
  sku?: string | null;
  account?: string | null;
  project_id?: string | null;
  retention?: string | number | null;
  unit_type?: string | null;
  [key: string]: unknown;
}

export interface CompraHoldedCruda {
  id: string;
  document_number?: string | null;
  contact_id?: string;
  description?: string | null;
  date?: string;
  due_date?: string | null;
  currency?: string;
  total?: string | number;
  design_id?: string | null;
  lines?: LineaCompraHoldedCruda[];
  [key: string]: unknown;
}

/** Lee tal cual una compra existente de Holded, sin transformar nada — base para editarCompraHolded (releer completo antes de reemplazar). */
export async function obtenerCompraHoldedPorId(empresa: Empresa, purchaseId: string): Promise<CompraHoldedCruda> {
  const data = (await holdedWriteCall(empresa, "GET", `/purchases/${purchaseId}`)) as CompraHoldedCruda;
  if (!data?.id) {
    throw new Error(`No se encontró la compra ${purchaseId} en Holded (${empresa}).`);
  }
  return data;
}

/**
 * Convierte un número "a la española" (ej. "4,10", o "3.380,67" con punto de
 * miles) que Holded devuelve en sus respuestas GET a un number real — nunca
 * asume que ya viene como number (verificado en vivo: Holded devuelve estos
 * campos como STRING con coma decimal, y SÍ usa punto de miles en montos
 * grandes, ej. un alquiler real de 3.380,67€ visto en producción).
 *
 * Bug real encontrado en auditoría: la versión anterior solo hacía
 * `.replace(",", ".")` — con "3.380,67" eso da "3.380.67" (dos puntos),
 * Number() lo parsea como NaN, y el fallback a 0 lo convertía en un CERO
 * silencioso. Con un total de 0, el resto de editarCompraHolded trataba la
 * factura como "sin línea previa con total real" y la reemplazaba entera
 * por una sola línea sin IVA — cualquier edición (incluso corregir solo el
 * número de documento) habría borrado el desglose real de una factura de
 * más de 999€. Ahora se quitan TODOS los puntos (miles) antes de convertir
 * la coma (decimal) a punto.
 */
function numeroDesdeHolded(valor: string | number | null | undefined): number {
  if (typeof valor === "number") return valor;
  if (!valor) return 0;
  const limpio = String(valor).replace(/\./g, "").replace(",", ".");
  const parsed = Number(limpio);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface CambiosCompraHolded {
  numeroDocumento?: string;
  fecha?: string;
  /** Si se da, REEMPLAZA todas las líneas (mismo criterio de monto/IVA que crearGastoHolded). Si no se da, se reenvían las líneas actuales tal cual (Holded exige el array completo en cada PUT, nunca un delta). */
  lineas?: LineaGastoHolded[];
  /**
   * Escala el precio de cada línea EXISTENTE proporcionalmente al nuevo
   * total, preservando sus taxes/cuenta/etc. tal cual venían de Holded (sin
   * necesitar volver a mapear el % de IVA a un tax_key) — pensado para
   * corregir un monto mal registrado sin tener que reconstruir el desglose
   * de IVA desde cero. Ignorado si también se da `lineas`.
   */
  montoNuevo?: number;
}

/**
 * Edita una compra YA CREADA en Holded — nunca borra ni recrea (conserva el
 * id real y cualquier conciliación/pago ya registrado contra ella). Relee el
 * documento completo, aplica SOLO los cambios pedidos sobre esa copia, y
 * reenvía TODO (a este endpoint no se le puede mandar un cambio parcial —
 * ver comentario de CompraHoldedCruda). Verifica releyendo después del PUT
 * que el cambio realmente quedó — un "200 OK" de Holded no es suficiente
 * prueba dado el reemplazo completo del recurso.
 */
/**
 * Reconstruye UNA línea cruda de Holded (ver LineaCompraHoldedCruda) al
 * shape que espera el PUT — bug real de auditoría: la versión anterior
 * copiaba sku/account/project_id/unit_type/discount/units/taxes de la línea
 * real pero se OLVIDABA de `tags` y `retention` (ambos presentes en la
 * respuesta real de Holded) — como el PUT reemplaza el documento entero,
 * CUALQUIER edición (incluso corregir solo el número de documento) borraba
 * en silencio las etiquetas de categorización y el % de retención de IRPF
 * de cada línea. `priceOverride`, si se da, reemplaza el precio (para el
 * escalado proporcional de montoNuevo); si no, se usa el precio real tal
 * cual viene de Holded.
 */
function lineaCrudaAItem(l: LineaCompraHoldedCruda, priceOverride?: number): Record<string, unknown> {
  return {
    name: l.name ?? "(línea)",
    type: l.type ?? "product",
    description: l.description ?? undefined,
    product_id: l.product_id ?? undefined,
    units: numeroDesdeHolded(l.units) || 1,
    price: priceOverride ?? numeroDesdeHolded(l.price),
    discount: numeroDesdeHolded(l.discount) || undefined,
    taxes: l.taxes ?? [],
    tags: l.tags ?? [],
    sku: l.sku ?? undefined,
    account: l.account ?? undefined,
    project_id: l.project_id ?? undefined,
    retention: numeroDesdeHolded(l.retention) || undefined,
    unit_type: l.unit_type ?? undefined,
  };
}

export async function editarCompraHolded(empresa: Empresa, purchaseId: string, cambios: CambiosCompraHolded): Promise<CompraHoldedCruda> {
  const actual = await obtenerCompraHoldedPorId(empresa, purchaseId);

  const catalogo = cambios.lineas ? await obtenerCatalogoImpuestos(empresa) : undefined;

  const lineasCrudasActuales = actual.lines ?? [];
  const totalActual = numeroDesdeHolded(actual.total);

  const items = cambios.lineas
    ? cambios.lineas.map((linea) => {
        const taxKey = catalogo ? mapearPorcentajeATaxKey(catalogo, linea.tipoIvaPct) : undefined;
        const retencionKey =
          catalogo && linea.retencionPct && linea.retencionPct > 0
            ? mapearRetencionATaxKey(catalogo, linea.retencionPct, linea.concepto)
            : undefined;
        return {
          name: linea.concepto || "(línea)",
          type: "product",
          units: 1,
          price: linea.base,
          taxes: [taxKey, retencionKey].filter((k): k is string => Boolean(k)),
        };
      })
    : cambios.montoNuevo !== undefined
      ? totalActual > 0 && lineasCrudasActuales.length > 0
        ? // Bug real de auditoría (aplicarTextoAjusteMonto, gastoCallbackHandler.ts):
          // escalar proporcionalmente (nunca reemplazar por el total completo
          // en cada línea) — de otro modo varias líneas reales quedarían
          // todas con el monto NUEVO completo en vez de repartirlo entre ellas.
          lineasCrudasActuales.map((l) => lineaCrudaAItem(l, (numeroDesdeHolded(l.price) * cambios.montoNuevo!) / totalActual))
        : // Sin línea previa con total real (0€ o sin líneas) — no hay proporción
          // que escalar, se reemplaza por una única línea limpia con el monto
          // nuevo, mismo criterio que el caso degenerado de aplicarTextoAjusteMonto.
          [{ name: actual.description ?? "(línea)", type: "product", units: 1, price: cambios.montoNuevo, taxes: [] }]
      : lineasCrudasActuales.map((l) => lineaCrudaAItem(l));

  const body: Record<string, unknown> = {
    number: cambios.numeroDocumento ?? actual.document_number ?? "00000",
    date: cambios.fecha ?? actual.date,
    due_date: actual.due_date ?? null,
    // design_id SÍ es un campo editable documentado de este PUT (verificado
    // en vivo contra la API real) — se preserva tal cual, igual que due_date.
    ...(actual.design_id ? { design_id: actual.design_id } : {}),
    items,
  };

  try {
    await holdedWriteCall(empresa, "PUT", `/purchases/${purchaseId}`, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/date has been locked/i.test(message)) {
      throw new FechaBloqueadaError(cambios.fecha ?? actual.date ?? "");
    }
    throw error;
  }

  // Verificación post-escritura: dado que el endpoint reemplaza el
  // documento entero, un 200 OK no confirma que el resultado sea el
  // esperado (ej. una línea mal formada podría quedar vacía en silencio).
  const releido = await obtenerCompraHoldedPorId(empresa, purchaseId);
  if (cambios.numeroDocumento && releido.document_number !== cambios.numeroDocumento) {
    throw new EdicionNoVerificadaError(
      `Holded aceptó la edición pero el número de documento quedó en "${releido.document_number}", no en "${cambios.numeroDocumento}" — revisar a mano en Holded.`,
      purchaseId
    );
  }
  if ((releido.lines?.length ?? 0) === 0 && items.length > 0) {
    throw new EdicionNoVerificadaError("Holded aceptó la edición pero la compra quedó SIN líneas — revisar a mano en Holded antes de dar esto por corregido.", purchaseId);
  }
  if (cambios.montoNuevo !== undefined && Math.abs(numeroDesdeHolded(releido.total) - cambios.montoNuevo) > 0.05) {
    throw new EdicionNoVerificadaError(
      `Holded aceptó la edición pero el total quedó en ${releido.total}, no en ${cambios.montoNuevo.toFixed(2)} — revisar a mano en Holded.`,
      purchaseId
    );
  }
  // Bug real de auditoría: sin este chequeo, cuando NI lineas NI montoNuevo
  // se pidieron (ej. solo corregir el número de documento), nada verificaba
  // que el total siguiera igual — un bug de parseo en numeroDesdeHolded
  // (ya corregido, pero esto es la red de seguridad) podría haber colapsado
  // una factura real a 0€ y el "✅ Editado" habría salido igual.
  if (cambios.montoNuevo === undefined && cambios.lineas === undefined && Math.abs(numeroDesdeHolded(releido.total) - totalActual) > 0.05) {
    throw new EdicionNoVerificadaError(
      `Holded aceptó la edición pero el total cambió de ${totalActual.toFixed(2)} a ${releido.total} sin que se pidiera — revisar a mano en Holded, no se tocó el monto a propósito.`,
      purchaseId
    );
  }

  return releido;
}

export interface MovimientoBancarioCandidato {
  accountId: string;
  movementId: string;
  descripcion: string;
  monto: number;
  /** Moneda de `monto` — igual a `criterios.moneda` de la búsqueda ("EUR" si no se especificó). */
  moneda: string;
  fecha: string;
}

// Hacia ADELANTE: un cargo bancario aparece más tarde que la fecha del
// documento casi nunca pasa de verdad (procesamiento del banco, unos pocos
// días) — se mantiene angosto para no arriesgar falsos positivos.
const VENTANA_DIAS_MOVIMIENTO = 5;
/**
 * Hacia ATRÁS: bug real encontrado en vivo (billete de avión AeroMexico,
 * Kelly Correales — vuelo 20 oct 2026, cargo real en el banco el 02 sep
 * 2026, 48 días antes): "fecha" en una compra de viaje es la fecha del
 * SERVICIO (el vuelo/la estadía), no la del pago — el cargo real en el
 * banco sale semanas o meses antes. Con ±5 días hacia atrás, tanto la
 * búsqueda exacta como la aproximada (buscarMovimientoAproximado) NUNCA
 * podían encontrar ese movimiento real, aunque existiera sin conciliar —
 * "conciliar" respondía que no encontraba nada cuando sí había un match
 * clarísimo. Se ensancha SOLO hacia atrás (no hacia adelante, donde sí
 * aplica el mismo criterio angosto de arriba) — mismo orden de magnitud
 * que VENTANA_DIAS_BUSQUEDA_DOCUMENTOS (facturas ya viejas).
 */
const VENTANA_DIAS_MOVIMIENTO_ATRAS = 90;

/** Ventana de búsqueda de movimientos bancarios para una fecha de compra/documento — ver comentario de las constantes arriba. */
function ventanaBusquedaMovimiento(fecha: string): { desde: Date; hasta: Date } {
  const fechaBase = new Date(fecha);
  const desde = new Date(fechaBase);
  desde.setDate(desde.getDate() - VENTANA_DIAS_MOVIMIENTO_ATRAS);
  const hasta = new Date(fechaBase);
  hasta.setDate(hasta.getDate() + VENTANA_DIAS_MOVIMIENTO);
  return { desde, hasta };
}

/**
 * Devuelve el conjunto de monedas en las que la empresa tiene de verdad una
 * cuenta de tesorería activa en Holded (ej. Footprint: EUR, USD Y COP — no
 * solo EUR). Bug real encontrado en vivo: procesarGastoEntrante asumía que
 * CUALQUIER factura que no viniera en EUR era "moneda extranjera" y exigía
 * un monto equivalente en EUR antes de seguir — pero un recibo real de
 * Footprint en USD (17.95 USD, MERA AEROPUERTO DE PANAMA SA) SÍ es el monto
 * real que salió de una cuenta real de Footprint en USD ("FTG USD"), sin
 * ninguna conversión de por medio. Carlos ya había confirmado "el documento
 * trae el valor exacto en dólares de 17.95" — pero el código seguía
 * pidiendo un "equivalente" que no existe ni tiene sentido pedir, dejando
 * el gasto atascado en la misma pregunta cada vez que se reintentaba. Ahora
 * solo se pide un equivalente cuando la moneda del documento NO coincide
 * con ninguna cuenta real de la empresa.
 */
export async function obtenerMonedasCuentasReales(empresa: Empresa): Promise<Set<string>> {
  const cuentasData = (await holdedWriteCall(empresa, "GET", "/treasury/accounts")) as {
    items?: Array<{ currency?: string; archived?: boolean }>;
  };
  const monedas = (cuentasData.items ?? [])
    .filter((c) => !c.archived && c.currency)
    .map((c) => (c.currency as string).toUpperCase().trim());
  return new Set(monedas.length > 0 ? monedas : ["EUR"]);
}

/**
 * Busca movimientos bancarios SIN conciliar (ver estaConciliado) en TODAS
 * las cuentas activas de la empresa (sin importar su moneda — recorre cada
 * cuenta de tesorería y normaliza cada movimiento a euros con
 * montoEnEuros), con monto y fecha cercanos a los dados. Se usa tanto para
 * el auto-conciliar tras crear/adjuntar un gasto como para el chequeo
 * PREVIO a crear uno nuevo (ver procesarGastoEntrante) — nunca para crear
 * gastos a partir de movimientos huérfanos (eso queda para revisión
 * humana, ver consultar_movimientos_sin_conciliar).
 *
 * `criterios.moneda` (por defecto "EUR") decide CÓMO se compara cada
 * movimiento — pedido explícito de Carlos: la conciliación puede necesitar
 * ser en EUR o en USD según qué tarjeta/cuenta real pagó el gasto, no
 * siempre en EUR:
 * - Si es "EUR" (caso más común, gastos que ya están en EUR o que se
 *   convirtieron a EUR): se compara con montoEnEuros(mov), que ya usa el
 *   `accounting_amount` que el propio Holded calcula para cuentas en otra
 *   moneda — permite encontrar el gasto aunque la cuenta bancaria real sea
 *   en otra divisa.
 * - Si NO es "EUR" (ej. "USD", cuando el gasto se creó en esa moneda
 *   porque la tarjeta/cuenta real que pagó está en esa moneda): solo se
 *   compara contra movimientos cuya moneda NATIVA sea exactamente esa
 *   misma — nunca se convierte con un tipo de cambio propio, así que un
 *   movimiento en otra moneda simplemente no es candidato.
 *
 * `toleranciaEur` es opcional (por defecto TOLERANCIA_MONTO, 1 céntimo) —
 * cuando el monto viene de un equivalente declarado en el documento/correo
 * (conversión de moneda), el llamador puede ensancharla: ese monto y el que
 * calcula/registra Holded pueden diferir por más de un céntimo sin dejar
 * de ser la MISMA transacción — con la tolerancia fija, un match real se
 * perdía en silencio.
 */
export async function buscarMovimientoSimilar(
  empresa: Empresa,
  criterios: { monto: number; fecha: string; moneda?: string },
  toleranciaEur: number = TOLERANCIA_MONTO
): Promise<MovimientoBancarioCandidato[]> {
  const monedaObjetivo = (criterios.moneda ?? "EUR").toUpperCase().trim();
  const { desde, hasta } = ventanaBusquedaMovimiento(criterios.fecha);

  const cuentasData = (await holdedWriteCall(empresa, "GET", "/treasury/accounts")) as {
    items?: Array<{ id: string; archived?: boolean }>;
  };
  const cuentas = (cuentasData.items ?? []).filter((c) => !c.archived);

  const candidatos: MovimientoBancarioCandidato[] = [];

  for (const cuenta of cuentas) {
    const params = new URLSearchParams({
      start_date: formatDateLocal(desde),
      end_date: formatDateLocal(hasta),
      limit: "100",
    });
    const data = (await holdedWriteCall(
      empresa,
      "GET",
      `/treasury/accounts/${cuenta.id}/bank-movements?${params.toString()}`
    )) as {
      items?: Array<{
        id: string;
        description?: string;
        amount?: string | number;
        currency?: string;
        accounting_amount?: string | number | null;
        booking_date?: string;
        status?: string;
      }>;
    };

    for (const mov of data.items ?? []) {
      if (estaConciliado(mov.status)) continue;

      let monto: number;
      if (monedaObjetivo === "EUR") {
        monto = montoEnEuros(mov);
      } else {
        // Nunca se inventa un tipo de cambio para monedas distintas a EUR:
        // solo son candidatos los movimientos cuya moneda nativa coincide
        // exactamente con la que se busca.
        if ((mov.currency ?? "EUR").toUpperCase() !== monedaObjetivo) continue;
        monto = parsearMontoMovimiento(mov.amount);
      }
      if (!Number.isFinite(monto) || !montosCercanos(Math.abs(monto), Math.abs(criterios.monto), toleranciaEur)) continue;

      candidatos.push({
        accountId: cuenta.id,
        movementId: mov.id,
        descripcion: mov.description ?? "",
        monto,
        moneda: monedaObjetivo,
        fecha: mov.booking_date ? mov.booking_date.slice(0, 10) : "",
      });
    }
  }

  return candidatos;
}

export interface MovimientoBancarioAproximado extends MovimientoBancarioCandidato {
  /** Diferencia absoluta, en la moneda de `monto`, entre el importe buscado y el de este movimiento. */
  diferenciaMonto: number;
}

const TOLERANCIA_APROXIMADA_PORCENTAJE = 0.15;
// Nunca menos de 1 (unidad de la moneda buscada): con montos chicos un
// porcentaje solo sería demasiado angosto para cubrir redondeos reales de
// conversión de moneda.
const TOLERANCIA_APROXIMADA_PISO = 1;

/**
 * true si `proveedor` parece estar mencionado en `descripcion` (o viceversa)
 * — substring en cualquier dirección (cubre "Uber" ⊂ "Dlo Uberrides") además
 * de textosParecidos (cubre variantes de más de una palabra, ej.
 * "Booking.com" vs "BOOKING HOLDINGS Inc."). Deliberadamente más permisivo
 * que textosParecidos solo (que exige palabras de 5+ letras, y "Uber" tiene
 * 4) — el riesgo de falso positivo es bajo porque quien llama a esto YA
 * filtró por monto cercano antes, así que hace falta que AMBAS señales
 * coincidan, nunca el nombre solo.
 */
function proveedorPareceEnDescripcion(proveedor: string, descripcion: string): boolean {
  const p = normalizar(proveedor).trim();
  const d = normalizar(descripcion).trim();
  if (p.length < 3 || d.length < 3) return false;
  if (d.includes(p) || p.includes(d)) return true;
  return textosParecidos(proveedor, descripcion);
}

/**
 * Fallback cuando buscarMovimientoSimilar (match exacto, 1 céntimo de
 * tolerancia) no encuentra nada — pedido explícito de Carlos tras un caso
 * real: un gasto de Uber llegó por correo como "9.74 EUR" pero el
 * movimiento bancario real que YA estaba en Holded era "Dlo Uberrides"
 * -9.24 € (diferencia de 0.50€, típico de una conversión MXN→EUR estimada a
 * mano en vez del tipo de cambio exacto que usa el banco) — con tolerancia
 * de 1 céntimo esto nunca aparecía, y el sistema decía "no encontré nada"
 * aunque el movimiento sí estuviera ahí, con un nombre reconociblemente
 * parecido y un monto casi idéntico. Exige AMBAS señales a la vez (monto
 * DENTRO de una banda ancha Y nombre parecido en la descripción) para no
 * proponer coincidencias falsas — nunca se concilia sola, solo se sugiere
 * (ver procesarGastoEntrante.ts / gastoCallbackHandler.ts).
 */
export async function buscarMovimientoAproximado(
  empresa: Empresa,
  criterios: { monto: number; fecha: string; moneda?: string; proveedor: string }
): Promise<MovimientoBancarioAproximado[]> {
  if (!criterios.proveedor.trim()) return [];

  const monedaObjetivo = (criterios.moneda ?? "EUR").toUpperCase().trim();
  const { desde, hasta } = ventanaBusquedaMovimiento(criterios.fecha);

  const cuentasData = (await holdedWriteCall(empresa, "GET", "/treasury/accounts")) as {
    items?: Array<{ id: string; archived?: boolean }>;
  };
  const cuentas = (cuentasData.items ?? []).filter((c) => !c.archived);

  const tolerancia = Math.max(TOLERANCIA_APROXIMADA_PISO, Math.abs(criterios.monto) * TOLERANCIA_APROXIMADA_PORCENTAJE);

  const candidatos: MovimientoBancarioAproximado[] = [];

  for (const cuenta of cuentas) {
    const params = new URLSearchParams({
      start_date: formatDateLocal(desde),
      end_date: formatDateLocal(hasta),
      limit: "100",
    });
    const data = (await holdedWriteCall(
      empresa,
      "GET",
      `/treasury/accounts/${cuenta.id}/bank-movements?${params.toString()}`
    )) as {
      items?: Array<{
        id: string;
        description?: string;
        amount?: string | number;
        currency?: string;
        accounting_amount?: string | number | null;
        booking_date?: string;
        status?: string;
      }>;
    };

    for (const mov of data.items ?? []) {
      if (estaConciliado(mov.status)) continue;
      if (!mov.description || !proveedorPareceEnDescripcion(criterios.proveedor, mov.description)) continue;

      let monto: number;
      if (monedaObjetivo === "EUR") {
        monto = montoEnEuros(mov);
      } else {
        if ((mov.currency ?? "EUR").toUpperCase() !== monedaObjetivo) continue;
        monto = parsearMontoMovimiento(mov.amount);
      }
      if (!Number.isFinite(monto)) continue;

      const diferencia = Math.abs(Math.abs(monto) - Math.abs(criterios.monto));
      if (diferencia > tolerancia) continue;
      // Un match EXACTO lo habría encontrado ya buscarMovimientoSimilar — no lo dupliques acá como "aproximado".
      if (montosCercanos(Math.abs(monto), Math.abs(criterios.monto), TOLERANCIA_MONTO)) continue;

      candidatos.push({
        accountId: cuenta.id,
        movementId: mov.id,
        descripcion: mov.description ?? "",
        monto,
        moneda: monedaObjetivo,
        fecha: mov.booking_date ? mov.booking_date.slice(0, 10) : "",
        diferenciaMonto: diferencia,
      });
    }
  }

  return candidatos.sort((a, b) => a.diferenciaMonto - b.diferenciaMonto);
}

/**
 * Concilia un movimiento bancario ENLAZÁNDOLO al documento de compra real
 * (POST .../reconcile con `documents: [{document_id, document_type:
 * "purchase"}]`) — no solo marca el movimiento como resuelto. Bug real
 * encontrado en vivo: esta función llamaba al endpoint con body vacío
 * `{}`, que Holded documenta como "marca conciliado SIN enlazar a ningún
 * documento" — el movimiento quedaba con status "forced_reconciled" pero
 * `reconciled_amount: "0.00"` (verificado comparando contra un movimiento
 * conciliado de verdad por Holded, que trae `reconciled_amount` igual al
 * monto real) — es decir, parecía conciliado pero NO estaba emparejado con
 * el gasto. El body correcto (`documents[].document_id` +
 * `document_type`) está documentado en
 * holded.com/es/desarrolladores/referencia-api/cuentas-bancarias/conciliar-un-movimiento-bancario.
 *
 * Esta función SIEMPRE relee el movimiento después de llamar, y el éxito
 * exige DOS cosas a la vez (nunca confía en el 200 por sí solo, el body de
 * éxito es `null`): que el status quede en un estado conciliado
 * (estaConciliado — "reconciled" o "forced_reconciled") Y que
 * `reconciled_amount` sea mayor a cero — exactamente el chequeo que le
 * faltaba antes y dejó pasar el bug real: status "conciliado" con
 * `reconciled_amount: "0.00"` (sin ningún documento enlazado de verdad).
 */
export async function reconciliarMovimiento(
  empresa: Empresa,
  accountId: string,
  movementId: string,
  fechaAproximada: string,
  documentoId: string
): Promise<{ ok: boolean; statusFinal: string; montoEnlazado: number }> {
  await holdedWriteCall(empresa, "POST", `/treasury/accounts/${accountId}/bank-movements/${movementId}/reconcile`, {
    documents: [{ document_id: documentoId, document_type: "purchase" }],
  });

  // La API no tiene un GET por id individual de movimiento documentado —
  // se relee acotando por fecha (misma ventana que la búsqueda) y se busca
  // el id dentro de esos resultados.
  const fechaBase = new Date(fechaAproximada);
  const desde = new Date(fechaBase);
  desde.setDate(desde.getDate() - VENTANA_DIAS_MOVIMIENTO);
  const hasta = new Date(fechaBase);
  hasta.setDate(hasta.getDate() + VENTANA_DIAS_MOVIMIENTO);

  const params = new URLSearchParams({
    start_date: formatDateLocal(desde),
    end_date: formatDateLocal(hasta),
    limit: "100",
  });
  const verificacion = (await holdedWriteCall(
    empresa,
    "GET",
    `/treasury/accounts/${accountId}/bank-movements?${params.toString()}`
  )) as { items?: Array<{ id: string; status?: string; reconciled_amount?: string }> };

  const movimiento = (verificacion.items ?? []).find((m) => m.id === movementId);
  const statusFinal = movimiento?.status ?? "(no encontrado al releer)";
  const montoEnlazado = Math.abs(parsearMontoMovimiento(movimiento?.reconciled_amount) || 0);

  // No basta con que el status diga "conciliado" — así es exactamente como
  // se veía el bug real que motivó este chequeo más estricto: status
  // "forced_reconciled" pero reconciled_amount "0.00" (sin ningún documento
  // realmente enlazado). Solo se reporta éxito si AMBAS cosas se confirman:
  // el estado cambió Y el monto enlazado es mayor a cero.
  const ok = estaConciliado(movimiento?.status) && montoEnlazado > 0;

  return { ok, statusFinal, montoEnlazado };
}

export interface NuevoEventoHolded {
  nombre: string;
  tipo: string;
  descripcion?: string;
  /** "YYYY-MM-DDTHH:mm:ss", tal cual — Holded lo interpreta como hora LOCAL Europe/Madrid (verificado en vivo: probé con offset +00:00, "Z" y sin offset, y en los 3 casos el valor se guardó igual, restando la diferencia de Madrid a UTC). Nunca construir esto con .toISOString() de un Date. */
  fechaInicio: string;
  fechaFin: string;
  contactId?: string;
  ubicacion?: string;
  /** ID interno de usuario Holded (dueño del evento) — ver buscarUsuarioHoldedPorNombre. Opcional. */
  userId?: string;
  /** Con quién manda Holded la notificación/invitación por correo al crear el evento. */
  participantes?: Array<{ email: string; name?: string }>;
}

/**
 * Busca en /employees de la empresa a alguien cuyo nombre o email coincida
 * (parcial) y que además tenga `holded_user_id` (solo los empleados con
 * acceso real al portal de Holded lo tienen — la mayoría de registros de
 * RRHH no) — ese es el id que espera `user_id` en POST /events. Verificado
 * en vivo: en WOBA existe (Carlos Gonzalez, carlos@wobagroup.com), en
 * EWORKS no aparece como empleado — en ese caso devuelve undefined y el
 * evento se crea sin dueño asignado en vez de fallar.
 */
export async function buscarUsuarioHoldedPorNombre(empresa: Empresa, nombreOEmail: string): Promise<string | undefined> {
  try {
    const objetivo = normalizar(nombreOEmail);
    const data = (await holdedWriteCall(empresa, "GET", "/employees?limit=100")) as {
      items?: Array<{ full_name?: string; email?: string; holded_user_id?: string | null }>;
    };

    const match = (data.items ?? []).find((e) => {
      if (!e.holded_user_id) return false;
      const nombre = e.full_name ? normalizar(e.full_name) : "";
      const email = e.email ? normalizar(e.email) : "";
      return nombre.includes(objetivo) || email.includes(objetivo) || objetivo.includes(nombre);
    });

    return match?.holded_user_id ?? undefined;
  } catch (error) {
    console.error(`[buscarUsuarioHoldedPorNombre] Error buscando usuario en ${empresa} (no crítico):`, error);
    return undefined;
  }
}

/**
 * Crea una actividad en el calendario CRM de Holded (POST /events). Verificado
 * en vivo contra las 3 empresas: `kind` es texto libre (no hay catálogo tipo
 * /taxes, probé un valor inventado y lo aceptó sin validar), y `contact_id`
 * vincula el evento a un contacto real si se conoce. `user_id` (dueño) y
 * `participants` (con quién manda Holded la notificación por correo) se
 * confirmaron en la documentación oficial de Holded — antes no se enviaba
 * ninguno de los dos, lo que dejaba el evento sin dueño asignado (podía no
 * aparecer en la vista de calendario filtrada por usuario) y sin ninguna
 * alerta por correo. Después de crear, relee el evento por id para
 * confirmar que de verdad quedó accesible — nunca confía solo en que la
 * API haya devuelto un id. Solo debe invocarse tras aprobación explícita
 * del usuario por botón — nunca automáticamente.
 */
export async function crearEventoHolded(empresa: Empresa, evento: NuevoEventoHolded): Promise<{ id: string; verificado: boolean }> {
  const data = (await holdedWriteCall(empresa, "POST", "/events", {
    name: evento.nombre,
    kind: evento.tipo,
    description: evento.descripcion ?? "",
    start_date: evento.fechaInicio,
    end_date: evento.fechaFin,
    contact_id: evento.contactId,
    location: evento.ubicacion ?? "",
    user_id: evento.userId,
    participants: evento.participantes,
  })) as { id?: string };

  if (!data.id) {
    throw new Error("Holded no devolvió un id para el evento creado.");
  }

  let verificado = false;
  try {
    const releido = (await holdedWriteCall(empresa, "GET", `/events/${data.id}`)) as { id?: string };
    verificado = releido.id === data.id;
  } catch (error) {
    console.error("[crearEventoHolded] No se pudo releer el evento para verificar (no crítico):", error);
  }

  return { id: data.id, verificado };
}

export interface EventoProximo {
  titulo: string;
  fecha: string;
  empresa: Empresa;
}

/**
 * Lista actividades del calendario CRM de Holded con fecha de inicio en los
 * próximos `dias` días (hoy incluido). Solo lectura.
 */
const MAX_PAGINAS_EVENTOS = 15;

export async function listarProximosEventosHolded(empresa: Empresa, dias: number): Promise<EventoProximo[]> {
  const desdeStr = formatDateLocal(new Date());
  const hastaStr = formatDateLocal(new Date(Date.now() + dias * 24 * 60 * 60 * 1000));

  // Verificado en vivo: a diferencia de /purchases y /bank-movements,
  // /events NO filtra por start_date/end_date en el servidor (una prueba
  // real con esos parámetros devolvió eventos de 2024 sin filtrar) — hay
  // que traer todo (el volumen real es pequeño, decenas por empresa) y
  // filtrar la fecha aquí.
  const eventos: Array<{ name?: string; start_date?: string }> = [];
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS_EVENTOS; pagina++) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);

    const data = (await holdedWriteCall(empresa, "GET", `/events?${params.toString()}`)) as {
      items?: Array<{ name?: string; start_date?: string }>;
      cursor?: string;
      has_more?: boolean;
    };

    eventos.push(...(data.items ?? []));
    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return eventos
    .filter((e) => {
      if (!e.start_date) return false;
      const fecha = e.start_date.slice(0, 10);
      return fecha >= desdeStr && fecha <= hastaStr;
    })
    .map((e) => ({
      titulo: e.name ?? "(sin título)",
      fecha: e.start_date ? e.start_date.slice(0, 10) : "",
      empresa,
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}
