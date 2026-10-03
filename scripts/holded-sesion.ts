import "dotenv/config";
import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { coincideNombreLegal, NOMBRES_LEGALES } from "../core/holded/automatizacion/empresas";
import { NavegadorHoldedPuppeteer, nombreVariableSesion, sesionWebConfigurada } from "../core/holded/automatizacion/navegadorHolded";
import { rutaChrome } from "../core/gmail/generarComprobantePDF";
import type { Empresa } from "../core/holded/client";

/**
 * Procedimiento seguro de sesión web de Holded para las automatizaciones del servidor: UNA SESIÓN POR EMPRESA
 * (el servidor no cambia de empresa por dentro: en Footprint eso es inestable).
 *   capturar [WOBA|EWORKS|Footprint|todas]
 *       Abre Chrome en TU ordenador. Para cada empresa se abre una ventana nueva (sesión de inicio independiente): inicias
 *       sesión tú (contraseña, 2FA y CAPTCHA los resuelves tú) y dejas esa empresa activa. Solo se guardan las cookies en
 *       un archivo local con permisos 600 (nunca se imprimen). Después, una sola orden las sube todas al servidor.
 *   comprobar [WOBA|EWORKS|Footprint|todas]
 *       Verifica, sin tocar nada, que la sesión de cada empresa (variable del entorno) sigue válida y es de esa empresa.
 * Nadie debe pegar contraseñas ni cookies en el chat.
 */
const EMPRESAS: readonly Empresa[] = ["WOBA", "EWORKS", "Footprint"];
const NOMBRE_EN_HOLDED: Record<Empresa, string> = { WOBA: "WOBA", EWORKS: "Eworks", Footprint: "Footprint Global" };
const archivoDe = (empresa: Empresa) => join(homedir(), `.wobi-holded-sesion-${empresa.toLowerCase()}.b64`);

function elegir(arg: string | undefined): Empresa[] {
  if (!arg || arg.toLowerCase() === "todas") return [...EMPRESAS];
  const e = EMPRESAS.find((x) => x.toLowerCase() === arg.toLowerCase());
  if (!e) throw new Error("Empresa no válida: usa WOBA, EWORKS, Footprint o todas.");
  return [e];
}

async function capturar(empresas: Empresa[]): Promise<void> {
  const { default: puppeteer } = await import("puppeteer-core");
  const chrome = await rutaChrome(process.env.WOBI_COMPROBANTE_CHROME_PATH);
  const browser = await puppeteer.launch({ executablePath: chrome.executablePath, headless: false, defaultViewport: null });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const guardadas: Empresa[] = [];
  try {
    for (const empresa of empresas) {
      // Contexto aislado = sesión de inicio nueva: cada empresa queda con su propia sesión en Holded.
      const contexto = await browser.createBrowserContext();
      const page = await contexto.newPage();
      await page.goto("https://app.holded.com/", { waitUntil: "domcontentloaded" });
      await rl.question(`\n[${empresa}] En la ventana de Chrome: inicia sesión y deja activa la empresa «${NOMBRE_EN_HOLDED[empresa]}» ` +
        `(menú de la empresa → Cambiar cuenta). Cuando veas su panel, pulsa Enter aquí… `);
      const cookies = (await contexto.cookies()).filter((c) => /holded/i.test(c.domain));
      if (cookies.length === 0) throw new Error(`No se encontraron cookies de Holded para ${empresa}: ¿se completó el inicio de sesión?`);
      const archivo = archivoDe(empresa);
      writeFileSync(archivo, Buffer.from(JSON.stringify(cookies)).toString("base64"), { mode: 0o600 });
      chmodSync(archivo, 0o600);
      guardadas.push(empresa);
      console.log(`[${empresa}] Sesión guardada (${cookies.length} cookies, contenido no mostrado).`);
      // La ventana de esa empresa se deja abierta hasta el final: cerrar sesión la invalidaría, cerrar la ventana no.
    }
  } finally { rl.close(); await browser.close(); }
  console.log("\nListo. Para subirlas al servidor sin que pasen por el chat:");
  const sets = guardadas.map((e) => `--set "${nombreVariableSesion(e)}=$(cat ${archivoDe(e)})"`).join(" ");
  console.log(`  railway variables ${sets}`);
  console.log(`Después borra los archivos locales: rm ${guardadas.map(archivoDe).join(" ")}`);
}

async function comprobar(empresas: Empresa[]): Promise<void> {
  let fallos = 0;
  for (const empresa of empresas) {
    if (!sesionWebConfigurada(empresa)) { console.log(`[${empresa}] Sin sesión configurada (${nombreVariableSesion(empresa)}).`); fallos++; continue; }
    // Activa la empresa y lee su NOMBRE LEGAL en Holded → Configuración: debe ser el esperado (el título del selector no basta).
    const r = await new NavegadorHoldedPuppeteer().leerNombreLegal(empresa);
    const ok = r.estado === "ok" && coincideNombreLegal(empresa, r.detalle ?? "");
    if (!ok) fallos++;
    console.log(`[${empresa}] ${ok ? `OK — ${r.detalle}` : r.estado === "ok" ? `NOMBRE LEGAL NO COINCIDE: Holded dice «${r.detalle}», esperado «${NOMBRES_LEGALES[empresa]}»` : `NO utilizable: ${r.estado} — ${r.detalle ?? ""}`}`);
  }
  process.exitCode = fallos === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const [accion, arg] = process.argv.slice(2);
  if (accion === "capturar") await capturar(elegir(arg));
  else if (accion === "comprobar") await comprobar(elegir(arg));
  else throw new Error("Uso: holded-sesion.ts capturar|comprobar [WOBA|EWORKS|Footprint|todas]");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "Error"); process.exitCode = 1; });
