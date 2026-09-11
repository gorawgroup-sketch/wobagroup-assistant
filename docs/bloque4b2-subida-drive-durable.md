# WOBI — bloque 4B.2: subida durable a Drive

Fecha: 2026-09-10. Base recuperable: merge `1df99a07fe13471336018f21af4aabcf0c03d4ad` (bloque 4B.1). Rama aislada: `codex/wobi-bloque4b2-drive`.

## Resultado

- Cada aprobación de archivo obtiene una identidad estable y opaca formada por la propuesta y la carpeta de destino.
- Antes de `files.create`, WOBI registra `preparada → subiendo` en la pestaña oculta `_subidas_drive_durables`.
- El archivo se crea con `appProperties.wobi_effect=<hash>`. Las propiedades de aplicación son privadas para la aplicación autenticada y Drive permite buscarlas con `appProperties has { key=... and value=... }` ([documentación oficial](https://developers.google.com/workspace/drive/api/guides/search-files)).
- Un estado `subiendo` o `incierta` nunca vuelve a llamar a `files.create`: solo busca el marcador en Drive. Si aparece, completa el checkpoint como `verificada`.
- La reconciliación al arrancar y sus tres revisiones diferidas son de solo lectura. Una búsqueda marcada por Drive como incompleta no se interpreta como “no existe”.
- La propuesta se consume únicamente después de confirmar el archivo. Si hay un error, Telegram ofrece un botón nuevo de verificar/reintentar y el chat propio conserva la misma propuesta para reintentar por texto.
- Si falta el archivo temporal tras un redeploy, solo `ENOENT` permite volver a descargar el adjunto de Gmail y repetir. Un timeout o 5xx no inicia una segunda transmisión.
- El control diario eleva como crítica una subida incierta o un ledger que no se puede leer. `/health` publica métricas operativas sin nombres, contenido ni credenciales.

## Datos conservados

El ledger guarda hash, proceso, estado, marcador, id de carpeta, id/link técnico del archivo y tiempos. No guarda nombre del archivo, ruta local, contenido, prompt, destinatarios ni secretos. Los datos verificados se conservan 180 días por defecto (`WOBI_DRIVE_LEDGER_RETENTION_DAYS`, acotado entre 30 y 365).

## Reversión

- `WOBI_DRIVE_DURABLE_ENABLED=false` restaura temporalmente la subida anterior sin eliminarla.
- Solo `false` explícito desactiva la protección; un valor mal escrito conserva la ruta segura.
- La reversión de código es el revert del commit/PR de este bloque. La pestaña oculta y las propiedades privadas son inocuas para la ruta anterior y no se borran automáticamente.

## Pruebas sin efectos reales

- aprobación repetida: una sola subida;
- reinicio en estado `subiendo`, con y sin archivo encontrado;
- timeout después de aceptación y reconciliación por marcador;
- timeout no confirmado bloqueado como incierto;
- `ENOENT` directo/envuelto y rechazo 403 inequívoco;
- identidad opaca, estable y separada por carpeta;
- reconciliación de arranque sin ninguna llamada de escritura;
- fallo de Sheets después de `files.create`, sin segunda subida;
- kill switch conservador y alertas del control diario.

No se subió ningún archivo real durante las pruebas. Este bloque no agrega modelos, tokens ni servicios: el gasto real de IA añadido es `0`; únicamente agrega llamadas pequeñas a Sheets y búsquedas de metadatos de Drive cuando hay una acción aprobada o una ambigüedad.

## Límite deliberado

Producción debe continuar con una sola réplica: Sheets más mutex local evita carreras en el despliegue actual, pero no ofrece compare-and-swap distribuido. Antes de aumentar réplicas se necesita un almacén transaccional compartido. La creación de carpetas ya busca una coincidencia antes de crear, pero su propio efecto externo se auditará por separado. La creación de compras de Holded quedó cubierta después en el bloque 6A; edición y conciliación siguen pendientes de reconciliadores específicos.
