import type { Empresa } from "./client";

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
function getWriteApiKey(empresa: Empresa): string {
  const envVar = empresa === "WOBA" ? "HOLDED_API_KEY_WRITE_WOBA" : "HOLDED_API_KEY_WRITE_EWORKS";
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

interface HoldedContact {
  id: string;
  name?: string;
  [key: string]: unknown;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(new RegExp("[̀-ͯ]", "g"), "")
    .toLowerCase();
}

const MAX_PAGINAS_CONTACTOS = 20;

/**
 * Busca un contacto de Holded por nombre (coincidencia parcial, insensible a
 * mayúsculas/acentos). La API de Holded no soporta filtrar por nombre en el
 * servidor (el parámetro `name` no filtra), así que se pagina y se filtra
 * localmente — igual que la búsqueda de archivos en Drive. Nunca inventa un
 * contact_id: si no encuentra coincidencia, devuelve undefined.
 */
export async function buscarContactoHolded(empresa: Empresa, nombre: string): Promise<HoldedContact | undefined> {
  const objetivo = normalizar(nombre);
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS_CONTACTOS; pagina++) {
    const path = `/contacts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = (await holdedWriteCall(empresa, "GET", path)) as {
      items?: HoldedContact[];
      cursor?: string;
      has_more?: boolean;
    };

    const match = (data.items ?? []).find((c) => typeof c.name === "string" && normalizar(c.name).includes(objetivo));
    if (match) return match;

    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }

  return undefined;
}

export interface NuevoGastoHolded {
  contactId: string;
  fecha: string; // YYYY-MM-DD
  descripcion: string;
  importe: number;
}

/**
 * Crea un documento de gasto/compra en Holded (POST /v2/purchases). Solo
 * debe invocarse tras aprobación explícita del usuario por botón — nunca
 * automáticamente. Queda como borrador/pendiente en Holded (no contabilizado
 * en firme), tal como se comportó en la prueba en vivo.
 */
export async function crearGastoHolded(empresa: Empresa, gasto: NuevoGastoHolded): Promise<{ id: string }> {
  const data = (await holdedWriteCall(empresa, "POST", "/purchases", {
    contact_id: gasto.contactId,
    date: gasto.fecha,
    description: gasto.descripcion,
    items: [{ name: gasto.descripcion, units: 1, price: gasto.importe, tax: 0 }],
  })) as { id?: string };

  if (!data.id) {
    throw new Error("Holded no devolvió un id para el gasto creado.");
  }

  return { id: data.id };
}
