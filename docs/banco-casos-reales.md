
## Guardarraíles automáticos (`core/guardarrailes/`)
- **`tragarErrores.test.ts` (ratchet):** falla si aparece un NUEVO «error tragado con valor por defecto» (`.catch(() => [])`, `catch { return undefined }`…) en los módulos que deciden con lecturas de Holded. La línea base (`lineaBase.json`, 41 sitios heredados) solo puede bajar. Caso real: con Holded en 502/503 se asumió «solo EUR».
- **`tecladoSinCallejones.test.ts`:** recorre todas las combinaciones de estado de una propuesta (sin cargo, cargo compatible, por confirmar, aprendido, contradictorio; con y sin gastos de Holded, correo y fecha) y exige (1) al menos una salida accionable y (2) que si hay un cargo utilizable y fecha válida exista «Crear» o «Crear y conciliar». Caso real: «encontré el cargo» sin ningún botón de crear.
