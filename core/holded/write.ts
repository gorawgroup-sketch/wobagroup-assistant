import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import type { Empresa } from "./client";
import { formatDateLocal } from "../utils/dateFormat";
import { buscarAliasProveedor } from "../gastos/proveedorAliasSheet";
import { montosCercanos } from "../utils/montos";

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
  method: "GET" | "POST",
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

/**
 * Busca un contacto de Holded por nombre (coincidencia parcial, insensible a
 * mayúsculas/acentos/puntuación). Primero revisa el alias aprendido (ver
 * proveedorAliasSheet.ts) — un nombre que el usuario ya confirmó
 * manualmente antes para este proveedor+empresa — y si no hay, pagina los
 * contactos reales de Holded (el parámetro `name` no filtra en el servidor)
 * y filtra localmente. Nunca inventa un contact_id: si no encuentra
 * coincidencia, devuelve undefined.
 */
export async function buscarContactoHolded(empresa: Empresa, nombre: string): Promise<HoldedContact | undefined> {
  const alias = await buscarAliasProveedor(empresa, nombre).catch(() => undefined);
  if (alias) return { id: alias.contactId, name: alias.contactName };

  const objetivo = normalizar(nombre);
  const contactos = await obtenerTodosLosContactos(empresa);

  return contactos.find((c) => {
    if (typeof c.name !== "string") return false;
    const candidato = normalizar(c.name);
    return candidato.includes(objetivo) || objetivo.includes(candidato);
  });
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
  const objetivo = normalizar(criterios.proveedor);
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
      const nombreNormalizado = normalizar(item.contact_name);
      if (!nombreNormalizado.includes(objetivo) && !objetivo.includes(nombreNormalizado)) continue;
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
  /** true si este resultado vino de la segunda pasada (solo monto, sin match de nombre) — ver buscarDocumentosHolded. */
  coincidenciaSoloPorMonto: boolean;
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
  const objetivo = contactoObjetivo ? normalizar(contactoObjetivo) : undefined;
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
      }>;
      cursor?: string;
      has_more?: boolean;
    };

    for (const item of data.items ?? []) {
      if (!item.contact_name) continue;

      if (objetivo) {
        const nombreNormalizado = normalizar(item.contact_name);
        const coincideNombre = nombreNormalizado.includes(objetivo) || objetivo.includes(nombreNormalizado);
        if (!coincideNombre) continue;
      }

      const total = parsearMontoHolded(item.total);
      if (monto !== undefined && Number.isFinite(total) && !montosCercanos(total, monto, TOLERANCIA_MONTO_DOCUMENTO)) {
        continue;
      }
      // Sin nombre Y sin monto no hay ningún criterio real de búsqueda — no debería llegar acá (buscarDocumentosHolded ya lo evita), pero por si acaso no se lista todo el histórico.
      if (!objetivo && monto === undefined) continue;

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
        coincidenciaSoloPorMonto: !objetivo,
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
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);
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

  if (porNombre.length > 0 || criterios.monto === undefined) return porNombre;

  return (
    await Promise.all(
      paths.map((p) =>
        buscarEnEndpointDocumentos(empresa, p.path, p.tipoDoc, undefined, criterios.monto, desdeStr, hastaStr)
      )
    )
  ).flat();
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
const PALABRAS_IGNORADAS_CONCEPTO = new Set(["para", "con", "del", "los", "las", "una", "por", "que", "servicio", "servicios"]);

function palabrasSignificativas(texto: string): string[] {
  return normalizar(texto)
    .split(/\s+/)
    .filter((p) => p.length >= 4 && !PALABRAS_IGNORADAS_CONCEPTO.has(p));
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

  const objetivoProveedor = normalizar(criterios.proveedor);
  const porNombre = objetivoProveedor
    ? lineas.filter((l) => {
        const nombre = normalizar(l.contactName);
        return nombre && (nombre.includes(objetivoProveedor) || objetivoProveedor.includes(nombre));
      })
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

export interface LineaGastoHolded {
  concepto: string;
  base: number;
  tipoIvaPct: number;
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
    return {
      name: linea.concepto || gasto.descripcion,
      units: 1,
      price: linea.base,
      tax: 0,
      taxes: taxKey ? [taxKey] : [],
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

export interface MovimientoBancarioCandidato {
  accountId: string;
  movementId: string;
  descripcion: string;
  monto: number;
  fecha: string;
}

const VENTANA_DIAS_MOVIMIENTO = 5;

/**
 * Busca movimientos bancarios SIN conciliar (status != "reconciled") en
 * todas las cuentas activas de la empresa, con monto (en valor absoluto) y
 * fecha cercanos a los dados. Se usa solo para el auto-conciliar tras crear
 * o adjuntar un gasto propio — nunca para crear gastos a partir de
 * movimientos huérfanos (eso queda para revisión humana, ver
 * consultar_movimientos_sin_conciliar).
 */
export async function buscarMovimientoSimilar(
  empresa: Empresa,
  criterios: { monto: number; fecha: string }
): Promise<MovimientoBancarioCandidato[]> {
  const fechaBase = new Date(criterios.fecha);
  const desde = new Date(fechaBase);
  desde.setDate(desde.getDate() - VENTANA_DIAS_MOVIMIENTO);
  const hasta = new Date(fechaBase);
  hasta.setDate(hasta.getDate() + VENTANA_DIAS_MOVIMIENTO);

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
      if (mov.status === "reconciled") continue;
      const monto = montoEnEuros(mov);
      if (!Number.isFinite(monto) || !montosCercanos(Math.abs(monto), Math.abs(criterios.monto), TOLERANCIA_MONTO)) continue;

      candidatos.push({
        accountId: cuenta.id,
        movementId: mov.id,
        descripcion: mov.description ?? "",
        monto,
        fecha: mov.booking_date ? mov.booking_date.slice(0, 10) : "",
      });
    }
  }

  return candidatos;
}

/**
 * Intenta conciliar un movimiento bancario contra el gasto que se le
 * asocia (POST .../reconcile). El body de este endpoint no está bien
 * documentado — probado en vivo con varios cuerpos contra un movimiento ya
 * conciliado, todos devuelven 200/null sin poder confirmar el efecto real.
 * Por eso esta función SIEMPRE relee el movimiento después de llamarlo y
 * solo reporta éxito si `status` realmente pasó a "reconciled" — nunca
 * confía en el 200 por sí solo.
 */
export async function reconciliarMovimiento(
  empresa: Empresa,
  accountId: string,
  movementId: string,
  fechaAproximada: string
): Promise<{ ok: boolean; statusFinal: string }> {
  await holdedWriteCall(empresa, "POST", `/treasury/accounts/${accountId}/bank-movements/${movementId}/reconcile`, {});

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
  )) as { items?: Array<{ id: string; status?: string }> };

  const movimiento = (verificacion.items ?? []).find((m) => m.id === movementId);
  const statusFinal = movimiento?.status ?? "(no encontrado al releer)";

  return { ok: statusFinal === "reconciled", statusFinal };
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
