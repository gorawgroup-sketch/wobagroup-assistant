# Voz Marin y conversación de WOBi

Elección de Carlos: 12-10-2026. Marin reemplaza Dalia en las salidas de voz existentes.

## Estado

Integración en `codex/voz-marin`, PR #463. Consulta gratuita del catálogo con la clave existente: HTTP 200. Cuenta API: 9,99 USD de saldo observado; recarga automática ON a umbral 5 USD, objetivo 10 USD y techo mensual 20 USD. Carlos desactivó la recarga; OFF verificado en la página de facturación. Dos pruebas reales: MP3 (respuesta SSE guardada de la primera generación) y PCM (nueva generación), HTTP 200 y voz Marin. Tokens 20/60 y 48/53: 0,0013968 USD, registrados una vez en Control diario. No hay compras ni cambios de facturación. Activación autorizada usando el saldo existente, sin recargas.

## Un único camino de audio

- Respuestas del navegador y del chat web: `/api/cerebro/voz/stream`, PCM firmado de 16 bits a 24 kHz, voz `marin`.
- Descarga MP3 existente: `/api/cerebro/voz`, misma voz y proveedor.
- Saludo de entrada: `wobi-saludo-marin-v1.mp3`, muestra elegida y descargada de OpenAI.fm; texto: «Hola, soy Wobi. Estoy aquí para ayudarte a consultar la información de tu sistema. Puedes preguntarme por los pendientes y por el costo de operación». Grabación pública sin datos privados ni gasto de API en WOBA.
- Telegram actualmente recibe notas de voz y responde por escrito; no se agrega un envío automático de audio. La voz de transcripción no es una voz de salida.
- No hay respaldo de voz del navegador ni sustitución de Marin.

La clave vive solo en el servidor. El proveedor recibe el texto que se va a leer, no la conversación completa. Respeta cancelación, concurrencia y timeout ya existentes. La API entrega eventos de audio y métricas finales; se registra el gasto por tokens reportados bajo `sintetizar_voz_wobi`. Una transmisión interrumpida sin métricas requiere reconciliar su consumo con OpenAI: nunca se registra como costo cero.

## Activación pendiente

1. Verificar que la recarga automática esté OFF en la organización de la clave existente.
2. Pruebas reales verificadas. No comprar créditos ni ampliar límites por este cambio. Añadir techo diario de 0,10 USD al proceso de voz conservando los demás límites.
3. Tras despliegue, verificar la respuesta real de Marin y ambos reproductores de WOBA; mantener cancelación y la voz fija.
4. Habilitar `WOBI_OPENAI_VOICE_ENABLED=true`. Si la política global usa allowlist, autorizar el proceso `sintetizar_voz_wobi` sin cambiar los otros procesos. Mantener los techos globales y de proceso.
5. Desplegar solo tras pruebas, tipos y build completos y revisión. No activar el gasto solo porque exista una clave.

## Recomendación conversacional

Reutilizar el mismo motor y herramientas de WOBi para el chat del front y Telegram, con historial por usuario, memoria resumida y permisos aplicados en el servidor. Añadir Marin como salida independiente. Así no se paga otro razonamiento para leer una respuesta ya calculada. Las cifras simples se leen de Control diario; los cálculos financieros los realizan herramientas sobre datos reales, y la respuesta muestra período, moneda, fuente y fecha. Conservar las confirmaciones de acciones existentes.

Un chat con OpenAI requiere conectar expresamente sus herramientas y conocimiento; no hereda este chat de Codex ni su suscripción. Migrar el motor de razonamiento es una preocupación separada de reparar audio. Realtime se reserva para conversación oral e interrupciones, si el uso justifica su costo y complejidad.

## Tarifas consultadas el 12-10-2026

Marin con `gpt-4o-mini-tts`: 0,60 USD por millón de tokens de entrada de texto y 12 USD por millón de tokens de salida de audio. Ejemplo matemático, no consumo medido: 400 tokens de entrada y 500 de audio = 0,00624 USD por generación; 1.000 generaciones iguales = 6,24 USD. El tiempo hablado y tokens reales determinan el importe, no una cuota fija. La página de modelo marca deprecación aunque la guía mantiene el endpoint: confirmar acceso y funcionamiento real antes de activar, y no sustituir el modelo o voz sin verificar tarifas.

Realtime 2.1: audio 32 USD entrada / 64 USD salida por millón de tokens, texto 4 / 24 USD. Realtime 2.1 mini: audio 10 / 20, texto 0,60 / 2,40 USD por millón. Estas tarifas no se comparan directamente con minutos ni con tokens de otro modelo. Para el chat se mantiene el costo actual del motor; un presupuesto de migración debe incluir historial, razonamiento y herramientas.

Fuentes oficiales:
- https://developers.openai.com/api/docs/guides/text-to-speech
- https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
- https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/guides/chatkit
