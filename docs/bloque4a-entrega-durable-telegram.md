# WOBI — bloque 4A: entrada durable de Telegram

Fecha: 2026-09-10. Base recuperable: merge `4d5f82493095719965fe6b15dd02cec3f1192ab8` (bloque 3). Rama aislada: `codex/wobi-bloque4-durable`.

## Resultado

- El webhook ya no confirma una entrega válida con `200` antes de conservarla. Primero crea una reserva en la pestaña oculta `_telegram_entregas_durables` del Sheet existente; solo después responde a Telegram y comienza el procesamiento.
- La reserva guarda el payload únicamente durante la ventana anterior al inicio y cifrado con AES-256-GCM mediante material secreto ya configurado en Railway. Al pasar a `iniciada`, el payload se borra de la fila; el ledger conserva solo hash, identificadores técnicos, tipo, estado y tiempos. No se crea ni registra una credencial nueva.
- Una entrega `reservada` que sobrevivió a un reinicio se recupera automáticamente después de una gracia de 5 s. Todavía no pudo producir efectos, por lo que reanudarla es seguro.
- Una entrega `iniciada` que sigue abierta tras 120 s se marca `incierta`, nunca se reejecuta y avisa al chat que debe comprobarse el resultado antes de repetir.
- Dos `callback_query` distintos sobre el mismo botón sensible comparten una clave SHA-256 derivada de usuario, mensaje y acción. La segunda pulsación no repite la operación y recibe una confirmación clara en Telegram. Los toggles y pre-pasos no usan esta deduplicación semántica para no bloquear cambios intencionales.
- Los estados terminales se conservan 30 días y se purgan en lote. Duplicados físicos conservan como canónico el estado más avanzado, evitando que una fila `reservada` venza sobre otra ya `completada`.
- La pestaña amplía automáticamente su cuadrícula en bloques cuando el volumen supera la capacidad inicial y sus lecturas no tienen el antiguo techo de 10.000 filas, sin volver a la heurística ambigua de `values.append`.
- `/health` expone únicamente contadores: habilitación, activas, revisiones pendientes, recuperadas, inciertas, duplicadas y errores. No muestra payload, usuario, chat, texto ni claves.
- El apagado controlado cancela timers locales; el siguiente proceso reconstruye las revisiones desde el ledger.

## Seguridad y límites deliberados

Este subbloque garantiza **al menos una reserva durable antes del ACK** y **no repetir automáticamente después del checkpoint de inicio**. No promete todavía ejecución distribuida exactamente una vez:

- Google Sheets no ofrece compare-and-swap. La protección combina estado durable y mutex local, por lo que producción debe seguir con una sola réplica.
- Los handlers históricos todavía consumen algunas propuestas antes de terminar su efecto externo. El ledger evita repetir la entrega, pero el bloque 4B debe convertir cada acción crítica en estados `preparada → enviada → verificada` y reconciliarla con Holded/Gmail/Drive.
- Un trabajo iniciado y cortado se detiene en `incierta`; se prioriza no duplicar pagos, documentos, correos o registros sobre un reintento ciego.
- Cada entrega añade lecturas/escrituras al Sheet. No tiene coste marginal de IA, Redis ni PostgreSQL, pero debe vigilarse la cuota antes de aumentar tráfico o réplicas.
- El chat web conserva su idempotencia de `messageId` ya existente. La recuperación automática de su outbox en el navegador queda para el bloque 4B.

## Configuración y reversión

- `WOBI_TELEGRAM_DURABLE_ENABLED=true`. Solo `false` explícito activa el comportamiento anterior; una errata conserva la ruta segura.
- `WOBI_TELEGRAM_RESERVATION_GRACE_MS=5000` (1–30 s).
- `WOBI_TELEGRAM_UNCERTAIN_AFTER_MS=120000` (30–600 s).
- `WOBI_TELEGRAM_LEDGER_RETENTION_DAYS=30` (7–180 días).

Reversión operativa inmediata: `WOBI_TELEGRAM_DURABLE_ENABLED=false`. Reversión completa: revertir únicamente el merge de este subbloque mediante una nueva PR. La pestaña oculta puede permanecer: es inerte y conservarla facilita auditoría/recuperación; no borrarla durante una incidencia.

## Pruebas

- Reserva antes de ejecución y finalización exactamente una vez dentro del proceso.
- Reentrega del mismo `update_id` sin segunda ejecución.
- Doble pulsación sensible con callback ids distintos y una sola clave durable.
- Mensajes distintos con el mismo texto no se confunden.
- Recuperación de una reserva previa al inicio.
- Conversión de una ejecución interrumpida en incierta, notificación y ausencia de reintento.
- Una ejecución local larga no se declara incierta mientras todavía continúa activa.
- Fallo del handler sin repetición automática.
- Interruptor y ventanas acotadas, incluida errata que mantiene el modo seguro.
- 85 pruebas (81 TypeScript + 4 del worker Claude Max), typecheck y build backend/frontend antes de publicar.

Punto de recuperación previo: deployment Railway `50a929ca-4ee1-4edb-b44b-0832fb061b1a`, commit `4d5f82493095719965fe6b15dd02cec3f1192ab8`, verificado en SUCCESS/RUNNING al cerrar el bloque 3.
