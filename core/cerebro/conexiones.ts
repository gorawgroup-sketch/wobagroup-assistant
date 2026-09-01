import { getTelegramWebhookInfo, setTelegramWebhook } from "../telegram/client";
import { obtenerUltimoEstadoClaude, verificarConexionClaude, obtenerUltimoEstadoBusquedaWeb } from "../claude/client";
import { verificarConexionSheets } from "../google/sheetsClient";
import { verificarConexionDrive } from "../drive/client";
import { verificarConexionGmail } from "../gmail/client";
import { verificarConexionHolded } from "../holded/client";
import type { Empresa } from "../holded/client";

/**
 * Panel de conexiones del /cerebro: un vistazo de si cada integración externa
 * (Telegram, Claude, Google Sheets/Drive/Gmail, Holded x3) está realmente
 * respondiendo, no solo si las variables de entorno existen. Cacheado con
 * TTL corto (ver obtenerEstadoConexiones) para no golpear todas las APIs en
 * cada carga del panel — varias son de pago o tienen límite de cuota.
 */
export interface ConexionEstado {
  id: string;
  nombre: string;
  ok: boolean;
  detalle?: string;
  /** Qué hace el botón de arreglo, en texto — null si no hay nada automatizable. */
  accionLabel: string | null;
  verificadoEn: string;
}

/**
 * No se compara la URL contra un valor fijo — verificado en vivo que el
 * webhook real vive en el dominio que asigna Railway
 * (wobagroup-assistant-production.up.railway.app), NO en copilot.wobagroup.com
 * (ese es el dominio custom del panel /cerebro, un servicio HTTP distinto
 * aunque corran en el mismo deploy). Fijar un dominio "esperado" a mano
 * habría marcado como roto un webhook que en realidad funciona. Solo se
 * valida que haya una URL registrada y que Telegram no reporte errores de
 * entrega recientes.
 */
async function verificarTelegram(): Promise<{ ok: boolean; detalle?: string }> {
  try {
    const info = await getTelegramWebhookInfo();
    if (!info.url) {
      return { ok: false, detalle: "No hay ninguna URL de webhook registrada en Telegram." };
    }
    if (info.lastErrorMessage) {
      return { ok: false, detalle: `Telegram reporta un error de entrega reciente: ${info.lastErrorMessage}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detalle: error instanceof Error ? error.message : String(error) };
  }
}

function conConTimeout<T>(promesa: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promesa,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Tiempo de espera agotado (${ms}ms)`)), ms)),
  ]);
}

const EMPRESAS_HOLDED: Empresa[] = ["WOBA", "EWORKS", "Footprint"];
const TIMEOUT_MS = 6000;

async function chequearUno(
  id: string,
  nombre: string,
  chequeo: () => Promise<{ ok: boolean; detalle?: string }>,
  accionLabel: string | null
): Promise<ConexionEstado> {
  try {
    const resultado = await conConTimeout(chequeo(), TIMEOUT_MS);
    return { id, nombre, ok: resultado.ok, detalle: resultado.detalle, accionLabel: resultado.ok ? null : accionLabel, verificadoEn: new Date().toISOString() };
  } catch (error) {
    return {
      id,
      nombre,
      ok: false,
      detalle: error instanceof Error ? error.message : String(error),
      accionLabel,
      verificadoEn: new Date().toISOString(),
    };
  }
}

