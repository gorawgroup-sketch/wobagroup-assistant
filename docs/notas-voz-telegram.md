# Órdenes por notas de voz en Telegram

Escrito el 15 de septiembre de 2026 y llevado a producción el 30 de septiembre de 2026. Se activa al configurar `OPENAI_API_KEY` en Railway; sin esa clave, una nota de voz responde «la transcripción todavía no está configurada» y no ejecuta nada.

## Uso

Envía una nota con el micrófono de Telegram. Wobi muestra «Entendí» con el texto transcrito y continúa por el mismo flujo que los mensajes escritos. No hay que copiar el texto ni enviarlo otra vez. Las acciones que ya requieren aprobación siguen usando su confirmación habitual.

Se admiten notas de hasta tres minutos y 20 MB en OGG/OGA, MP3 o M4A. El audio se descarga en memoria, se transcribe en español y no se archiva como documento ni se reenvía como mensaje de otro usuario. El texto conserva el chat, remitente, mensaje y actualización originales. La autorización se comprueba antes de descargar o transcribir. Se mantiene la entrega durable del webhook existente; no se crea otro webhook ni un segundo trabajo para la nota.

Si la nota está vacía, excede los límites, la transcripción alcanza el límite de salida o falla la descarga/proveedor, no se continúa a las órdenes. Se informa al usuario. La transcripción automática puede equivocarse en nombres e importes; el texto queda visible y puede corregirse en el chat. No se ha medido todavía su exactitud con la voz del usuario.

## Configuración

- Configurar `OPENAI_API_KEY` en los secretos del servidor de WOBA; no enviarla por Telegram ni guardarla en el repositorio.
- `TELEGRAM_VOICE_ENABLED=true` activa la ruta; `false` la desactiva sin afectar mensajes escritos.
- Modelo: `gpt-4o-mini-transcribe`, endpoint de transcripciones, respuesta JSON, idioma español.
- Respeta la política de consumo existente. Si `WOBI_AI_API_MODE=allowlist`, incluir `transcribir_voz_telegram` en `WOBI_AI_API_ALLOWED_PROCESSES` y mantener los presupuestos existentes. No cambiar la política global para habilitar la función.
- Registra el consumo bajo `openai_api_key` como gasto de API en `_costos_ia`, sin contenido del audio. Usa los tokens de la respuesta; si no llegan métricas, registra la estimación publicada por minuto.

Pendiente: prueba real con una nota de voz una vez configurada la clave.

## Validación

Pruebas automatizadas con proveedor y Telegram simulados: identidad conservada; órdenes completas con importes y negaciones; texto escrito sin transcripción; falta de configuración; desactivación; tamaño/duración; límite de descarga aun sin metadatos; errores sin secretos; política de consumo; multipart con idioma y formato; registro de métricas; transcripción vacía, inválida o potencialmente truncada sin ejecutar instrucciones.

Para la prueba en producción, usar primero una nota de consulta sin efectos externos: «Consulta los gastos pendientes de Footprint». Confirmar que se ve el texto y se devuelve una respuesta, y después verificar el flujo habitual de aprobación con una propuesta reversible.

## Referencias

- [Transcripciones de audio: formatos y parámetros](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- [Modelo de transcripción](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)
- [Tarifas oficiales](https://developers.openai.com/api/docs/pricing)
