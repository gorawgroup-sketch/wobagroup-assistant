import { etiquetaEmpresa } from "../holded/automatizacion/empresas";
import { empresasAutomatizacion, modoAutomatizacion } from "../holded/automatizacion/modo";
import { almacenTrabajosHolded, hayAlmacenDuradero, type Trabajo } from "../holded/automatizacion/trabajos";
import { fechaHoyEspana } from "../utils/diaHabil";
import type { ToolDefinition } from "./types";

/**
 * Consulta de SOLO LECTURA del estado de las dos automatizaciones de Holded en servidor (sincronización bancaria de las 06:00 y
 * conversión de gastos a ticket): modo, alcance, y para cada cuenta/gasto su estado y motivo. Existe para no depender de que un
 * aviso llegue: el registro está en la base de datos del servidor y esta herramienta lo lee desde ahí.
 */
export const estadoAutomatizacionHoldedTool: ToolDefinition = {
  name: "estado_automatizacion_holded",
  description:
    "Muestra el estado real de las automatizaciones de Holded en servidor: la sincronización bancaria de las 06:00 (cada cuenta: " +
    "solicitada, en curso, completada, fallida, requiere intervención o no confirmada, con el motivo) y la conversión de gastos a " +
    "ticket (casos pendientes, completados o que requieren revisión, con el motivo). Solo lectura. Úsala cuando pregunten si se " +
    "sincronizó el banco, por qué no se ejecutó algo, o cómo va la conversión a ticket.",
  input_schema: { type: "object", properties: {}, required: [] },
  handler: async () => {
    const lineas: string[] = [];
    for (const [nombre, clave] of [["Sincronización bancaria", "SYNC_BANCARIA"], ["Conversión a ticket", "TICKETS"]] as const) {
      lineas.push(`• ${nombre}: modo ${modoAutomatizacion(clave)}${modoAutomatizacion(clave) === "activo" ? `, empresas ${empresasAutomatizacion(clave).join("/") || "ninguna"}` : ""}`);
    }
    if (!hayAlmacenDuradero()) return `${lineas.join("\n")}\n\nNo hay base de datos duradera configurada: no hay registro que consultar.`;
    const almacen = almacenTrabajosHolded();
    const ahora = Date.now();
    const hoy = fechaHoyEspana();
    const fmt = (t: Trabajo) => `${t.estado.replace(/_/g, " ")}${t.ultimoError ? ` — ${t.ultimoError}` : ""}`;

    const sync = (await almacen.listar({ tipo: "sync_bancaria", desde: ahora - 36 * 3_600_000 })).filter((t) => t.clave.startsWith(`sync:${hoy}:`));
    lineas.push("", `Sincronización de hoy (${hoy}): ${sync.length === 0 ? "sin cuentas registradas todavía" : `${sync.length} cuenta(s)`}`);
    for (const t of sync) {
      const ver = t.verificadoEn ? `, verificada ${new Date(t.verificadoEn).toISOString().slice(11, 16)} UTC` : "";
      lineas.push(`  - ${etiquetaEmpresa(t.empresa)} · ${String(t.evidencia.nombre ?? t.objetivo)}: ${fmt(t)}${ver}`);
    }

    const tickets = await almacen.listar({ tipo: "ticket", desde: ahora - 7 * 24 * 3_600_000 });
    const porEstado: Record<string, number> = {};
    for (const t of tickets) porEstado[t.estado] = (porEstado[t.estado] ?? 0) + 1;
    lineas.push("", `Conversión a ticket (últimos 7 días): ${tickets.length === 0 ? "sin casos" : Object.entries(porEstado).map(([e, n]) => `${n} ${e.replace(/_/g, " ")}`).join(", ")}`);
    for (const t of tickets.filter((x) => ["solicitado", "requiere_intervencion", "no_confirmado", "fallido"].includes(x.estado)).slice(0, 15)) {
      lineas.push(`  - ${etiquetaEmpresa(t.empresa)} · ${String(t.evidencia.proveedor ?? t.objetivo)} (${t.objetivo.slice(0, 8)}…): ${fmt(t)}`);
    }
    return lineas.join("\n");
  },
};
