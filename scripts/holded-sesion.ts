import "dotenv/config";
import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { comprobarSesionWeb } from "../core/holded/automatizacion/navegadorHolded";
import { rutaChrome } from "../core/gmail/generarComprobantePDF";

/**
 * Procedimiento seguro de sesión web de Holded para las automatizaciones del servidor.
 *   capturar  — abre Chrome en TU ordenador; inicias sesión tú (contraseña, 2FA, CAPTCHA los resuelves tú) y el script
 *               guarda SOLO las cookies de sesión en un archivo local con permisos 600 (nunca se imprimen).
 *   comprobar — lee WOBI_HOLDED_WEB_SESSION del entorno y verifica, sin tocar nada, que la sesión sigue válida.
 * Nadie debe pegar contraseñas ni cookies en el chat.
 */
async function capturar(): Promise<void> {
  const { default: puppeteer } = await import("puppeteer-core");
  const chrome = await rutaChrome(process.env.WOBI_COMPROBANTE_CHROME_PATH);
  const browser = await puppeteer.launch({ executablePath: chrome.executablePath, headless: false, defaultViewport: null });
  try {
    const page = await browser.newPage();
    await page.goto("https://app.holded.com/", { waitUntil: "domcontentloaded" });
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Inicia sesión en la ventana de Chrome (con la cuenta que usará WOBI). Cuando veas tu panel de Holded, pulsa Enter aquí… ");
    rl.close();
    const cookies = (await browser.cookies()).filter((c) => /holded/i.test(c.domain));
    if (cookies.length === 0) throw new Error("No se encontraron cookies de Holded: ¿se completó el inicio de sesión?");
    const archivo = join(homedir(), ".wobi-holded-sesion.b64");
    writeFileSync(archivo, Buffer.from(JSON.stringify(cookies)).toString("base64"), { mode: 0o600 });
    chmodSync(archivo, 0o600);
    console.log(`Sesión guardada en ${archivo} (permisos 600; ${cookies.length} cookies, contenido no mostrado).`);
    console.log("Para subirla al servidor sin que pase por el chat:");
    console.log(`  railway variables --set "WOBI_HOLDED_WEB_SESSION=$(cat ${archivo})"`);
    console.log(`Después borra el archivo local: rm ${archivo}`);
  } finally { await browser.close(); }
}

async function main(): Promise<void> {
  const accion = process.argv[2];
  if (accion === "capturar") await capturar();
  else if (accion === "comprobar") {
    const r = await comprobarSesionWeb();
    console.log(r.estado === "ok" ? "Sesión web de Holded válida." : `Sesión NO utilizable: ${r.estado} — ${"detalle" in r ? r.detalle : ""}`);
    process.exitCode = r.estado === "ok" ? 0 : 1;
  } else throw new Error("Uso: holded-sesion.ts capturar|comprobar");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "Error"); process.exitCode = 1; });
