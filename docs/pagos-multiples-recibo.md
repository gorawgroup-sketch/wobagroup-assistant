# Recibos cobrados en varios pagos (fase 1: observación)

**Caso real (Footprint, 28/09/2026):** recibo de Uber por 8,95 USD cobrado con la misma tarjeta en dos pagos, 6,91 y 2,04, el mismo día.
WOBI proponía conciliar con «Uber Pending» de 9,95 USD del 25/09: un cargo distinto y anterior al viaje.

## Qué hace ahora
1. El lector del recibo guarda `pagos` (importe y fecha de cada cobro de la sección *Payments*) cuando son varios; si no suman el total, se ignoran.
2. Cada pago se busca como su **propio movimiento** del banco: sin conciliar, de salida, misma moneda, importe exacto y fecha a ±2 días del pago; cada movimiento se usa una vez.
3. La propuesta del gasto muestra los cargos encontrados (o los que faltan) como evidencia.
4. **No concilia nada.** Conciliar un gasto con varios movimientos aún no está activado (fase 2).

## Guardia general
Un movimiento fechado **antes del gasto** (1 día de holgura) nunca se propone como coincidencia aproximada, tenga o no pagos múltiples.

## Fase 2 (pendiente de autorización escrita de Carlos)
Conciliar el gasto con los N movimientos con botón de superadministrador. Reutilizar `core/holded/conciliacionMultiple/` (rama
`codex/holded-proyectos`, hoy solo EUR y compra ya creada): extenderlo a USD con las cautelas de las conciliaciones multimoneda
(`docs/banco-casos-reales.md`) y a «crear y conciliar».

Código: `core/holded/pagosMultiples/pagos.ts` (pruebas con el caso real en `pagos.test.ts`).
