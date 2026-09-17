import test from "node:test";
import assert from "node:assert/strict";
import {
  cruzarListasUnoAUno,
  generarCruceCashflowHolded,
  parsearImporteCashflow,
  resolverFilasSinEmpresaGlobal,
  type FilaCashflowCruce,
  type MovimientoHoldedCruce,
  type ResultadoCruceCashflowHolded,
} from "./cruceHoldedCashflow";

function fila(id: string, descripcion: string, valorEur: number, tipo: "ingreso" | "gasto" = "gasto"): FilaCashflowCruce {
  return { id, empresa: "WOBA", categoria: tipo === "ingreso" ? "INGRESOS" : "PAGOS_EXTRAS", descripcion, semana: "S37", valorEur, tipo };
}

function movimiento(
  id: string,
  descripcion: string,
  valorEur: number,
  opciones: Partial<MovimientoHoldedCruce> = {}
): MovimientoHoldedCruce {
  return {
    id,
    empresa: "WOBA",
    accountId: "main",
    cuenta: "Main",
    descripcion,
    fecha: "2026-09-10",
    valorEur,
    valorNativo: valorEur,
    moneda: "EUR",
    enPeriodo: true,
    toleranciaEur: 0.01,
    ...opciones,
  };
}

function resultado(
  empresa: "WOBA" | "EWORKS",
  filasSinEmpresa: FilaCashflowCruce[],
  movimientos: MovimientoHoldedCruce[]
): ResultadoCruceCashflowHolded {
  return {
    empresa,
    semana: "S37",
    desde: "2026-09-07",
    hasta: "2026-09-13",
    desdeBancos: "2026-09-05",
    hastaBancos: "2026-09-16",
    coincidencias: [],
    filasSinMovimiento: [],
    movimientosSinCashflow: [],
    filasSinEmpresa,
    problemasCobertura: [],
    ambiguos: movimientos.map((item) => ({
      movimiento: item,
      alternativas: filasSinEmpresa.map((fila) => fila.id),
      motivo: "El importe puede corresponder a una fila del cashflow que no tiene EMPRESA",
    })),
  };
}

test("normaliza importes europeos y anglosajones sin cambiar su valor", () => {
  assert.equal(parsearImporteCashflow("€6,892.73"), 6892.73);
  assert.equal(parsearImporteCashflow("6.892,73 €"), 6892.73);
  assert.equal(parsearImporteCashflow("(1.234,56 €)"), -1234.56);
});

test("asigna uno a uno por proveedor cuando hay dos cargos del mismo importe", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Ovidio Playa", 29.5), fila("f2", "Obm Usera", 29.5)],
    [movimiento("m1", "OBM USERA", -29.5), movimiento("m2", "OVIDIO PLAYA", -29.5)]
  );

  assert.equal(resultado.coincidencias.length, 2);
  assert.deepEqual(
    new Set(resultado.coincidencias.map((c) => `${c.fila.id}:${c.movimiento.id}`)),
    new Set(["f1:m2", "f2:m1"])
  );
  assert.equal(resultado.ambiguos.length, 0);
});

test("un solo movimiento nunca cubre dos filas iguales", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Uber", 3), fila("f2", "Uber", 3)],
    [movimiento("m1", "Uber", -3)]
  );

  assert.equal(resultado.coincidencias.length, 0);
  assert.equal(resultado.filasSinMovimiento.length, 0);
  assert.equal(resultado.ambiguos.filter((a) => a.fila).length, 2);
  assert.equal(resultado.ambiguos.length, 2, "no duplica además la misma duda desde el movimiento");
});

test("una palabra genérica no confirma una coincidencia contable", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Hotel", 106.92)],
    [movimiento("m1", "HOTEL CENTRAL", -106.92)]
  );

  assert.equal(resultado.coincidencias.length, 0);
  assert.equal(resultado.filasSinMovimiento.length, 0);
  assert.equal(resultado.ambiguos.length, 1);
});

