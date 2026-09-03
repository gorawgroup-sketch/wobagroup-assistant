import { buscarGastoSimilar, buscarMovimientoSimilar, buscarMovimientoAproximado, reconciliarMovimiento } from "../holded/write";
import type { Empresa } from "../holded/client";
import type { ToolDefinition } from "./types";

/**
 * Pedido explícito de Carlos, tras un caso real: le pidió al chat que
 * conciliara un movimiento bancario ("Cafe Vida", -42.46€) con un gasto ya
 * creado ("Almuerzo con Alejandro", 42.46 EUR) que el propio asistente había
 * identificado con las tools de consulta — pero no existía ninguna tool que
 * de verdad EJECUTARA la conciliación, solo las de solo lectura
 * (consultar_movimientos_sin_conciliar, consultar_estado_factura_holded).
 * "No tengo una herramienta que ejecute la conciliación directamente en
 * Holded" era honesto, no un bug, pero era una capacidad real que faltaba.
 *
 * Misma lógica de matching que ya usa procesarGastoEntrante.ts/
 * gastoCallbackHandler.ts al conciliar automáticamente tras crear un gasto
 * (match exacto por monto/fecha, y si no hay, aproximado por nombre+monto;
 * nunca elige sola entre varios candidatos; siempre relee el estado real en
 * vez de asumir éxito) — reimplementada acá en vez de importada desde
 * gastoCallbackHandler.ts a propósito: importar ese archivo desde un tool
 * (cargado por core/tools/registry.ts, que a su vez carga core/claude/
 * client.ts) cerraba un ciclo de módulos real (ReferenceError: Cannot
 * access 'conciliarMovimientoTool' before initialization, verificado en
 * vivo) — esta tool solo depende de core/holded/write.ts, sin ciclo.
 */
