# WOBI — bloque 2: concurrencia controlada

Fecha: 2026-09-10. Base recuperable: merge `ebb5aa0cc013214088ac1bcee3dc79407e6a2ced` (bloque 1). Rama aislada: `codex/wobi-bloque2-concurrencia`.

## Resultado

- Cuando Claude pide varias consultas independientes en una misma respuesta, WOBI ejecuta en paralelo únicamente grupos contiguos de herramientas expresamente auditadas. Los resultados vuelven al modelo en el orden original aunque terminen en otro orden.
- Primera lista permitida: resumen y detalle de cashflow, saldos bancarios y calendario. La pertenencia al modo rápido no basta: cada herramienta necesita además la marca explícita de lectura paralela y su recurso.
- Cupos predeterminados por proceso Railway: 4 lecturas globales, 2 por identidad compartida entre Telegram y web, y 1 lectura de cashflow. El límite específico de cashflow evita agravar la cuota de Google Sheets observada en producción.
- Toda herramienta de escritura o no auditada actúa como barrera exclusiva: espera a las lecturas previas, bloquea las posteriores y no se ejecuta si falla el grupo de lectura anterior. Por ahora las escrituras se serializan globalmente, una elección conservadora hasta auditar claves idempotentes por integración.
- Una escritura se marca como posible efecto solo cuando obtiene el cupo, inmediatamente antes de entrar al handler. Si vence esperando admisión, nunca empieza ni se marca como ejecutada.
- Máximo 32 operaciones esperando y 30 s para obtener admisión. Las lecturas que superan su timeout visible conservan el cupo hasta que la operación subyacente termina, evitando superar el límite real a espaldas del usuario.
- Los flujos anidados reutilizan una reserva exclusiva para evitar interbloqueos. Una reserva de lectura nunca puede convertirse en escritura silenciosamente.
- El apagado controlado de Railway espera también las herramientas subyacentes que continúen después de un timeout visible. `/health` expone solo cantidades de herramientas activas y pendientes, sin identidad, argumentos ni datos de negocio.
- Registros estructurados por ejecución: herramienta, fase, espera y duración. No incluyen chatId, argumentos, resultados ni errores crudos.

## Qué mejora y qué no

Mejora análisis que consultan simultáneamente fuentes independientes. En la validación final, una simulación determinista de ocho lecturas de 20 ms, con dos cupos por identidad, pasó de aproximadamente 170 ms a 83 ms, con las mismas ocho llamadas y los mismos resultados. Es una prueba local, no una promesa de latencia de producción.

Este bloque no reduce llamadas, tokens ni coste directo: reduce tiempo de espera. Tampoco procesa dos mensajes consecutivos de la misma conversación a la vez; se conserva el orden del historial entre Telegram y web. Diferentes identidades ya pueden avanzar en paralelo. Para análisis verdaderamente independientes del mismo usuario se necesita el modo de trabajos del bloque 4, con estado y memoria separados.

La coordinación es local a una instancia. WOBI tiene una sola réplica actualmente; no aumentar réplicas antes de contar con coordinación e idempotencia durables. Las acciones de botones, cron y otros caminos que no pasan por el registro conversacional no quedan serializadas por este planificador; conservan sus controles actuales y se auditarán antes de unificarlos.

## Seguridad, coste y reversión

No se añadieron dependencias, migraciones, secretos, llamadas de prueba a IA ni operaciones financieras. No se modificaron las rutas API ni la política de uso de suscripciones/API. El paralelismo puede aumentar ráfagas, por eso los cupos son conservadores y cashflow permanece en uno.

Reversión inmediata de paralelismo: configurar `WOBI_PARALLEL_READS_ENABLED=false`; los lotes vuelven a ser secuenciales y permanecen los bloqueos de seguridad. Reversión completa: revertir únicamente el commit de merge de este bloque mediante una nueva revisión, sin resetear `main`.

## Verificación requerida para publicar

- Typecheck, 63 pruebas (59 TypeScript + 4 del worker) y build backend/frontend.
- Pruebas de cupo global, por identidad y cashflow; orden de resultados; barreras; equidad; saturación; cancelación antes de admisión; timeout con trabajo subyacente; nesting y recuperación tras fallo.
- Pruebas del registro real con handlers simulados, sin red ni escrituras reales.
- Tras el merge: commit exacto en Railway, instancia RUNNING, `/health`, `/cerebro/`, acceso al chat sin sesión y logs iniciales.
- Mantener el interruptor listo y observar varios ciclos reales. Un arranque correcto no demuestra estabilidad sostenida.

Punto de recuperación anterior al despliegue: Railway `c20d1a7a-1c61-4492-a9f5-2935d061d1d6`, commit `ebb5aa0cc013214088ac1bcee3dc79407e6a2ced`, verificado en estado SUCCESS/RUNNING. Preferir revertir el commit de este bloque para no descartar correcciones posteriores.
