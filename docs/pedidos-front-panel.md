# Panel de pedidos de WOBi

Integración del contrato del PR #450 en `frontend-cerebro/src/modules/pedidos/`. No modifica el backend, los roles ni el procesamiento de Telegram.

## Uso

En «Pídele a WOBi», una solicitud operativa escrita o dictada prepara un borrador cuando el dispositivo está vinculado. El texto exacto devuelto por el servidor se muestra en un campo de solo lectura. Solo el botón **Confirmar y enviar** confirma ese borrador con su `textoHash`; un «sí» dictado no aprueba ni envía un pedido. Otras solicitudes pueden prepararse usando el campo del panel, hasta 4.000 caracteres. No se añade automáticamente la compañía seleccionada: el texto enviado es exactamente el revisado.

Sin vínculo, el panel ofrece generar el código del flujo existente. La persona escribe `/vincular CODIGO` en su Telegram y pulsa **Ya lo vinculé · comprobar**. No se vincula el dispositivo desde un pedido. Con el puente apagado se conserva la derivación al chat, con alternativa si el navegador bloquea la ventana.

## Recepción y seguimiento

- Se guarda únicamente el identificador del pedido en el navegador, separado por dispositivo/nombre. No se persiste el texto ni el hash de confirmación.
- Tras perder una respuesta, se consulta el mismo identificador y se puede reintentar la misma confirmación. Nunca se confirma automáticamente ni se fabrica otro pedido para reintentar.
- Se consulta cada tres segundos mientras esté recibido/procesando, se pausa en segundo plano y se detiene al terminar o fallar. Tras cinco minutos queda disponible la consulta manual, sin reenviar.
- Borradores caducados/perdidos por reinicio muestran que no se envió nada y permiten preparar otro. Los rechazos de texto no permitido dejan el campo editable; los errores de recepción/cuota mantienen la referencia.
- Resultado incierto nunca ofrece reenviar ni preparar otra solicitud desde ese seguimiento. El usuario debe verificar Telegram.
- La voz existente anuncia cambios de estado y el enjambre reacciona a ese audio. Las respuestas y aprobaciones reales siguen en Telegram. El historial opcional del front solo muestra texto posterior a la referencia, sin inventar correlación cuando la marca no aparece; no duplica los botones de decisión del chat existente.

## Verificación

Pruebas del cliente incluidas en `npm test`: estados, identidad por cabeceras, texto/hash exactos, referencia persistida, reintentos y errores. Chrome ejecuta el front compilado contra el router y coordinador durable reales con un repositorio en memoria y un procesador de prueba: ninguna consulta ni operación de negocio real. Las capturas de `docs/evidencias/pedidos-front/` son de ese entorno de prueba.

**La prueba de producción vinculada la realiza Carlos** desde su propio navegador: consulta de solo lectura «¿qué pagos de seguros hay pendientes?», revisar el borrador y confirmar una vez; comprobar la referencia y la respuesta en su Telegram. Codex solo verifica disponibilidad y bloqueo del dispositivo no vinculado en producción.
