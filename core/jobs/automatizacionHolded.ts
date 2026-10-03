import { crearNavegadorHolded } from "../holded/automatizacion/navegadorHolded";
import { etiquetaEmpresa } from "../holded/automatizacion/empresas";
import { modoAutomatizacion, parsearCasosAprobados } from "../holded/automatizacion/modo";
import { lanzarSincronizacionBancaria, textoAvisoSincronizacion, verificarSincronizacionBancaria, type ResumenSync } from "../holded/automatizacion/sincronizacionBancaria";
import { claveTicket, procesarColaTickets, reevaluarCambiosNormales, type ResumenTickets } from "../holded/automatizacion/tickets";
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
  console.log("[sincronizacionBancariaHolded] inicio", JSON.stringify({ fase, modo }));
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
  const reevaluados = await reevaluarCambiosNormales(almacen).catch((error) => { console.error("[conversionTicketsHolded] No se pudo reevaluar casos previos:", error); return 0; });
  if (reevaluados > 0) console.log(`[conversionTicketsHolded] ${reevaluados} caso(s) previos cerrados: solo tenían efectos normales de pasar a ticket`);
  // Lista aprobada por Carlos: WOBI_HOLDED_TICKETS_CASO="Empresa:id,Empresa:id,…". Mientras exista, SOLO se tocan esos gastos
  // (el resto de la cola no se procesa) y el resultado de cada uno se comunica a los administradores en un solo aviso.
  const casos = parsearCasosAprobados(process.env.WOBI_HOLDED_TICKETS_CASO);
  const soloIds = casos.length > 0 ? new Set(casos.map((c) => c.id)) : undefined;
  for (const caso of casos) {
    const clave = claveTicket(caso.empresa, caso.id);
    if (!(await almacen.obtener(clave))) {
      const t = nuevoTrabajo({ clave, tipo: "ticket", empresa: caso.empresa, objetivo: caso.id }, Date.now());
      t.evidencia = { origen: "lista_aprobada", clasificacion: "ticket" };
      await almacen.guardar(t);
      await almacen.evento(clave, "caso_controlado_registrado", {});
    }
  }
  const resumen = await procesarColaTickets({ almacen, navegador: crearNavegadorHolded, soloIds });
  console.log("[conversionTicketsHolded]", JSON.stringify({ modo, revisados: resumen.revisados, porEstado: resumen.porEstado }));
  if (casos.length > 0 && modo === "activo") {
    const lineas: string[] = [];
    for (const caso of casos) {
      const clave = claveTicket(caso.empresa, caso.id);
      const hecho = resumen.detalle.find((d) => d.clave === clave && d.estado !== "solicitado");
      if (!hecho) {
        // Gasto de la lista que NO se procesó en este ciclo: se informa su estado y motivo, una sola vez por cada cambio, para que
        // nunca quede un caso sin explicar (p. ej. esperando conciliación o ya resuelto antes).
        const p = await almacen.obtener(clave);
        const huella = p ? `${p.estado}|${p.ultimoError ?? ""}` : "";
        if (p && p.evidencia.reportado !== huella && (p.estado !== "solicitado" || p.ultimoError)) {
          p.evidencia.reportado = huella;
          await almacen.guardar(p);
          lineas.push(`  • ${etiquetaEmpresa(caso.empresa)} · ${String(p.evidencia.proveedor ?? "")} (${caso.id.slice(0, 8)}…): ${p.estado.replace(/_/g, " ")} (no procesado en este ciclo)${p.ultimoError ? ` — ${p.ultimoError}` : ""}`);
        }
        continue;
      }
      const t = await almacen.obtener(hecho.clave);
      const dif = Array.isArray(t?.evidencia.diferencias) ? (t!.evidencia.diferencias as Array<{ campo: string; antes: string; despues: string; informativo?: boolean }>) : [];
      const detalle = dif.slice(0, 6).map((d) => `\n    - ${d.campo}${d.informativo ? " (informativo)" : ""}: ${d.antes} → ${d.despues}`).join("");
      lineas.push(`  • ${etiquetaEmpresa(caso.empresa)} · ${String(t?.evidencia.proveedor ?? "")} (${caso.id.slice(0, 8)}…): ${hecho.estado.replace(/_/g, " ")}${t?.ultimoError ? ` — ${t.ultimoError}` : ""}${detalle}`);
    }
    if (lineas.length > 0) await notificarAdmins(`🧪 Conversión a ticket (lista aprobada): ${lineas.length} gasto(s)\n${lineas.join("\n")}`);
  }
  if (opciones.revisionNocturna && modo === "activo") {
    const dudosos = await almacen.listar({ tipo: "ticket", estados: ["requiere_intervencion", "no_confirmado", "fallido"] });
    if (dudosos.length > 0) {
      const lineas = dudosos.slice(0, 15).map((t) => `  • ${etiquetaEmpresa(t.empresa)} · ${String(t.evidencia.proveedor ?? t.objetivo)}: ${t.estado.replace(/_/g, " ")}${t.ultimoError ? ` — ${t.ultimoError}` : ""}`);
      await notificarAdmins([`🧾 Conversión a ticket en Holded: ${dudosos.length} gasto(s) esperan revisión.`, ...lineas, dudosos.length > 15 ? `  … y ${dudosos.length - 15} más` : ""].filter(Boolean).join("\n"));
    }
  }
  return resumen;
}
