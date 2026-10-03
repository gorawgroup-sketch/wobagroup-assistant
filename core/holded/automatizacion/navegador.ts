import type { Empresa } from "../client";

/**
 * Contrato del trabajador de navegador que actúa sobre la interfaz web de Holded (lo único que la API no permite:
 * pulsar «Sincronizar» y desmarcar «Es una factura de compra»). Es una interfaz para poder probar toda la
 * orquestación con un navegador simulado, sin sesión real.
 */
export type ResultadoNavegador =
  | { estado: "ok"; detalle?: string; /** Texto que Holded mostró junto al saldo tras sincronizar (p. ej. «Actualizado hace unos segundos»). */ confirmadoEnPantalla?: string }
  | { estado: "sesion_caducada" | "requiere_verificacion" | "no_disponible" | "elemento_no_encontrado" | "error"; detalle: string };

export interface CuentaParaNavegador { id: string; nombre: string; institucion?: string }

export interface NavegadorHolded {
  sincronizarCuenta(empresa: Empresa, cuenta: CuentaParaNavegador): Promise<ResultadoNavegador>;
  /**
   * Abre la edición de la compra, Opciones → desmarca «Es una factura de compra» → Guardar. Si el gasto es borrador se usa
   * «Guardar como borrador» para no aprobarlo. No verifica: eso lo hace el llamador.
   */
  desmarcarFacturaDeCompra(empresa: Empresa, compraId: string, opciones?: { borrador?: boolean }): Promise<ResultadoNavegador>;
  /** Solo lectura: nombre LEGAL de la empresa que queda activa tras activarla (p. ej. «Business Atelier Europa SL»). Opcional. */
  leerNombreLegal?(empresa: Empresa): Promise<ResultadoNavegador>;
  cerrar(): Promise<void>;
}

const PIDE_CONSENTIMIENTO = /consentimiento|renovar|reconectar|reautoriz/i;

/**
 * Estados que nunca se arreglan reintentando y exigen a una persona: sesión caducada, 2FA/CAPTCHA, sin sesión configurada y
 * un banco que pide renovar el consentimiento. Todo lo demás (una pantalla de Holded que se recargó, un elemento que aún no
 * apareció, una empresa que no llegó a activarse) es TRANSITORIO: se reintenta en la siguiente pasada, con límite, en vez de
 * dejar el caso atascado a la espera de alguien.
 */
export function requiereIntervencion(r: ResultadoNavegador): boolean {
  if (r.estado === "sesion_caducada" || r.estado === "requiere_verificacion" || r.estado === "no_disponible") return true;
  return r.estado === "elemento_no_encontrado" && PIDE_CONSENTIMIENTO.test(r.detalle);
}
