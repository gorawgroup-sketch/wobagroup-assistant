# Aviso de formato de soportes

**Pedido (Carlos, 14-10-2026).** Muchas personas respondían al correo de solicitud con el soporte, o lo mandaban sin contexto, y el flujo no podía leerlos bien. Hacía falta escribir a todas las personas a las que ya se les pidieron soportes: agradecer a quien ya los envió y explicar a quien no cómo enviarlos. El asistente respondía que «no podía mezclar» eso en un correo masivo porque el proceso de soportes solo sabía pedir cargos nuevos (y su regla prohíbe usar `proponer_envio_correo` para ello).

**Formato que se pide (fuente única: `INSTRUCCIONES_ENVIO_SOPORTES`, `core/soportes/redactarCorreoSoportes.ts`).**
1. Cada soporte en un correo **aparte y nuevo** a `asistente@wobagroup.com`; no se responde al correo de la solicitud.
2. Asunto con el **detalle del gasto, el valor, la moneda en que se pagó y la empresa**. Ejemplo: «Uber traslado aeropuerto · 12,50 EUR · Footprint».
3. Documento original adjunto (PDF o foto legible).

Ese mismo texto sale ahora en el correo de solicitud de soportes (texto plano y HTML), en la hoja «Read me» de seguimiento y en el aviso, y está en la regla fija del asistente (`reglaProceso.ts`, puntos 2 y 11), con prueba.

**Código (todo en `core/soportes/`, salvo la herramienta).**
- `avisoFormato.ts`: lógica pura — destinatarios (una persona = un correo, agrupados por email; solo con email confirmado; sin sociedades; exclusión por nombre) y redacción del aviso.
- `avisoFormatoStore.ts`: estado durable (`_soportes_avisos_formato`, 14 días) mientras se decide.
- `avisoFormatoTelegram.ts`: resumen con botones `sop_av` (ver correo), `sop_ae` (enviar, solo superadmin, en `ACCIONES_SENSIBLES` y entrega durable) y `sop_ac` (cancelar); envío con clave de idempotencia por aviso+persona+destinatario.
- `core/tools/avisoFormatoSoportes.ts`: herramienta `preparar_aviso_formato_soportes` (solo prepara; el envío es el botón).
- `solicitudesSoportesSheet.ts`: `leerSolicitantes()` (quién recibió alguna solicitud, por empresa).

**Reglas.** Nada sale sin «Enviar» de un superadministrador; nunca se adivina un email; no se escribe a sociedades; el correo es de texto fijo (sin IA, sin coste).
