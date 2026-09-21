import { fetchDetalleRegistrosConMeta, obtenerUltimaVerificacionEstructura } from "../google/cashflowSheet";
import { consultarCashflow, formatearResultadoCashflow, parsearEntradaConsulta } from "../google/buscarEnCashflow";
import { notaFrescura } from "../utils/readCache";
import type { ToolDefinition } from "./types";

/**
 * Lee los movimientos de detalle de la hoja DATOS: ingresos, pagos a proyectos,
 * pagos extras, impuestos por pagar, aplazamientos de impuestos, gastos fijos
 * (nóminas, créditos, servicios), gastos consultores mes actual, gastos
 * consultores próximo mes, y pendientes (Alberto / deudas con otros) —
 * filtrables por semana, empresa dueña del movimiento y/o contraparte
 * (cliente/proveedor/concepto).
 *
 * "empresa" y "contraparte" son conceptos distintos y no deben mezclarse:
 * - empresa: WOBA o EWORKS, la entidad del grupo dueña del movimiento (viene
 *   de la columna de tag; existe en Ingresos, Pagos Proyectos, y — desde que
 *   Carlos agregó esa columna, ver hallazgo real de auditoría en
 *   cashflowSheet.ts — también en Pagos Pendientes Alberto / Deudas
 *   Pendientes. Impuestos por Pagar, Aplazamiento Impuestos, Gastos Fijos y
 *   Gastos Consultores NO tienen esa columna (verificado en vivo 2026-09-21: las
 *   83 filas sin empresa son de esas tablas, más algunas de Deudas Pendientes):
 *   al filtrar por empresa esas filas NO se descartan — se devuelven marcadas
 *   "sin empresa" (o con la empresa inferida por su nombre, p. ej. "MOD 303
 *   EWORKS Q2"). Caso real 2026-09-21: filtrar por EWORKS escondía "Providencia
 *   de apremio" y "Sanción AEAT", y Wobi dijo que no estaban en el cashflow.
 *   Ver core/google/buscarEnCashflow.ts).
 * - contraparte: texto libre con el nombre de quien paga o cobra, o el
 *   concepto del gasto (ej. "Limpieza", "Google", "Renting"), que puede
 *   incluir nombres de otras empresas del grupo (ej. "Footprint" aparece como
 *   cliente dentro del cashflow de WOBA/EWORKS).
 *
 * Bug real corregido en vivo (2026-09-01): "Impuestos por Pagar" y
 * "Aplazamiento Impuestos por Pagar" viven en la MISMA columna que Pagos
 * Proyectos (columna N de DATOS, apiladas debajo por título de sección) —
 * antes se leían como si fueran filas de Pagos Proyectos, con datos
 * completamente corrompidos (ver parsearSeccionesColumnaN en
 * cashflowSheet.ts). Ya corregido — ambas se leen como su propia categoría.
 * Corrección relacionada (misma sesión): "Gastos Consultores Mes Actual" y
 * "Gastos Consultores Próximo Mes" son tablas propias (con su propio título
 * fusionado y encabezado de columna) apiladas debajo de Gastos Fijos en la
 * columna I — antes se leían mezcladas como Gastos Fijos genérico, sin poder
 * distinguirlas (ver parsearSeccionesColumnaI). Carlos las señaló
 * explícitamente como categorías propias — nunca asumir que "ya se
 * entendió" la estructura de este Sheet sin verificar en vivo primero.
 */
