import type { Page } from "puppeteer-core";
import type { Empresa } from "../client";
import type { ResultadoNavegador } from "../automatizacion/navegador";
import { activarEmpresa, BASE, clicPorTexto, conPagina, empresaActivaEnPantalla, estadoSesion, esperarEstable, pausa } from "../automatizacion/navegadorHolded";

/**
 * «Transferir» de la interfaz de Holded (verificado en la pantalla real el 05-10-2026). La API pública no lo ofrece:
 * un asiento creado con POST /ledger-entries queda sin número y la conciliación contra él devuelve 200 sin enlazar nada.
 *
 * Camino: Tesorería → cuenta → Conciliación (`/banking/accounts/<id>/reconcile`) → se selecciona el movimiento pendiente
 * (cada fila lleva `data-id` = id del movimiento) → «Transferir» → pestaña «Transferir a cuenta contable» → se elige la
 * cuenta contable del OTRO banco → «Transferir y conciliar». Holded crea un cobro y un pago enlazados (tipo «trans»):
 * el del movimiento pulsado queda conciliado y el otro queda pendiente en la otra cuenta para conciliar el segundo movimiento.
 */

// El tsconfig del servidor no incluye la librería DOM: lo que page.evaluate ejecuta DENTRO del navegador va sin tipos.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
declare const getComputedStyle: any;


export interface OrdenTransferir {
  /** Cuenta bancaria del movimiento sobre el que se pulsa «Transferir». */
  cuentaId: string;
  movimientoId: string;
  /** Cuenta contable (8 dígitos) del otro banco. */
  cuentaContable: string;
  /** Importe que debe mostrar el formulario (Holded lo enseña en EUR), para comprobar que es el movimiento correcto. */
  importe: number;
  /**
   * Para un movimiento ya conciliado en parte: lo que le queda por conciliar. El formulario enseña el importe COMPLETO del
   * movimiento, pero Holded transfiere solo lo restante (visto en la pantalla real el 05-10-2026 y en las conversiones hechas
   * a mano en Footprint); se exige que el panel muestre «Restante por conciliar» con este importe antes de abrir el formulario.
   */
  restante?: number;
  /** Descripción del movimiento en el banco: sirve para filtrar la lista cuando no está en la primera página. */
  descripcion?: string;
}

const ESPERAS_NAVEGADOR_OCUPADO = 24;

/** `pulsado` = se llegó a pulsar «Transferir y conciliar»: a partir de ahí el resultado solo se conoce leyendo Holded. */
export type ResultadoTransferir = ResultadoNavegador & { pulsado: boolean };

/** «1.300,00»: como muestra Holded los importes. */
export const importeEnPantalla = (n: number) => {
  const [entero, decimales] = Math.abs(n).toFixed(2).split(".");
  return `${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decimales}`;
};

const textoPagina = (page: Page) => page.mainFrame().evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ")).catch(() => "");

async function esperarTexto(page: Page, patron: RegExp, ms: number, presente = true): Promise<boolean> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (patron.test(await textoPagina(page)) === presente) return true;
    await pausa(500);
  }
  return false;
}

/**
 * Centro en pantalla de la fila del movimiento. La tabla de pendientes está PAGINADA (25 por página, comprobado el
 * 05-10-2026 en eWorks): la página pinta todas sus filas, así que si la fila no está entre ellas no sirve desplazarse.
 */
async function localizarFila(page: Page, movimientoId: string, esperaMs = 15_000): Promise<{ x: number; y: number } | undefined> {
  const limite = Date.now() + esperaMs;
  while (Date.now() < limite) {
    const punto = await page.mainFrame().evaluate((id) => {
      const fila = document.querySelector(`[role="row"][data-id="${id}"]`);
      if (!fila) return document.querySelectorAll('[role="row"][data-id]').length > 0 ? ("no_esta" as const) : ("sin_filas" as const);
      fila.scrollIntoView({ block: "center" });
      const celda = fila.querySelector('[data-field="description"]') ?? fila;
      const r = celda.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2 };
    }, movimientoId).catch(() => "sin_filas" as const);
    if (typeof punto === "object") { await pausa(400); return punto; }
    if (punto === "no_esta") return undefined;
    await pausa(700);
  }
  return undefined;
}

/** Filtra la lista de pendientes con el buscador de la pantalla (solo filtra; no modifica nada). */
async function filtrarPendientes(page: Page, textoBusqueda: string): Promise<boolean> {
  const campo = await page.mainFrame().evaluate(() => {
    const visibles = (Array.from(document.querySelectorAll('input[placeholder="Buscar"]')) as any[]).filter((i) => i.getClientRects().length > 0);
    if (visibles.length === 0) return undefined;
    // Con un movimiento seleccionado hay otro buscador en el panel derecho: el de la lista es el de más a la izquierda.
    const r = visibles.map((i) => i.getBoundingClientRect()).sort((a, b) => a.left - b.left)[0];
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }).catch(() => undefined);
  if (!campo) return false;
  await page.mouse.click(campo.x, campo.y);
  await pausa(300);
  await page.keyboard.type(textoBusqueda, { delay: 30 });
  await pausa(3000);
  return true;
}

