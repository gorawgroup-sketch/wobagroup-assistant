import { crearNavegadorHolded } from "../holded/automatizacion/navegadorHolded";
import { modoAutomatizacion } from "../holded/automatizacion/modo";
import { lanzarSincronizacionBancaria, textoAvisoSincronizacion, verificarSincronizacionBancaria, type ResumenSync } from "../holded/automatizacion/sincronizacionBancaria";
import { claveTicket, procesarColaTickets, type ResumenTickets } from "../holded/automatizacion/tickets";
import { almacenTrabajosHolded, hayAlmacenDuradero, nuevoTrabajo } from "../holded/automatizacion/trabajos";
import type { Empresa } from "../holded/client";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { fechaHoyEspana } from "../utils/diaHabil";

/**
 * Jobs de las dos automatizaciones de Holded en servidor. Ambos terminan en seguida si su interruptor está en
 * «apagado» (valor por defecto), así que registrarlos en el cron no cambia nada hasta que alguien los enciende.
 * En modo «activo» exigen almacén duradero (PostgreSQL): sin él no pueden garantizar idempotencia tras un reinicio.
 */
async function notificarAdmins(texto: string): Promise<void> {
  const admins = await obtenerAdmins();
  for (const admin of admins) {
    await sendTelegramMessage(admin.userId, texto).catch((error) => console.error("[automatizacionHolded] No se pudo avisar a un admin:", error));
  }
}

function modoSeguro(nombre: "SYNC_BANCARIA" | "TICKETS"): "apagado" | "simulacion" | "activo" {
  const modo = modoAutomatizacion(nombre);
  if (modo === "activo" && !hayAlmacenDuradero()) {
    console.error(`[automatizacionHolded] ${nombre} en modo activo sin PostgreSQL duradero: no se ejecuta.`);
    return "apagado";
  }
  return modo;
}

export async function sincronizacionBancariaHolded(fase: "lanzar" | "verificar" | "cierre", ahora: Date = new Date()): Promise<ResumenSync | undefined> {
  const modo = modoSeguro("SYNC_BANCARIA");
  if (modo === "apagado") return undefined;
  const dep = { almacen: almacenTrabajosHolded(), navegador: crearNavegadorHolded };
  const fecha = fechaHoyEspana(ahora);
  if (fase === "lanzar") {
    const resumen = await lanzarSincronizacionBancaria(fecha, dep);
    console.log("[sincronizacionBancariaHolded]", JSON.stringify({ fase, modo, cuentas: resumen.cuentas, porEstado: resumen.porEstado }));
    return resumen;
  }
  const r = await verificarSincronizacionBancaria(dep);
  console.log("[sincronizacionBancariaHolded]", JSON.stringify({ fase, modo, ...r }));
  if (fase === "cierre" && modo === "activo") {
    const hoy = (await dep.almacen.listar({ tipo: "sync_bancaria", desde: Date.parse(`${fecha}T00:00:00Z`) - 3_600_000 * 2 })).filter((t) => t.clave.startsWith(`sync:${fecha}:`));
    const aviso = textoAvisoSincronizacion(hoy);
    if (aviso) await notificarAdmins(aviso); // en silencio si todo salió bien
  }
  return undefined;
}

export async function conversionTicketsHolded(opciones: { revisionNocturna?: boolean } = {}): Promise<ResumenTickets | undefined> {
  const modo = modoSeguro("TICKETS");
  if (modo === "apagado") return undefined;
  const almacen = almacenTrabajosHolded();
  // Caso controlado aprobado por Carlos: WOBI_HOLDED_TICKETS_CASO="Empresa:idDeLaCompra". Mientras exista, SOLO se toca ese
  // gasto (el resto de la cola no se procesa) y su resultado se comunica a los administradores.
  const [empresaCaso, idCaso] = (process.env.WOBI_HOLDED_TICKETS_CASO ?? "").trim().split(":");
  const soloIds = idCaso ? new Set([idCaso]) : undefined;
  if (idCaso && empresaCaso) {
    const clave = claveTicket(empresaCaso as Empresa, idCaso);
    if (!(await almacen.obtener(clave))) {
      const t = nuevoTrabajo({ clave, tipo: "ticket", empresa: empresaCaso, objetivo: idCaso }, Date.now());
      t.evidencia = { origen: "caso_controlado_aprobado", clasificacion: "ticket" };
      await almacen.guardar(t);
      await almacen.evento(clave, "caso_controlado_registrado", {});
    }
  }
  const resumen = await procesarColaTickets({ almacen, navegador: crearNavegadorHolded, soloIds });
  console.log("[conversionTicketsHolded]", JSON.stringify({ modo, revisados: resumen.revisados, porEstado: resumen.porEstado }));
  if (idCaso && empresaCaso && modo === "activo") {
    const hecho = resumen.detalle.find((d) => d.clave === claveTicket(empresaCaso as Empresa, idCaso) && d.estado !== "solicitado");
    if (hecho) {
      const t = await almacen.obtener(hecho.clave);
      const cambios = Array.isArray(t?.evidencia.camposCambiados) ? ` Campos cambiados: ${(t!.evidencia.camposCambiados as string[]).join(", ")}.` : "";
      await notificarAdmins(`🧪 Caso controlado de ticket (${empresaCaso} · ${idCaso}): ${hecho.estado.replace(/_/g, " ")}.${t?.ultimoError ? ` ${t.ultimoError}.` : ""}${cambios}`);
    }
  }
  if (opciones.revisionNocturna && modo === "activo") {
    const dudosos = await almacen.listar({ tipo: "ticket", estados: ["requiere_intervencion", "no_confirmado", "fallido"] });
    if (dudosos.length > 0) {
      const lineas = dudosos.slice(0, 15).map((t) => `  • ${t.empresa} · ${String(t.evidencia.proveedor ?? t.objetivo)}: ${t.estado.replace(/_/g, " ")}${t.ultimoError ? ` — ${t.ultimoError}` : ""}`);
      await notificarAdmins([`🧾 Conversión a ticket en Holded: ${dudosos.length} gasto(s) esperan revisión.`, ...lineas, dudosos.length > 15 ? `  … y ${dudosos.length - 15} más` : ""].filter(Boolean).join("\n"));
    }
  }
  return resumen;
}
