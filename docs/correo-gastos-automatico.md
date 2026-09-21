# Revisión automática de correo y revisión manual

La entrada existente `revisarCorreoNuevo` (cron, comando y herramienta de revisión) ejecuta primero el pase automático y después sincroniza la cola manual. No se añade otro cron ni otra cola de correo. La revisión manual conserva su aprobación individual y el orden del mensaje pendiente más antiguo al más reciente.

El pase programado se ejecuta cada dos horas en días hábiles y dos veces al día los fines de semana. Para evitar ruido, solo dos pases diarios publican un informe consolidado; las demás ejecuciones permanecen silenciosas salvo que necesiten comunicar un fallo accionable. Una orden manual responde siempre con su resultado y revisa exhaustivamente todos los correos no leídos del lote, sin heredar el máximo reducido de análisis del cron. Los límites manuales (`WOBI_MAIL_MANUAL_MAX_THREADS_PER_RUN`, `WOBI_MAIL_MANUAL_MAX_RUN_MS` y `WOBI_MAIL_MANUAL_ANALYSIS_CONCURRENCY`) controlan tamaño, duración y paralelismo sin recortar silenciosamente el lote normal de trabajo.

## Cuándo se registra un gasto

Se leen todos los mensajes sin leer, incluidos los archivados, excepto spam y papelera. Se descargan el cuerpo completo, el contexto del hilo y los adjuntos. Una lectura fallida, un formato que no se puede analizar o un límite de tamaño deja el mensaje pendiente; no se clasifica un fragmento como si fuera el correo completo.

Para automatizar deben cumplirse todas las comprobaciones:

- Ticket/recibo identificado con confianza alta y evidencia de empresa, proveedor, fecha e importe.
- Empresa habilitada y contacto único exacto en su Holded, admitiendo únicamente alias confirmados previamente.
- Cuenta contable respaldada por una corrección confirmada o precedentes válidos del proveedor.
- Consultas completas, sin gasto existente ni propuesta pendiente equivalente.
- Un único cargo bancario real, pendiente, con saldo conciliado cero, moneda y fecha coincidentes. No se fabrican movimientos.
- Comprobante único por fuente y sin reservas previas del documento, archivo o movimiento.

Las tolerancias existentes identifican candidatos: un céntimo en moneda nativa, o el mayor entre cinco céntimos y 2% para un equivalente explícito en otra moneda. Una diferencia en moneda nativa pasa a revisión; no se cambia el importe del recibo para forzar la conciliación. Con equivalente explícito se registra el cargo real y se conserva la información de ambos importes.

## Única ruta de creación y conversión manual a ticket

La fase automática no mantiene reglas paralelas para crear compras. Reutiliza las mismas funciones durables del flujo uno a uno para inferir la cuenta desde los precedentes y correcciones confirmadas, componer las etiquetas funcionales, crear o corregir la compra, adjuntar el comprobante y conciliar el movimiento. Si esa memoria no permite demostrar una cuenta o cualquier otro dato, el correo queda para revisión manual; no se sustituye por una cuenta, etiqueta o valor por defecto.

Se crea una compra en borrador, se adjunta el comprobante original, se concilia contra el movimiento real y se releen los resultados. Se utiliza el procedimiento acordado: **después se convierte cada compra a ticket manualmente en Holded**. Las identidades técnicas de idempotencia se conservan en los registros internos y en las notas privadas necesarias para recuperación, nunca como etiquetas visibles. El resumen indica empresa, importe e ID de cada compra. La automatización no hace la conversión a ticket.

Solo se marca leído el mensaje concreto cuando todo su contenido ha quedado atendido y las operaciones externas quedaron verificadas. Si contiene otras solicitudes, se conserva sin leer aunque su gasto ya esté creado y conciliado. Los mensajes no elegibles siguen en la cola manual. La identidad exige conjuntamente `threadId` y `messageId`: una acción antigua de otro mensaje del mismo hilo nunca puede cerrar el mensaje activo. Los hilos con revisión manual o conversación automática activa se respetan.

## Coordinación, reintentos y memoria

PostgreSQL conserva operaciones, reservas únicas y eventos. Un bloqueo por buzón coordina cron, comandos y activación manual; un bloqueo por empresa coordina escrituras Holded. El control de versión rechaza actualizaciones de una ejecución obsoleta.