async function flujoTransferir(page: Page, empresa: Empresa, orden: OrdenTransferir, marcarPulsado: (valor: boolean) => void): Promise<ResultadoNavegador> {
  const activada = await activarEmpresa(page, empresa);
  if (activada.estado !== "ok") return activada;
  await page.goto(`${BASE}/banking/accounts/${encodeURIComponent(orden.cuentaId)}/reconcile`, { waitUntil: "domcontentloaded" });
  const sesion = await estadoSesion(page);
  if (sesion.estado !== "ok") return sesion;
  await esperarEstable(page);
  if (!(await empresaActivaEnPantalla(page)).startsWith(empresa.toLowerCase())) return { estado: "elemento_no_encontrado", detalle: `La empresa activa en Holded no es ${empresa}; no se tocó nada` };
  if (!(await esperarTexto(page, /Conciliaci[óo]n/, 30_000))) return { estado: "elemento_no_encontrado", detalle: "No se abrió la pantalla de conciliación de la cuenta" };

  let fila = await localizarFila(page, orden.movimientoId);
  // No está en la primera página: se filtra por su descripción y se vuelve a buscar por su id (el id es lo que decide).
  const busqueda = (orden.descripcion ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!fila && busqueda && await filtrarPendientes(page, busqueda)) fila = await localizarFila(page, orden.movimientoId, 8000);
  if (!fila) return { estado: "elemento_no_encontrado", detalle: "El movimiento no aparece entre los pendientes de la cuenta en la pantalla de Holded" };
  await page.mouse.click(fila.x, fila.y);
  await pausa(1500);
  const seleccion = await page.mainFrame().evaluate((id) => {
    const marcadas = (Array.from(document.querySelectorAll('[role="row"][data-id][aria-selected="true"]')) as any[]).map((f) => f.getAttribute("data-id"));
    return { sola: marcadas.length === 1 && marcadas[0] === id, cuantas: marcadas.length };
  }, orden.movimientoId);
  if (!seleccion.sola) return { estado: "elemento_no_encontrado", detalle: `No quedó seleccionado únicamente el movimiento pedido (${seleccion.cuantas} seleccionados); no se tocó nada` };

  if (orden.restante !== undefined) {
    const restante = new RegExp(`Restante por conciliar\\s*[+-]?${importeEnPantalla(orden.restante).replace(/\./g, "\\.")}\\s*€`);
    if (!(await esperarTexto(page, restante, 12_000))) return { estado: "elemento_no_encontrado", detalle: `La pantalla no muestra «Restante por conciliar ${importeEnPantalla(orden.restante)} €» para este movimiento; no se tocó nada` };
  }
  if (!(await clicPorTexto(page.mainFrame(), ["Transferir"], true))) return { estado: "elemento_no_encontrado", detalle: "No se encontró el botón «Transferir»" };
  if (!(await esperarTexto(page, /Transferir a cuenta contable/, 15_000))) return { estado: "elemento_no_encontrado", detalle: "No se abrió el formulario «Transferir a cuenta contable»" };
  // Solo el diálogo: la tabla del fondo también contiene el importe del movimiento.
  const formulario = await page.mainFrame().evaluate(() => {
    const dialogo = (Array.from(document.querySelectorAll('[role="dialog"]')) as any[]).find((x) => /Transferir a cuenta contable/.test(x.innerText ?? ""));
    return ((dialogo ?? document.body).innerText ?? "").replace(/\s+/g, " ");
  }).catch(() => "");
  if (!/Movimiento \(1\)/.test(formulario)) return { estado: "elemento_no_encontrado", detalle: "El formulario no muestra exactamente un movimiento; no se tocó nada" };
  if (!new RegExp(`(^|[^\\d.,])[+-]?${importeEnPantalla(orden.importe).replace(/\./g, "\\.")}(?![\\d,])`).test(formulario)) return { estado: "elemento_no_encontrado", detalle: `El formulario no muestra el importe ${importeEnPantalla(orden.importe)}; no se tocó nada` };

  // Cuenta contable: se abre el desplegable, se escribe el número completo y debe quedar UNA sola opción que empiece por él.
  const campo = await page.mainFrame().evaluate(() => {
    const el = (Array.from(document.querySelectorAll("input, div, span")) as any[]).find((e) =>
      (e.getAttribute("placeholder") ?? "") === "Selecciona una cuenta contable" || (e.children.length === 0 && (e.textContent ?? "").trim() === "Selecciona una cuenta contable"));
    if (!el) return undefined;
    const r = el.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + r.height / 2 };
  });
  if (!campo) return { estado: "elemento_no_encontrado", detalle: "No se encontró el campo «Cuenta contable» del formulario" };
  await page.mouse.click(campo.x, campo.y);
  await pausa(600);
  await page.keyboard.type(orden.cuentaContable, { delay: 40 });
  await pausa(1800);
  const opcion = await page.mainFrame().evaluate((numero) => {
    const candidatas = (Array.from(document.querySelectorAll('[role="option"]')) as any[])
      .filter((e) => e.getClientRects().length > 0 && (e.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(numero));
    if (candidatas.length !== 1) return { cuantas: candidatas.length };
    const r = candidatas[0].getBoundingClientRect();
    return { cuantas: 1, x: r.left + Math.min(r.width / 2, 80), y: r.top + r.height / 2 };
  }, orden.cuentaContable);
  if (opcion.cuantas !== 1 || opcion.x === undefined) return { estado: "elemento_no_encontrado", detalle: `La cuenta contable ${orden.cuentaContable} no aparece de forma única en el desplegable (${opcion.cuantas}); no se tocó nada` };
  await page.mouse.click(opcion.x, opcion.y!);
  await pausa(900);
  const elegido = await page.mainFrame().evaluate((numero) => {
    const valores = (Array.from(document.querySelectorAll("input")) as any[]).map((i) => i.value ?? "");
    const fecha = (Array.from(document.querySelectorAll('input[type="radio"]')) as any[])
      .find((i) => /fecha movimiento/i.test(i.closest("label")?.textContent ?? i.parentElement?.parentElement?.textContent ?? ""));
    // Elegida = el desplegable se cerró (no queda ninguna opción a la vista) y el número sigue mostrado en el formulario.
    const abiertas = (Array.from(document.querySelectorAll('[role="option"]')) as any[]).filter((e) => e.getClientRects().length > 0).length;
    return { cuenta: abiertas === 0 && (valores.some((v) => v.includes(numero)) || (document.body.innerText ?? "").includes(numero)), fechaMovimiento: fecha ? fecha.checked : undefined };
  }, orden.cuentaContable);
  if (!elegido.cuenta) return { estado: "elemento_no_encontrado", detalle: "La cuenta contable no quedó elegida en el formulario; no se tocó nada" };
  if (elegido.fechaMovimiento !== true) return { estado: "elemento_no_encontrado", detalle: "No pude confirmar que el formulario tenga marcada «Fecha movimiento»; no se tocó nada" };

  // Se marca ANTES de pulsar: si el navegador se corta justo aquí, lo ocurrido solo se sabe leyendo Holded.
  marcarPulsado(true);
  if (!(await clicPorTexto(page.mainFrame(), ["Transferir y conciliar"], true))) {
    marcarPulsado(false);
    return { estado: "elemento_no_encontrado", detalle: "No se encontró el botón «Transferir y conciliar»; no se tocó nada" };
  }
  // El formulario se cierra cuando Holded acepta la operación.
  if (!(await esperarTexto(page, /Transferir a cuenta contable/, 40_000, false))) {
    const aviso = (await textoPagina(page)).slice(-300);
    return { estado: "error", detalle: `Se pulsó «Transferir y conciliar» pero el formulario no se cerró: ${aviso.slice(0, 160)}` };
  }
  await pausa(2500);
  return { estado: "ok", detalle: "«Transferir y conciliar» pulsado; falta verificar con Holded" };
}

