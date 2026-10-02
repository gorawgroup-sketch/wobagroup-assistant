import type { Empresa } from "../client";

/**
 * Contrato del trabajador de navegador que actúa sobre la interfaz web de Holded (lo único que la API no permite:
 * pulsar «Sincronizar» y desmarcar «Es una factura de compra»). Es una interfaz para poder probar toda la
 * orquestación con un navegador simulado, sin sesión real.
 */
export type ResultadoNavegador =
  | { estado: "ok"; detalle?: string }
  | { estado: "sesion_caducada" | "requiere_verificacion" | "no_disponible" | "elemento_no_encontrado" | "error"; detalle: string };

export interface CuentaParaNavegador { id: string; nombre: string; institucion?: string }

export interface NavegadorHolded {
  sincronizarCuenta(empresa: Empresa, cuenta: CuentaParaNavegador): Promise<ResultadoNavegador>;
  /**
   * Abre la edición de la compra, Opciones → desmarca «Es una factura de compra» → Guardar. Si el gasto es borrador se usa
   * «Guardar como borrador» para no aprobarlo. No verifica: eso lo hace el llamador.
   */
  desmarcarFacturaDeCompra(empresa: Empresa, compraId: string, opciones?: { borrador?: boolean }): Promise<ResultadoNavegador>;
  cerrar(): Promise<void>;
}

/** Estados del navegador que nunca se arreglan reintentando: exigen a una persona (sesión, 2FA, CAPTCHA, UI cambiada). */
export function requiereIntervencion(r: ResultadoNavegador): boolean {
  return r.estado === "sesion_caducada" || r.estado === "requiere_verificacion" || r.estado === "no_disponible" || r.estado === "elemento_no_encontrado";
}
