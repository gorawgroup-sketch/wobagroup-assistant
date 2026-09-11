# Bloque 6A — creación durable de compras en Holded

## Alcance

Este subbloque protege exclusivamente `POST /api/v2/purchases`, utilizado por las aprobaciones de gastos y pagos recurrentes. Edición, adjuntos y conciliación se mantienen sin cambios para tratarlos en subbloques separados.

## Garantía operativa

Cada aprobación usa su id estable como clave, combinada con la empresa. Antes del POST se guarda un registro en la pestaña oculta `_compras_holded_durables`; la compra recibe en `notes` un marcador SHA-256 opaco. La documentación oficial de Holded define esas notas como internas y confirma que el GET individual las devuelve.

- `preparada`: puede ejecutar un POST.
- `creando`: el POST pudo haber llegado; solo se permite consultar Holded.
- `incierta`: no se repite el POST; la reconciliación continúa siendo de solo lectura.
- `verificada`: los reintentos reutilizan el id guardado.

Timeouts, errores de red, 408/409/425/429, respuestas 5xx y respuestas exitosas sin id se consideran ambiguos. Solo un rechazo 4xx inequívoco vuelve a `preparada`, lo que permite corregir, por ejemplo, una fecha contable bloqueada.

La búsqueda de reconciliación se limita por empresa, contacto y fecha, abre cada candidato y exige exactamente el marcador interno. Cero resultados conserva el estado incierto; más de uno o una paginación incompleta fallan cerrados.

## Privacidad y configuración

El ledger guarda hashes, empresa, ids técnicos, fecha operativa, estado y tiempos. No guarda proveedor, descripción, importe, líneas, número de documento, prompts ni credenciales.

- `WOBI_HOLDED_PURCHASE_DURABLE_ENABLED=true`: activo por defecto. Solo `false` explícito restaura temporalmente la ruta anterior.
- `WOBI_HOLDED_PURCHASE_LEDGER_RETENTION_DAYS=365`: retención de registros verificados, acotada entre 90 y 1095 días.

La ruta anterior no se elimina. La reversión operativa inmediata consiste en definir `WOBI_HOLDED_PURCHASE_DURABLE_ENABLED=false`; la pestaña oculta debe conservarse para auditoría y recuperación.

Producción debe mantenerse en una sola réplica mientras Sheets sea el ledger. El mutex protege concurrencia dentro de la réplica actual, pero Sheets no ofrece aquí una reserva compare-and-swap entre varias réplicas. Escalar horizontalmente exige migrar estos ledgers a un almacén transaccional compartido.

## Verificación segura

Las pruebas usan repositorios y transportes en memoria. No llaman a Holded, no crean compras y no escriben en Sheets. Cubren repetición, recuperación tras timeout, conflicto de contenido, rechazo definitivo, reconciliación de arranque y fallo del checkpoint posterior al POST.