export const conciliarMovimientoTool: ToolDefinition = {
  name: "conciliar_movimiento_bancario",
  description:
    "Concilia (enlaza) de verdad un movimiento bancario de Holded con un gasto ya registrado — la acción " +
    "real, no solo consultar. Úsala cuando el usuario pida conciliar/vincular/enlazar un movimiento con un " +
    "gasto (típicamente después de identificarlos con consultar_movimientos_sin_conciliar y/o " +
    "consultar_gastos_sin_comprobante, o porque el usuario ya te dio los datos). Necesita el proveedor/" +
    "concepto del gasto tal como aparece en Holded, su monto, su fecha y la empresa — busca el gasto y el " +
    "movimiento correspondientes por su cuenta y, si ambos son un match único y claro, los enlaza de " +
    "verdad. Si hay ambigüedad en cualquiera de los dos lados (varios candidatos parecidos, o ninguno), " +
    "NUNCA elige sola — te dice exactamente qué encontró para que confirmes cuál es, en vez de adivinar en " +
    "un tema financiero.",
  input_schema: {
    type: "object",
    properties: {
      empresa: { type: "string", enum: ["WOBA", "EWORKS", "Footprint"], description: "Empresa del grupo." },
      proveedor: {
        type: "string",
        description: "Proveedor/contacto del gasto en Holded, tal como aparece ahí (ej. 'UBER COLOMBIA').",
      },
      monto: { type: "number", description: "Importe del gasto/movimiento (deben coincidir)." },
      fecha: { type: "string", description: "Fecha del gasto en formato YYYY-MM-DD." },
      moneda: { type: "string", description: "Código de moneda, ej. EUR, USD. Opcional, por defecto EUR." },
    },
    required: ["empresa", "proveedor", "monto", "fecha"],
  },
  handler: async (input) => {
    const empresa = input.empresa as Empresa;
    if (empresa !== "WOBA" && empresa !== "EWORKS" && empresa !== "Footprint") {
      return "Error: 'empresa' debe ser WOBA, EWORKS o Footprint.";
    }

    const proveedor = typeof input.proveedor === "string" ? input.proveedor.trim() : "";
    const monto = typeof input.monto === "number" ? input.monto : NaN;
    const fecha = typeof input.fecha === "string" ? input.fecha.trim() : "";
    const moneda = typeof input.moneda === "string" && input.moneda.trim() ? input.moneda.trim().toUpperCase() : "EUR";

    if (!proveedor || !Number.isFinite(monto) || !fecha) {
      return "Error: faltan datos — hacen falta proveedor, monto (número) y fecha (YYYY-MM-DD) del gasto.";
    }

    let candidatosGasto: Awaited<ReturnType<typeof buscarGastoSimilar>>;
    try {
      candidatosGasto = await buscarGastoSimilar(empresa, { proveedor, monto, fecha });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error buscando el gasto en Holded: ${message}`;
    }

    if (candidatosGasto.length === 0) {
      return `No encontré ningún gasto de "${proveedor}" por ${monto} ${moneda} cerca del ${fecha} en Holded (${empresa}) — confirma esos datos antes de reintentar.`;
    }
    if (candidatosGasto.length > 1) {
      const lista = candidatosGasto
        .map((c) => `  • ${c.contactName} — ${c.total.toFixed(2)} € (${c.fecha}) — ${c.descripcion} [id: ${c.id}]`)
        .join("\n");
      return `Encontré ${candidatosGasto.length} gastos parecidos, no sé cuál conciliar — dime cuál es:\n${lista}`;
    }

    const gasto = candidatosGasto[0];

    let candidatosMov: Awaited<ReturnType<typeof buscarMovimientoSimilar>> = [];
    try {
      candidatosMov = await buscarMovimientoSimilar(empresa, { monto, fecha, moneda });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Encontré el gasto (${gasto.contactName} — ${gasto.total.toFixed(2)} €) pero hubo un error buscando el movimiento bancario: ${message}`;
    }

    let candidato: (typeof candidatosMov)[number] | undefined;
    let esAproximado = false;

    if (candidatosMov.length === 1) {
      candidato = candidatosMov[0];
    } else if (candidatosMov.length > 1) {
      const lista = candidatosMov.map((m) => `  • "${m.descripcion || "(sin descripción)"}" — ${m.monto.toFixed(2)} ${m.moneda} (${m.fecha})`).join("\n");
      return `Encontré el gasto (${gasto.contactName} — ${gasto.total.toFixed(2)} €), pero hay ${candidatosMov.length} movimientos bancarios parecidos sin conciliar — dime cuál es:\n${lista}`;
    } else {
      const aproximados = await buscarMovimientoAproximado(empresa, { monto, fecha, moneda, proveedor }).catch(() => []);
      if (aproximados.length === 1) {
        candidato = aproximados[0];
        esAproximado = true;
      } else if (aproximados.length > 1) {
        const lista = aproximados.map((m) => `  • "${m.descripcion || "(sin descripción)"}" — ${m.monto.toFixed(2)} ${m.moneda} (${m.fecha})`).join("\n");
        return `Encontré el gasto (${gasto.contactName} — ${gasto.total.toFixed(2)} €), pero hay ${aproximados.length} movimientos parecidos (no exactos) — dime cuál es:\n${lista}`;
      }
    }

    if (!candidato) {
      return `Encontré el gasto (${gasto.contactName} — ${gasto.total.toFixed(2)} €, ${gasto.fecha}) pero no encontré ningún movimiento bancario sin conciliar que coincida — revísalo a mano en Holded.`;
    }

    const resultado = await reconciliarMovimiento(empresa, candidato.accountId, candidato.movementId, candidato.fecha, gasto.id);
    const notaAprox = esAproximado ? " — coincidencia APROXIMADA (nombre y monto parecidos, no exactos), confírmalo en Holded" : "";

    if (resultado.ok) {
      return (
        `Conciliado — gasto "${gasto.contactName}" (${gasto.total.toFixed(2)} €) enlazado al movimiento bancario ` +
        `"${candidato.descripcion || "(sin descripción)"}" (${candidato.monto.toFixed(2)} ${candidato.moneda}, ` +
        `enlazado por ${resultado.montoEnlazado.toFixed(2)} ${candidato.moneda})${notaAprox}.`
      );
    }
    return (
      `Encontré un movimiento parecido ("${candidato.descripcion || "(sin descripción)"}", ${candidato.monto.toFixed(2)} ${candidato.moneda}) ` +
      `pero no pude confirmar que quedó conciliado Y enlazado (estado: ${resultado.statusFinal}, monto enlazado: ` +
      `${resultado.montoEnlazado.toFixed(2)} ${candidato.moneda}) — revísalo a mano en Holded.`
    );
  },
};
