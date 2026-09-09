# WOBI — bloque 1: esperas acotadas y recuperación segura

Fecha: 2026-09-09. Base recuperable: `aea82c72e51685b87d37a9d9389a266e184482fa`.
Trabajo aislado en `codex/wobi-bloque1-recuperado`, sin modificar la copia de desarrollo de Carlos.

## Alcance implementado

- Gateway Anthropic: límite total por solicitud (incluye cuerpo de respuesta y eventuales reintentos), aborto del transporte y cero reintentos internos por defecto. Haiku 60 s, Sonnet 120 s, otros 180 s. Las variables opcionales están documentadas en `.env.example`.
- Si Haiku no está disponible, se intenta Sonnet; no se vuelve al mismo Haiku que acaba de fallar. El respaldo existente desde Sonnet solo puede reiniciar el turno si no empezó ninguna herramienta con posibles efectos.
- Marca de efectos ANTES de ejecutar una herramienta de escritura. Un error de esa herramienta se propaga, no se devuelve como resultado que invite al modelo a repetirla. Los errores posteriores, incluidos los 400 y los fallos de guardado de la respuesta, no reinician automáticamente el pedido. Ambos canales muestran un aviso de incertidumbre y piden consultar el estado antes de repetir acciones.
- Las lecturas auditadas de resumen/detalle de cashflow, saldos y calendario dejan de esperar a los 45 s. Un timeout termina el análisis, sin una cadena de reintentos del modelo. Este límite NO cancela la lectura subyacente: podría terminar después. No se aplica a escrituras, OCR, lecturas con modelos anidados ni herramientas no auditadas.
- La herramienta mixta de gestión de contactos de autorespuesta ya no está clasificada como solo lectura. No debe estar disponible en el modo web de consulta.
- Telegram: acuse vacío automático al segundo si el handler aún no respondió. Nunca sustituye la autorización. Los avisos posteriores (incluido acceso denegado o propuesta caducada) se conservan mediante mensaje privado al usuario; dependen de que Telegram permita entregarlo. Acuses concurrentes deduplicados dentro del proceso, transporte acotado a 4 s y sin reintentos ocultos. Los callbacks internos `seleccion_...` no se envían a Telegram.
- Cola por identidad compartida web/Telegram extraída y probada. Mantiene el orden del historial; otras identidades siguen avanzando. No libera una escritura en curso a la fuerza.
- El chat web rechaza el mismo identificador con texto diferente también durante la ejecución, no solo al consultar el registro persistido. Una reserva fallida no se reejecuta automáticamente.
- El apagado controlado también tiene en cuenta solicitudes web activas, además de Telegram y jobs. Conserva la ventana existente de 55 s dentro de los 60 s de drenaje de Railway.
- No se borra el historial ante un rechazo de formato. La recuperación sin historial se limita a errores de estructura reconocibles y solo omite ese contexto en la solicitud aislada.

## Verificación

Pruebas locales sin llamadas facturables, sin credenciales de producción y sin crear operaciones de negocio:

- `npm run typecheck`.
- `npm test`: 43 pruebas (39 TypeScript + 4 del worker).
- `npm run build`: backend TypeScript y frontend Vite. Sigue existiendo un aviso de tamaño del bundle del frontend (~530 kB sin gzip); este bloque no cambia la interfaz ni sus dependencias.
- SDK Anthropic instalado con transporte simulado: 503 sin reintentos, aborto antes de cabeceras y durante un cuerpo bloqueado.
- Recuperación de cola tras timeout, orden por identidad y avance de una identidad independiente mientras otra escribe.
- Marca previa a escritura y bloqueo de reinicio tras error; las escrituras no se abandonan por el límite de lectura.
- Acuse temprano, mensajes de rechazo tardíos conservados, deduplicación concurrente y recuperación tras fallo del acuse.
- Identificadores web completados, en curso, conflictivos y fallidos.
- Políticas API, memoria/control diario, identidad web, tiempo real y worker existentes permanecen en la batería.

Una prueba local o `/health` correcto no demuestra por sí sola una conciliación real ni varios ciclos estables en producción. La publicación requiere comprobar por separado el commit en Railway, el arranque y las rutas públicas; no se generan escrituras financieras para probar.

## Límites explícitos y próximos bloques

No es todavía una garantía de ejecución exactamente una vez. La deduplicación de Telegram y las colas activas son locales a un proceso. Dos clics distintos, dos solicitudes nuevas equivalentes o un reinicio todavía requieren idempotencia persistente por acción y conciliación del resultado con cada proveedor. No aumentar las réplicas para buscar paralelismo antes de resolver esto.

Los 45/60/120/180 s son límites por operación, no por turno completo. Un análisis de varias llamadas puede tardar más. Siguen pendientes las esperas de preparación/permisos/historial, otras herramientas y la presión de cuotas de Sheets. No se ha añadido una carrera global que deje escrituras vivas al liberar la cola.

El apagado tiene un límite: un trabajo que dure más que la ventana de drenaje puede quedar interrumpido. El aviso de incertidumbre no sustituye un registro durable de cada paso. La cuota de Sheets también puede impedir guardar ese aviso; se registra el fallo sin repetir la acción.

1. **Bloque 2 — concurrencia controlada:** lecturas independientes con cupo global y por usuario; escrituras serializadas por recurso; orden del historial y estados de progreso compartidos entre canales. Verificar con pruebas de carga simulada antes de activar.
2. **Bloque 3 — cuotas y eficiencia:** agrupar lecturas de Sheets, caché breve con invalidación tras escrituras, deduplicar lecturas simultáneas y prioridades entre chat y cron. Mostrar antigüedad del dato, no presentar caché como dato recién consultado.
3. **Bloque 4 — ejecución durable:** cola persistente, idempotencia por acción, checkpoints y recuperación tras reinicio. La elección de infraestructura y cualquier gasto adicional requieren confirmación de Carlos.

## Costes

No se cambian proveedores, suscripciones, políticas de autorización API ni límites monetarios en este bloque. Las rutas API permanecen. Se eliminan reintentos ocultos por defecto y reinicios potencialmente duplicados; no hay una cifra mensual de ahorro verificable todavía.

Un timeout del cliente NO prueba que Anthropic no facturó la solicitud. El registro de fallo indica `consumo: no_confirmado` y metadatos de ejecución, sin prompts ni secretos. Comparar facturación y métricas reales durante varios ciclos antes de estimar ahorro.

## Publicación y reversión

Publicar el bloque como un commit/PR separado sobre la base revisada, comprobar que `main` no cambió y dejar que Railway construya desde GitHub. No hay migración de datos, eliminación de rutas, rotación de secretos ni nuevas dependencias.

Si hay regresión atribuible al bloque: revertir su commit de merge en una nueva revisión y volver a desplegar, conservando cambios ajenos posteriores. Como recuperación de emergencia, el despliegue anterior verificado era `bcefadce-9cc1-4f76-8643-81500ce6ba35` (base `aea82c7`); solo volver a él si no se perderían correcciones posteriores. No usar reset forzado de `main`.
