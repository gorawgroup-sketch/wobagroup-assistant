# Cola manual de correo en PostgreSQL

Con `WOBI_MAIL_DATABASE_URL`, el arranque aplica el esquema y copia una sola vez
`_cola_revision_correo` a `wobi_mail_queue_rows`. La namespace incluye
`CASHFLOW_SHEET_ID`. No cambiar ese identificador para sortear un fallo.

La importación usa una transacción y bloqueo, compara todas las columnas,
conserva las identidades Gmail y las acciones ya resueltas y registra la migración
solo después de verificarlas. Sheets queda intacto como respaldo histórico.
Un fallo aborta el arranque; no activa una cola vacía ni vuelve silenciosamente
a Sheets. Los arranques posteriores no necesitan leer esa hoja.

Las mutaciones comparten el coordinador distribuido de correo y el mutex local.
Los IDs PostgreSQL son estables al borrar filas. Las demás hojas (aprendizajes,
propuestas, etc.) siguen usando sus almacenes existentes.

Desplegar sin una revisión de correo en curso. Verificar el mensaje
`[correo-cola] Migración PostgreSQL verificada` y después `/healthz`.
No ejecutar una revisión masiva para probar la migración.

Para revertir después de usar PostgreSQL, detener los consumidores y exportar
primero la cola ACTUAL de PostgreSQL, incluidas acciones resueltas, a un respaldo.
No desplegar una versión antigua ni quitar la URL de base de datos directamente:
la hoja conservada representa el instante de migración, no el estado actual.
Restaurar y verificar la cola actual en el almacén de destino antes de reiniciar.

Pruebas: `WOBI_TEST_DATABASE_URL` debe apuntar exclusivamente a una base desechable.
CI usa PostgreSQL 15 local al job. Las pruebas verifican importación concurrente,
rollback, reinicio sin Sheets, identidad y resolución idempotente de callbacks.
