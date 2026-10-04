# Clasificación contable con evidencia del proveedor y del servicio

## Caso Anthropic, WOBA, compra 2618-1534

Lectura de Holded realizada el 17 de septiembre de 2026, sin modificar documentos:

- Compra examinada: `6aac3bbfd41aa2ed9d00ef77`, fecha 15/09/2026, 17,34 EUR, compra de créditos Anthropic. Cuenta actual: **Gastos de Viaje — 62900001**, ID `65a7f2ccc8dd45cda100d2ff`.
- Historial completo del contacto `6a63329b02e47ae65406237e`: cinco documentos. Se consultó el catálogo real de 37 cuentas de WOBA.
- Precedentes del servicio: `FCBI6EZ40001`, del 23/07/2026, y `FCBI6EZ4-0002`, del 23/08/2026; ambos “Anthropic* Claude Sub”, 18,00 EUR, en **Otros servicios — 62900000**, ID `612907d5df8f4b3f101b5e75`.
- Los otros dos apuntes de Anthropic, 0,02 EUR y 0,03 EUR, están en Diferencias negativas de cambio. No son precedentes comparables para comprar créditos del servicio.

La nueva función aplicada a esas lecturas devuelve **Otros servicios**, con ambos documentos como evidencia. La compra investigada se excluye de la inferencia para que no se justifique a sí misma. Esta conclusión está respaldada por el uso real en WOBA; no se inventó un número de cuenta a partir del nombre comercial.

La compra real sigue sin modificar. La corrección concreta a revisar es cambiar exclusivamente la cuenta de su línea de `65a7f2ccc8dd45cda100d2ff` a `612907d5df8f4b3f101b5e75`, conservando importes, moneda, impuestos, fechas, proveedor, comprobante y pagos. La herramienta de revisión añadida es de lectura; no ejecuta esa reclasificación.

## Cambios de comportamiento

`evaluarCuentaGasto` consulta el [catálogo de cuentas de gasto](https://www.holded.com/developers/api-reference/expenses-accounts/list-all-expenses-accounts) y las [compras del contacto](https://www.holded.com/developers/api-reference/purchases/list-purchases), con paginación y credenciales de la misma empresa. Si el proveedor no aporta evidencia suficiente, consulta documentos comparables del último año. Una lectura incompleta o fallida bloquea la validación.

`evaluarCuentaContable` es una función determinista que:

1. Excluye la compra examinada, documentos duplicados, borradores, cancelados y estados desconocidos.
2. Comprueba las cuentas contra el catálogo activo y descarta las incompatibles con la naturaleza del gasto.
3. Separa servicios digitales y profesionales del contexto personal de viaje. El pagador, la tarjeta y el nombre de una persona no bastan para elegir viajes; esa cuenta exige una naturaleza compatible.
4. Separa ajustes de cambio, comisiones y redondeos de la compra del servicio cuando el concepto no es un ajuste.
5. Da prioridad al historial del proveedor. Exige dos documentos independientes en una misma cuenta compatible; diez líneas de una factura siguen siendo un solo precedente. Ante varias cuentas comparables no desempata por mayoría.
6. Acepta una corrección confirmada vigente solo si la cuenta sigue activa y es compatible. No deja que una corrección antigua de viajes convierta software en viaje.
7. Si no hay precedente suficiente, usa únicamente documentos comparables por naturaleza o por al menos dos términos sustantivos del concepto. No elige entre cuentas frecuentes de toda la empresa por descarte ni pide a la IA que adivine.

La propuesta muestra el nombre e ID de la cuenta y los documentos de respaldo. Los tags de personas no se heredan del histórico de otros gastos.

## Puntos de control

- Antes de consumir una propuesta para crear el gasto se vuelve a evaluar la cuenta. Si no coincide, se conserva para revisión.
- `crearGastoHolded` revalida empresa, contacto, concepto e ID aprobado inmediatamente antes de la escritura. Las propuestas antiguas o los otros flujos que no incluyan una cuenta revisada quedan bloqueados; no se crea un gasto usando silenciosamente el valor por defecto de Holded.
- La conciliación individual revisa la cuenta de la compra antes de proponer y antes de escribir. Cuando la revisión falla, no avanza la cola como si el gasto estuviera resuelto.
- La conciliación múltiple revisa la clasificación al preparar, al aprobar y antes de cada movimiento. Conserva las cuentas en la identidad del documento para detectar cambios después de la aprobación.
- `revisar_cuenta_contable_gasto(empresa, compra_id)` permite al asistente explicar la cuenta actual, la sugerencia y sus precedentes. Solo lee y no afirma haber corregido la compra.

Esta versión exige revisión manual de compras con distintas cuentas en varias líneas. Tampoco garantiza que un precedente coherente sea fiscalmente correcto: ofrece evidencia verificable y conserva la aprobación humana. La elección de “Otros servicios” para Anthropic se basa en el historial de WOBA, no es una regla universal para todas las empresas.

## Validación y despliegue

Pruebas de regresión de Anthropic con viajes, ajustes de cambio y dos compras del servicio; contaminación del historial; cuentas archivadas; empates; facturas repetidas; múltiples líneas; cuentas ausentes; persona/tarjeta como ruido; correcciones aprendidas; servicios similares y bloqueos antes de conciliación.

También se aplicó la función nueva a lecturas reales del historial completo de Anthropic; devolvió los dos documentos y la cuenta indicados arriba. No se hicieron escrituras contables ni se probó una conciliación real.

El proyecto mantiene los errores de compilación previos de la sesión (116). Hay que resolver esa integración antes del despliegue. La modificación de la lógica y la herramienta de revisión aún no están activas en producción.