/**
 * Pulsa «Transferir» sobre UN movimiento. Solo se repite (una vez) si el fallo ocurrió ANTES de pulsar el botón final:
 * después de pulsarlo nunca se reintenta, lo decide la lectura de Holded.
 */
export async function transferirMovimientoEnHolded(empresa: Empresa, orden: OrdenTransferir): Promise<ResultadoTransferir> {
  let pulsado = false;
  let resultado: ResultadoNavegador = { estado: "error", detalle: "sin intentos" };
  const ocupado = () => /Ya hay una acción de navegador/.test(resultado.detalle ?? "");
  for (let intento = 1, esperas = 0; intento <= 2 && !pulsado; intento++) {
    resultado = await conPagina(empresa, (page) => flujoTransferir(page, empresa, orden, (valor) => { pulsado = valor; }), 240_000);
    if (resultado.estado === "ok" || resultado.estado === "sesion_caducada" || resultado.estado === "requiere_verificacion" || resultado.estado === "no_disponible") break;
    // El navegador es único: si lo ocupa la sincronización de bancos o la conversión de tickets, se espera el turno (hasta ~6 min).
    if (ocupado()) { if (++esperas > ESPERAS_NAVEGADOR_OCUPADO) break; await pausa(15_000); intento--; continue; }
    if (!pulsado && intento < 2) await pausa(4000);
  }
  return { ...resultado, pulsado } as ResultadoTransferir;
}
