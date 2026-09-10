# WOBI — bloque 3: cuotas y eficiencia de lectura

Fecha: 2026-09-10. Base recuperable: merge `11e929f8079611e8cc8e00597ce127c68ae48dc9` (bloque 2). Rama aislada: `codex/wobi-bloque3-cache`.

## Resultado

- Caché breve y local al proceso para las lecturas repetidas de resumen y detalle de cashflow, cuentas bancarias de Holded y calendario de Holded. Los TTL predeterminados son 10 s para cashflow/cuentas y 30 s para eventos; se pueden reducir, ampliar dentro de límites conservadores o desactivar en la configuración de Railway.
- `single-flight`: si varias solicitudes piden la misma fuente mientras la primera sigue cargando, comparten esa única consulta. Una prueba determinista con 20 solicitudes simultáneas produjo 1 carga y 19 llamadas evitadas, con el mismo resultado para las 20.
- Los fallos nunca se cachean y no existe retorno silencioso de un valor vencido. Si la fuente falla, WOBI informa el error normal; no presenta como actual una fotografía anterior.
- Cada lectura cacheada devuelve origen, antigüedad y TTL. Las herramientas visibles de resumen/detalle de cashflow, numeración, saldos y calendario incorporan `[Frescura: ...]`; el prompt obliga a conservar esa nota en la respuesta.
- Las escrituras de cashflow, conciliaciones y creación de eventos invalidan sus cachés antes y después. Esto cubre carreras con lecturas en curso y respuestas de red perdidas después de que el proveedor hubiera aceptado el cambio.
- Los crons ceden hasta 30 s cuando coinciden con herramientas interactivas activas o en cola. Después continúan para no sufrir inanición; un cron ya iniciado nunca se pausa ni se cancela a medias.
- `/health` expone solo contadores agregados desde el último arranque: cargas, aciertos de caché, lecturas compartidas, llamadas evitadas, invalidaciones y errores. No contiene argumentos, resultados, identidades ni secretos.

## Impacto de coste y rendimiento

Este bloque reduce llamadas y presión de cuota en Google Sheets y Holded, además de la latencia en ráfagas. No reduce por sí mismo los tokens de Claude ni permite atribuir un ahorro monetario directo de API de IA. Sheets y Holded no tienen aquí un precio marginal por cada GET, por lo que el beneficio económico directo medible es evitar sobrecuotas, bloqueos y trabajo repetido; el ahorro indirecto debe calcularse con datos reales de `/health` durante varios ciclos.

Una ráfaga idéntica dentro del TTL puede reducir hasta `N` consultas externas a una sola. No se proyecta ese máximo como ahorro mensual: consultas separadas por más del TTL siguen leyendo la fuente y las claves/empresas diferentes no se mezclan.

Las métricas son de proceso y se reinician con cada despliegue. No se añadió persistencia para no crear nuevas escrituras, coste ni migraciones en este bloque.

## Límites deliberados

- La caché y la deduplicación son locales a una instancia. Producción usa una réplica; no aumentar réplicas hasta el bloque 4 de idempotencia y coordinación durable.
- Los TTL son cortos porque el Sheet también puede cambiar manualmente fuera de WOBI; esos cambios externos se observan como máximo al vencer el TTL.
- La prioridad del chat actúa antes de iniciar cada cron. No interrumpe un cron ya empezado porque hacerlo puede dejar operaciones externas con resultado incierto.
- Se cachean fotografías completas y se filtran después. En eventos esto permite reutilizar una sola paginación para rangos de días distintos sin confundir empresas.
- No se añadieron paquetes, secretos, llamadas reales de prueba a Sheets/Holded/IA ni escrituras financieras.

## Configuración y reversión

- `WOBI_CASHFLOW_CACHE_TTL_MS=10000` (0–60 s).
- `WOBI_HOLDED_CACHE_TTL_MS=10000` (0–60 s).
- `WOBI_HOLDED_EVENTS_CACHE_TTL_MS=30000` (0–120 s).
- `WOBI_CRON_INTERACTIVE_GRACE_MS=30000` (0–120 s; `0` desactiva la cesión del cron).

Para una reversión operativa inmediata sin código, fijar los tres TTL a `0` y la gracia a `0`; la deduplicación simultánea se conserva, pero la reutilización posterior queda anulada. Reversión completa: revertir únicamente el commit de merge de este bloque mediante una nueva revisión, sin resetear `main` ni eliminar las rutas API existentes.

## Verificación para publicar

- Typecheck, 74 pruebas (70 TypeScript + 4 del worker Claude Max) y build backend/frontend.
- TTL y metadatos de antigüedad; deduplicación simultánea; invalidación durante una lectura; errores no cacheados; ausencia de temporizadores permanentes; ráfaga de 20 solicitudes.
- Prioridad inmediata, espera hasta liberar chat, límite contra bloqueo indefinido y desactivación explícita.
- Sin pruebas contra datos reales ni acciones externas.
- Tras el merge: comprobar commit exacto en Railway, deployment SUCCESS/RUNNING, `/health`, `/cerebro/` y acceso del chat sin sesión.

Punto de recuperación previo: deployment Railway `7ebaecdf-02d2-49f6-b865-4f5eb5afbec0`, commit `11e929f8079611e8cc8e00597ce127c68ae48dc9`, verificado en SUCCESS/RUNNING al cerrar el bloque 2.
