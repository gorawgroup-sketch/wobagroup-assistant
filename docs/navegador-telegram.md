# Derivación del navegador a Telegram

El front reconoce solicitudes operativas explícitas para crear/registrar facturas y gastos, revisar/procesar correos o conciliar movimientos, además de pedir abrir Telegram. Explica con la voz existente que deben procesarse en ese canal y abre el chat fijo de WOBi. Es navegación, nunca ejecución. No envía mensajes, no pasa texto empresarial por URL ni almacena la petición fuera del panel. La petición queda visible para copiar y enviar en Telegram, donde siguen aplicando la identidad, permisos y confirmaciones propias del bot.

La apertura es inmediata desde el envío; no espera al final del audio porque el navegador puede perder la activación del usuario. Si bloquea la ventana (especialmente después del dictado), se muestra un aviso y un enlace para abrir el chat con un clic. Telegram puede requerir su propio login.

No se derivan automáticamente consultas desconocidas, fallos de fuentes, agentes pendientes ni lecturas sin contrato como costos de hoy. El clasificador local cubre estas intenciones explícitas, no lenguaje abierto. Para ampliar la derivación semántica, Claude debe añadir una señal validada al contrato de `/conversar`; Codex no modifica el backend ni el rol del navegador.
