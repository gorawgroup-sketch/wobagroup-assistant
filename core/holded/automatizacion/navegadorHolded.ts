import type { Browser, Page, Cookie } from "puppeteer-core";
import type { Empresa } from "../client";
import type { CuentaParaNavegador, NavegadorHolded, ResultadoNavegador } from "./navegador";

/**
 * Trabajador de navegador headless contra la interfaz web de Holded, para el servidor (sin depender del Mac de nadie).
 * Reglas de seguridad:
 *  - La sesión llega SOLO por la variable de entorno secreta WOBI_HOLDED_WEB_SESSION (cookies en JSON codificado en
 *    base64, capturadas por la propia persona con scripts/holded-sesion.ts). Nunca contraseñas, nunca en repo ni logs.
 *  - No salta login, 2FA ni CAPTCHA: si aparecen, devuelve «sesion_caducada»/«requiere_verificacion» y se para.
 *  - Un único navegador a la vez en este proceso (evita dos usos simultáneos de la misma sesión).
 *  - Los selectores y rutas de la interfaz se basan en etiquetas visibles y son sobrescribibles por entorno; hasta
 *    validarlos con el caso controlado, cualquier elemento no encontrado detiene el caso (nunca se adivina un clic).
 */
// El tsconfig del servidor no incluye la librería DOM; estas declaraciones mínimas cubren solo el código que
// page.evaluate ejecuta DENTRO del navegador.
declare const document: { body?: { innerText?: string }; querySelectorAll<T>(selector: string): ArrayLike<T> };
interface HTMLElement { textContent: string | null; offsetParent: unknown; getClientRects(): { length: number }; click(): void; querySelector(s: string): unknown; parentElement: HTMLElement | null }

const BASE = (process.env.WOBI_HOLDED_WEB_URL ?? "https://app.holded.com").replace(/\/$/, "");
const RUTA_COMPRA = process.env.WOBI_HOLDED_WEB_RUTA_COMPRA ?? "/purchases#open:purchase-{id}";
const RUTA_TESORERIA = process.env.WOBI_HOLDED_WEB_RUTA_TESORERIA ?? "/treasury";
const TIEMPO_MAXIMO_MS = 90_000;

let enUso = false;

export function sesionWebConfigurada(): boolean { return Boolean(process.env.WOBI_HOLDED_WEB_SESSION?.trim()); }

function leerCookies(): Cookie[] | undefined {
  const crudo = process.env.WOBI_HOLDED_WEB_SESSION?.trim();
  if (!crudo) return undefined;
  try {
    const lista = JSON.parse(Buffer.from(crudo, "base64").toString("utf8")) as Cookie[];
    return Array.isArray(lista) && lista.length > 0 ? lista : undefined;
  } catch { return undefined; }
}

