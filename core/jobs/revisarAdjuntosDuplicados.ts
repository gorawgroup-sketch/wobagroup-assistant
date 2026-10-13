import { holdedGet, type Empresa } from "../holded/client";
import { durablePurchaseEditStore } from "../holded/durablePurchaseEditStore";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";

/**
 * Detector de adjuntos duplicados en Holded. Cada PUT de una compra duplica la lista de sus adjuntos (adjuntos = 2^n): caso real 2026-10-13,
 * una compra con 32.768 copias de su comprobante tras 15 «reparaciones» automáticas, que dejó de abrirse en la interfaz. Aunque el código ya no
 * hace PUT sin cambios y limita las ediciones automáticas, esto avisa si aun así una compra empieza a acumular copias.
 *
 * Solo lee: mira las compras editadas en los últimos días (según el ledger de ediciones) y cuenta sus adjuntos. Silencio = todo bien.
 */
export const VENTANA_DIAS_ADJUNTOS = 14;
/** Una edición legítima deja 2 copias, dos dejan 4: más de 4 ya no es una edición normal. */
export const UMBRAL_ADJUNTOS_SOSPECHOSO = 4;

export interface DepsAdjuntosDuplicados {
  comprasEditadasDesde(desdeMs: number): Promise<Array<{ empresa: Empresa; purchaseId: string }>>;
  contarAdjuntos(empresa: Empresa, purchaseId: string): Promise<number>;
  admins(): Promise<Array<{ userId: number }>>;
  avisar(userId: number, texto: string): Promise<void>;
  ahora?: () => number;
}

const depsReales: DepsAdjuntosDuplicados = {
  comprasEditadasDesde: (desde) => durablePurchaseEditStore.comprasEditadasDesde(desde),
  contarAdjuntos: async (empresa, id) => {
    const r = (await holdedGet(empresa, `/purchases/${encodeURIComponent(id)}/attachments`)) as { items?: unknown[] } | unknown[];
    return (Array.isArray(r) ? r : r.items ?? []).length;
  },
  admins: () => obtenerAdmins(),
  avisar: (userId, texto) => sendTelegramMessage(userId, texto),
};

export interface Sospechosa { empresa: Empresa; purchaseId: string; adjuntos: number }

export async function revisarAdjuntosDuplicados(deps: DepsAdjuntosDuplicados = depsReales): Promise<{ revisadas: number; sospechosas: Sospechosa[]; sinLeer: number }> {
  const ahora = (deps.ahora ?? Date.now)();
  const compras = await deps.comprasEditadasDesde(ahora - VENTANA_DIAS_ADJUNTOS * 86_400_000);
  const sospechosas: Sospechosa[] = [];
  let sinLeer = 0;
  for (let i = 0; i < compras.length; i += 4) {
    await Promise.all(compras.slice(i, i + 4).map(async (c) => {
      try {
        const n = await deps.contarAdjuntos(c.empresa, c.purchaseId);
        if (n >= UMBRAL_ADJUNTOS_SOSPECHOSO) sospechosas.push({ ...c, adjuntos: n });
      } catch (error) {
        // Una lectura fallida NO es «sin duplicados»: se cuenta y se dice.
        sinLeer++;
        console.error(`[revisarAdjuntosDuplicados] No se pudo leer los adjuntos de ${c.empresa}:${c.purchaseId}:`, error instanceof Error ? error.name : "Error");
      }
    }));
  }
  if (sospechosas.length === 0 && sinLeer === 0) {
    console.log(`[revisarAdjuntosDuplicados] ${compras.length} compra(s) editada(s) en ${VENTANA_DIAS_ADJUNTOS} días, sin adjuntos duplicados.`);
    return { revisadas: compras.length, sospechosas, sinLeer };
  }
  const admins = await deps.admins();
  if (admins.length === 0) { console.error("[revisarAdjuntosDuplicados] Hay avisos pero no existe ningún admin para notificarlos."); return { revisadas: compras.length, sospechosas, sinLeer }; }
  const lineas = sospechosas.sort((a, b) => b.adjuntos - a.adjuntos).slice(0, 15).map((s) => `  • ${s.empresa} · compra ${s.purchaseId} · ${s.adjuntos} adjuntos`);
  const texto = [
    sospechosas.length > 0 ? `⚠️ WOBI encontró ${sospechosas.length} compra(s) de Holded con adjuntos duplicados (Holded duplica los adjuntos en cada guardado):` : "⚠️ WOBI no pudo comprobar algunas compras de Holded:",
    ...lineas,
    ...(sinLeer > 0 ? [`  • ${sinLeer} compra(s) no se pudieron leer ahora: no se puede afirmar que estén bien.`] : []),
    "",
    "No se ha cambiado nada. No abras esas compras en Holded hasta limpiarlas; el comprobante original sigue en el adjunto (una sola copia física).",
  ].join("\n");
  for (const a of admins) {
    try { await deps.avisar(a.userId, texto); } catch (error) { console.error(`[revisarAdjuntosDuplicados] Error notificando a admin ${a.userId}:`, error instanceof Error ? error.name : "Error"); }
  }
  return { revisadas: compras.length, sospechosas, sinLeer };
}