async function verificarTodas(): Promise<ConexionEstado[]> {
  const estadoClaude = obtenerUltimoEstadoClaude();

  const resultados = await Promise.all([
    chequearUno("telegram", "Telegram", verificarTelegram, "🔧 Reconfigurar webhook"),
    chequearUno("google_sheets", "Google Sheets", verificarConexionSheets, "🔄 Reintentar"),
    chequearUno("google_drive", "Google Drive", verificarConexionDrive, "🔄 Reintentar"),
    chequearUno("gmail", "Gmail", verificarConexionGmail, "🔄 Reintentar"),
    ...EMPRESAS_HOLDED.map((empresa) =>
      chequearUno(`holded_${empresa.toLowerCase()}`, `Holded (${empresa})`, () => verificarConexionHolded(empresa), "🔄 Reintentar")
    ),
  ]);

  // Claude es el único chequeo pasivo (no dispara una llamada nueva sola) —
  // ver core/claude/client.ts para el porqué.
  const claudeEstado: ConexionEstado = estadoClaude
    ? {
        id: "claude",
        nombre: "Claude (Anthropic)",
        ok: estadoClaude.ok,
        detalle: estadoClaude.detalle,
        accionLabel: estadoClaude.ok ? null : "🔄 Reintentar",
        verificadoEn: new Date(estadoClaude.en).toISOString(),
      }
    : {
        id: "claude",
        nombre: "Claude (Anthropic)",
        ok: true,
        detalle: "Sin actividad reciente para verificar — se confirma con el primer mensaje del chat.",
        accionLabel: null,
        verificadoEn: new Date().toISOString(),
      };

  // Pedido explícito de Carlos: que el front tenga visibilidad del nuevo
  // módulo de búsqueda web. Mismo chequeo pasivo que Claude (arriba) — es
  // una tool hospedada sin conexión propia que pingear, y una búsqueda real
  // solo para el panel costaría dinero en cada carga sin necesidad. "No
  // usada aún" se muestra como ok=true (informativo, no es una falla) —
  // solo pasa a ok=false si la ÚLTIMA vez que se intentó de verdad, la API
  // devolvió un error real (org sin la tool habilitada, límite excedido,
  // etc.), nunca por simple falta de uso. accionLabel siempre null: a
  // diferencia de Claude (que sí tiene un ping real y barato de 1 token
  // para "Reintentar"), no hay ningún chequeo automatizado de bajo costo
  // para esta — mostrar un botón que solo re-lee el mismo estado guardado,
  // sin comprobar nada nuevo, sería fingir una acción que no hace nada real.
  const estadoBusquedaWeb = obtenerUltimoEstadoBusquedaWeb();
  const busquedaWebEstado: ConexionEstado = estadoBusquedaWeb
    ? {
        id: "web_search",
        nombre: "Búsqueda web (Claude)",
        ok: estadoBusquedaWeb.ok,
        detalle: estadoBusquedaWeb.detalle,
        accionLabel: null,
        verificadoEn: new Date(estadoBusquedaWeb.en).toISOString(),
      }
    : {
        id: "web_search",
        nombre: "Búsqueda web (Claude)",
        ok: true,
        detalle: "Sin uso reciente para verificar — se confirma la primera vez que el chat necesite buscar en internet.",
        accionLabel: null,
        verificadoEn: new Date().toISOString(),
      };

  return [claudeEstado, busquedaWebEstado, ...resultados];
}

let cache: { en: number; datos: ConexionEstado[] } | null = null;
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 min — varias APIs son de pago o tienen cuota, no se golpean en cada carga

export async function obtenerEstadoConexiones(forzar = false): Promise<ConexionEstado[]> {
  if (!forzar && cache && Date.now() - cache.en < CACHE_TTL_MS) {
    return cache.datos;
  }
  const datos = await verificarTodas();
  cache = { en: Date.now(), datos };
  return datos;
}

/**
 * Ejecuta la acción de arreglo para una conexión y devuelve su estado
 * actualizado. Para Telegram, re-registra el webhook (arreglo real). Para
 * el resto, es un reintento del mismo chequeo — arregla blips de red
 * transitorios (verificado que ocurren de verdad, ver core/telegram/client.ts),
 * pero una API key revocada o un permiso retirado necesita una persona;
 * en ese caso el `detalle` devuelto debe decirlo, no fingir que se arregló.
 */
export async function arreglarConexion(id: string): Promise<ConexionEstado> {
  if (id === "telegram") {
    try {
      // Re-registra la URL YA configurada (no una fija a mano) — el arreglo
      // real aquí es forzar a Telegram a "olvidar" un error de entrega
      // anterior y reintentar desde cero, no cambiar a dónde apunta.
      const actual = await getTelegramWebhookInfo();
      if (actual.url) await setTelegramWebhook(actual.url);
    } catch (error) {
      console.error("[conexiones] Error reconfigurando webhook de Telegram:", error);
    }
  }

  if (id === "claude") {
    const resultado = await verificarConexionClaude();
    const estado: ConexionEstado = {
      id,
      nombre: "Claude (Anthropic)",
      ok: resultado.ok,
      detalle: resultado.detalle,
      accionLabel: resultado.ok ? null : "🔄 Reintentar",
      verificadoEn: new Date().toISOString(),
    };
    if (cache) cache.datos = cache.datos.map((c) => (c.id === id ? estado : c));
    return estado;
  }

  const todas = await verificarTodas();
  cache = { en: Date.now(), datos: todas };
  const actualizado = todas.find((c) => c.id === id);
  if (!actualizado) {
    throw new Error(`Conexión desconocida: ${id}`);
  }
  return actualizado;
}