El análisis semántico se conserva por buzón, mensaje, huella completa y versión de política. Un correo inmutable no vuelve a consumir una llamada de IA cada hora; las evidencias reales de proveedor, duplicados, cuenta contable y movimiento bancario sí se consultan de nuevo, de modo que un gasto puede volverse elegible cuando llegue su movimiento o se confirme una corrección.

Antes de cada escritura externa se guarda su intención. Ante un timeout, **no se repite el POST**. Las ejecuciones siguientes intentan recuperar el resultado mediante lecturas y etiquetas, verifican el comprobante y comprueban movimiento, pago y saldo de la compra. Si no pueden demostrar el resultado, conservan la reserva y lo informan. Una operación incierta pausa nuevas escrituras en esa empresa para evitar duplicados; otros correos y empresas pueden seguir evaluándose.

Los eventos guardan análisis, evidencia, decisión, regla, versión y resultado. Son observaciones auditables; no se convierten por sí solos en reglas de confianza. Las operaciones completadas también alimentan el registro existente de gasto por correo y asignación contable. Los alias, precedentes contables y correcciones confirmadas usan la memoria existente compartida con el flujo uno a uno. Una funcionalidad nueva debe partir de esas fuentes de verdad y no crear una ruta paralela para un proceso ya aprendido. El contenido de un correo nunca puede modificar las reglas de autorización.

## Configuración y puesta en marcha

El código se entrega desactivado por defecto; instalarlo no ejecuta gastos reales.

1. Configurar una base PostgreSQL persistente en `WOBI_MAIL_DATABASE_URL`, con acceso restringido al servicio y copias de seguridad. Los bloqueos necesitan conexiones de sesión; no usar un pooler en modo transacción.
2. Mantener las credenciales existentes de Gmail, Holded, Sheets y Anthropic. Configurar `GMAIL_IMPERSONATE_EMAIL` y el chat de avisos.
3. El arranque del servicio aplica el esquema idempotente antes de abrir el servidor. `npm run mail:auto:setup` permite prepararlo o repararlo manualmente; ninguna de las dos rutas modifica Gmail ni Holded.
4. Definir `WOBI_MAIL_AUTO_COMPANIES=WOBA,EWORKS,Footprint` (o la lista habilitada) y `WOBI_MAIL_AUTO_MODE=simulate`. Reiniciar el servicio y lanzar la revisión existente. La simulación analiza y audita sin reservar gastos, escribir en Holded ni marcar leído.
5. Tras comprobar la simulación, establecer `WOBI_MAIL_AUTO_MODE=execute` y reiniciar. El cron existente y las órdenes usarán automáticamente el mismo flujo.

`npm run mail:auto:status` muestra modo, empresas y operaciones por estado. `WOBI_MAIL_AUTO_KILL_SWITCH=true` desactiva el pase automático; tras cambiar el entorno hay que reiniciar el proceso. No elimina las reservas ni oculta operaciones incompletas.

`WOBI_MAIL_SCHEDULED_REVIEW_ENABLED=false` desactiva únicamente la revisión general programada del buzón. `/revisarcorreo` y `/admin/run-gmail-check` siguen disponibles bajo pedido. Las conversaciones automáticas de contactos e hilos previamente aprobados continúan cada 15 minutos mediante una sola consulta de Gmail filtrada por remitente; no recorren el buzón completo y solo usan IA cuando existe un mensaje nuevo. `WOBI_AUTOREPLY_MAX_THREADS_PER_RUN` limita cuántos hilos pueden procesarse por pasada (3 por defecto). El vigilante de trabajos manuales también permanece activo para detectar bloqueos.

Si una operación continúa incierta, revisar su evento, etiquetas y estado real en Holded antes de intervenir. No borrar reservas ni cambiarla a rechazada para forzar un reintento de un POST que pudo ejecutarse. Resolver primero la operación externa y reanudar la revisión; la recuperación de resultados confirmados es por lectura.

## Verificación

`npm run test:mail-auto` ejecuta los casos con Gmail/Holded simulados. Para probar además las reservas, bloqueos, auditoría y control de versiones contra PostgreSQL real, pasar `WOBI_MAIL_TEST_DATABASE_URL` apuntando exclusivamente a una base desechable. Esa prueba vacía las tablas de automatización de dicha base; nunca reutilizar la base de producción.

Las pruebas cubren elegibilidad, duplicados, lectura completa, simulación, correos mixtos, interrupciones, recuperación, errores de Gmail, adjuntos reales y conciliación. No se realizaron escrituras reales en Gmail ni Holded durante el desarrollo.
