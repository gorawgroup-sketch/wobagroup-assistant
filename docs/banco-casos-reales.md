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

## Pendiente de decisión del propietario
Política de gastos sin cargo bancario (hoy, desde #204, una propuesta de ticket no ofrece crear sin un cargo compatible; antes sí). El caso correspondiente se añade cuando se decida.

## Guardarraíles automáticos (`core/guardarrailes/`)
- **`tragarErrores.test.ts` (ratchet):** falla si aparece un NUEVO «error tragado con valor por defecto» (`.catch(() => [])`, `catch { return undefined }`…) en los módulos que deciden con lecturas de Holded. La línea base (`lineaBase.json`, 41 sitios heredados) solo puede bajar. Caso real: con Holded en 502/503 se asumió «solo EUR».
- **`tecladoSinCallejones.test.ts`:** recorre todas las combinaciones de estado de una propuesta (sin cargo, cargo compatible, por confirmar, aprendido, contradictorio; con y sin gastos de Holded, correo y fecha) y exige (1) al menos una salida accionable y (2) que si hay un cargo utilizable y fecha válida exista «Crear» o «Crear y conciliar». Caso real: «encontré el cargo» sin ningún botón de crear.
