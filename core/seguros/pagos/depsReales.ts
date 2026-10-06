import { crearEventoRecordatorio, eliminarEventoRecordatorio } from "../../google/calendarClient";
import { listTreasuryAccounts, type Empresa } from "../../holded/client";
import { formatDateLocal } from "../../utils/dateFormat";
import type { CuentaCaja } from "./caja";
import type { DepsCalendarioPagos } from "./calendarioPagos";
import { actualizarPagoSeguro, leerPagosSeguros } from "./pagosStore";

/** Las dependencias REALES del calendario de pagos: Sheets, Holded (solo lectura) y el calendario de Google. */
export function depsRealesCalendarioPagos(): DepsCalendarioPagos {
  return {
    hoy: () => formatDateLocal(new Date()),
    leerPagos: leerPagosSeguros,
    actualizar: actualizarPagoSeguro,
    cuentas: async (empresa: Empresa): Promise<CuentaCaja[]> =>
      (await listTreasuryAccounts(empresa)).map((c) => ({
        nombre: c.name ?? String(c.id),
        moneda: (c.currency ?? "EUR").toUpperCase(),
        saldo: c.balance === undefined || c.balance === "" ? Number.NaN : Number(String(c.balance).replace(",", ".")),
        tipo: c.type,
        archivada: c.archived === true,
      })),
    // Carlos como invitado (el mismo correo que usan las acciones programadas) para que le aparezca en SU calendario.
    crearEvento: async (evento) =>
      (await crearEventoRecordatorio({ ...evento, invitados: process.env.GOOGLE_IMPERSONATE_EMAIL ? [process.env.GOOGLE_IMPERSONATE_EMAIL] : undefined }))?.id ?? null,
    borrarEvento: eliminarEventoRecordatorio,
  };
}
