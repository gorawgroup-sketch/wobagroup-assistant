/**
 * Borradores de pedido, EN MEMORIA: el texto exacto que la persona escribió y que todavía debe confirmar. Una entrada por
 * (persona, pedidoId): otra persona con el mismo pedidoId no la ve ni la pisa. Caducan a los 10 minutos si nadie los confirma; si el
 * servidor se reinicia se pierden (solo un borrador sin confirmar: nada se ha enviado, la persona lo vuelve a pedir). Una vez
 * confirmado, la verdad pasa al ledger durable de Telegram y esta entrada solo recuerda que ya se envió (anti doble envío).
 */
export const TTL_BORRADOR_MS = 10 * 60_000;
export const MAX_BORRADORES_PENDIENTES_POR_CHAT = 20;
const RETENCION_CONFIRMADO_MS = 24 * 60 * 60_000;
const MAX_ENTRADAS = 2_000;

export type EstadoBorrador = "pendiente" | "confirmado" | "cancelado";

export interface Borrador {
  pedidoId: string;
  chatId: number;
  /** Huella corta del dispositivo que lo creó. */
  dispositivo: string;
  /** Exactamente lo escrito: no se recorta ni se normaliza. */
  texto: string;
  textoHash: string;
  estado: EstadoBorrador;
  creadoEn: number;
  expiraEn: number;
  confirmadoEn?: number;
}

export type ResultadoCrear =
  | { tipo: "creado" | "existente"; borrador: Borrador }
  | { tipo: "conflicto_texto" }
  | { tipo: "demasiados_pendientes" };

export interface AlmacenBorradores {
  crear(entrada: { chatId: number; pedidoId: string; dispositivo: string; texto: string; textoHash: string }): ResultadoCrear;
  obtener(chatId: number, pedidoId: string): Borrador | undefined;
  /** Pasa a `confirmado` solo desde `pendiente` y vigente; devuelve el borrador o undefined si no se pudo. */
  confirmar(chatId: number, pedidoId: string): Borrador | undefined;
  cancelar(chatId: number, pedidoId: string): Borrador | undefined;
  tamano(): number;
}

export function crearAlmacenBorradores(opciones: { ahora?: () => number; ttlMs?: number } = {}): AlmacenBorradores {
  const ahora = opciones.ahora ?? Date.now;
  const ttl = opciones.ttlMs ?? TTL_BORRADOR_MS;
  const entradas = new Map<string, Borrador>();
  const clave = (chatId: number, pedidoId: string): string => `${chatId}:${pedidoId}`;

  const caducado = (b: Borrador, t: number): boolean => (b.estado === "pendiente" ? t >= b.expiraEn : t - (b.confirmadoEn ?? b.creadoEn) >= RETENCION_CONFIRMADO_MS);
  const purgar = (): void => {
    const t = ahora();
    for (const [k, b] of entradas) if (caducado(b, t)) entradas.delete(k);
    while (entradas.size >= MAX_ENTRADAS) {
      const primera = entradas.keys().next().value as string | undefined;
      if (primera === undefined) break;
      entradas.delete(primera);
    }
  };
  const vigente = (chatId: number, pedidoId: string): Borrador | undefined => {
    const b = entradas.get(clave(chatId, pedidoId));
    if (!b) return undefined;
    if (caducado(b, ahora())) { entradas.delete(clave(chatId, pedidoId)); return undefined; }
    return b;
  };

  return {
    crear({ chatId, pedidoId, dispositivo, texto, textoHash }) {
      purgar();
      const existente = vigente(chatId, pedidoId);
      if (existente) return existente.textoHash === textoHash ? { tipo: "existente", borrador: { ...existente } } : { tipo: "conflicto_texto" };
      let pendientes = 0;
      for (const b of entradas.values()) if (b.chatId === chatId && b.estado === "pendiente") pendientes++;
      if (pendientes >= MAX_BORRADORES_PENDIENTES_POR_CHAT) return { tipo: "demasiados_pendientes" };
      const t = ahora();
      const borrador: Borrador = { pedidoId, chatId, dispositivo, texto, textoHash, estado: "pendiente", creadoEn: t, expiraEn: t + ttl };
      entradas.set(clave(chatId, pedidoId), borrador);
      return { tipo: "creado", borrador: { ...borrador } };
    },
    obtener(chatId, pedidoId) {
      const b = vigente(chatId, pedidoId);
      return b ? { ...b } : undefined;
    },
    confirmar(chatId, pedidoId) {
      const b = vigente(chatId, pedidoId);
      if (!b || b.estado !== "pendiente") return undefined;
      b.estado = "confirmado"; b.confirmadoEn = ahora();
      return { ...b };
    },
    cancelar(chatId, pedidoId) {
      const b = vigente(chatId, pedidoId);
      if (!b || b.estado !== "pendiente") return undefined;
      b.estado = "cancelado";
      return { ...b };
    },
    tamano: () => entradas.size,
  };
}
