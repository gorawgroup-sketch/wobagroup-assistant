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