test("el mismo id de Holded en cuentas distintas no colisiona", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Iberdrola", 50), fila("f2", "Anthropic", 50)],
    [
      movimiento("repetido", "IBERDROLA", -50, { accountId: "main" }),
      movimiento("repetido", "ANTHROPIC", -50, { accountId: "usd" }),
    ]
  );

  assert.equal(resultado.coincidencias.length, 2);
  assert.equal(resultado.ambiguos.length, 0);
});

test("un abono no respalda un gasto aunque el importe sea idéntico", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Proveedor", 100, "gasto")],
    [movimiento("m1", "Proveedor", 100)]
  );

  assert.equal(resultado.coincidencias.length, 0);
  assert.equal(resultado.filasSinMovimiento.length, 1);
  assert.equal(resultado.movimientosSinCashflow.length, 1);
});

test("un cargo del margen posterior puede respaldar la fila sin convertirse en otro faltante", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "RAMINATRANS", 2844.86)],
    [movimiento("m1", "RAMINATRANS S.L.", -2844.86, { fecha: "2026-09-14", enPeriodo: false })]
  );

  assert.equal(resultado.coincidencias.length, 1);
  assert.equal(resultado.filasSinMovimiento.length, 0);
  assert.equal(resultado.movimientosSinCashflow.length, 0);
});

test("un importe único con proveedor distinto queda ambiguo y nunca se confirma por monto solamente", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Cuota servicio septiembre", 10.89)],
    [movimiento("m1", "DD 482991", -10.89)]
  );

  assert.equal(resultado.coincidencias.length, 0);
  assert.equal(resultado.filasSinMovimiento.length, 0);
  assert.equal(resultado.ambiguos.filter((caso) => caso.fila?.id === "f1").length, 1);
});

test("reconoce un total consolidado solo cuando agrupa el mismo proveedor", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Amazon compras semana", 30)],
    [movimiento("m1", "WWW AMAZON", -10), movimiento("m2", "WWW AMAZON", -20)]
  );

  assert.equal(resultado.coincidencias.length, 1);
  assert.equal(resultado.coincidencias[0].criterio, "proveedor_total_agrupado");
  assert.deepEqual(resultado.coincidencias[0].movimientos.map((m) => m.id), ["m1", "m2"]);
  assert.equal(resultado.filasSinMovimiento.length, 0);
  assert.equal(resultado.movimientosSinCashflow.length, 0);
});

test("no suma proveedores diferentes para fabricar una coincidencia", () => {
  const resultado = cruzarListasUnoAUno(
    [fila("f1", "Compra consolidada", 30)],
    [movimiento("m1", "Proveedor A", -10), movimiento("m2", "Proveedor B", -20)]
  );

  assert.equal(resultado.coincidencias.length, 0);
  assert.equal(resultado.filasSinMovimiento.length, 1);
  assert.equal(resultado.movimientosSinCashflow.length, 2);
});

test("atribuye una fila sin empresa solo si el banco demuestra un dueño global único", () => {
  const sinEmpresa = { ...fila("f1", "Iberdrola", 264.46), empresa: undefined };
  const movimientoWoba = movimiento("m1", "IBERDROLA CLIENTES", -264.46);
  const resolucion = resolverFilasSinEmpresaGlobal([
    resultado("WOBA", [sinEmpresa], [movimientoWoba]),
    resultado("EWORKS", [sinEmpresa], []),
  ]);

  assert.equal(resolucion.atribuciones.length, 1);
  assert.equal(resolucion.atribuciones[0].empresa, "WOBA");
  assert.equal(resolucion.filasSinResolver.length, 0);
});

test("no atribuye una fila sin empresa si ambas compañías tienen un cargo compatible", () => {
  const sinEmpresa = { ...fila("f1", "Uber", 8.95), empresa: undefined };
  const movimientoWoba = movimiento("m1", "Uber Pending", -8.95);
  const movimientoEworks = movimiento("m2", "Uber Pending", -8.95, { empresa: "EWORKS", accountId: "ew" });
  const resolucion = resolverFilasSinEmpresaGlobal([
    resultado("WOBA", [sinEmpresa], [movimientoWoba]),
    resultado("EWORKS", [sinEmpresa], [movimientoEworks]),
  ]);

  assert.equal(resolucion.atribuciones.length, 0);
  assert.equal(resolucion.filasSinResolver.length, 1);
});

