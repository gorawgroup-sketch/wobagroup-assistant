/**
 * Menú de comandos del bot (la «hamburguesa» de Telegram). Pedido de Carlos (2026-10-04): las órdenes que hay que
 * darle al sistema a menudo deben estar a un clic, sin tener que recordarlas ni escribirlas.
 *
 * El menú se publica al arrancar el servidor, así que esta lista es la única fuente de verdad: para añadir una orden
 * al menú se añade aquí y se atiende en `procesarUpdateTelegram` (src/server.ts). Hasta ahora el menú se había puesto
 * a mano en Telegram y solo tenía «revisarcorreo».
 */
export const COMANDOS_MENU: ReadonlyArray<{ command: string; description: string }> = [
  { command: "revisarcorreo", description: "Revisar el correo nuevo" },
  { command: "soportes", description: "Pedir soportes de gastos con tarjeta (subir CSV de Revolut)" },
  { command: "transferencias", description: "Transferencias entre cuentas propias por conciliar" },
  { command: "preguntas", description: "Volver a mostrar las preguntas pendientes" },
  { command: "conocimiento", description: "Enseñar a los agentes: documentos, enlaces o texto" },
];

/** «/transferencias», «/transferencias woba» o «transferencias internas de Footprint»: devuelve la empresa pedida o "todas". */
export function parsearComandoTransferencias(texto: string): "WOBA" | "EWORKS" | "Footprint" | "todas" | undefined {
  const t = texto.trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const m = /^\/?(?:transferencias(?:@\w+)?(?:\s+internas)?|revisa(?:r)?\s+(?:las\s+)?transferencias(?:\s+internas)?)\b\s*(?:de\s+)?(\w+)?\s*$/.exec(t);
  if (!m) return undefined;
  const empresa = m[1];
  if (!empresa) return "todas";
  if (empresa === "woba") return "WOBA";
  if (empresa === "eworks") return "EWORKS";
  if (empresa === "footprint") return "Footprint";
  return undefined;
}

/**
 * «/soportes», «/soportes woba» o «pedir soportes»: arranca el proceso de pedir soportes a quien gastó con la tarjeta.
 * Devuelve { empresa } si la nombran (o {} si no). Una frase que solo menciona soportes no lo dispara.
 */
export function parsearComandoSoportes(texto: string): { empresa?: "WOBA" | "EWORKS" | "Footprint" } | undefined {
  const t = texto.trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const m = /^(?:\/soportes(?:@\w+)?|pedir\s+soportes(?:\s+de\s+(?:las\s+)?tarjetas?)?)(?:\s+(?:de\s+)?(woba|eworks|footprint))?\s*$/.exec(t);
  if (!m) return undefined;
  const e = m[1];
  return e === "woba" ? { empresa: "WOBA" } : e === "eworks" ? { empresa: "EWORKS" } : e === "footprint" ? { empresa: "Footprint" } : {};
}

/** Publica el menú en Telegram. Un fallo aquí no debe impedir que el servidor arranque. */
export async function publicarMenuComandos(token: string | undefined = process.env.TELEGRAM_BOT_TOKEN): Promise<boolean> {
  if (!token) return false;
  try {
    const respuesta = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: COMANDOS_MENU }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!respuesta.ok) {
      console.error(`[menu] Telegram rechazó el menú de comandos (${respuesta.status}).`);
      return false;
    }
    console.log(`[menu] Menú de Telegram publicado: ${COMANDOS_MENU.map((c) => `/${c.command}`).join(", ")}`);
    return true;
  } catch (error) {
    console.error("[menu] No se pudo publicar el menú de comandos:", error instanceof Error ? error.message : error);
    return false;
  }
}
