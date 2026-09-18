# Revisión automática de correo y revisión manual

La entrada existente `revisarCorreoNuevo` (cron, comando y herramienta de revisión) ejecuta primero el pase automático y después sincroniza la cola manual. No se añade otro cron ni otra cola de correo. La revisión manual conserva su aprobación individual y el orden del mensaje pendiente más antiguo al más reciente.

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

## Borradores y conversión manual a ticket

Se crea una compra mediante la API con `draft: true`, se adjunta el comprobante original, se concilia contra el movimiento real y se verifican los resultados. Se utiliza el procedimiento acordado: **después se convierte cada compra a ticket manualmente en Holded**. No se exige soporte de un tipo ticket nativo para ejecutar este flujo.

Las compras llevan la etiqueta `wobi-ticket-pendiente` y una etiqueta única de operación. El resumen indica empresa, importe e ID de cada compra. La conversión manual debe incluir la retirada de `wobi-ticket-pendiente` cuando corresponda. La automatización no hace esa conversión.

Solo se marca leído el mensaje concreto cuando todo su contenido ha quedado atendido. Si contiene otras solicitudes, se conserva sin leer aunque su gasto ya esté creado y conciliado. Los mensajes no elegibles siguen en la cola manual. Los hilos con revisión manual o conversación automática activa se respetan.

## Coordinación, reintentos y memoria

PostgreSQL conserva operaciones, reservas únicas y eventos. Un bloqueo por buzón coordina cron, comandos y activación manual; un bloqueo por empresa coordina escrituras Holded. El control de versión rechaza actualizaciones de una ejecución obsoleta.

El análisis semántico se conserva por buzón, mensaje, huella completa y versión de política. Un correo inmutable no vuelve a consumir una llamada de IA cada hora; las evidencias reales de proveedor, duplicados, cuenta contable y movimiento bancario sí se consultan de nuevo, de modo que un gasto puede volverse elegible cuando llegue su movimiento o se confirme una corrección.

Antes de cada escritura externa se guarda su intención. Ante un timeout, **no se repite el POST**. Las ejecuciones siguientes intentan recuperar el resultado mediante lecturas y etiquetas, verifican el comprobante y comprueban movimiento, pago y saldo de la compra. Si no pueden demostrar el resultado, conservan la reserva y lo informan. Una operación incierta pausa nuevas escrituras en esa empresa para evitar duplicados; otros correos y empresas pueden seguir evaluándose.

Los eventos guardan análisis, evidencia, decisión, regla, versión y resultado. Son observaciones auditables; no se convierten por sí solos en reglas de confianza. Las operaciones completadas también alimentan el registro existente de gasto por correo y asignación contable. Los alias y las correcciones confirmadas siguen usando la memoria existente. El contenido de un correo nunca puede modificar las reglas de autorización.

## Configuración y puesta en marcha

El código se entrega desactivado por defecto; instalarlo no ejecuta gastos reales.

1. Configurar una base PostgreSQL persistente en `WOBI_MAIL_DATABASE_URL`, con acceso restringido al servicio y copias de seguridad. Los bloqueos necesitan conexiones de sesión; no usar un pooler en modo transacción.
2. Mantener las credenciales existentes de Gmail, Holded, Sheets y Anthropic. Configurar `GMAIL_IMPERSONATE_EMAIL` y el chat de avisos.
3. Ejecutar `npm run mail:auto:setup` para aplicar el esquema de las tres tablas. No modifica Gmail ni Holded.
4. Definir `WOBI_MAIL_AUTO_COMPANIES=WOBA,EWORKS,Footprint` (o la lista habilitada) y `WOBI_MAIL_AUTO_MODE=simulate`. Reiniciar el servicio y lanzar la revisión existente. La simulación analiza y audita sin reservar gastos, escribir en Holded ni marcar leído.
5. Tras comprobar la simulación, establecer `WOBI_MAIL_AUTO_MODE=execute` y reiniciar. El cron existente y las órdenes usarán automáticamente el mismo flujo.

`npm run mail:auto:status` muestra modo, empresas y operaciones por estado. `WOBI_MAIL_AUTO_KILL_SWITCH=true` desactiva el pase automático; tras cambiar el entorno hay que reiniciar el proceso. No elimina las reservas ni oculta operaciones incompletas.

Si una operación continúa incierta, revisar su evento, etiquetas y estado real en Holded antes de intervenir. No borrar reservas ni cambiarla a rechazada para forzar un reintento de un POST que pudo ejecutarse. Resolver primero la operación externa y reanudar la revisión; la recuperación de resultados confirmados es por lectura.

## Verificación

`npm run test:mail-auto` ejecuta los casos con Gmail/Holded simulados. Para probar además las reservas, bloqueos, auditoría y control de versiones contra PostgreSQL real, pasar `WOBI_MAIL_TEST_DATABASE_URL` apuntando exclusivamente a una base desechable. Esa prueba vacía las tablas de automatización de dicha base; nunca reutilizar la base de producción.

Las pruebas cubren elegibilidad, duplicados, lectura completa, simulación, correos mixtos, interrupciones, recuperación, errores de Gmail, adjuntos reales y conciliación. No se realizaron escrituras reales en Gmail ni Holded durante el desarrollo.
