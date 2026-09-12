# WOBi: voz e icono

## Saludo

Archivo: `frontend-cerebro/public/brand/wobi-saludo-neural-v3.mp3`.
Voz: `es-MX-DaliaNeural`, ritmo y tono naturales (+0%). Grabación estática compartida por todos los dispositivos, generada con edge-tts 7.2.8. El navegador no sintetiza este saludo.

Texto de locución: «Hola, soy Uóbi. Estoy aquí para ayudarte a organizar la información y avanzar con claridad. Dime qué necesitas y lo vemos juntos.»
La grafía fonética Uóbi se usa solo en la locución; la marca visible sigue siendo WOBi.

La lectura del chat utiliza la misma `es-MX-DaliaNeural`, con ritmo +0% y tono +0 Hz, fijada en el servidor para todos los usuarios. `POST /api/cerebro/voz` exige la misma autorización del chat y sintetiza fragmentos de hasta 500 caracteres mediante `msedge-tts` (cliente del servicio Microsoft Edge). El usuario autorizó expresamente enviar las respuestas del chat a Microsoft para esta síntesis, incluido su posible contenido interno. No se almacena el audio y se responde con `Cache-Control: no-store`.

El cliente divide las respuestas en frases y omite la sintaxis Markdown. `POST /api/cerebro/voz/stream` entrega PCM s16le mono a 24 kHz, decodificado incrementalmente en el servidor con mpg123-decoder. Web Audio reproduce los bloques conforme llegan, con una cola continua y hasta diez segundos preparados por adelantado. El siguiente fragmento se solicita mientras sigue sonando el anterior. Al cerrar el chat, desactivar la voz o salir de la pestaña se cancela la reproducción y la petición pendiente. Si el navegador bloquea el audio, ofrece un único botón para habilitarlo. Si Microsoft no responde, conserva la respuesta escrita y comunica el error; no sustituye la voz por la del sistema operativo. Wobi se transforma en Uóbi únicamente en la locución.

## Favicon

El favicon actual es `brand/wobi-wordmark.svg`: únicamente el nombre WOBi en letras negras, sobre fondo transparente. Los PNG de 16, 32, 48, 180, 192 y 512 px y el ICO de 16/32/48 px se exportan del mismo SVG. Los nuevos nombres de archivo renuevan la caché del icono. El retrato principal permanece en `brand/wobi.png`.

## Retrato central transparente

Archivo: `frontend-cerebro/public/brand/wobi-transparent.png`, PNG RGBA 1254 × 1254. Se usa en el centro de las células; conserva el retrato aprobado y elimina el fondo exterior. El montaje muestrea su canal alfa y funde las partículas con la figura final durante 1,8 segundos. Con movimiento reducido se muestra directamente la figura.

Herramienta: ImageGen integrada. Prompt final: Remove the background from this image. Make a transparent-background cutout PNG of the blue and gold Wobi nanobot person, keeping the same face, head, neck, shoulders and glowing particles. Output with transparent background enabled and actual alpha transparency. Do not draw checkerboard. Keep original artwork intact.

## Cabeza actual: centro

El centro muestra únicamente la cabeza del mismo `wobi-transparent.png` aprobado, sin cambiar ni regenerar el rostro. `src/wobiHead.js` define el encuadre y el contorno de la mandíbula; `WobiAvatar` aplica ese mismo recorte al SVG visible y al muestreo de nanobots. No se modifican los píxeles del original.

## Reproducción del chat

El chat tiene un único interruptor «Voz activada / Voz desactivada» y recuerda la preferencia en el dispositivo; permanece apagado en dispositivos nuevos. Al activarlo se habilita el contexto de audio desde el gesto del usuario. Las nuevas respuestas se leen automáticamente, sin reproductor ni botones por mensaje. Activarlo no repite conversaciones antiguas. Desactivarlo detiene inmediatamente todos los bloques programados. Se conserva un reintento únicamente ante errores. La consulta del asistente sigue completándose antes de sintetizar: el streaming reduce la espera de audio, no el tiempo de consulta a herramientas o generación de la respuesta.

Prueba local con el componente real, las cabeceras CSP de producción y síntesis real: primer audio programado a 955 ms desde Enviar (incluyendo una respuesta de chat simulada de 300 ms), 289 bloques y 0 ms de hueco añadido entre bloques. Es una medición de prueba, no una garantía de latencia de consultas reales.

## Política de medios del navegador

El servidor permite `media-src 'self' blob:` para reproducir el MP3 autenticado a través de una URL temporal creada por el navegador. Sin esta directiva, `default-src 'self'` bloqueaba el audio del chat aunque el endpoint entregara un MP3 válido; el saludo estático sí podía reproducirse. Las restricciones de scripts, conexiones y marcos se conservan. La prueba de reproducción debe incluir las cabeceras CSP de producción: verificar solo el endpoint o Vite no detecta este bloqueo.

El chat actual utiliza Web Audio con PCM recibido del mismo origen. El decodificador WASM se ejecuta en el servidor; no se relajan las restricciones de scripts del navegador. El endpoint MP3 anterior se mantiene compatible.
