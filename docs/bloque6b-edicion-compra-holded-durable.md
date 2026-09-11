# Bloque 6B — edición durable de compras en Holded

## Alcance

Este subbloque protege `PUT /api/v2/purchases/{id}`, ejecutado únicamente después de aprobar una propuesta de corrección. La creación, los adjuntos y la conciliación permanecen en fronteras separadas.

## Garantía operativa

Antes del PUT, Wobi relee la compra completa, construye el reemplazo y guarda en `_ediciones_holded_durables` una huella SHA-256 del estado esperado. El ledger conserva solo hashes, empresa, id técnico, estados y tiempos; no guarda el número de documento, importes, líneas ni el body financiero.

- `preparada`: todavía no se cruzó la frontera de escritura.
- `editando`: el PUT pudo salir; desde aquí solo se permite releer y comparar la huella.
- `incierta`: el resultado aún no coincide; nunca se repite automáticamente.
- `verificada`: la relectura coincide y una pulsación duplicada reutiliza el resultado.

Timeouts, errores de red, 408/409/425/429, respuestas 5xx, un 200 no verificable y fallos del checkpoint se consideran ambiguos. Solo un rechazo 4xx inequívoco vuelve a `preparada`. La propuesta se elimina únicamente después de cancelar o verificar el resultado.

La reconciliación al arrancar y sus reintentos son exclusivamente de lectura. El control diario y `/health` exponen contadores, nunca datos comerciales.

## Configuración y reversión

- `WOBI_HOLDED_EDIT_DURABLE_ENABLED=true`: activo por defecto; solo `false` explícito recupera temporalmente la ruta anterior.
- `WOBI_HOLDED_EDIT_LEDGER_RETENTION_DAYS=365`: retención de verificadas, entre 90 y 1095 días.

La ruta anterior sigue disponible como respaldo. La pestaña durable debe conservarse para auditoría. Mientras el ledger resida en Sheets, producción debe continuar con una sola réplica; escalar horizontalmente requiere un almacén transaccional compartido.

## CI y validación segura

El workflow `Validación continua` ejecuta pruebas, typecheck y build en cada pull request y push a `main`, sin secretos ni permisos de escritura. Las pruebas de este bloque usan repositorio y transporte en memoria: no llaman a Holded, no editan compras y no escriben en Sheets.
