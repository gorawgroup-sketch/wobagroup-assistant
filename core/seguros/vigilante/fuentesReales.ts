/**
 * Las fuentes REALES del vigilante de seguros: registro en Sheets, banco en Holded (solo lectura), buzón del asistente
 * (solo lectura) y la memoria propia. Aparte de vigilante.ts para que la lógica se pruebe con fuentes falsas y este
 * archivo sea el único que toca los sistemas de verdad.
 */
import { invalidarEstadoCerebro } from "../../cerebro/estadoAgregado";
import { publicarCambioCerebro } from "../../cerebro/realtime";
import { invalidarComplementosSeguros } from "../estadoCerebro";
import { buscarMensajes, obtenerResumenCorreo } from "../../gmail/client";
import { listBankMovements, listTreasuryAccounts } from "../../holded/client";
import { actualizarCalendarioConPagoConfirmado } from "../pagos/alConfirmarPago";
import { actualizarPoliza, listarPolizas } from "../polizaRegistroSheet";
import { leerEstadoVigilante, guardarEstadoVigilante, purgarEstadoVigilante } from "./estadoStore";
import { leerMovimientosBancarios } from "./lecturaBancaria";
import { EMPRESAS_VIGILADAS } from "./tipos";
import type { FuentesVigilante } from "./vigilante";

export function fuentesRealesVigilante(): FuentesVigilante {
  return {
    ahora: () => new Date(),
    listarPolizas,
    actualizarPoliza,
    leerBanco: (desde, hasta) => leerMovimientosBancarios(EMPRESAS_VIGILADAS, desde, hasta, { listTreasuryAccounts, listBankMovements }),
    // Sin buzón configurado no hay lectura de correo (la revisión lo avisa y sigue con el banco).
    correo: process.env.GMAIL_IMPERSONATE_EMAIL ? { buscarMensajes, obtenerResumenCorreo } : null,
    leerEstado: leerEstadoVigilante,
    guardarEstado: guardarEstadoVigilante,
    borrarEstado: async (ids) => {
      await purgarEstadoVigilante((e) => ids.includes(e.id));
    },
    purgarCorreosVistos: (fechaLimite) =>
      purgarEstadoVigilante((e) => e.id.startsWith("correo:") && e.actualizadoEn.slice(0, 10) < fechaLimite),
    invalidarCerebro: () => {
      invalidarComplementosSeguros();
      invalidarEstadoCerebro(["seguros"]);
      publicarCambioCerebro("seguros:vigilante");
    },
    // Un pago confirmado en el banco se refleja en el calendario de pagos (pagado + siguiente de la serie).
    alConfirmarPago: async (pago, hoy) => { await actualizarCalendarioConPagoConfirmado(pago, hoy); },
  };
}
