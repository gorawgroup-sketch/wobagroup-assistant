# WOBi: voz e icono

## Saludo

Archivo: `frontend-cerebro/public/brand/wobi-saludo-neural-v3.mp3`.
Voz: `es-MX-DaliaNeural`, ritmo y tono naturales (+0%). Grabación estática compartida por todos los dispositivos, generada con edge-tts 7.2.8. El navegador no sintetiza este saludo.

Texto de locución: «Hola, soy Uóbi. Estoy aquí para ayudarte a organizar la información y avanzar con claridad. Dime qué necesitas y lo vemos juntos.»
La grafía fonética Uóbi se usa solo en la locución; la marca visible sigue siendo WOBi.

La lectura de respuestas del chat es una función separada. Su conexión a síntesis externa requiere autorización porque las respuestas pueden contener información interna.

## Favicon

Generado con la herramienta integrada ImageGen a partir del retrato WOBi aprobado. PNG con alfa real; versiones 32, 180, 192 y 512 px; ICO de 16, 32 y 48 px. El retrato principal permanece en `brand/wobi.png`.

Prompt: Create a single professional favicon brand mark derived from the reference WOBi face. Only the head/face, no neck, shoulders, torso, enclosing circle or background. Actual transparent alpha background. Simplify the mature calm humanoid identity into an elegantly designed bold vector-like icon: cobalt and cyan sculpted contour strokes define oval head, two calm eyes, nose and mouth; restrained amber central nose/forehead accent. Clean thick contour bands rather than photographic particle detail. A few geometric fragments along the right temple suggest nanobots assembling the face. Preserve mature human facial proportions, not a toy robot or child mascot. Centered in a square with balanced padding, strong silhouette legible at 16 and 32px. No text, watermark, black or navy rectangle. Transparent outside the face and in negative spaces between contour lines.

## Retrato central transparente

Archivo: `frontend-cerebro/public/brand/wobi-transparent.png`, PNG RGBA 1254 × 1254. Se usa en el centro de las células; conserva el retrato aprobado y elimina el fondo exterior. El montaje muestrea su canal alfa y funde las partículas con la figura final durante 1,8 segundos. Con movimiento reducido se muestra directamente la figura.

Herramienta: ImageGen integrada. Prompt final: Remove the background from this image. Make a transparent-background cutout PNG of the blue and gold Wobi nanobot person, keeping the same face, head, neck, shoulders and glowing particles. Output with transparent background enabled and actual alpha transparency. Do not draw checkerboard. Keep original artwork intact.

## Cabeza actual: centro y favicon

El centro muestra únicamente la cabeza del mismo `wobi-transparent.png` aprobado, sin cambiar ni regenerar el rostro. `src/wobiHead.js` define el encuadre y el contorno de la mandíbula; `WobiAvatar` aplica ese mismo recorte al SVG visible y al muestreo de nanobots. No se modifican los píxeles del original.

El favicon activo es `brand/wobi-head.ico`, con PNG de 32, 180, 192 y 512 px. Se exporta del mismo SVG, contorno y archivo original mediante Sharp, conservando alfa; sustituye al anterior icono gráfico `wobi-face`. El PNG de 512 px permite reutilizar la cabeza en otros soportes.
