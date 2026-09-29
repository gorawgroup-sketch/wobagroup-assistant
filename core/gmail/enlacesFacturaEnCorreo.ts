/**
 * Caso real (Footprint, 29 sep 2026): un correo reenviado de un apartamento en Venecia no traía
 * ningún adjunto real de Gmail — las 3 facturas (alojamiento, servicios, tasa turística) solo eran
 * enlaces `https://...pdf` dentro del cuerpo HTML, con el remitente pidiendo explícitamente sumarlas
 * ("@Admin Asistente toma en cuenta que hay 3 facturas aquí que dan el total pagado"). El sistema no
 * seguía nunca ningún enlace del cuerpo — solo leía el texto plano (que ya descarta las URLs de los
 * `<a href>` al convertir HTML a texto, ver `htmlATexto` en core/gmail/client.ts).
 *
 * Esta función es deliberadamente estricta: solo reconoce enlaces `https://` que terminan en `.pdf`
 * (una señal barata e inequívoca — nunca "cualquier enlace"). No decide nada por sí sola sobre si
 * hay que descargarlos; eso lo hace `facturasEnlazadasEnCuerpo.ts`, que además exige que la suma
 * cuadre con el importe que el propio correo ya afirmaba antes de usarlas.
 */
export interface EnlacePdf {
  url: string;
  /** Texto visible del enlace en el correo — solo para trazabilidad en logs/auditoría. */
  texto: string;
}

const MAX_ENLACES = 6;

export function extraerEnlacesPdf(html: string): EnlacePdf[] {
  if (!html) return [];
  const patron = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const vistos = new Set<string>();
  const resultado: EnlacePdf[] = [];
  for (const match of html.matchAll(patron)) {
    const url = match[1]?.trim();
    if (!url || vistos.has(url)) continue;
    if (!/^https:\/\//i.test(url)) continue;
    // El ancla puede llevar parámetros de tracking tras el .pdf (ej. "?token=..."); solo interesa
    // que el PATH termine en .pdf, no la cadena completa.
    let ruta: string;
    try { ruta = new URL(url).pathname; } catch { continue; }
    if (!/\.pdf$/i.test(ruta)) continue;
    vistos.add(url);
    const texto = match[2].replace(/<[^>]+>/g, "").trim();
    resultado.push({ url, texto });
    if (resultado.length >= MAX_ENLACES) break;
  }
  return resultado;
}
