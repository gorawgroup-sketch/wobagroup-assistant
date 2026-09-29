/**
 * Descarga un PDF enlazado en el cuerpo de un correo (ver core/gmail/enlacesFacturaEnCorreo.ts).
 * A diferencia de un adjunto real de Gmail (que ya pasó por el antivirus/antispam de Google antes de
 * llegar), esto es contenido de un servidor de terceros elegido por el remitente — se trata como
 * dato no confiable: solo lectura, nunca se ejecuta ni se abre, con límites estrictos de tiempo y
 * tamaño, y se exige la firma real de PDF (además del content-type, que un servidor puede mentir).
 *
 * Hallazgo real de la revisión adversarial del PR #247: el destino de esta petición lo elige
 * contenido de un tercero no confiable — es el ÚNICO `fetch()` de todo el repo donde eso ocurre
 * (Holded/Telegram/GitHub/tipo de cambio siempre apuntan a bases fijas puestas por el desarrollador).
 * Dos defensas, ninguna perfecta pero juntas cierran el vector confirmado en la revisión:
 * - Nunca se sigue una redirección (`redirect: "manual"`): un 302 desde un dominio público hacia un
 *   host interno pasaba el chequeo de "https + .pdf" del enlace original y llegaba igual. Un
 *   proveedor real de facturas no necesita redirigir para servir un PDF; si lo hace, la descarga
 *   falla y el correo sigue exactamente igual que sin esta función (nunca se bloquea nada).
 * - Se rechaza el host ANTES de conectar si es una IP literal, localhost, o un dominio que termina en
 *   un sufijo interno típico de nube (.internal/.local/.localhost) — cubre el caso más burdo
 *   (enlazar directo a 169.254.169.254 o a un servicio interno de Railway).
 * Límite conocido y no resuelto: esto no protege contra "DNS rebinding" (un dominio público que
 * resuelve a una IP interna en el momento exacto de la conexión) — eso exigiría resolver el DNS y
 * fijar esa IP antes de conectar (un `dispatcher` propio de undici), fuera del alcance de este PR.
 */
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 15 * 1024 * 1024;

export class DescargaFacturaEnlazadaError extends Error {}

function hostInternoOLiteral(hostname: string): boolean {
  // `URL.hostname` de Node CONSERVA los corchetes de un literal IPv6 ("[::1]"), a diferencia del
  // resto de casos — se quitan antes de comparar.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  if (/\.(internal|local|localhost)$/.test(h)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4 literal
  if (h.includes(":") && /^[0-9a-f:]+$/i.test(h)) return true; // IPv6 literal
  return false;
}

export async function descargarFacturaEnlazada(url: string): Promise<Buffer> {
  const hostname = new URL(url).hostname;
  if (hostInternoOLiteral(hostname)) {
    throw new DescargaFacturaEnlazadaError(`El enlace apunta a un host interno o una IP literal (${hostname}); no se descarga.`);
  }
  let respuesta: Response;
  try {
    respuesta = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
  } catch (error) {
    throw new DescargaFacturaEnlazadaError(
      `No se pudo descargar el enlace (${error instanceof Error ? error.message : "fallo de red"}).`
    );
  }
  if (respuesta.type === "opaqueredirect" || (respuesta.status >= 300 && respuesta.status < 400)) {
    throw new DescargaFacturaEnlazadaError("El enlace redirige a otra URL; por seguridad no se sigue.");
  }
  if (!respuesta.ok) throw new DescargaFacturaEnlazadaError(`El enlace respondió ${respuesta.status}.`);
  const longitudDeclarada = Number(respuesta.headers.get("content-length"));
  if (Number.isFinite(longitudDeclarada) && longitudDeclarada > MAX_BYTES) {
    throw new DescargaFacturaEnlazadaError(`El archivo enlazado supera el límite seguro de ${MAX_BYTES} bytes.`);
  }
  const bytes = Buffer.from(await respuesta.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    throw new DescargaFacturaEnlazadaError(`El archivo enlazado supera el límite seguro de ${MAX_BYTES} bytes.`);
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new DescargaFacturaEnlazadaError("El enlace no descargó un PDF real (firma de archivo inválida).");
  }
  return bytes;
}
