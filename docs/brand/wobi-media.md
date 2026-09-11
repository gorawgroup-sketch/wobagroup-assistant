# WOBi: voz e icono

## Saludo

Archivo: `frontend-cerebro/public/brand/wobi-saludo-neural-v3.mp3`.
Voz: `es-MX-DaliaNeural`, ritmo y tono naturales (+0%). Grabación estática compartida por todos los dispositivos, generada con edge-tts 7.2.8. El navegador no sintetiza este saludo.

Texto de locución: «Hola, soy Uóbi. Estoy aquí para ayudarte a organizar la información y avanzar con claridad. Dime qué necesitas y lo vemos juntos.»
La grafía fonética Uóbi se usa solo en la locución; la marca visible sigue siendo WOBi.

La lectura del chat utiliza la misma `es-MX-DaliaNeural`, con ritmo +0% y tono +0 Hz, fijada en el servidor para todos los usuarios. `POST /api/cerebro/voz` exige la misma autorización del chat y sintetiza fragmentos de hasta 500 caracteres mediante `msedge-tts` (cliente del servicio Microsoft Edge). El usuario autorizó expresamente enviar las respuestas del chat a Microsoft para esta síntesis, incluido su posible contenido interno. No se almacena el audio y se responde con `Cache-Control: no-store`.

El cliente divide las respuestas en frases, omite la sintaxis Markdown y reproduce el audio recibido. Al cerrar el chat, desactivar la lectura o salir de la pestaña cancela la voz. Si el navegador bloquea la reproducción automática, ofrece un botón para reproducir el audio ya preparado. Si Microsoft no responde, conserva la respuesta escrita y comunica el error; no sustituye la voz por la del sistema operativo. Wobi se transforma en Uóbi únicamente en la locución.

## Favicon

El favicon actual es `brand/wobi-outline.svg`: dibujo vectorial del contorno de la cabeza, ojos, nariz y boca, sin cuello ni fondo. Sus líneas son negras en pestañas claras y blancas en pestañas oscuras. Los PNG de 16, 32, 48, 180, 192 y 512 px y el ICO de 16/32/48 px se exportan de ese SVG con alfa transparente. Esta versión reemplaza el recorte fotográfico para mejorar su lectura a tamaño pequeño. El retrato principal permanece en `brand/wobi.png`.

## Retrato central transparente

Archivo: `frontend-cerebro/public/brand/wobi-transparent.png`, PNG RGBA 1254 × 1254. Se usa en el centro de las células; conserva el retrato aprobado y elimina el fondo exterior. El montaje muestrea su canal alfa y funde las partículas con la figura final durante 1,8 segundos. Con movimiento reducido se muestra directamente la figura.

Herramienta: ImageGen integrada. Prompt final: Remove the background from this image. Make a transparent-background cutout PNG of the blue and gold Wobi nanobot person, keeping the same face, head, neck, shoulders and glowing particles. Output with transparent background enabled and actual alpha transparency. Do not draw checkerboard. Keep original artwork intact.

## Cabeza actual: centro

El centro muestra únicamente la cabeza del mismo `wobi-transparent.png` aprobado, sin cambiar ni regenerar el rostro. `src/wobiHead.js` define el encuadre y el contorno de la mandíbula; `WobiAvatar` aplica ese mismo recorte al SVG visible y al muestreo de nanobots. No se modifican los píxeles del original.
