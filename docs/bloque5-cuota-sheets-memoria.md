# Bloque 5 — cuota de Sheets y continuidad de memoria

Fecha: 2026-09-11. Base recuperable: `64b436179728c62e6f579854f2f5cda30cd0bc1d`.
Rama aislada: `codex/wobi-bloque5-sheets-quota`.

## Incidencia real

Producción agotó la cuota de lecturas por minuto de Google Sheets durante el
resumen diario de pendientes. El resumen recorre más de veinte stores y cada
pestaña ejecutaba su propio `spreadsheets.get` del catálogo completo, seguido
de otra lectura para encabezados y otra para datos. La ráfaga terminó también
impidiendo que `conversationStore` guardara la memoria de un turno.

## Cambio

- Una sola fotografía estructural —título, gridId y número de filas— se
  comparte entre todos los stores del proceso mediante single-flight.
- Un error de metadata no se cachea; la operación siguiente puede recuperarse.
- La primera lectura de cada pestaña incluye la fila de encabezados y los
  valida dentro del mismo request que ya trae los datos.
- La memoria conversacional reutiliza el mismo catálogo compartido.
- `/health` expone solicitudes, cargas reales, reutilizaciones, esperas
  compartidas y errores de metadata, sin nombres de pestañas ni datos.
- El resumen pasa de las 19:00 a las 19:10 para no competir con el chequeo
  horario de correo, que también usa Sheets en el minuto 0.
- No se cachean celdas ni información financiera y no se sirven datos viejos.

En el arranque del resumen, el tramo común pasa aproximadamente de tres
lecturas por pestaña a una lectura de metadata total más una lectura por
pestaña. Las escrituras conservan verificación posterior y los mutex
existentes.

## Reversión

Revertir este bloque restaura las consultas anteriores. No cambia esquemas,
datos, secretos, APIs de IA ni variables de Railway.


## 2026-10-05 — Medición del uso y ráfagas de arranque

Contexto: 429 de Google a las 14:05 (≈3 min tras un despliegue) sin saber qué los provocaba. El front del Cerebro NO lee Sheets directamente (solo llama a `/api/cerebro/*`); el panel mantiene 11 secciones al día (TTL 45–60 s) solo si alguien lo mira, y el refresco forzado solo ocurre con «actualizar» manual. La carga estable medida en `/health → cuotaSheets` fue de 2–14 lecturas/min sobre 50.

- **Medición:** `limitadorSheets.ts` anota cada petición (tipo, prioridad, hoja abreviada, pestaña y módulo del proyecto que la hizo, sacado de la pila) durante 10 min. Se consulta en `GET /admin/uso-sheets?secret=ADMIN_SECRET` (los nombres de pestañas no van a `/health`, que es público). El origen es «(sin origen)» cuando la pila asíncrona no llega al código del proyecto.
- **Arranque:** el precalentado del panel espera 75 s (`WOBI_CEREBRO_PRECALENTAR_MS`) en vez de lanzarse en el segundo cero junto a las reconciliaciones; un visitante anterior igualmente carga su sección.
- **SIGTERM:** el contenedor viejo detiene el refresco del panel de inmediato; antes seguía leyendo Sheets durante todo el drenado, solapado con el nuevo.
- **Quedó fuera a propósito** (decidir con datos de `/admin/uso-sheets`): cachés de escritura directa en los almacenes calientes, cuenta de servicio separada para el panel, Postgres para almacenes calientes, petición de más cuota en Google Cloud.