test("no atribuye una fila sin empresa por importe único si el proveedor no coincide", () => {
  const sinEmpresa = { ...fila("f1", "Holded Woba", 10.89), empresa: undefined };
  const movimientoWoba = movimiento("m1", "DD 482991", -10.89);
  const resolucion = resolverFilasSinEmpresaGlobal([
    resultado("WOBA", [sinEmpresa], [movimientoWoba]),
    resultado("EWORKS", [sinEmpresa], []),
  ]);

  assert.equal(resolucion.atribuciones.length, 0);
  assert.equal(resolucion.filasSinResolver.length, 1);
});

test("una segunda lectura recupera un movimiento omitido y evita un falso impago", async () => {
  let lecturas = 0;
  const resultado = await generarCruceCashflowHolded(
    "WOBA",
    "S37",
    "2026-09-07",
    "2026-09-13",
    new Date("2026-09-17T12:00:00Z"),
    {
      fetchDetalleRegistros: async () => [
        {
          categoria: "PAGOS_PROYECTOS",
          fila: 12,
          cliente: "RAMINATRANS",
          semana: "S37",
          valor: "2.844,86 €",
          empresa: "WOBA",
        },
      ],
      obtenerUltimaVerificacionEstructura: () => [],
      listTreasuryAccounts: async () => [{ id: "main", name: "Main", currency: "EUR" }],
      listBankMovements: async () => {
        lecturas += 1;
        return lecturas === 1
          ? []
          : [{ id: "mov-1", booking_date: "2026-09-14", description: "RAMINATRANS S.L.", amount: -2844.86, currency: "EUR" }];
      },
    }
  );

  assert.equal(lecturas, 2);
  assert.equal(resultado.filasSinMovimiento.length, 0);
  assert.equal(resultado.coincidencias.length, 1);
  assert.equal(resultado.problemasCobertura.length, 0);
});

test("consulta cuentas archivadas al auditar una semana histórica", async () => {
  let cuentaConsultada = "";
  const resultado = await generarCruceCashflowHolded(
    "WOBA",
    "S37",
    "2026-09-07",
    "2026-09-13",
    new Date("2026-09-17T12:00:00Z"),
    {
      fetchDetalleRegistros: async () => [
        {
          categoria: "PAGOS_EXTRAS",
          fila: 8,
          cliente: "Proveedor histórico",
          semana: "S37",
          valor: "90.00",
          empresa: "WOBA",
        },
      ],
      obtenerUltimaVerificacionEstructura: () => [],
      listTreasuryAccounts: async () => [
        { id: "archivada", name: "Cuenta antigua", currency: "EUR", archived: true },
      ],
      listBankMovements: async (_empresa, accountId) => {
        cuentaConsultada = accountId;
        return [{ id: "mov-arch", booking_date: "2026-09-10", description: "PROVEEDOR HISTORICO", amount: -90, currency: "EUR" }];
      },
    }
  );

  assert.equal(cuentaConsultada, "archivada");
  assert.equal(resultado.filasSinMovimiento.length, 0);
  assert.equal(resultado.coincidencias.length, 1);
});

test("sin cuentas de tesorería falla cerrado y no autoriza conclusiones de ausencia", async () => {
  const resultado = await generarCruceCashflowHolded(
    "WOBA",
    "S37",
    "2026-09-07",
    "2026-09-13",
    new Date("2026-09-17T12:00:00Z"),
    {
      fetchDetalleRegistros: async () => [
        {
          categoria: "PAGOS_EXTRAS",
          fila: 8,
          cliente: "Proveedor",
          semana: "S37",
          valor: "90.00",
          empresa: "WOBA",
        },
      ],
      obtenerUltimaVerificacionEstructura: () => [],
      listTreasuryAccounts: async () => [],
      listBankMovements: async () => assert.fail("no debe consultar una cuenta inexistente"),
    }
  );

  assert.match(resultado.problemasCobertura.join("\n"), /ninguna cuenta de tesorería/i);
});

