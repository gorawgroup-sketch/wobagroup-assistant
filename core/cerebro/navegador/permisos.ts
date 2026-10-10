import type { Rol } from "../../telegram/authorizedUsersSheet";
import type { Capacidad } from "./catalogo";

/**
 * Permisos de navegación, decididos SIEMPRE en el servidor a partir de la identidad que resuelve `resolverIdentidadChatWeb` (clave +
 * dispositivo vinculado). Nada de lo que envíe el navegador (rol, permisos, capacidades, URLs) se lee jamás.
 *
 * Esta tabla es una PROPUESTA conservadora, editable aquí en un solo sitio:
 *  - un dispositivo sin vincular a Telegram es `anonimo` (el chat web ya lo trata como «solo lectura»);
 *  - Finanzas y Correo son datos de la organización: desde `admin`;
 *  - lo demás (seguros, documentos, calendario, planeación…) ya se consulta en solo lectura desde sesiones sin vincular, así que no se
 *    endurece aquí: la navegación nunca es más estricta que el acceso a los datos de su destino, salvo Finanzas y Correo;
 *  - una capacidad NUEVA que no esté en la tabla exige al menos `colaborador` (vinculado): por defecto se cierra, no se abre.
 * Seleccionar una compañía NO concede permisos.
 */
export type NivelAcceso = "anonimo" | "colaborador" | "admin" | "superadmin";
const ORDEN: readonly NivelAcceso[] = ["anonimo", "colaborador", "admin", "superadmin"];

/** `chatId` solo sirve para aislar el contexto de conversación por identidad; nunca influye en permisos. */
export interface IdentidadNavegacion { rol?: Rol; modo: "completo" | "solo_lectura"; chatId?: number }

export function nivelDeIdentidad(i: IdentidadNavegacion): NivelAcceso {
  return i.modo === "completo" && i.rol ? i.rol : "anonimo";
}

interface Requisito { coincide: (id: string) => boolean; minimo: NivelAcceso; razon: string }
const REQUISITOS: Requisito[] = [
  { coincide: (id) => id === "area:finance" || id.startsWith("module:finance:"), minimo: "admin", razon: "datos financieros de la organización" },
  { coincide: (id) => id === "module:operations:correo", minimo: "admin", razon: "correo de la organización" },
  { coincide: (id) => /^(area|module):(insurance|corporate|operations|people|marketing|commercial|procurement|compliance|quality|technology|processes)(:|$)/.test(id), minimo: "anonimo", razon: "consulta de solo lectura" },
];

/** Una sección (`section:<área>:<módulo>:<sección>`) hereda SIEMPRE los permisos de su módulo: nunca es más abierta ni más cerrada que él. */
export const padreDeSeccion = (id: string): string => {
  if (!id.startsWith("section:")) return id;
  const [, area, modulo] = id.split(":");
  return `module:${area}:${modulo}`;
};

export function nivelRequerido(capacidadId: string): { minimo: NivelAcceso; razon: string } {
  const id = padreDeSeccion(capacidadId);
  const r = REQUISITOS.find((x) => x.coincide(id));
  return r ? { minimo: r.minimo, razon: r.razon } : { minimo: "colaborador", razon: "capacidad sin política explícita (cerrada por defecto)" };
}

export function tieneAcceso(nivel: NivelAcceso, capacidadId: string): boolean {
  return ORDEN.indexOf(nivel) >= ORDEN.indexOf(nivelRequerido(capacidadId).minimo);
}

/** Compañías que esta identidad puede usar. Hoy el sistema no tiene permisos por compañía: todas las del catálogo. Único punto a ampliar. */
export function companiasAutorizadas(_identidad: IdentidadNavegacion, universo: string[]): string[] {
  return [...universo];
}

/**
 * Restricciones de FUENTE por destino y compañía (hechos del sistema, no permisos): el cashflow disponible es conjunto de WOBA y eWorks y
 * Footprint no tiene fuente de cashflow propia. No se atribuyen saldos conjuntos a una sola empresa.
 */
export type RestriccionFuente = { tipo: "no_consultable" | "aviso"; mensaje: string };
export const RESTRICCIONES_FUENTE: Record<string, Record<string, RestriccionFuente>> = {
  "module:finance:cashflow": {
    Footprint: { tipo: "no_consultable", mensaje: "Footprint no tiene todavía una fuente de cashflow propia; el cashflow disponible es el conjunto de WOBA y eWorks." },
    WOBA: { tipo: "aviso", mensaje: "El cashflow es conjunto de WOBA y eWorks: no se atribuye a una sola compañía." },
    EWORKS: { tipo: "aviso", mensaje: "El cashflow es conjunto de WOBA y eWorks: no se atribuye a una sola compañía." },
  },
};

export function restriccionDeFuente(c: Pick<Capacidad, "id">, companyId: string): RestriccionFuente | undefined {
  return RESTRICCIONES_FUENTE[c.id]?.[companyId];
}