async function conTiempo<T>(tarea: Promise<T>, ms: number, nombre: string): Promise<T> {
  let t: NodeJS.Timeout;
  const limite = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${nombre} superó ${ms} ms`)), ms); });
  try { return await Promise.race([tarea, limite]); } finally { clearTimeout(t!); }
}

const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Clic en el primer elemento visible cuyo texto coincide con alguna de las etiquetas. */
async function clicPorTexto(page: Page, etiquetas: string[]): Promise<boolean> {
  return page.evaluate((tags) => {
    const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
    const buscados = tags.map(norm);
    const candidatos = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button], [role=menuitem], label, span") as ArrayLike<HTMLElement>);
    for (const el of candidatos) {
      const visible = el.offsetParent !== null || el.getClientRects().length > 0;
      const texto = norm(el.textContent ?? "");
      if (visible && texto.length < 80 && buscados.some((b) => texto === b || texto.startsWith(b))) { el.click(); return true; }
    }
    return false;
  }, etiquetas);
}

async function abrirSesion(): Promise<{ browser: Browser; page: Page } | ResultadoNavegador> {
  const cookies = leerCookies();
  if (!cookies) return { estado: "no_disponible", detalle: "No hay sesión web de Holded configurada (WOBI_HOLDED_WEB_SESSION)" };
  const { rutaChrome, modoHeadlessComprobante } = await import("../../gmail/generarComprobantePDF");
  const { default: puppeteer } = await import("puppeteer-core");
  const chrome = await rutaChrome(process.env.WOBI_COMPROBANTE_CHROME_PATH);
  const headless = modoHeadlessComprobante(chrome.empaquetadoServerless);
  const args = chrome.empaquetadoServerless ? await puppeteer.defaultArgs({ args: chrome.args, headless }) : chrome.args;
  const browser = await puppeteer.launch({ executablePath: chrome.executablePath, args, headless, timeout: 40_000, defaultViewport: { width: 1366, height: 900 } });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await page.setCookie(...cookies);
    return { browser, page };
  } catch (error) { await browser.close().catch(() => undefined); throw error; }
}

/** Distingue sesión válida de login/verificación mirando la URL y los textos visibles; no interactúa con ellos. */
async function estadoSesion(page: Page): Promise<ResultadoNavegador> {
  const url = page.url();
  const cuerpo = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "");
  if (/captcha|no soy un robot|i'?m not a robot/i.test(cuerpo)) return { estado: "requiere_verificacion", detalle: "Holded pide CAPTCHA; lo debe resolver una persona" };
  if (/verification code|código de verificación|two-factor|autenticación en dos pasos/i.test(cuerpo)) return { estado: "requiere_verificacion", detalle: "Holded pide verificación en dos pasos" };
  const pareceLogin = /\/(login|signin|auth)\b/i.test(url) || (/iniciar sesión|log in|sign in/i.test(cuerpo.slice(0, 600)) && /contraseña|password/i.test(cuerpo));
  if (pareceLogin) return { estado: "sesion_caducada", detalle: "La sesión web de Holded caducó; hay que renovarla con scripts/holded-sesion.ts" };
  return { estado: "ok" };
}

async function conPagina(tarea: (page: Page) => Promise<ResultadoNavegador>): Promise<ResultadoNavegador> {
  if (enUso) return { estado: "error", detalle: "Ya hay una acción de navegador de Holded en curso en este proceso" };
  enUso = true;
  let browser: Browser | undefined;
  try {
    return await conTiempo((async () => {
      const abierto = await abrirSesion();
      if (!("browser" in abierto)) return abierto;
      browser = abierto.browser;
      return tarea(abierto.page);
    })(), TIEMPO_MAXIMO_MS, "Acción de navegador de Holded");
  } catch (error) {
    return { estado: "error", detalle: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  } finally {
    enUso = false;
    await browser?.close().catch(() => undefined);
  }
}

export class NavegadorHoldedPuppeteer implements NavegadorHolded {
  async sincronizarCuenta(_empresa: Empresa, cuenta: CuentaParaNavegador): Promise<ResultadoNavegador> {
    return conPagina(async (page) => {
      await page.goto(`${BASE}${RUTA_TESORERIA}`, { waitUntil: "networkidle2" });
      const sesion = await estadoSesion(page);
      if (sesion.estado !== "ok") return sesion;
      // Se entra en la cuenta por su nombre visible y se pulsa «Sincronizar»; si algo no está, se detiene.
      if (!(await clicPorTexto(page, [cuenta.nombre]))) return { estado: "elemento_no_encontrado", detalle: `No se encontró la cuenta «${cuenta.nombre}» en la pantalla de tesorería` };
      await pausa(1500);
      if (!(await clicPorTexto(page, ["Sincronizar", "Synchronize", "Sync"]))) return { estado: "elemento_no_encontrado", detalle: "No se encontró el botón «Sincronizar» (¿banco que requiere renovar consentimiento?)" };
      await pausa(2000);
      const despues = await estadoSesion(page);
      return despues.estado === "ok" ? { estado: "ok", detalle: "Botón «Sincronizar» pulsado; falta verificar con Holded" } : despues;
    });
  }

  async desmarcarFacturaDeCompra(_empresa: Empresa, compraId: string): Promise<ResultadoNavegador> {
    return conPagina(async (page) => {
      await page.goto(`${BASE}${RUTA_COMPRA.replace("{id}", encodeURIComponent(compraId))}`, { waitUntil: "networkidle2" });
      const sesion = await estadoSesion(page);
      if (sesion.estado !== "ok") return sesion;
      if (!(await clicPorTexto(page, ["Editar", "Edit"]))) return { estado: "elemento_no_encontrado", detalle: "No se encontró «Editar» en el gasto" };
      await pausa(1000);
      if (!(await clicPorTexto(page, ["Opciones", "Options"]))) return { estado: "elemento_no_encontrado", detalle: "No se encontró «Opciones»" };
      await pausa(500);
      // La casilla se localiza por su etiqueta y solo se toca si está marcada (nunca se marca por error).
      const resultado = await page.evaluate(() => {
        const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
        for (const l of Array.from(document.querySelectorAll<HTMLElement>("label, span, div") as ArrayLike<HTMLElement>)) {
          if ((l.textContent ?? "").length > 60 || !norm(l.textContent ?? "").startsWith("es una factura de compra")) continue;
          const caja = (l.querySelector("input[type=checkbox]") ?? l.parentElement?.querySelector("input[type=checkbox]")) as { checked: boolean; click(): void } | null;
          if (!caja) continue;
          if (!caja.checked) return "ya_desmarcada";
          caja.click();
          return caja.checked ? "sigue_marcada" : "desmarcada";
        }
        return "no_encontrada";
      });
      if (resultado === "no_encontrada") return { estado: "elemento_no_encontrado", detalle: "No se encontró la casilla «Es una factura de compra»" };
      if (resultado === "sigue_marcada") return { estado: "error", detalle: "La casilla no cambió al pulsarla; no se guardó nada" };
      if (resultado === "ya_desmarcada") return { estado: "ok", detalle: "La casilla ya estaba desmarcada; no se guardó nada" };
      if (!(await clicPorTexto(page, ["Guardar", "Save"]))) return { estado: "elemento_no_encontrado", detalle: "No se encontró «Guardar»; no se guardó nada" };
      await pausa(2500);
      return { estado: "ok", detalle: "Casilla desmarcada y guardado pulsado; falta verificar con Holded" };
    });
  }

  async cerrar(): Promise<void> { /* cada acción abre y cierra su propio navegador */ }
}

/** Comprobación de solo lectura de la sesión (sin tocar nada): para el diagnóstico y el procedimiento de activación. */
export async function comprobarSesionWeb(): Promise<ResultadoNavegador> {
  return conPagina(async (page) => {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    return estadoSesion(page);
  });
}

export function crearNavegadorHolded(): NavegadorHolded | undefined {
  return sesionWebConfigurada() ? new NavegadorHoldedPuppeteer() : undefined;
}
