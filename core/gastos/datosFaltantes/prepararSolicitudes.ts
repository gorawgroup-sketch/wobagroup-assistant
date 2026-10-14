import { obtenerAdmins } from "../../telegram/authorizedUsersSheet";
import { prepararEnvioMasivo } from "../../comunicaciones/envioMasivoTelegram";
import { obtenerGastosPendienteDatosPorChat, type GastoPendienteDatos } from "../gastoPendienteDatosStore";
import { agruparSolicitudes, ASUNTO_SOLICITUD_DATOS, CUERPO_SOLICITUD_DATOS } from "./solicitudDatos";
import { pendientesYaSolicitados, registrarSolicitudes } from "./solicitudDatosStore";
import { BUZON_SOPORTES } from "../../soportes/redactarCorreoSoportes";

/**
 * Prepara, para un superadministrador, el correo que pide a los creadores de los gastos lo que falta (ver solicitudDatos.ts). No envía nada: deja el resumen
 * del correo a una audiencia con «Ver correo / Enviar / Cancelar» y registra qué pendientes ya se pidieron.
 */
export interface OpcionesSolicitud {
  /** Solo estos pendientes (ids). Sin ellos, todos los que no se hayan pedido ya y lleven más de `minutosEspera` esperando. */
  ids?: string[];
  /** Tiempo que se da a quien opera para contestar por su cuenta antes de molestar al creador. */
  minutosEspera?: number;
  ahora?: number;
}

export interface DepsSolicitud {
  pendientes(chatId: number): Promise<GastoPendienteDatos[]>;
  yaSolicitados(ahora: number): Promise<Set<string>>;
  preparar(chatId: number, creadores: Array<{ nombre: string; email: string; detalle: string }>): Promise<string>;
  registrar(pendientes: Array<{ id: string; creador: string }>, comunicacion: string, ahora: number): Promise<void>;
  emailsAdmin(): Promise<string[]>;
}

const depsReales: DepsSolicitud = {
  pendientes: obtenerGastosPendienteDatosPorChat,
  yaSolicitados: pendientesYaSolicitados,
  preparar: (chatId, creadores) => prepararEnvioMasivo(chatId, {
    audiencia: "lista", parametros: { destinatarios: creadores },
    asunto: ASUNTO_SOLICITUD_DATOS, cuerpo: CUERPO_SOLICITUD_DATOS,
    descripcion: "Pedir a los creadores de gastos los datos que faltan para registrarlos y conciliarlos",
  }),
  registrar: registrarSolicitudes,
  emailsAdmin: async () => [BUZON_SOPORTES],
};

export async function prepararSolicitudesDatos(chatId: number, opciones: OpcionesSolicitud = {}, deps: DepsSolicitud = depsReales): Promise<string> {
  const ahora = opciones.ahora ?? Date.now();
  const espera = (opciones.minutosEspera ?? 0) * 60_000;
  const yaPedidos = await deps.yaSolicitados(ahora);
  const candidatos = (await deps.pendientes(chatId)).filter((p) =>
    (!opciones.ids || opciones.ids.includes(p.id)) && !yaPedidos.has(p.id) && ahora - p.creadoEn >= espera);
  const creadores = agruparSolicitudes(candidatos, await deps.emailsAdmin());
  if (creadores.length === 0) {
    return opciones.ids ? "Esos gastos no se pueden pedir a su creador: no vienen de un correo, ya se pidieron hace poco o no tienen un dato que preguntar." : "No hay gastos pendientes de datos que haya que pedir a su creador.";
  }
  const resultado = await deps.preparar(chatId, creadores.map(({ nombre, email, detalle }) => ({ nombre, email, detalle })));
  if (resultado.startsWith("Error")) return resultado;
  await deps.registrar(creadores.flatMap((c) => c.pendientes.map((id) => ({ id, creador: c.email }))), "preparada", ahora);
  return `${resultado} Gastos incluidos: ${creadores.reduce((n, c) => n + c.pendientes.length, 0)} (de ${creadores.length} ${creadores.length === 1 ? "persona" : "personas"}).`;
}

/** Para el job: a todos los superadministradores con pendientes, sin tocar lo ya pedido y dando tiempo a quien opera a contestar primero. */
export async function prepararSolicitudesDatosPeriodico(ahora = Date.now()): Promise<number> {
  let preparados = 0;
  for (const a of (await obtenerAdmins()).filter((x) => x.rol === "superadmin")) {
    const r = await prepararSolicitudesDatos(a.userId, { minutosEspera: 120, ahora });
    if (r.startsWith("Preparé")) preparados++;
  }
  return preparados;
}
