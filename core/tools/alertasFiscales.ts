import { calcularProximasAlertas } from "../fiscal/calendario";
import { formatDateLocal } from "../utils/dateFormat";
import { buscarEnCashflowPorConcepto } from "../google/buscarEnCashflow";
import { parseValorFormateado } from "../jobs/revisarHoldedVsCashflow";
import type { DetalleRegistro } from "../google/cashflowSheet";
import type { ToolDefinition } from "./types";

/**
 * El calendario fiscal (docs/calendario_fiscal.json) sabe CUÁNDO vence algo
 * pero nunca el monto — esos datos solo viven en el cashflow real. Antes,
 * responder "cuánto suma lo que vence pronto" dependía de que el modelo
 * encadenara una llamada aparte a consultar_cashflow_detalle por cada
 * concepto, y a veces se saltaba ese paso o buscaba con una palabra
 * demasiado corta y se perdía filas reales (caso real verificado en vivo:
 * buscar solo "crédito" para "Créditos/Préstamos" se perdía los préstamos
 * de WOBA y EWORKS, dando un total muy por debajo del real). Ahora esta
 * misma herramienta busca el monto real de cada concepto — no depende de
 * que el modelo se acuerde de hacerlo aparte, ni de qué palabra elija.
 */

// Palabras vacías/genéricas que no aportan como término de búsqueda por sí
// solas — se filtran antes de partir un concepto en palabras clave.
const PALABRAS_VACIAS = new Set(["de", "la", "el", "los", "las", "y", "del", "para", "con", "en"]);

function palabrasClaveDe(concepto: string): string[] {
  const palabras = concepto
    .toLowerCase()
    .replace(/[.,/]/g, " ")
    .split(/\s+/)
    .filter((p) => p.length >= 5 && !PALABRAS_VACIAS.has(p));
  return palabras.length > 0 ? palabras : [concepto];
}

async function buscarMontoReal(concepto: string): Promise<{ registros: DetalleRegistro[]; aproximado: boolean }> {
  // Un concepto con varias palabras clave o una barra ("Créditos/Préstamos")
  // puede cubrir más de un tipo de pago real — se busca CADA palabra por
  // separado y se combinan los resultados (sin duplicar), en vez de una
  // sola búsqueda con la frase completa que puede quedarse corta.
  const claves = palabrasClaveDe(concepto);
  const vistos = new Set<string>();
  const registros: DetalleRegistro[] = [];
  let algunoAproximado = false;

  for (const clave of claves) {
    const resultado = await buscarEnCashflowPorConcepto(clave);
    if (resultado.aproximado) algunoAproximado = true;
    for (const r of resultado.coincidencias) {
      const clave2 = `${r.categoria}|${r.cliente ?? ""}|${r.concepto ?? ""}|${r.semana}|${r.valor}`;
      if (vistos.has(clave2)) continue;
      vistos.add(clave2);
      registros.push(r);
    }
  }

  return { registros, aproximado: algunoAproximado && registros.length > 0 };
}

export const alertasFiscalesTool: ToolDefinition = {
  name: "consultar_proximas_alertas",
  seguraParaModoRapido: true,
  description:
    "Consulta qué vencimientos fiscales o pagos recurrentes del grupo (seguridad social, créditos, " +
    "seguros, impuestos, controles médicos...) están próximos a vencer — Y de una vez busca el monto " +
    "real de cada uno en el cashflow (no hace falta llamar a consultar_cashflow_detalle aparte para " +
    "esto). Úsala cuando el usuario pregunte qué vence pronto, qué hay que pagar, cuánto suma lo que " +
    "viene, o sobre seguros/impuestos/domiciliaciones próximas.",
  input_schema: {
    type: "object",
    properties: {
      dias: {
        type: "number",
        description:
          "Ventana de días hacia adelante a considerar, aplicada por igual a todas las entradas. " +
          "Opcional: si se omite, usa 3 días para vencimientos mensuales (día exacto conocido) y 7 " +
          "días para anuales (fecha aproximada).",
      },
    },
  },
  handler: async (input) => {
    const diasOverride = typeof input.dias === "number" && input.dias > 0 ? input.dias : undefined;
    // Deliberadamente SIN filtro de empresa en la búsqueda de montos: la
    // mayoría de las categorías donde vive esto (Gastos Fijos, Aplazamiento
    // Impuestos, Pendientes) NO tienen columna de empresa — filtrar por
    // empresa las excluiría siempre (mismo límite ya documentado en
    // consultar_cashflow_detalle). Bug real encontrado en la primera
    // versión de este fix: pasar empresaFiltro="WOBA" dejaba fuera
    // "Impuestos seg social" y "Prestamo 36 meses WOBA" (sin tag de
    // empresa), y solo sobrevivía un ingreso sin relación que sí tenía tag.
    const alertas = calcularProximasAlertas(new Date(), diasOverride);

    if (alertas.length === 0) {
      return diasOverride
        ? `No hay vencimientos fiscales ni pagos recurrentes en los próximos ${diasOverride} días.`
        : "No hay vencimientos fiscales ni pagos recurrentes próximos (3 días para mensuales, 7 para anuales).";
    }

    let totalConocido = 0;
    let huboAproximado = false;
    let huboSinMonto = false;

    const bloques = await Promise.all(
      alertas.map(async (a) => {
        const cuando = a.diasParaVencer === 0 ? "hoy" : a.diasParaVencer === 1 ? "mañana" : `en ${a.diasParaVencer} días`;
        const encabezado = `${a.concepto} (${a.empresa}, ${a.tipo}) — vence ${cuando} (${formatDateLocal(a.fecha)})`;

        const { registros, aproximado } = await buscarMontoReal(a.concepto);

        if (registros.length === 0) {
          huboSinMonto = true;
          return `${encabezado}\n  (no encontré el monto en el cashflow — puede que aún no esté registrado, o con un nombre distinto)`;
        }

        if (aproximado) huboAproximado = true;

        const lineas = registros
          .map((r) => {
            const valor = parseValorFormateado(r.valor);
            if (Number.isFinite(valor)) totalConocido += Math.abs(valor);
            const nombre = r.cliente ?? r.concepto ?? "(sin nombre)";
            const empresaTag = r.empresa ? ` [${r.empresa}]` : "";
            const bancoTag = r.banco ? ` (${r.banco})` : "";
            return `  ${aproximado ? "~" : "•"} ${nombre}${empresaTag} — ${r.semana || "(sin semana)"} — ${r.valor}${bancoTag}`;
          })
          .join("\n");

        return `${encabezado}\n${lineas}`;
      })
    );

    const notaAproximado = huboAproximado
      ? "\n\n⚠️ Los montos marcados con \"~\" son coincidencia aproximada (no exacta) — confírmalos antes de darlos por seguros."
      : "";
    const notaSinMonto = huboSinMonto
      ? "\n\n⚠️ Algunos vencimientos no tienen monto registrado todavía en el cashflow — el total de abajo NO los incluye."
      : "";

    return (
      bloques.join("\n\n") +
      `\n\n**Total conocido: €${totalConocido.toFixed(2)}**` +
      notaAproximado +
      notaSinMonto
    );
  },
};
