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

### Resolver una incidencia desde el Diagnóstico Diario

Una edición `incierta` compara siempre contra la huella que esperaba **en su momento**. Si la misma compra se reedita después (o alguien la toca en Holded), esa huella antigua ya no puede coincidir y el registro sería crítico para siempre aunque el documento esté bien. Caso real (2026-09-20, Footprint): 7 compras sanas acumularon 63 ediciones inciertas por reediciones repetidas de la reparación automática de correo.

El panel ofrece, con la key maestra y sin invocar ningún modelo:

- **Verificar ahora** (`POST /api/cerebro/control-diario/resolver`, `accion: "verificar"`): ejecuta la misma reconciliación de solo lectura del arranque. El mensaje distingue verificados, liberados, inciertos, errores de lectura y elementos que requieren revisión manual: nunca da por bueno un resumen con pendientes.
- **Revisar y cerrar** (`GET /api/cerebro/control-diario/ediciones-inciertas` y `accion: "aceptar"` con `confirmar: true`): muestra el estado real de cada compra en Holded (las 50 más recientes) y, tras confirmación humana, cierra en el ledger las ediciones inciertas de las compras cuyo documento **sigue exactamente igual que cuando se revisó** (la petición lleva la huella del documento leído; si cambió, no se cierra) y que además **existen y son coherentes** (proveedor, líneas con cuenta contable, total legible) o **ya no existen en Holded** (404). Un total 0 o negativo, un borrador o una moneda distinta de EUR son avisos, no bloqueos. Una compra que no se puede releer o es incoherente nunca se cierra. **Nunca se escribe en Holded.**

Garantías del cierre (`cerrarPorRevisionHumana`, solo desde `incierta`):

- **No reescribe la huella esperada.** "Verificada" aquí significa «una persona revisó y aceptó», no «el PUT quedó aplicado»: si se sobrescribiera la huella, un reintento con la misma clave idempotente (por ejemplo, una aprobación posterior por Telegram) vería el documento igual a la huella nueva y devolvería un falso «editado» sin haber aplicado el cambio. Conservando la original, ese reintento sigue chocando con `EdicionCompraInciertaError` y nunca repite el PUT.
- **Rastro de auditoría:** el campo `proceso` del registro pasa a terminar en `|cierre_revision_humana` y `verificadoEn` guarda cuándo se cerró.
- **Serialización:** verificar y cerrar toman el mismo coordinador que el cron y los comandos de correo (con PostgreSQL); si hay una revisión de correo en curso, responden 409 en lugar de tocar el ledger con una edición en vuelo.
- **Solo la key maestra**, tanto el detalle como la acción; el trabajo se registra como trabajo en segundo plano para que un redeploy espere a que termine.
- Un fallo al escribir el ledger de una compra (por ejemplo, cuota de Sheets) no aborta las demás y se informa por compra.

Cerrar no elimina la causa: si el flujo automático vuelve a reeditar una compra (la clave idempotente de la reparación automática incluye la versión de política, así que cada cambio de política es una edición nueva), las incidencias reaparecerán y hay que corregir esa causa en el flujo automático.

## Configuración y reversión

- `WOBI_HOLDED_EDIT_DURABLE_ENABLED=true`: activo por defecto; solo `false` explícito recupera temporalmente la ruta anterior.
- `WOBI_HOLDED_EDIT_LEDGER_RETENTION_DAYS=365`: retención de verificadas, entre 90 y 1095 días.

La ruta anterior sigue disponible como respaldo. La pestaña durable debe conservarse para auditoría. Mientras el ledger resida en Sheets, producción debe continuar con una sola réplica; escalar horizontalmente requiere un almacén transaccional compartido.

## CI y validación segura

El workflow `Validación continua` ejecuta pruebas, typecheck y build en cada pull request y push a `main`, sin secretos ni permisos de escritura. Las pruebas de este bloque usan repositorio y transporte en memoria: no llaman a Holded, no editan compras y no escriben en Sheets.
