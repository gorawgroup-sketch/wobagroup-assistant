# Banco de casos reales (Fase 0)

**Regla:** cada incidente real de emparejamiento, moneda o conciliación se añade aquí **antes** de arreglarlo. Así una corrección no se puede deshacer sin que falle un caso, y el sistema no repite el mismo error con otro nombre.

## Qué es
`core/casosReales/casos/*.json`: un fichero por incidente, con lo que Holded devolvía (cuentas y movimientos tal como estaban), lo que decía el ticket y la decisión correcta. `core/casosReales/banco.test.ts` los ejecuta con el **código real** (búsqueda de cargos y teclado de botones) contra un Holded simulado que no permite escrituras: cualquier POST/PUT hace fallar el caso.

## Cómo añadir un caso
1. Copia el caso más parecido de `casos/` y cambia `id`, `fuente` (incidente y fecha), `descripcion`.
2. Rellena `ticket` (proveedor, concepto, monto, moneda, fecha), `cuentas` y `movimientos` con los datos reales de Holded del día del fallo.
3. `esperado`: qué candidatos se ofrecen al armar la propuesta (`candidatos`, con su marca `por_confirmar`/`aprendido`/`null`), qué vería la conciliación automática (`vistoPorConciliacionAutomatica`, nunca por_confirmar ni aprendido) y los botones que deben (`botonesIncluyen`) o no deben (`botonesExcluyen`) aparecer.
4. Ejecuta `npx tsx --test core/casosReales/banco.test.ts`: el caso debe **fallar** con el código actual, se arregla y pasa.

Tipos: `busqueda_cargo` (búsqueda de cargo + teclado) y `monedas_cuentas` (lectura de las monedas de cuenta con Holded caído). Nuevos tipos (creación, conciliación con conversión, correo automático) se añaden en `banco.ts` cuando aparezca el primer incidente.

## Riesgos conocidos
Un caso con `riesgoConocido` documenta un comportamiento actual que no es el deseado (p. ej. `sixt-go-riesgo-conocido`: la compatibilidad solo por categoría puede enlazar dos comercios distintos con el mismo importe y día). Si el comportamiento cambia, el caso falla y hay que decidirlo a propósito.

## Decisiones del propietario registradas
- **2026-09-28 — «Crear (sin conciliar)» restaurado.** Desde #204 (27/09) una propuesta de ticket no ofrecía crear sin un cargo compatible; antes sí (6 de 15 compras creadas por Wobi en septiembre no tenían pago). Ahora «Crear (sin conciliar)» solo exige fecha documental válida y la comprobación de duplicados al aprobar; «Crear y conciliar» sigue exigiendo un cargo utilizable y las categorías contradictorias siguen impidiendo conciliar. Caso: `sin-cargo-se-puede-crear-sin-conciliar`.
