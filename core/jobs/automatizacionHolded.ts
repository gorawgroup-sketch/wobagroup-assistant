import { crearNavegadorHolded } from "../holded/automatizacion/navegadorHolded";
import { marcarEnEjecucion, registrarTraza } from "../holded/automatizacion/traza";
import { etiquetaEmpresa } from "../holded/automatizacion/empresas";
import { escanearReglaTicket, type CandidatoRegla } from "../holded/automatizacion/escaneoTickets";
import { empresasAutomatizacion, modoAutomatizacion, parsearCasosAprobados } from "../holded/automatizacion/modo";
import { lanzarSincronizacionBancaria, textoAvisoSincronizacion, verificarSincronizacionBancaria, type ResumenSync } from "../holded/automatizacion/sincronizacionBancaria";
import { claveTicket, procesarColaTickets, reabrirTicketsTransitorios, registrarCasoAprobado, reevaluarCambiosNormales, type ResumenTickets } from "../holded/automatizacion/tickets";
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

async function sincronizacionBancariaHoldedInterna(fase: "lanzar" | "verificar" | "cierre", ahora: Date = new Date()): Promise<ResumenSync | undefined> {
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

let ultimoAvisoDisyuntor = "";
async function conversionTicketsHoldedInterna(opciones: { revisionNocturna?: boolean } = {}): Promise<ResumenTickets | undefined> {
  const modo = modoSeguro("TICKETS");
  if (modo === "apagado") return undefined;
  const almacen = almacenTrabajosHolded();
  const reevaluados = await reevaluarCambiosNormales(almacen).catch((error) => { console.error("[conversionTicketsHolded] No se pudo reevaluar casos previos:", error); return 0; });
  const reabiertos = await reabrirTicketsTransitorios(almacen).catch((error) => { console.error("[conversionTicketsHolded] No se pudo reabrir casos transitorios:", error); return 0; });
  if (reabiertos > 0) console.log(`[conversionTicketsHolded] ${reabiertos} caso(s) reabiertos tras un fallo transitorio de pantalla`);
  if (reevaluados > 0) console.log(`[conversionTicketsHolded] ${reevaluados} caso(s) previos cerrados: solo tenían efectos normales de pasar a ticket`);
  // Regla amplia: explora las compras recientes de las empresas en alcance y registra en la cola las que son ticket. En
  // «simulacion» solo registra y avisa (nada se convierte hasta que Carlos apruebe la lista real).
  const reglaModo = modoAutomatizacion("TICKETS_REGLA");
  if (reglaModo !== "apagado") {
    const nuevos: CandidatoRegla[] = [];
    for (const empresa of empresasAutomatizacion("TICKETS_REGLA")) {
      try {
        const r = await escanearReglaTicket(empresa, almacen, { simulada: reglaModo !== "activo" });
        nuevos.push(...r.candidatos);
        registrarTraza("escaneo_regla", { empresa, revisadas: r.revisadas, candidatos: r.candidatos.length, aRevisar: r.aRevisar, excluidas: r.excluidas });
      } catch (error) { console.error(`[conversionTicketsHolded] Error explorando candidatos de ${empresa}:`, error instanceof Error ? error.message : error); }
    }
    if (nuevos.length > 0) {
      const lista = nuevos.slice(0, 12).map((c) => `  • ${etiquetaEmpresa(c.empresa)} · ${c.proveedor} · ${c.total} ${c.moneda} (${c.fecha}) — ${c.motivos.join("; ")}`).join("\n");
      await notificarAdmins(`🧾 Regla de ticket (${reglaModo === "activo" ? "ACTIVA" : "SIMULACIÓN: no se convierte nada"}): ${nuevos.length} candidato(s) nuevo(s)\n${lista}${nuevos.length > 12 ? `\n  … y ${nuevos.length - 12} más` : ""}`).catch(() => undefined);
    }
  }
  // Lista aprobada por Carlos: WOBI_HOLDED_TICKETS_CASO="Empresa:id,Empresa:id,…". Mientras exista, SOLO se tocan esos gastos
  // (el resto de la cola no se procesa) y el resultado de cada uno se comunica a los administradores en un solo aviso.
  const casos = parsearCasosAprobados(process.env.WOBI_HOLDED_TICKETS_CASO);
  const soloIds = casos.length > 0 ? new Set(casos.map((c) => c.id)) : undefined;
  for (const caso of casos) await registrarCasoAprobado(almacen, caso.empresa, caso.id);
  const resumen = await procesarColaTickets({ almacen, navegador: crearNavegadorHolded, soloIds });
  console.log("[conversionTicketsHolded]", JSON.stringify({ modo, revisados: resumen.revisados, porEstado: resumen.porEstado }));
  if (resumen.disyuntor) {
    registrarTraza("disyuntor_conversion", { casosInesperados: resumen.disyuntor });
    const dia = fechaHoyEspana();
    if (ultimoAvisoDisyuntor !== dia) {
      ultimoAvisoDisyuntor = dia;
      await notificarAdmins(`🛑 Conversión a ticket DETENIDA por seguridad: ${resumen.disyuntor} gasto(s) de las últimas 24 h terminaron con cambios inesperados en Holded. No se convierte nada más hasta que lo revises (pídeme el estado de las automatizaciones de Holded).`).catch(() => undefined);
    }
  }
  // Traza visible en /health del estado de cada gasto de la lista aprobada (tanto si se procesó en este ciclo como si no).
  for (const caso of casos) {
    const p = await almacen.obtener(claveTicket(caso.empresa, caso.id)).catch(() => undefined);
    registrarTraza("caso_ticket", { empresa: caso.empresa, id: caso.id.slice(0, 8), estado: p?.estado ?? "sin registro", intentos: p?.intentos ?? 0, error: p?.ultimoError?.slice(0, 140) ?? null }, `ticket:${caso.empresa}:${caso.id.slice(0, 8)}`);
  }
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

/** Envoltorio con traza visible en /health: inicio, fin (o error) y duración de cada pasada. */
async function conTraza<T>(nombre: string, tarea: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  registrarTraza("inicio", { tarea: nombre });
  marcarEnEjecucion(nombre, true);
  try {
    const r = await tarea();
    registrarTraza("fin", { tarea: nombre, segundos: Math.round((Date.now() - t0) / 1000) });
    return r;
  } catch (error) {
    registrarTraza("error", { tarea: nombre, segundos: Math.round((Date.now() - t0) / 1000), mensaje: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    throw error;
  } finally { marcarEnEjecucion(nombre, false); }
}

export const sincronizacionBancariaHolded = (fase: "lanzar" | "verificar" | "cierre", ahora: Date = new Date()) =>
  conTraza(`sync_${fase}`, () => sincronizacionBancariaHoldedInterna(fase, ahora));
export const conversionTicketsHolded = (opciones: { revisionNocturna?: boolean } = {}) =>
  conTraza(opciones.revisionNocturna ? "tickets_revision" : "tickets", () => conversionTicketsHoldedInterna(opciones));
