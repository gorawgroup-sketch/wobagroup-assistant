# Derivación del navegador a Telegram

El front reconoce solicitudes operativas explícitas para crear/registrar facturas y gastos, revisar/procesar correos o conciliar movimientos, además de pedir abrir Telegram. Explica con la voz existente que deben procesarse en ese canal y abre el chat fijo de WOBi. Es navegación, nunca ejecución. No envía mensajes, no pasa texto empresarial por URL ni almacena la petición fuera del panel. La petición queda visible para copiar y enviar en Telegram, donde siguen aplicando la identidad, permisos y confirmaciones propias del bot.

La apertura es inmediata desde el envío; no espera al final del audio porque el navegador puede perder la activación del usuario. Si bloquea la ventana (especialmente después del dictado), se muestra un aviso y un enlace para abrir el chat con un clic. Telegram puede requerir su propio login.

No se derivan automáticamente consultas desconocidas, fallos de fuentes, agentes pendientes ni lecturas sin contrato como costos de hoy. El clasificador local cubre estas intenciones explícitas, no lenguaje abierto. Para ampliar la derivación semántica, Claude debe añadir una señal validada al contrato de `/conversar`; Codex no modifica el backend ni el rol del navegador.

Preguntas de orientación como «si necesito ejecutar una operación cómo me puedes ayudar» ofrecen abrir Telegram y esperan un sí/no, hablado o mediante botones. La oferta vive únicamente mientras el panel está abierto; «sí» sin esa oferta continúa en el servidor y no abre Telegram. Reiniciar o enviar otra petición elimina la oferta.

## Revisión financiera (11-10-2026)

Una solicitud explícita de revisar o analizar estados financieros, balances contables o cuentas anuales recibe orientación hablada: no se analiza desde el navegador; se ofrece abrir Telegram. El sí conserva el texto original, disponible para copiar; el no mantiene al usuario en el front. Esto no consulta datos financieros ni concede permisos: Telegram comprobará su propia identidad y disponibilidad. Los errores de fuente y la navegación interna siguen su camino existente.

Pendiente de Claude: una clasificación autorizada en el contrato del servidor para derivaciones más amplias, y un puente autenticado e idempotente antes de enviar solicitudes al bot. El front no afirma que el mensaje haya sido enviado ni que una revisión se haya realizado.
