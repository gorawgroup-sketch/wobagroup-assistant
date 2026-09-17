import {
  generarCruceCashflowGastosHolded,
  generarCruceCashflowHolded,
  resolverFilasSinEmpresaGlobal,
  type EmpresaCashflowCruce,
  type ResolucionFilasSinEmpresa,
  type ResultadoCruceCashflowGastosHolded,
  type ResultadoCruceCashflowHolded,
} from "../cashflow/cruceHoldedCashflow";
import {
  currentWeekRangeToDate,
  formatDateISO,
  lunesDeEtiquetaSemana,
  previousWeekRange,
  weekLabel,
} from "../utils/isoWeek";
import type { ToolDefinition } from "./types";

const EMPRESAS: EmpresaCashflowCruce[] = ["WOBA", "EWORKS"];

type Direccion = "ambas" | "banco_a_cashflow" | "cashflow_a_banco";
type Fuente = "bancos" | "gastos" | "ambos";

function rangoPedido(input: Record<string, unknown>):
  | { semana: string; desde: string; hasta: string; etiqueta: string }
  | { error: string } {
  const referencia = new Date();
  const semanaPedida = typeof input.semana === "string" ? input.semana.trim() : "";
  let start: Date;
  let end: Date;

  if (semanaPedida) {
    const lunes = lunesDeEtiquetaSemana(semanaPedida, referencia);
    if (!lunes) return { error: `"${semanaPedida}" no es una semana válida (usa, por ejemplo, S37).` };
    start = lunes;
    end = new Date(lunes);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (input.periodo === "semana_anterior") {
    ({ start, end } = previousWeekRange(referencia));
  } else {
    ({ start, end } = currentWeekRangeToDate(referencia));
  }

  const semana = weekLabel(start);
  return {
    semana,
    desde: formatDateISO(start),
    hasta: formatDateISO(end),
    etiqueta: semanaPedida ? semana : input.periodo === "semana_anterior" ? `${semana}, semana anterior` : `${semana}, hasta hoy`,
  };
}

function referenciaFila(resultado: ResultadoCruceCashflowHolded, indice: number): string {
  const fila = resultado.filasSinMovimiento[indice];
  return fila.fila ? `fila ${fila.fila}` : fila.id;
}

function formatearEmpresa(
  resultado: ResultadoCruceCashflowHolded,
  direccion: Direccion,
  resolucionGlobal: ResolucionFilasSinEmpresa
): string {
  const atribuciones = resolucionGlobal.atribuciones.filter((item) => item.empresa === resultado.empresa);
  const ambiguosVisibles = resultado.ambiguos.filter(
    (caso) =>
      !caso.movimiento ||
      !resolucionGlobal.movimientosResueltos.has(`${caso.movimiento.empresa}:${caso.movimiento.id}`)
  );
  const lineas: string[] = [
    `\n${resultado.empresa} — ${resultado.coincidencias.length + atribuciones.length} coincidencia(s) verificadas`,
    `Cobertura bancaria consultada: ${resultado.desdeBancos} a ${resultado.hastaBancos}.`,
  ];

  if (resultado.problemasCobertura.length > 0) {
    lineas.push("⛔ INFORME INCOMPLETO: no se emiten conclusiones de ausencia mientras exista este problema:");
    lineas.push(...resultado.problemasCobertura.map((problema) => `  • ${problema}`));
    return lineas.join("\n");
  }

  if (atribuciones.length > 0) {
    lineas.push(
      `🔎 ${atribuciones.length} fila(s) sin etiqueta EMPRESA fueron atribuidas por evidencia bancaria única:`
    );
    lineas.push(
      ...atribuciones.map(
        ({ fila, movimiento }) =>
          `  • ${fila.descripcion} · ${Math.abs(fila.valorEur).toFixed(2)} EUR → ${resultado.empresa}/${movimiento.cuenta} · movimiento ${movimiento.id}`
      )
    );
  }

  if (direccion !== "cashflow_a_banco") {
    if (resultado.movimientosSinCashflow.length === 0) {
      lineas.push("✅ Banco → cashflow: no hay movimientos confirmados como ausentes.");
    } else {
      lineas.push(`⚠️ Banco → cashflow: ${resultado.movimientosSinCashflow.length} movimiento(s) sin fila confirmada:`);
      lineas.push(
        ...resultado.movimientosSinCashflow.map(
          (movimiento) =>
            `  • ${movimiento.fecha} · ${movimiento.descripcion} · ${Math.abs(movimiento.valorEur).toFixed(2)} EUR · ${movimiento.cuenta} (${movimiento.moneda}) · id ${movimiento.id}`
        )
      );
    }
  }

  if (direccion !== "banco_a_cashflow") {
    const gastosSinMovimiento = resultado.filasSinMovimiento.filter((fila) => fila.tipo === "gasto");
    if (gastosSinMovimiento.length === 0) {
      lineas.push("✅ Cashflow → banco: no hay gastos confirmados como ausentes.");
    } else {
      lineas.push(`⚠️ Cashflow → banco: ${gastosSinMovimiento.length} gasto(s) sin salida bancaria confirmada:`);
      for (const fila of gastosSinMovimiento) {
        const indice = resultado.filasSinMovimiento.indexOf(fila);
        lineas.push(
          `  • ${fila.descripcion} · ${Math.abs(fila.valorEur).toFixed(2)} EUR · ${fila.categoria} · ${referenciaFila(resultado, indice)}`
        );
      }
    }
  }

  if (ambiguosVisibles.length > 0) {
    lineas.push(`🟠 ${ambiguosVisibles.length} caso(s) ambiguo(s), separados de los faltantes y sin adivinar:`);
    lineas.push(
      ...ambiguosVisibles.map((caso) => {
        const sujeto = caso.movimiento
          ? `${caso.movimiento.fecha} · ${caso.movimiento.descripcion} · ${Math.abs(caso.movimiento.valorEur).toFixed(2)} EUR`
          : `${caso.fila?.descripcion ?? "fila sin identificar"} · ${Math.abs(caso.fila?.valorEur ?? 0).toFixed(2)} EUR`;
        return `  • ${sujeto}: ${caso.motivo}`;
      })
    );
  }

  return lineas.join("\n");
}

function formatearGastosHolded(
  resultado: ResultadoCruceCashflowGastosHolded,
  resolucionGlobal: ResolucionFilasSinEmpresa
): string {
  const atribuciones = resolucionGlobal.atribuciones.filter((item) => item.empresa === resultado.empresa);
  const ambiguosVisibles = resultado.ambiguos.filter(
    (caso) =>
      !caso.movimiento ||
      !resolucionGlobal.movimientosResueltos.has(`${caso.movimiento.empresa}:${caso.movimiento.id}`)
  );
  const lineas: string[] = [
    `\n${resultado.empresa} · gastos Holded — ${resultado.coincidencias.length + atribuciones.length} coincidencia(s) verificadas`,
    `Cobertura de documentos: ${resultado.desde} a ${resultado.hasta}.`,
  ];
  if (resultado.problemasCobertura.length > 0) {
    lineas.push("⛔ INFORME INCOMPLETO: no se emiten conclusiones de ausencia:");
    lineas.push(...resultado.problemasCobertura.map((problema) => `  • ${problema}`));
    return lineas.join("\n");
  }

  if (atribuciones.length > 0) {
    lineas.push(`🔎 ${atribuciones.length} fila(s) sin EMPRESA fueron atribuidas por un gasto inequívoco:`);
    lineas.push(
      ...atribuciones.map(
        ({ fila, movimiento }) =>
          `  • ${fila.descripcion} · ${fila.valorEur.toFixed(2)} EUR → ${resultado.empresa} · gasto ${movimiento.id}`
      )
    );
  }
  lineas.push(
    resultado.gastosHoldedSinCashflow.length === 0
      ? "✅ Gastos Holded → cashflow: no hay documentos EUR confirmados como ausentes."
      : `⚠️ Gastos Holded → cashflow: ${resultado.gastosHoldedSinCashflow.length} documento(s) EUR sin fila confirmada:`
  );
  lineas.push(
    ...resultado.gastosHoldedSinCashflow.map(
      (gasto) =>
        `  • ${gasto.fecha} · ${gasto.descripcion} · ${Math.abs(gasto.valorEur).toFixed(2)} EUR · id ${gasto.id}`
    )
  );
  lineas.push(
    resultado.filasSinGastoHolded.length === 0
      ? "✅ Cashflow → gastos Holded: no hay filas confirmadas como ausentes."
      : `⚠️ Cashflow → gastos Holded: ${resultado.filasSinGastoHolded.length} fila(s) sin documento EUR confirmado:`
  );
  lineas.push(
    ...resultado.filasSinGastoHolded.map(
      (fila) =>
        `  • ${fila.descripcion} · ${fila.valorEur.toFixed(2)} EUR · ${fila.categoria}${fila.fila ? ` · fila ${fila.fila}` : ""}`
    )
  );
  if (resultado.gastosNoComparables.length > 0) {
    lineas.push(
      `🟠 ${resultado.gastosNoComparables.length} gasto(s) no EUR/no numérico separados: no se fuerza una paridad falsa contra el cashflow EUR.`
    );
    lineas.push(
      ...resultado.gastosNoComparables.map(
        (gasto) => `  • ${gasto.fecha} · ${gasto.contactName} · ${gasto.total} ${gasto.moneda} · id ${gasto.id}`
      )
    );
  }
  if (ambiguosVisibles.length > 0) {
    lineas.push(`🟠 ${ambiguosVisibles.length} caso(s) ambiguo(s) entre cashflow y gastos Holded:`);
    lineas.push(
      ...ambiguosVisibles.map(
        (caso) =>
          `  • ${caso.movimiento?.descripcion ?? caso.fila?.descripcion ?? "sin identificar"}: ${caso.motivo}`
      )
    );
  }
  return lineas.join("\n");
}

/**
 * Informe contable bidireccional único. Centralizar ambos sentidos evita que
 * el modelo improvise cruces separados y llegue a conclusiones distintas con
 * fotografías diferentes de Sheets/Holded.
 */
export const compararCashflowHoldedTool: ToolDefinition = {
  name: "comparar_cashflow_holded",
  description:
    "Motor oficial y de solo lectura para comparar cashflow y Holded con un único mapa. Úsalo SIEMPRE " +
    "que pidan un informe, comparación o auditoría entre el cashflow y gastos/documentos o bancos de " +
    "Holded, en uno o ambos sentidos. Descubre las tablas por títulos y " +
    "encabezados aunque se muevan filas/columnas; cruza empresa, signo, importe convertido a EUR, " +
    "proveedor y ventana de fechas; asigna movimientos uno a uno, reconoce totales consolidados del " +
    "mismo proveedor y separa los ambiguos. Si falta estructura, empresa o cobertura, lo declara " +
    "incompleto y NO afirma que algo falta o está al día. Nunca armes el cruce manualmente combinando " +
    "consultar_cashflow_detalle con herramientas de movimientos de Holded.",
  input_schema: {
    type: "object",
    properties: {
      empresa: {
        type: "string",
        enum: ["WOBA", "EWORKS"],
        description: "Empresa a comparar. Si se omite, compara WOBA y EWORKS por separado.",
      },
      semana: {
        type: "string",
        description: "Semana concreta, por ejemplo S37. Tiene prioridad sobre periodo.",
      },
      periodo: {
        type: "string",
        enum: ["semana_actual", "semana_anterior"],
        description: "Semana actual (por defecto) o semana anterior completa.",
      },
      direccion: {
        type: "string",
        enum: ["ambas", "banco_a_cashflow", "cashflow_a_banco"],
        description: "Por defecto ambas. Permite limitar el informe al sentido pedido.",
      },
      fuente: {
        type: "string",
        enum: ["bancos", "gastos", "ambos"],
        description:
          "Qué parte de Holded comparar: movimientos bancarios, documentos de gasto (/purchases), o ambos. Por defecto ambos.",
      },
    },
  },
  seguraParaModoRapido: true,
  lecturaAcotable: true,
  handler: async (input) => {
    const empresa = input.empresa as EmpresaCashflowCruce | undefined;
    if (empresa && !EMPRESAS.includes(empresa)) return "Error: empresa debe ser WOBA o EWORKS.";
    const direccion = (input.direccion ?? "ambas") as Direccion;
    if (!["ambas", "banco_a_cashflow", "cashflow_a_banco"].includes(direccion)) {
      return "Error: dirección no válida.";
    }
    const fuente = (input.fuente ?? "ambos") as Fuente;
    if (!["bancos", "gastos", "ambos"].includes(fuente)) return "Error: fuente no válida.";
    const rango = rangoPedido(input);
    if ("error" in rango) return `Error: ${rango.error}`;

    const empresas = empresa ? [empresa] : EMPRESAS;
    const resultados =
      fuente === "gastos"
        ? []
        : await Promise.all(
            empresas.map((item) => generarCruceCashflowHolded(item, rango.semana, rango.desde, rango.hasta))
          );
    const resultadosGastos =
      fuente === "bancos"
        ? []
        : await Promise.all(
            empresas.map((item) => generarCruceCashflowGastosHolded(item, rango.semana, rango.desde, rango.hasta))
          );
    // Una fila sin EMPRESA solo puede atribuirse si se consultaron AMBAS
    // compañías: de otro modo una coincidencia "única" en WOBA podría tener
    // una gemela no consultada en EWORKS (o viceversa).
    const resolucionGlobal: ResolucionFilasSinEmpresa =
      resultados.length === EMPRESAS.length
        ? resolverFilasSinEmpresaGlobal(resultados)
        : {
            atribuciones: [],
            filasSinResolver: resultados[0]?.filasSinEmpresa ?? [],
            movimientosResueltos: new Set<string>(),
          };
    const resolucionGastos: ResolucionFilasSinEmpresa =
      resultadosGastos.length === EMPRESAS.length
        ? resolverFilasSinEmpresaGlobal(resultadosGastos)
        : {
            atribuciones: [],
            filasSinResolver: resultadosGastos[0]?.filasSinEmpresa ?? [],
            movimientosResueltos: new Set<string>(),
          };

    const incompleto = [...resultados, ...resultadosGastos].some(
      (resultado) => resultado.problemasCobertura.length > 0
    );
    const partes = [
      `${incompleto ? "⛔ INFORME INCOMPLETO" : "Informe verificado"} cashflow ↔ Holded — ${rango.etiqueta} (${rango.desde} a ${rango.hasta})`,
      ...resultados.map((resultado) => formatearEmpresa(resultado, direccion, resolucionGlobal)),
      ...resultadosGastos.map((resultado) => formatearGastosHolded(resultado, resolucionGastos)),
    ];

    const atribucionesPorFila = new Map<string, Set<EmpresaCashflowCruce>>();
    for (const atribucion of [...resolucionGlobal.atribuciones, ...resolucionGastos.atribuciones]) {
      const dueños = atribucionesPorFila.get(atribucion.fila.id) ?? new Set<EmpresaCashflowCruce>();
      dueños.add(atribucion.empresa);
      atribucionesPorFila.set(atribucion.fila.id, dueños);
    }
    const conflictos = [...atribucionesPorFila.entries()].filter(([, dueños]) => dueños.size > 1);
    const resueltasSinConflicto = new Set(
      [...atribucionesPorFila.entries()].filter(([, dueños]) => dueños.size === 1).map(([id]) => id)
    );
    const universoFilasSinEmpresa =
      resultados[0]?.filasSinEmpresa ?? resultadosGastos[0]?.filasSinEmpresa ?? [];
    const filasSinEmpresa = universoFilasSinEmpresa.filter((fila) => !resueltasSinConflicto.has(fila.id));

    if (conflictos.length > 0) {
      partes.push(
        "\n⛔ Conflictos de empresa entre gastos y bancos: no se atribuyeron estas filas:",
        ...conflictos.map(([id, dueños]) => `  • ${id}: ${[...dueños].join(" frente a ")}`)
      );
    }
    if (filasSinEmpresa.length > 0) {
      partes.push(
        "\n🟠 Filas sin EMPRESA: no se atribuyeron ni a WOBA ni a EWORKS y no se duplicaron en el informe:",
        ...filasSinEmpresa.map(
          (fila) =>
            `  • ${fila.descripcion} · ${Math.abs(fila.valorEur).toFixed(2)} EUR · ${fila.categoria}${fila.fila ? ` · fila ${fila.fila}` : ""}`
        )
      );
    }
    partes.push(
      "\nCriterio: empresa + sentido (ingreso/gasto) + importe EUR + proveedor + fechas; cada movimiento/documento se usa una sola vez. Los casos dudosos se muestran como ambiguos, no como faltantes."
    );
    return partes.join("\n");
  },
};
