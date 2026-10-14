import { holdedGet, type Empresa } from "../holded/client";
import { cerrarInciertasAntiguas, type CompraPosterior, type DepsCierreInciertas, type ResultadoCierre } from "../holded/cierreInciertas";
import { durableContactStore } from "../holded/durableContactStore";
import { durablePurchaseStore } from "../holded/durablePurchaseStore";
import { obtenerAsignacionesPendientesDeRevisar } from "../holded/asignacionCuentaLogSheet";
import { inspeccionarCreacionContactoRegistrada } from "../holded/write";
import { listarRegistrosGastoPorEmpresa } from "../gastos/gastoPorCorreoStore";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";

/**
 * Job diario (8:40): cierra solo los contactos y compras inciertos antiguos que la lectura de Holded demuestra inexistentes o sustituidos
 * (ver core/holded/cierreInciertas.ts). Sin aprobaciones: lo demostrado se cierra; lo dudoso se avisa una vez, sin botones.
 */
const MAX_COMPRAS_A_LEER = 80;

/** Ids de compras creadas por WOBi (ledger de creaciones + registros de correo + asignaciones de cuenta) entre dos instantes. */
export async function idsComprasPropiasEntre(empresa: Empresa, desdeMs: number, hastaMs: number): Promise<string[]> {
  const ids = new Set<string>(await durablePurchaseStore.listarIdsCreadasEntre(empresa, desdeMs, hastaMs));
  for (const r of await listarRegistrosGastoPorEmpresa(empresa)) if (r.creadoEn >= desdeMs && r.creadoEn <= hastaMs) ids.add(r.gastoId);
  for (const a of await obtenerAsignacionesPendientesDeRevisar()) if (a.empresa === empresa && a.creadoEn >= desdeMs && a.creadoEn <= hastaMs) ids.add(a.gastoId);
  return [...ids].filter((i) => /^[a-f0-9]{24}$/.test(i));
}

const depsReales: DepsCierreInciertas = {
  contactosInciertos: async () => (await durableContactStore.listarPendientes()).filter((r) => r.estado === "incierta"),
  inspeccionarContacto: inspeccionarCreacionContactoRegistrada,
  cerrarContacto: (clave) => durableContactStore.cerrarSinEfecto(clave),
  comprasInciertas: async () => (await durablePurchaseStore.listarPendientes()).filter((r) => r.estado === "incierta"),
  nombreDeContacto: async (empresa, contactId) => String(((await holdedGet(empresa, `/contacts/${encodeURIComponent(contactId)}`)) as { name?: string }).name ?? ""),
  comprasPropiasPosteriores: async (empresa, desdeMs, hastaMs) => {
    const salida: CompraPosterior[] = [];
    for (const id of (await idsComprasPropiasEntre(empresa, desdeMs, hastaMs)).slice(0, MAX_COMPRAS_A_LEER)) {
      try {
        const d = (await holdedGet(empresa, `/purchases/${id}`)) as { id?: string; date?: string; contact_id?: string; contact_name?: string; notes?: string };
        if (d.id) salida.push({ id: d.id, fecha: String(d.date ?? ""), contactId: String(d.contact_id ?? ""), contactoNombre: String(d.contact_name ?? ""), notas: String(d.notes ?? "") });
      } catch (error) {
        // Una compra ilegible no cuenta como prueba: simplemente no sirve para sustituir (el caso quedará como dudoso y se avisa).
        console.error(`[cerrarInciertasAntiguas] No se pudo leer la compra ${id}:`, error instanceof Error ? error.name : "Error");
      }
    }
    return salida;
  },
  cerrarCompra: (clave) => durablePurchaseStore.cerrarSinEfecto(clave),
  avisar: async (texto) => { for (const a of await obtenerAdmins()) await sendTelegramMessage(a.userId, texto).catch((e) => console.error("[cerrarInciertasAntiguas] Error avisando a un admin:", e instanceof Error ? e.name : "Error")); },
};

export async function ejecutarCierreInciertas(opciones: { simular?: boolean } = {}): Promise<ResultadoCierre> {
  const r = await cerrarInciertasAntiguas({ ...depsReales, simular: opciones.simular });
  console.log(`[cerrarInciertasAntiguas] ${r.simulado ? "SIMULACIÓN · " : ""}cerrados ${r.cerrados.length}, dudosos ${r.dudosos.length}, omitidos ${r.omitidos}`);
  for (const c of r.cerrados) console.log(`[cerrarInciertasAntiguas]   ${r.simulado ? "cerraría" : "cerrado"}: ${c.descripcion} → ${c.motivo}`);
  return r;
}
