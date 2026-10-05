import type { Browser, Frame, Page, Cookie } from "puppeteer-core";
import type { Empresa } from "../client";
import { esSolicitudPeligrosa, exigirEtiquetasPermitidas } from "./cuidados";
import { registrarTraza } from "./traza";
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
declare const document: { body?: { innerText?: string }; querySelectorAll<T = HTMLElement>(selector: string): ArrayLike<T>; querySelector(selector: string): HTMLElement | null };
interface HTMLElement { children: { length: number }; textContent: string | null; offsetParent: unknown; getClientRects(): { length: number }; click(): void; querySelector(s: string): unknown; parentElement: HTMLElement | null }

export const BASE = (process.env.WOBI_HOLDED_WEB_URL ?? "https://app.holded.com").replace(/\/$/, "");
// Verificado contra la interfaz real (2026-10-02): la edición de un gasto tiene URL directa.
const RUTA_EDITAR_COMPRA = process.env.WOBI_HOLDED_WEB_RUTA_EDITAR_COMPRA ?? "/doc/purchase/{id}/edit";
const RUTA_ATERRIZAJE = process.env.WOBI_HOLDED_WEB_RUTA_ATERRIZAJE ?? "/contacts";
const RUTA_TESORERIA =process.env.WOBI_HOLDED_WEB_RUTA_TESORERIA ?? "/treasury";
const TIEMPO_MAXIMO_MS = 150_000;
const LIMITE_SINCRONIZAR_MS = 540_000;
const ESPERA_CONFIRMACION_MS = 300_000;

let enUso = false;

/** Una sesión web por empresa: WOBI_HOLDED_WEB_SESSION_WOBA / _EWORKS / _FOOTPRINT (la general sirve de último recurso). */
export const nombreVariableSesion = (empresa: Empresa) => `WOBI_HOLDED_WEB_SESSION_${empresa.toUpperCase()}`;

export function sesionWebConfigurada(empresa?: Empresa, env: NodeJS.ProcessEnv = process.env): boolean {
  const hay = (nombre: string) => Boolean(env[nombre]?.trim());
  return empresa ? hay(nombreVariableSesion(empresa)) || hay("WOBI_HOLDED_WEB_SESSION")
    : (["WOBA", "EWORKS", "Footprint"] as const).some((e) => hay(nombreVariableSesion(e))) || hay("WOBI_HOLDED_WEB_SESSION");
}

/** `dedicada` = sesión propia de esa empresa (no hace falta cambiar de empresa por dentro, que es lo inestable). */
function leerCookies(empresa: Empresa): { cookies: Cookie[]; dedicada: boolean } | undefined {
  const propia = process.env[nombreVariableSesion(empresa)]?.trim();
  const crudo = propia || process.env.WOBI_HOLDED_WEB_SESSION?.trim();
  if (!crudo) return undefined;
  const dedicada = Boolean(propia);
  try {
    const lista = JSON.parse(Buffer.from(crudo, "base64").toString("utf8")) as Cookie[];
    return Array.isArray(lista) && lista.length > 0 ? { cookies: lista, dedicada } : undefined;
  } catch { return undefined; }
}