test("una divisa extranjera sin importe contable EUR deja el informe incompleto", async () => {
  const resultado = await generarCruceCashflowHolded(
    "WOBA",
    "S37",
    "2026-09-07",
    "2026-09-13",
    new Date("2026-09-17T12:00:00Z"),
    {
      fetchDetalleRegistros: async () => [
        { categoria: "PAGOS_EXTRAS", fila: 8, cliente: "Anthropic", semana: "S37", valor: "90", empresa: "WOBA" },
      ],
      obtenerUltimaVerificacionEstructura: () => [],
      listTreasuryAccounts: async () => [{ id: "usd", name: "USD", currency: "USD" }],
      listBankMovements: async () => [
        { id: "mov-usd", booking_date: "2026-09-10", description: "ANTHROPIC", amount: -90, currency: "USD" },
      ],
    }
  );

  assert.match(resultado.problemasCobertura.join("\n"), /divisa extranjera/i);
  assert.equal(resultado.coincidencias.length, 0);
});

test("la huella estable no duplica movimientos sin id si cambia el orden entre lecturas", async () => {
  let lecturas = 0;
  const proveedor = { booking_date: "2026-09-10", description: "PROVEEDOR", amount: -10, currency: "EUR" };
  const otro = { booking_date: "2026-09-10", description: "OTRO", amount: -99, currency: "EUR" };
  const resultado = await generarCruceCashflowHolded(
    "WOBA",
    "S37",
    "2026-09-07",
    "2026-09-13",
    new Date("2026-09-17T12:00:00Z"),
    {
      fetchDetalleRegistros: async () => [
        { categoria: "PAGOS_EXTRAS", fila: 8, cliente: "Proveedor", semana: "S37", valor: "20", empresa: "WOBA" },
      ],
      obtenerUltimaVerificacionEstructura: () => [],
      listTreasuryAccounts: async () => [{ id: "main", name: "Main", currency: "EUR" }],
      listBankMovements: async () => {
        lecturas += 1;
        return lecturas === 1 ? [proveedor, otro] : [otro, proveedor];
      },
    }
  );

  assert.equal(lecturas, 2);
  assert.equal(resultado.coincidencias.length, 0, "no fabrica un total 10+10 usando dos snapshots");
  assert.equal(resultado.filasSinMovimiento.length, 1);
});

test("banco a cashflow evita la segunda lectura que solo confirma ausencias inversas", async () => {
  let lecturas = 0;
  const resultado = await generarCruceCashflowHolded(
    "WOBA",
    "S37",
    "2026-09-07",
    "2026-09-13",
    new Date("2026-09-17T12:00:00Z"),
    {
      fetchDetalleRegistros: async () => [
        { categoria: "PAGOS_EXTRAS", fila: 8, cliente: "Proveedor", semana: "S37", valor: "90", empresa: "WOBA" },
      ],
      obtenerUltimaVerificacionEstructura: () => [],
      listTreasuryAccounts: async () => [{ id: "main", name: "Main", currency: "EUR" }],
      listBankMovements: async () => {
        lecturas += 1;
        return [];
      },
    },
    { confirmarAusencias: false }
  );

  assert.equal(lecturas, 1);
  assert.equal(resultado.filasSinMovimiento.length, 1);
});

test("un fallo de una cuenta se devuelve como cobertura incompleta y no lanza", async () => {
  const resultado = await generarCruceCashflowHolded(
    "WOBA",
    "S37",
    "2026-09-07",
    "2026-09-13",
    new Date("2026-09-17T12:00:00Z"),
    {
      fetchDetalleRegistros: async () => [],
      obtenerUltimaVerificacionEstructura: () => [],
      listTreasuryAccounts: async () => [{ id: "main", name: "Main", currency: "EUR" }],
      listBankMovements: async () => {
        throw new Error("timeout simulado");
      },
    }
  );

  assert.match(resultado.problemasCobertura.join("\n"), /timeout simulado/i);
});
