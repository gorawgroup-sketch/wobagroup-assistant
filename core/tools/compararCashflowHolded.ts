import {
  claveMovimientoGlobal,
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

/**
 * El filtro visible nunca recorta la investigación de filas históricas sin EMPRESA.
 * Son solo dos compañías, por lo que consultar ambas mantiene el costo acotado y evita
 * declarar un impago en WOBA cuando el cargo real está en EWORKS (o al revés).
 */
export function empresasBancariasAConsultar(
  _empresaVisible?: EmpresaCashflowCruce
): EmpresaCashflowCruce[] {
  return [...EMPRESAS];
}

type Direccion = "ambas" | "banco_a_cashflow" | "cashflow_a_banco";
type Fuente = "bancos" | "gastos" | "ambos";
type ResultadoAtribuible = Pick<
  ResultadoCruceCashflowHolded,
  "filasSinEmpresa" | "ambiguos" | "problemasCobertura"
>;

export function fuenteSolicitada(input: Record<string, unknown>): Fuente {
  if (input.fuente === "bancos" || input.fuente === "gastos" || input.fuente === "ambos") {
    return input.fuente;
  }
  // `direccion` describe específicamente el cruce con bancos. Si está presente y el llamador no
  // pidió documentos, traer también gastos de Holded añade ruido y puede contradecir el pedido.
  return input.direccion === "banco_a_cashflow" || input.direccion === "cashflow_a_banco"
    ? "bancos"
    : "ambos";
}

export function resolverFilasSinEmpresaConCobertura(
  resultados: ResultadoAtribuible[],
  cantidadEsperada = EMPRESAS.length
): ResolucionFilasSinEmpresa {
  if (
    resultados.length === cantidadEsperada &&
    resultados.every((resultado) => resultado.problemasCobertura.length === 0)
  ) {
    return resolverFilasSinEmpresaGlobal(resultados);
  }
  const filasPorId = new Map<string, ResultadoAtribuible["filasSinEmpresa"][number]>();
  for (const resultado of resultados) {
    for (const fila of resultado.filasSinEmpresa) filasPorId.set(fila.id, fila);
  }
  return {
    atribuciones: [],
    filasSinResolver: [...filasPorId.values()],
    filasAmbiguas: [],
    filasSinMovimiento: [],
    candidatosPorFila: [],
    movimientosResueltos: new Set<string>(),
  };
}

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

export function formatearEmpresa(
  resultado: ResultadoCruceCashflowHolded,
  direccion: Direccion,
  resolucionGlobal: ResolucionFilasSinEmpresa
): string {
  const atribuciones = resolucionGlobal.atribuciones.filter((item) => item.empresa === resultado.empresa);
  const ambiguosVisibles = resultado.ambiguos.filter(
    (caso) =>
      !caso.movimiento ||
      !resolucionGlobal.movimientosResueltos.has(claveMovimientoGlobal(caso.movimiento))
  );
  const movimientosSinCashflowVisibles = resultado.movimientosSinCashflow.filter(
    (movimiento) => !resolucionGlobal.movimientosResueltos.has(claveMovimientoGlobal(movimiento))
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
    if (movimientosSinCashflowVisibles.length === 0) {
      lineas.push("✅ Banco → cashflow: no hay movimientos confirmados como ausentes.");
    } else {
      lineas.push(`⚠️ Banco → cashflow: ${movimientosSinCashflowVisibles.length} movimiento(s) sin fila confirmada:`);
      lineas.push(
        ...movimientosSinCashflowVisibles.map(
          (movimiento) =>
            `  • ${movimiento.fecha} · ${movimiento.descripcion} · ${Math.abs(movimiento.valorEur).toFixed(2)} EUR · ${movimiento.cuenta} (${movimiento.moneda}) · id ${movimiento.id}`
        )
      );
    }
  }

  if (direccion !== "banco_a_cashflow") {
    const gastosSinMovimiento = resultado.filasSinMovimiento.filter((fila) => fila.tipo === "gasto");
    if (gastosSinMovimiento.length === 0) {
      lineas.push(
        `✅ Cashflow → banco (filas etiquetadas ${resultado.empresa}): no hay gastos confirmados como ausentes.`
      );
    } else {
      lineas.push(
        `⚠️ Cashflow → banco (filas etiquetadas ${resultado.empresa}): ${gastosSinMovimiento.length} gasto(s) sin salida bancaria confirmada:`
      );
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

export function formatearGastosHolded(
  resultado: ResultadoCruceCashflowGastosHolded,
  resolucionGlobal: ResolucionFilasSinEmpresa,
  direccion: Direccion
): string {
  const atribuciones = resolucionGlobal.atribuciones.filter((item) => item.empresa === resultado.empresa);
  const ambiguosVisibles = resultado.ambiguos.filter(
    (caso) =>
      !caso.movimiento ||
      !resolucionGlobal.movimientosResueltos.has(claveMovimientoGlobal(caso.movimiento))
  );
  const gastosSinCashflowVisibles = resultado.gastosHoldedSinCashflow.filter(
    (movimiento) => !resolucionGlobal.movimientosResueltos.has(claveMovimientoGlobal(movimiento))
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
  if (direccion !== "cashflow_a_banco") {
    lineas.push(
      gastosSinCashflowVisibles.length === 0
        ? "✅ Gastos Holded → cashflow: no hay documentos EUR confirmados como ausentes."
        : `⚠️ Gastos Holded → cashflow: ${gastosSinCashflowVisibles.length} documento(s) EUR sin fila confirmada:`
    );
    lineas.push(
      ...gastosSinCashflowVisibles.map(
        (gasto) =>
          `  • ${gasto.fecha} · ${gasto.descripcion} · ${Math.abs(gasto.valorEur).toFixed(2)} EUR · id ${gasto.id}`
      )
    );
  }
  if (direccion !== "banco_a_cashflow") {
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
  }
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
    if (input.fuente !== undefined && !["bancos", "gastos", "ambos"].includes(String(input.fuente))) {
      return "Error: fuente no válida.";
    }
    const fuente = fuenteSolicitada(input);
    const rango = rangoPedido(input);
    if ("error" in rango) return `Error: ${rango.error}`;

    const empresasMostradas = empresa ? [empresa] : EMPRESAS;
    // Las filas etiquetadas siguen respetando su empresa. Las filas sin EMPRESA se resuelven
    // globalmente y por eso la fotografía de investigación siempre incluye WOBA y EWORKS.
    const empresasInvestigadas = empresasBancariasAConsultar(empresa);
    const resultados =
      fuente === "gastos"
        ? []
        : await Promise.all(
            empresasInvestigadas.map((item) =>
              generarCruceCashflowHolded(
                item,
                rango.semana,
                rango.desde,
                rango.hasta,
                new Date(),
                {},
                { confirmarAusencias: direccion !== "banco_a_cashflow" }
              )
            )
          );
    const resultadosGastos =
      fuente === "bancos"
        ? []
        : await Promise.all(
            empresasInvestigadas.map((item) => generarCruceCashflowGastosHolded(item, rango.semana, rango.desde, rango.hasta))
          );
    const resultadosVisibles = resultados.filter((resultado) =>
      empresasMostradas.includes(resultado.empresa)
    );
    const resultadosGastosVisibles = resultadosGastos.filter((resultado) =>
      empresasMostradas.includes(resultado.empresa)
    );
    // Una fila sin EMPRESA solo puede atribuirse si se consultaron AMBAS
    // compañías: de otro modo una coincidencia "única" en WOBA podría tener
    // una gemela no consultada en EWORKS (o viceversa).
    const resolucionGlobal = resolverFilasSinEmpresaConCobertura(resultados);
    const resolucionGastos = resolverFilasSinEmpresaConCobertura(resultadosGastos);

    const atribucionesPorFila = new Map<string, Set<EmpresaCashflowCruce>>();
    for (const atribucion of [...resolucionGlobal.atribuciones, ...resolucionGastos.atribuciones]) {
      const dueños = atribucionesPorFila.get(atribucion.fila.id) ?? new Set<EmpresaCashflowCruce>();
      dueños.add(atribucion.empresa);
      atribucionesPorFila.set(atribucion.fila.id, dueños);
    }
    const conflictos = [...atribucionesPorFila.entries()].filter(([, dueños]) => dueños.size > 1);
    const idsConflictivos = new Set(conflictos.map(([id]) => id));
    const sinAtribucionesConflictivas = (
      resolucion: ResolucionFilasSinEmpresa
    ): ResolucionFilasSinEmpresa => {
      const atribuciones = resolucion.atribuciones.filter(
        (atribucion) => !idsConflictivos.has(atribucion.fila.id)
      );
      return {
        atribuciones,
        filasSinResolver: resolucion.filasSinResolver,
        filasAmbiguas: resolucion.filasAmbiguas,
        filasSinMovimiento: resolucion.filasSinMovimiento,
        candidatosPorFila: resolucion.candidatosPorFila,
        movimientosResueltos: new Set(
          atribuciones.map(({ movimiento }) => claveMovimientoGlobal(movimiento))
        ),
      };
    };
    const resolucionGlobalSegura = sinAtribucionesConflictivas(resolucionGlobal);
    const resolucionGastosSegura = sinAtribucionesConflictivas(resolucionGastos);
    const incompleto = [...resultados, ...resultadosGastos].some(
      (resultado) => resultado.problemasCobertura.length > 0
    );
    // Solo después de retirar atribuciones contradictorias se construye el texto. Así una fila nunca
    // aparece primero como atribuida y después como conflicto en la misma respuesta.
    const partes = [
      `${incompleto ? "⛔ INFORME INCOMPLETO" : "Informe verificado"} cashflow ↔ Holded — ${rango.etiqueta} (${rango.desde} a ${rango.hasta})`,
      ...resultadosVisibles.map((resultado) => formatearEmpresa(resultado, direccion, resolucionGlobalSegura)),
      ...resultadosGastosVisibles.map((resultado) =>
        formatearGastosHolded(resultado, resolucionGastosSegura, direccion)
      ),
    ];

    if (conflictos.length > 0) {
      partes.push(
        "\n⛔ Conflictos de empresa entre gastos y bancos: no se atribuyeron estas filas:",
        ...conflictos.map(([id, dueños]) => `  • ${id}: ${[...dueños].join(" frente a ")}`)
      );
    }

    const atribucionesBancariasOcultas = resolucionGlobalSegura.atribuciones.filter(
      (atribucion) => !empresasMostradas.includes(atribucion.empresa)
    );
    if (atribucionesBancariasOcultas.length > 0) {
      partes.push(
        "\n🔎 Búsqueda global de filas sin EMPRESA: se encontraron fuera del filtro visible:",
        ...atribucionesBancariasOcultas.map(
          ({ fila, movimiento, empresa: empresaEncontrada }) =>
            `  • ${fila.descripcion} · ${Math.abs(fila.valorEur).toFixed(2)} EUR → ${empresaEncontrada}/${movimiento.cuenta} · ${movimiento.fecha} · ${movimiento.descripcion} · id ${movimiento.id}`
        )
      );
    }

    if (fuente !== "gastos" && direccion !== "banco_a_cashflow") {
      if (resolucionGlobalSegura.filasAmbiguas.length > 0) {
        partes.push(
          "\n🟠 Filas sin EMPRESA con candidatos bancarios: requieren validación; no se consideran ejecutadas ni pendientes todavía:",
          ...resolucionGlobalSegura.filasAmbiguas.map((fila) => {
            const candidatos = resolucionGlobalSegura.candidatosPorFila.find(
              (item) => item.fila.id === fila.id
            )?.movimientos ?? [];
            const detalle = candidatos
              .map(
                (movimiento) =>
                  `${movimiento.empresa}/${movimiento.cuenta} · ${movimiento.fecha} · ${movimiento.descripcion} · ${Math.abs(movimiento.valorEur).toFixed(2)} EUR · id ${movimiento.id}`
              )
              .join(" | ");
            return `  • ${fila.descripcion} · ${Math.abs(fila.valorEur).toFixed(2)} EUR${detalle ? ` → ${detalle}` : ""}`;
          })
        );
      }
      if (resolucionGlobalSegura.filasSinMovimiento.length > 0) {
        partes.push(
          "\n🔴 Sin salida bancaria en WOBA ni EWORKS al momento del corte (dos lecturas completas): operacionalmente, estos gastos aún no se han ejecutado:",
          ...resolucionGlobalSegura.filasSinMovimiento.map(
            (fila) =>
              `  • ${fila.descripcion} · ${Math.abs(fila.valorEur).toFixed(2)} EUR · ${fila.categoria}${fila.fila ? ` · fila ${fila.fila}` : ""}`
          )
        );
      }
      const bancosCompletos =
        resultados.length === EMPRESAS.length &&
        resultados.every((resultado) => resultado.problemasCobertura.length === 0);
      if (!bancosCompletos && resolucionGlobalSegura.filasSinResolver.length > 0) {
        partes.push(
          "\n⛔ Filas sin EMPRESA y sin conclusión bancaria: la cobertura de ambas compañías no fue completa; no se las declara ejecutadas ni pendientes:",
          ...resolucionGlobalSegura.filasSinResolver.map(
            (fila) => `  • ${fila.descripcion} · ${Math.abs(fila.valorEur).toFixed(2)} EUR`
          )
        );
      }
    }

    if (fuente !== "bancos" && resolucionGastosSegura.filasSinResolver.length > 0) {
      partes.push(
        "\n🟠 Filas sin EMPRESA aún no resueltas contra documentos de gasto (esto no determina si el dinero salió del banco):",
        ...resolucionGastosSegura.filasSinResolver.map(
          (fila) => `  • ${fila.descripcion} · ${Math.abs(fila.valorEur).toFixed(2)} EUR`
        )
      );
    }
    partes.push(
      "\nCriterio: la EMPRESA se usa cuando está informada; si falta, se busca globalmente en WOBA y EWORKS por sentido, importe EUR exacto o cercano, proveedor/categoría y fechas. Cada movimiento/documento se usa una sola vez.",
      "REGLA DE RESPUESTA: reproduce estas categorías sin reinterpretarlas. Solo llama no ejecutado a 'Sin salida bancaria' tras cobertura completa de ambas empresas y doble lectura; nunca a un caso ambiguo o informe incompleto."
    );
    return partes.join("\n");
  },
};