async function conTiempo<T>(tarea: Promise<T>, ms: number, nombre: string): Promise<T> {
  let t: NodeJS.Timeout;
  const limite = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${nombre} superó ${ms} ms`)), ms); });
  try { return await Promise.race([tarea, limite]); } finally { clearTimeout(t!); }
}

export const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Clic en el primer elemento visible cuyo texto coincide con alguna de las etiquetas. */
export async function clicPorTexto(page: Page | Frame, etiquetas: string[], exacto = false, hacerClic = true): Promise<boolean> {
  if (hacerClic) exigirEtiquetasPermitidas(etiquetas);
  return page.evaluate((tags, soloExacto, clic) => {
    const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
    const buscados = tags.map(norm);
    const candidatos = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button], [role=menuitem], label, span") as ArrayLike<HTMLElement>);
    for (const el of candidatos) {
      const visible = el.offsetParent !== null || el.getClientRects().length > 0;
      const texto = norm(el.textContent ?? "");
      if (visible && texto.length < 80 && buscados.some((b) => texto === b || (!soloExacto && texto.startsWith(b)))) { if (clic) el.click(); return true; }
    }
    return false;
  }, etiquetas, exacto, hacerClic);
}

async function abrirSesion(empresa: Empresa): Promise<{ browser: Browser; page: Page; dedicada: boolean } | ResultadoNavegador> {
  const sesion = leerCookies(empresa);
  if (!sesion) return { estado: "no_disponible", detalle: `No hay sesión web de Holded para ${empresa} (${nombreVariableSesion(empresa)})` };
  const { cookies, dedicada } = sesion;
  const { rutaChrome, modoHeadlessComprobante } = await import("../../gmail/generarComprobantePDF");
  const { default: puppeteer } = await import("puppeteer-core");
  const chrome = await rutaChrome(process.env.WOBI_COMPROBANTE_CHROME_PATH);
  const headless = modoHeadlessComprobante(chrome.empaquetadoServerless);
  const args = chrome.empaquetadoServerless ? await puppeteer.defaultArgs({ args: chrome.args, headless }) : chrome.args;
  const browser = await puppeteer.launch({ executablePath: chrome.executablePath, args, headless, timeout: 40_000, defaultViewport: { width: 1366, height: 900 } });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    // Cuidado de seguridad (el usuario de WOBI es Administrador): se bloquea cualquier borrado y cualquier escritura sobre usuarios,
    // suscripción, facturación o cierre de periodos, y se deja constancia en /health.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (esSolicitudPeligrosa(req.method(), req.url())) {
        registrarTraza("peticion_bloqueada", { metodo: req.method(), ruta: (() => { try { return new URL(req.url()).pathname.slice(0, 80); } catch { return "?"; } })() });
        void req.abort("blockedbyclient").catch(() => undefined);
      } else void req.continue().catch(() => undefined);
    });
    await page.evaluateOnNewDocument("window.__name = window.__name || function (f) { return f; }");
    await page.setCookie(...cookies);
    return { browser, page, dedicada };
  } catch (error) { await browser.close().catch(() => undefined); throw error; }
}

/** Distingue sesión válida de login/verificación mirando la URL y los textos visibles; no interactúa con ellos. */
export async function estadoSesion(page: Page): Promise<ResultadoNavegador> {
  const url = page.url();
  // Una recarga justo en este instante (pasa en la portada de Footprint) no es un fallo: se reintenta una vez.
  const leerCuerpo = () => page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "");
  const cuerpo = await leerCuerpo().catch(async () => { await pausa(2500); return leerCuerpo(); });
  if (/captcha|no soy un robot|i'?m not a robot/i.test(cuerpo)) return { estado: "requiere_verificacion", detalle: "Holded pide CAPTCHA; lo debe resolver una persona" };
  if (/verification code|código de verificación|two-factor|autenticación en dos pasos/i.test(cuerpo)) return { estado: "requiere_verificacion", detalle: "Holded pide verificación en dos pasos" };
  const pareceLogin = /\/(login|signin|auth)\b/i.test(url) || (/iniciar sesión|log in|sign in/i.test(cuerpo.slice(0, 600)) && /contraseña|password/i.test(cuerpo));
  if (pareceLogin) return { estado: "sesion_caducada", detalle: "La sesión web de Holded caducó; hay que renovarla con scripts/holded-sesion.ts" };
  return { estado: "ok" };
}

export async function conPagina(empresa: Empresa, tarea: (page: Page, dedicada: boolean) => Promise<ResultadoNavegador>, limiteMs = TIEMPO_MAXIMO_MS): Promise<ResultadoNavegador> {
  if (enUso) return { estado: "error", detalle: "Ya hay una acción de navegador de Holded en curso en este proceso" };
  enUso = true;
  let browser: Browser | undefined;
  try {
    return await conTiempo((async () => {
      const abierto = await abrirSesion(empresa);
      if (!("browser" in abierto)) return abierto;
      browser = abierto.browser;
      return tarea(abierto.page, abierto.dedicada);
    })(), limiteMs, "Acción de navegador de Holded");
  } catch (error) {
    return { estado: "error", detalle: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  } finally {
    enUso = false;
    await browser?.close().catch(() => undefined);
  }
}

/** La edición vive dentro de un marco anidado: se espera al que contiene el texto indicado. */
async function esperarMarco(page: Page, patron: RegExp, ms = 40_000): Promise<Frame | undefined> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    for (const marco of page.frames()) {
      const ok = await marco.evaluate((src) => new RegExp(src, "i").test(document.body?.innerText ?? ""), patron.source).catch(() => false);
      if (ok) return marco;
    }
    await pausa(500);
  }
  return undefined;
}

/** Como clicPorTexto, pero una recarga de la pantalla en mitad de la consulta cuenta como «aún no» en vez de error. */
const clicPorTextoSeguro = (marco: Frame, etiquetas: string[], exacto: boolean, hacerClic = true) => clicPorTexto(marco, etiquetas, exacto, hacerClic).catch(() => false);

export const empresaActivaEnPantalla = async (page: Page) =>
  (await page.mainFrame().evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60)).catch(() => "")).toLowerCase();

/**
 * Espera a que la pantalla deje de recargarse: el mismo texto no vacío durante 3 lecturas seguidas. Las páginas de Footprint
 * (miles de documentos) tardan 10-15 s en asentarse y mientras tanto se recargan; interactuar antes hace fallar los clics.
 */
export async function esperarEstable(page: Page, ms = 60_000): Promise<boolean> {
  const limite = Date.now() + ms;
  let previo = "", iguales = 0;
  while (Date.now() < limite) {
    const t = await empresaActivaEnPantalla(page);
    if (t !== "" && t === previo) iguales++; else iguales = 0;
    previo = t;
    if (iguales >= 3) return true;
    await pausa(1000);
  }
  return false;
}

/**
 * Antes de CUALQUIER acción se activa la empresa pedida. En Holded la empresa activa es del USUARIO (no de la sesión): cualquier
 * otra acción —incluida una persona usando esa misma cuenta— la cambia para todas las sesiones, así que nunca se puede suponer
 * cuál es. Menú de la empresa → «Cambiar cuenta» → «WOBA» / «Footprint Global» / «Eworks» (verificado en la interfaz real); después
 * se comprueba que quedó activa. Si ya lo era, no se toca nada.
 */
export async function activarEmpresa(page: Page, empresa: Empresa, urlLigera: string = `${BASE}${RUTA_ATERRIZAJE}`): Promise<ResultadoNavegador> {
  await page.goto(urlLigera, { waitUntil: "domcontentloaded" });
  const sesion = await estadoSesion(page);
  if (sesion.estado !== "ok") return sesion;
  const objetivo = empresa.toLowerCase();
  await esperarEstable(page);
  if ((await empresaActivaEnPantalla(page)).startsWith(objetivo)) return { estado: "ok" };
  // El menú se abre con un clic en el selector; si la pantalla aún se estaba recargando, se reintenta hasta 5 veces.
  let menu = false;
  for (let intento = 0; intento < 5 && !menu; intento++) {
    await page.mouse.click(120, 69);
    await pausa(1500);
    menu = await clicPorTextoSeguro(page.mainFrame(), ["Cambiar cuenta"], true);
    if (!menu) { await pausa(2500); await esperarEstable(page, 20_000); }
  }
  if (!menu) return { estado: "elemento_no_encontrado", detalle: "No se encontró «Cambiar cuenta» en el menú de la empresa" };
  await pausa(1200);
  if (!(await clicPorTextoSeguro(page.mainFrame(), [empresa], false))) return { estado: "elemento_no_encontrado", detalle: `No apareció ${empresa} en la lista de cuentas de Holded` };
  const espera = Date.now() + 60_000;
  while (Date.now() < espera) { if ((await empresaActivaEnPantalla(page)).startsWith(objetivo)) { await esperarEstable(page, 30_000); return { estado: "ok" }; } await pausa(1000); }
  return { estado: "elemento_no_encontrado", detalle: `No se pudo activar la empresa ${empresa} en Holded; no se tocó nada` };
}

async function flujoDesmarcar(page: Page, empresa: Empresa, compraId: string, o: { borrador: boolean; guardar: boolean }, dedicada: boolean): Promise<ResultadoNavegador> {
  await page.emulateTimezone("Europe/Madrid"); // las fechas del editor no deben desplazarse por la zona horaria del servidor
  // Página de aterrizaje para cambiar de empresa: el menú de empresa está en todas, pero esta es la que se mantiene estable
  // en el navegador sin pantalla (el editor de un gasto de OTRA empresa da error y la portada/Compras se recargan en bucle).
  void dedicada; // la empresa activa es del usuario, no de la sesión: se activa SIEMPRE antes de actuar
  const activada = await activarEmpresa(page, empresa, `${BASE}${RUTA_ATERRIZAJE}`);
  if (activada.estado !== "ok") return activada;
  await page.goto(`${BASE}${RUTA_EDITAR_COMPRA.replace("{id}", encodeURIComponent(compraId))}`, { waitUntil: "domcontentloaded" });
  const sesion = await estadoSesion(page);
  if (sesion.estado !== "ok") return sesion;
  await esperarEstable(page);
  const editor = () => esperarMarco(page, /Editar Compra/, 15_000);
  if (!(await esperarMarco(page, /Editar Compra/))) return { estado: "elemento_no_encontrado", detalle: "No se abrió el editor del gasto (¿no existe o no es de la empresa activa?)" };
  // Seguridad: la sesión actúa sobre la empresa activa en Holded; si no es la esperada, no se toca nada.
  const activa = (await page.mainFrame().evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60))).toLowerCase();
  if (!activa.startsWith(empresa.toLowerCase())) return { estado: "elemento_no_encontrado", detalle: `La empresa activa en Holded no es ${empresa}; no se tocó nada` };
  const m1 = await editor();
  if (!m1 || !(await clicPorTexto(m1, ["Opciones", "Options"], true))) return { estado: "elemento_no_encontrado", detalle: "No se encontró «Opciones» en el editor" };
  await pausa(1000);
  // La casilla se localiza por su etiqueta; solo se actúa si está marcada (jamás se marca por error).
  const m2 = await editor();
  if (!m2) return { estado: "error", detalle: "El editor se cerró inesperadamente" };
  const casilla = await m2.evaluate(() => {
    const hoja = Array.from(document.querySelectorAll<HTMLElement>("*") as ArrayLike<HTMLElement>).find((e) => e.children.length === 0 && (e.textContent ?? "").trim().toLowerCase() === "es una factura de compra") as HTMLElement | undefined;
    if (!hoja) return { estado: "no_encontrada" as const };
    let n: HTMLElement | null = hoja;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      const caja = n.querySelector("input[type=checkbox]") as { checked: boolean; click(): void } | null;
      if (caja) { const estaba = caja.checked; if (estaba) caja.click(); return { estado: estaba ? ("desmarcada" as const) : ("ya_desmarcada" as const), ahora: caja.checked }; }
    }
    return { estado: "sin_input" as const };
  });
  if (casilla.estado === "no_encontrada" || casilla.estado === "sin_input") return { estado: "elemento_no_encontrado", detalle: "No se encontró la casilla «Es una factura de compra»" };
  if (casilla.estado === "ya_desmarcada") return { estado: "ok", detalle: "La casilla ya estaba desmarcada; no se guardó nada" };
  if (casilla.ahora !== false) return { estado: "error", detalle: "La casilla no cambió al pulsarla; no se guardó nada" };
  // Se cierra el panel de opciones (cubre el botón Guardar) y se guarda; un borrador se guarda como borrador para no aprobarlo.
  await page.keyboard.press("Escape");
  await pausa(700);
  let m3 = await editor();
  const abierto = async () => (await m3?.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("*") as ArrayLike<HTMLElement>).some((e) => e.children.length === 0 && (e.textContent ?? "").trim().toLowerCase() === "es una factura de compra" && (e.offsetParent !== null))).catch(() => false)) === true;
  if (await abierto()) { await page.mouse.click(1327, 41); await pausa(700); m3 = await editor(); }
  if (await abierto()) return { estado: "error", detalle: "No se pudo cerrar el panel de opciones; no se guardó nada" };
  const boton = o.borrador ? ["Guardar como borrador"] : ["Guardar"];
  // En el ensayo el botón solo se localiza (hacerClic=false): nada se guarda.
  if (!m3 || !(await clicPorTexto(m3, boton, true, o.guardar))) return { estado: "elemento_no_encontrado", detalle: `No se encontró «${boton[0]}»; no se guardó nada` };
  if (!o.guardar) return { estado: "ok", detalle: `Ensayo correcto: editor, Opciones, casilla desmarcada, panel cerrado y botón «${boton[0]}» localizado (SIN guardar)` };
  await pausa(4000);
  return { estado: "ok", detalle: "Casilla desmarcada y guardado pulsado; falta verificar con Holded" };
}

/**
 * Sincronización de UNA cuenta bancaria (verificado en la interfaz real, 2026-10-02): cada cuenta tiene su página
 * `/banking/accounts/<id>` (el mismo id que la API de tesorería) con un botón azul «Sincronizar» arriba a la derecha.
 * Una cuenta que necesita renovar el consentimiento del banco no mostrará ese botón: se informa, nunca se reconecta.
 */
async function flujoSincronizar(page: Page, empresa: Empresa, cuenta: CuentaParaNavegador, o: { pulsar: boolean }, dedicada: boolean): Promise<ResultadoNavegador> {
  void dedicada; // la empresa activa es del usuario, no de la sesión: se activa SIEMPRE antes de actuar
  const activada = await activarEmpresa(page, empresa, `${BASE}${RUTA_ATERRIZAJE}`);
  if (activada.estado !== "ok") return activada;
  await page.goto(`${BASE}/banking/accounts/${encodeURIComponent(cuenta.id)}`, { waitUntil: "domcontentloaded" });
  const sesion = await estadoSesion(page);
  if (sesion.estado !== "ok") return sesion;
  await esperarEstable(page);
  // Seguridad: la empresa activa debe ser la esperada.
  const limite = Date.now() + 25_000;
  let activa = "";
  while (Date.now() < limite) { activa = await empresaActivaEnPantalla(page); if (activa.startsWith(empresa.toLowerCase())) break; await pausa(600); }
  if (!activa.startsWith(empresa.toLowerCase())) return { estado: "elemento_no_encontrado", detalle: `La empresa activa en Holded no es ${empresa}; no se tocó nada` };
  // Espera a que cargue la página de la cuenta y localiza el botón (sin pulsar todavía).
  const espera = Date.now() + 30_000;
  let hay = false;
  while (Date.now() < espera && !hay) { hay = await clicPorTextoSeguro(page.mainFrame(), ["Sincronizar", "Synchronize"], true, false); if (!hay) await pausa(1000); }
  if (!hay) {
    const texto = await page.mainFrame().evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ")).catch(() => "");
    const pideConsentimiento = /reconectar|renovar|consentimiento|autorizar|reconnect|re-authenticate|reautoriz/i.test(texto);
    return { estado: "elemento_no_encontrado", detalle: pideConsentimiento
      ? "La cuenta pide renovar el consentimiento del banco; lo debe hacer una persona (WOBI no reconecta bancos)"
      : "No se encontró el botón «Sincronizar» en la página de la cuenta" };
  }
  if (!o.pulsar) return { estado: "ok", detalle: `Ensayo correcto: página de «${cuenta.nombre}» y botón «Sincronizar» localizados (SIN pulsar)` };
  if (!(await clicPorTextoSeguro(page.mainFrame(), ["Sincronizar", "Synchronize"], true, true))) return { estado: "error", detalle: "No se pudo pulsar «Sincronizar»" };
  // Confirmación en pantalla: tras sincronizar, junto al saldo Holded cambia «Actualizado hace N horas» por «Actualizado hace unos
  // segundos». Es la prueba de que se sincronizó, cuenta por cuenta; se espera hasta 5 minutos SIN salir de la página.
  const limiteConfirmacion = Date.now() + ESPERA_CONFIRMACION_MS;
  while (Date.now() < limiteConfirmacion) {
    const texto = await page.mainFrame().evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ")).catch(() => "");
    const m = /Actualizado hace (unos segundos|\d+ segundos?|un minuto|un momento|unos instantes)/i.exec(texto);
    if (m) return { estado: "ok", detalle: `Sincronizada: «${m[0]}»`, confirmadoEnPantalla: m[0] };
    await pausa(2000);
  }
  const despues = await estadoSesion(page);
  if (despues.estado !== "ok") return despues;
  // No se da por buena ni se pasa a la siguiente como si nada: la cuenta se reintenta en la pasada siguiente (antes se mirará la
  // fecha de sincronización real de Holded por si sí se actualizó).
  return { estado: "error", detalle: "No se confirmó la sincronización: la pantalla no mostró «Actualizado hace unos segundos» en 5 minutos" };
}

/**
 * La interfaz de Holded a veces se recarga a mitad de acción (sobre todo en Footprint). Un fallo así es transitorio y se
 * repite hasta 3 veces con un navegador nuevo. Repetir es seguro: si el guardado ya se había aplicado, la casilla aparece
 * desmarcada y el flujo termina sin guardar nada más; el llamador verifica además el estado real en Holded.
 * Sesión caducada, verificación, CAPTCHA o «no hay sesión» NUNCA se reintentan.
 */
async function conReintentosTransitorios(accion: () => Promise<ResultadoNavegador>, maximo = 3): Promise<ResultadoNavegador> {
  let r: ResultadoNavegador = { estado: "error", detalle: "sin intentos" };
  for (let intento = 1; intento <= maximo; intento++) {
    r = await accion();
    // Tras pulsar «Sincronizar» sin confirmación NO se vuelve a pulsar dentro de la misma pasada (se mira antes el estado real).
    if (r.estado === "error" && /No se confirmó la sincronización/.test(r.detalle)) return r;
    const transitorio = r.estado === "error" ||
      (r.estado === "elemento_no_encontrado" && /Cambiar cuenta|lista de cuentas|No se abrió el editor|No se pudo activar|No se encontró el botón «Sincronizar»/i.test(r.detalle));
    if (!transitorio) return r;
    await pausa(3000 * intento);
  }
  return r;
}

export class NavegadorHoldedPuppeteer implements NavegadorHolded {
  async sincronizarCuenta(empresa: Empresa, cuenta: CuentaParaNavegador): Promise<ResultadoNavegador> {
    // Cuenta por cuenta y SIN abandonar la página hasta ver la confirmación: salir antes puede abortar la sincronización. El límite
    // cubre activar la empresa (hasta ~3 min) más hasta 5 min de espera de la confirmación.
    return conReintentosTransitorios(() => conPagina(empresa, (page, dedicada) => flujoSincronizar(page, empresa, cuenta, { pulsar: true }, dedicada), LIMITE_SINCRONIZAR_MS), 2);
  }

  /**
   * Solo lectura: activa la empresa, abre Configuración desde el menú de la empresa y devuelve el NOMBRE LEGAL que muestra el panel
   * (p. ej. «Business Atelier Europa SL»). Sirve para verificar la identidad de la empresa activa. No modifica nada.
   */
  async leerNombreLegal(empresa: Empresa): Promise<ResultadoNavegador> {
    return conReintentosTransitorios(() => conPagina(empresa, async (page) => {
      const activada = await activarEmpresa(page, empresa, `${BASE}${RUTA_ATERRIZAJE}`);
      if (activada.estado !== "ok") return activada;
      // Menú de la empresa → «Configuración» (verificado en la interfaz real); se reintenta si la pantalla aún se recarga.
      let abierto = false;
      for (let intento = 0; intento < 5 && !abierto; intento++) {
        await esperarEstable(page, 30_000);
        await page.mouse.click(120, 69);
        await pausa(1500);
        abierto = await clicPorTextoSeguro(page.mainFrame(), ["Configuración", "Settings"], true);
        if (!abierto) await pausa(2000);
      }
      if (!abierto) return { estado: "elemento_no_encontrado", detalle: "No se encontró «Configuración» en el menú de la empresa" };
      // El panel de configuración muestra «CONFIGURACIÓN <nombre legal>» en su cabecera.
      const limite = Date.now() + 40_000;
      while (Date.now() < limite) {
        for (const marco of page.frames()) {
          const t = await marco.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim()).catch(() => "");
          // El panel va al final de un texto largo (la pantalla de debajo sigue en el DOM): se busca en todo el texto.
          const m = /CONFIGURACI[ÓO]N\s+(.{3,80}?)\s+(?:Buscar en ajustes|Cuenta Personaliza|Facturaci[óo]n)/.exec(t);
          if (m) return { estado: "ok", detalle: m[1].trim() };
        }
        await pausa(1000);
      }
      return { estado: "elemento_no_encontrado", detalle: "No se pudo leer el nombre legal en el panel de configuración" };
    }));
  }

  /** Ensayo: llega hasta el botón «Sincronizar» de la cuenta y confirma que existe, SIN pulsarlo. */
  async ensayarSincronizacion(empresa: Empresa, cuenta: CuentaParaNavegador): Promise<ResultadoNavegador> {
    return conReintentosTransitorios(() => conPagina(empresa, (page, dedicada) => flujoSincronizar(page, empresa, cuenta, { pulsar: false }, dedicada)));
  }

  async desmarcarFacturaDeCompra(empresa: Empresa, compraId: string, opciones: { borrador?: boolean } = {}): Promise<ResultadoNavegador> {
    return conReintentosTransitorios(() => conPagina(empresa, (page, dedicada) => flujoDesmarcar(page, empresa, compraId, { borrador: opciones.borrador === true, guardar: true }, dedicada)));
  }

  /** Ensayo: recorre el mismo camino pero NO guarda; informa de lo encontrado. El navegador se cierra sin cambios. */
  async ensayarDesmarcado(empresa: Empresa, compraId: string, borrador = false): Promise<ResultadoNavegador> {
    return conReintentosTransitorios(() => conPagina(empresa, (page, dedicada) => flujoDesmarcar(page, empresa, compraId, { borrador, guardar: false }, dedicada)));
  }

  async cerrar(): Promise<void> { /* cada acción abre y cierra su propio navegador */ }
}

/** Comprobación de solo lectura de la sesión (sin tocar nada): para el diagnóstico y el procedimiento de activación. */
export async function comprobarSesionWeb(empresa: Empresa): Promise<ResultadoNavegador> {
  // Activa la empresa pedida (la empresa activa es del usuario, no de la sesión) y confirma que quedó activa.
  return conPagina(empresa, async (page) => {
    const r = await activarEmpresa(page, empresa, `${BASE}${RUTA_ATERRIZAJE}`);
    return r.estado === "ok" ? { estado: "ok", detalle: `Sesión válida; empresa ${empresa} activa` } : r;
  });
}

export function crearNavegadorHolded(): NavegadorHolded | undefined {
  return sesionWebConfigurada() ? new NavegadorHoldedPuppeteer() : undefined;
}