export const cashflowDetalleTool: ToolDefinition = {
  name: "consultar_cashflow_detalle",
  seguraParaModoRapido: true,
  lecturaAcotable: true,
  lecturaParalela: "cashflow",
  description:
    "Consulta el detalle de movimientos del cashflow desde la hoja DATOS: ingresos, pagos a proyectos, " +
    "pagos extras, impuestos por pagar, aplazamientos de impuestos, gastos fijos (nóminas, créditos, " +
    "servicios como limpieza/renting/alquiler), gastos consultores mes actual, gastos consultores " +
    "próximo mes (categoría PROPIA, distinta de gastos fijos), y pendientes (pagos pendientes a Alberto, " +
    "deudas con otros). Un dato se puede buscar de TRES maneras y debes usar las que el usuario te dé: " +
    "(1) por NOMBRE/concepto con 'contraparte' (ej. 'apremio', 'sanción', 'limpieza'; no distingue tildes " +
    "ni mayúsculas y entiende sinónimos como Hacienda≈AEAT); (2) por IMPORTE con 'valor' (ej. 747.31 — " +
    "encuentra el importe exacto y, si no hay, uno cercano marcado como aproximado); (3) por el TÍTULO de la " +
    "sección con 'categoria' (ej. 'impuestos por pagar', 'aplazamiento', 'gastos fijos') — devuelve toda esa " +
    "tabla. Combínalas cuando el usuario diga varias (nombre + sección + importe): es la forma más segura. " +
    "IMPORTANTE con 'empresa': Impuestos por Pagar, Aplazamientos, Gastos Fijos, Pagos Extras y Gastos " +
    "Consultores NO tienen columna de empresa en la hoja; esas filas se devuelven igualmente marcadas " +
    "'sin empresa en la hoja' — nunca las des por de una empresa concreta si la hoja no lo dice. " +
    "Si el resultado viene marcado como coincidencia APROXIMADA o con un filtro relajado, dilo así al " +
    "usuario y pregunta si es lo que buscaba, no lo des por hecho. Si no hay resultados, la respuesta " +
    "detalla qué se probó (y si la lectura de la hoja tuvo filas ilegibles): repítelo al usuario tal cual y " +
    "NUNCA concluyas que un pago 'no está en el cashflow' si el usuario te dio nombre, importe o sección y no " +
    "los probaste todos. " +
    "Úsala cuando el usuario pida un desglose detallado en vez de solo el resumen semanal. Si en cambio " +
    "piden verificar/comparar esto contra los movimientos bancarios reales de Holded (¿qué falta " +
    "registrar?, ¿está al día?, para cualquier semana incluida una pasada concreta como 'S36') usa MEJOR " +
    "comparar_cashflow_holded — es el único motor oficial y ya hace esa comparación con tolerancias y " +
    "detección de duplicados; " +
    "no intentes cruzar esta tool con movimientos de Holded a mano, se te van a escapar coincidencias " +
    "reales (falsos 'falta registrar').",
  input_schema: {
    type: "object",
    properties: {
      semana: {
        type: "string",
        description: "Filtra por semana exacta, formato 'S38'. Opcional.",
      },
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS"],
        description:
          "Empresa del grupo DUEÑA del movimiento (WOBA o EWORKS), no el nombre del cliente/proveedor. " +
          "Las filas sin columna de empresa (impuestos por pagar, aplazamientos, gastos fijos, gastos " +
          "consultores) se devuelven marcadas 'sin empresa'; solo se apartan las que la hoja o su nombre " +
          "atribuyen a la OTRA empresa (y se dice cuántas). Opcional.",
      },
      contraparte: {
        type: "string",
        description:
          "Nombre de quien paga o cobra, o concepto del gasto (ej. 'Google', 'apremio', 'MOD 303'); " +
          "coincidencia parcial sin distinguir mayúsculas ni tildes. También acepta un importe (ej. '747'). " +
          "Opcional.",
      },
      valor: {
        type: "number",
        description:
          "Importe buscado en euros, positivo (ej. 747.31). Coincide con el valor exacto; si no hay, con " +
          "uno cercano (marcado aproximado). Opcional.",
      },
      tolerancia_eur: {
        type: "number",
        description: "Diferencia máxima en € para el importe cercano. Opcional (por defecto entre 1 y 5 €).",
      },
      categoria: {
        type: "string",
        description:
          "Título de la sección de la hoja en lenguaje natural: 'ingresos', 'pagos proyectos', 'pagos extras', " +
          "'impuestos por pagar', 'aplazamiento impuestos', 'gastos fijos', 'gastos consultores mes actual', " +
          "'gastos consultores próximo mes', 'pagos pendientes Alberto', 'deudas pendientes otros'. " +
          "Devuelve esa tabla (filtrada por lo demás). Opcional.",
      },
    },
  },
  handler: async (input) => {
    const entrada = parsearEntradaConsulta(input);
    if (entrada.rechazo) return entrada.rechazo;
    const consulta = entrada.consulta ?? {};

    const lectura = await fetchDetalleRegistrosConMeta();
    const resultado = consultarCashflow(lectura.datos, consulta);
    const texto = formatearResultadoCashflow(resultado, consulta, {
      problemasLectura: obtenerUltimaVerificacionEstructura(),
      ignorados: entrada.ignorados,
    });
    return `${texto}\n${notaFrescura(lectura.meta)}`;
  },
};
