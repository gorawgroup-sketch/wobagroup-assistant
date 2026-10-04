# Conciliación de varios movimientos con una compra

La herramienta `conciliar_multiples_movimientos_bancarios` conserva la selección explícita de movimientos y la vincula a una compra existente por ID. Resuelve el caso Gora: cargos de 1.000 + 1.000 + 200 + 1.000 EUR contra un saldo de compra de 3.200 EUR, aunque las fechas o las cuentas bancarias sean distintas.

## Uso desde la conversación

1. Consultar la compra con `consultar_estado_factura_holded`; el resultado ahora incluye su ID real, además del número de factura.
2. Consultar los movimientos con `consultar_movimientos_sin_conciliar`; cada resultado incluye `accountId`, `movementId`, fecha y estado.
3. Pasar esos identificadores a `conciliar_multiples_movimientos_bancarios` con `empresa`, `compra_id`, `movimientos` y un `motivo` que explique la relación. No sustituir los identificadores por nombres o por números de factura; no buscar nuevamente un movimiento de 3.200 EUR ni una compra de 1.000 EUR.
4. La herramienta relee los datos de Holded, guarda el plan y muestra el proveedor, compra, cuentas, fechas, importes, identificadores, pagos previos, saldo pendiente y diferencia cero. El botón requiere superadministrador y el chat original.
5. Al aprobar, se relee todo el lote y se ejecuta secuencialmente. `consultar_conciliacion_multiple`, con `plan_id`, permite recuperar el avance guardado después de un reinicio o cambio de conversación dentro del mismo chat.

La suma exacta es necesaria, pero no demuestra por sí sola que los pagos correspondan a la compra. La selección debe estar identificada por el usuario o por evidencia verificable y mostrarse para aprobación. No hay selección automática de subconjuntos por importe.

## Invariantes

- Todos los recursos se leen con las credenciales de la misma empresa. Se exige que el ID y la cuenta devueltos coincidan con los solicitados.
- Entre 2 y 20 cargos completos, únicos, pendientes y con importe conciliado cero. Se rechazan abonos, movimientos parciales, estados desconocidos y compras anuladas. La compra puede estar en borrador: así la crea WOBI y el flujo normal también concilia sobre el borrador.
- Inicialmente solo EUR, sin conversiones ni ajustes por comisiones. El repositorio documenta un incidente previo de aplicación incorrecta de importes en otras monedas por Holded.
- Se calcula en céntimos enteros. No hay tolerancia ni redondeo. Se admiten los decimales de la API y los importes ES con coma usados por Holded; las representaciones ambiguas se rechazan.
- La suma debe ser igual al **saldo pendiente**, no necesariamente al total original. Se admiten compras con pagos anteriores cuando su detalle y saldos cuadran exactamente.
- Después de cada POST se comprueba el estado y el importe bancario, el nuevo pago con su ID, cuenta, fecha e importe, la conservación de pagos anteriores y la reducción exacta del saldo de la compra. Al finalizar se releen todos los movimientos y se exige saldo cero.
- Los botones antiguos de conciliación individual respetan las reservas del lote. La función de escritura individual comparte el mutex y comprueba esas reservas.

## Persistencia, errores y límites

La pestaña oculta `_conciliaciones_multiples_audit` del `CASHFLOW_SHEET_ID` conserva eventos completos: propuesta, aprobador, paso en vuelo, movimientos y pagos verificados, saldo tras cada pago y resultado. No se borran filas ni se consumen propuestas al aprobar. La propuesta expira a las 24 horas; los estados ejecutando/incierto/completado conservan sus reservas.

Se persiste el paso en vuelo **antes** de enviar cada POST. Si la escritura o la verificación fallan, el lote se detiene. Un timeout no demuestra que Holded no haya aplicado el pago. Un doble clic, otro plan que use los mismos recursos o una reentrega tras reinicio no repiten la operación. Si no se puede guardar el estado posterior al POST, el último estado durable sigue bloqueando el recurso.

Holded ofrece escrituras por movimiento, no una transacción atómica para el lote. No se promete rollback: un lote detenido puede tener pagos aplicados. No se reanuda automáticamente ni se liberan reservas inciertas por tiempo. Hay que revisar el historial del plan y los datos de Holded antes de cualquier corrección. La consulta de estado lee el registro, no reconcilia de nuevo ni convierte un estado incierto en éxito. La recuperación automática por evidencia queda fuera de esta primera versión.

El almacén de Sheets y los mutex existentes requieren **un único proceso escritor**. No desplegar varias réplicas ni procesos solapados que escriban durante un redeploy; para soportarlos se necesita un almacén transaccional con exclusión distribuida. Tampoco existe bloqueo transaccional contra cambios manuales simultáneos en Holded. Las relecturas reducen esa ventana y detectan inconsistencias, pero no pueden garantizar exclusión frente a usuarios externos.

El registro bloquea nuevas escrituras al aproximarse a 9.500 eventos; requiere archivado controlado que preserve reservas y evidencia. El tamaño de cada snapshot también está limitado para evitar exceder una celda de Sheets. Si un movimiento no aparece antes del límite de paginación, se bloquea la operación, sin deducir que no existe.

La nueva ruta no avanza la cola de correos por su cuenta: una selección por IDs no acredita qué mensaje de correo es dueño del plan. En particular, nunca anuncia “resuelto” ante un lote incompleto. Los botones antiguos asociados a una compra reservada remiten al plan sin consumir la pregunta ni avanzar la cola.

## Validación y despliegue

Pruebas sin credenciales reales ni escrituras a servicios:

```sh
node --import tsx --test core/holded/conciliacionMultiple*.test.ts
node --import tsx --test core/**/*.test.ts
npm run typecheck
```

Las pruebas cubren Gora, céntimos, divisas, duplicados, pagos previos, cambios después de proponer, autorización, doble clic, reinicio, timeouts tras aplicar un pago, respuestas 200 sin efecto, paginación y fallos de persistencia. El adaptador HTTP se prueba con respuestas controladas; no constituye validación de una ejecución real en Holded.

Al desarrollar esta función el repositorio ya presentaba 116 errores de TypeScript por módulos/exportaciones faltantes y otros cambios incompletos. No se añadieron errores respecto a esa línea base. Es necesario resolver esa integración antes de desplegar el conjunto. No se ha ejecutado el caso Gora ni ninguna conciliación real como parte del desarrollo.

Antes de activar el flujo en producción: compilación completa limpia, único escritor, acceso al registro durable y validación de los campos del adaptador con lecturas autorizadas del entorno de destino. La primera escritura real debe partir de una propuesta completa aprobada; si Holded no devuelve la evidencia esperada, se detiene sin repetir.

## Referencia de la API

- [Conciliar un movimiento](https://www.holded.com/developers/api-reference/banking-accounts/reconcile-a-bank-movement): POST con `documents: [{ document_id, document_type: "purchase" }]`; no se envía un cuerpo vacío ni un importe no documentado.
- [Detalle de compra](https://www.holded.com/developers/api-reference/purchases/get-a-purchase): saldo y `payments_detail` usados para verificar el pago en el documento correcto.
- [Movimientos bancarios](https://www.holded.com/developers/api-reference/banking-accounts/list-banking-account-movements): paginación por cursor y estado/importe conciliado. Los filtros de fecha usan fecha valor, por eso la búsqueda por ID no presupone que coincida con `booking_date`.
