# Bloque 6D — conciliaciones bancarias durables en Holded

## Riesgo auditado

Holded documenta que `POST /treasury/accounts/{accountId}/bank-movements/{movementId}/reconcile` no es idempotente: repetir el mismo par movimiento/documento puede devolver `422` porque el documento ya está pagado o su saldo restante es cero. Un timeout, `422`, `423`, `429` o error `5xx` no demuestra que la primera conciliación no ocurrió.

Antes de este bloque WOBI releyó correctamente el movimiento después del `POST`, pero no conservaba un checkpoint previo al efecto. Un reinicio o respuesta perdida podía permitir que una aprobación futura intentara la misma conciliación otra vez.

## Flujo implantado

1. Validar identificadores y fecha antes de cualquier reserva o llamada de escritura.
2. Reservar en `_conciliaciones_holded_durables`, usando una clave opaca única por empresa, cuenta y movimiento.
3. Releer primero el movimiento con la credencial de solo lectura y paginación exhaustiva de hasta 2.000 movimientos.
4. Si ya está conciliado, bloquear el `POST`; nunca atribuir automáticamente una conciliación previa al documento actual.
5. Marcar `conciliando` antes del único `POST` permitido.
6. Ante timeout, `422`, `423`, `429`, error transitorio, verificación fallida o caída del ledger, ejecutar únicamente lecturas posteriores.
7. Confirmar éxito solo si el movimiento queda `reconciled`/`forced_reconciled` y `reconciled_amount` es mayor que cero. Se conserva la comprobación existente del saldo pendiente de la compra.
8. Reconciliar estados pendientes al arrancar, mostrar métricas en `/health` y elevar incidencias en el control diario.

Referencias oficiales: [Reconcile a bank movement](https://www.holded.com/developers/api-reference/banking-accounts/reconcile-a-bank-movement) y [List banking account movements](https://www.holded.com/developers/api-reference/banking-accounts/list-banking-account-movements).

## Privacidad y reversión

El ledger guarda únicamente hashes, empresa, ids técnicos, fecha de búsqueda, estado y tiempos. No conserva descripciones bancarias, importes, proveedores, documentos completos ni credenciales.

- `WOBI_HOLDED_RECONCILIATION_DURABLE_ENABLED=false` recupera temporalmente la ruta anterior.
- Revertir el commit elimina la integración sin borrar el ledger de auditoría.
- Mientras Sheets sea el ledger se mantiene una sola réplica de Railway.

Las pruebas usan repositorio y transporte en memoria; no concilian movimientos reales ni escriben en Sheets.
