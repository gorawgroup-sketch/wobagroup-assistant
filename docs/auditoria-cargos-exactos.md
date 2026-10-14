# Auditoría de cargos exactos no ofrecidos

Pedida por Carlos tras el caso «Bk» −20,15 € (12-10-2026). Código: `core/holded/auditoriaCargosExactos.ts` (lógica pura), `core/jobs/auditoriaCargosExactos.ts` (lecturas reales y aviso), `core/jobs/auditoriaCargosExactosStore.ts` (pestaña oculta `_auditoria_cargos_exactos`).

**Qué hace.** Cada laborable a las 8:45 busca compras propias (45 días, con importe pendiente de pago) para las que existe en el banco UN cargo libre de su mismo importe exacto, y pregunta al mismo buscador del chat (`buscarMovimientoSimilar`, con traza) qué haría con él. Avisa por Telegram, sin botones y una sola vez por pareja, de tres casos:

- `no_ofrecido`: el buscador lo vio y lo descartó por nombre/fecha (no por categoría contradictoria, ni por estar ya conciliado, ni por ser un ingreso: esos descartes son correctos).
- `fuera_de_ventana`: el cargo es posterior en más de 5 días al gasto (el buscador solo mira 5 días hacia delante). Una factura se paga semanas después; solo para importes ≥ 50 y hasta 30 días (caso real KMINO: 2.372,42 USD el 28-09, cargo el 08-10).
- `ofrecido_sin_conciliar`: sí se ofrecería pero nadie lo ha conciliado.

**Qué no hace.** No concilia, no escribe en Holded, no crea nada. Solo parejas únicas por ambos lados (un cargo ↔ una compra); las ambiguas se cuentan y se ignoran. Compras de menos de 2 días no se auditan (el cargo puede no haber llegado).

**A demanda.** `POST /admin/auditoria-cargos-exactos` (cabecera `x-admin-secret`): simula por defecto; con `{"simular": false}` avisa y marca.

**Coste.** Sin IA. Unas 400 lecturas de compras por id y la lectura de movimientos de todas las cuentas de las 3 empresas por pasada.
