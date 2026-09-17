# Hotfix de seguridad contable: cashflow ↔ Holded

Fecha: 2026-09-17  
Base desplegada auditada: `531b492` (PR #101)  
Rama del hotfix: `codex/cashflow-audit-release`

## Objetivo

Cerrar los hallazgos de la auditoría de Claude Code sin mezclar el trabajo en curso del resumen de pendientes ni ampliar el alcance funcional del cruce. El hotfix prioriza exactitud contable, conclusiones negativas con cobertura comprobada y bloqueo de escrituras ante ambigüedad.

## Relación con los hallazgos

| # | Hallazgo auditado | Tratamiento del hotfix |
|---|---|---|
| 1 | Duplicados excluidos en categorías sin `EMPRESA` | Corregido. Se consideran filas con empresa coincidente o sin empresa y se vuelve a leer antes de escribir. |
| 2 | Protección fail-closed absorbida por el cron | Corregido. El fallo se avisa por Telegram y una ejecución incompleta no actualiza la marca de último run. |
| 3 | Función inversa huérfana con contrato engañoso | Corregido. Se elimina el camino huérfano. |
| 4 | Movimiento atribuido que reaparece como faltante | Corregido. Los movimientos resueltos globalmente se excluyen de los faltantes visibles. |
| 5 | Atribución firme mediante semántica genérica | Corregido. Solo proveedor fuerte, importe exacto y unicidad bidireccional permiten atribución automática. |
| 6 | Reintroducción del criterio peligroso | Corregido. Se eliminan equivalencias operativas genéricas y los importes aproximados solo generan ambigüedad. |
| 7 | Fallo de gastos Holded tumba el informe combinado | Corregido. La fuente afectada queda marcada como cobertura incompleta sin producir conclusiones negativas. |
| 8 | Fecha de hoy calculada en UTC | Corregido. Se calcula la fecha civil en `Europe/Madrid`. |
| 9 | Documentos sin margen ni segunda lectura | Corregido. Se consulta una ventana de gracia y se exige una segunda lectura antes de afirmar ausencias. |
| 10 | Motores de matching divergentes | Mitigado de forma conservadora. Ambos respetan los mismos invariantes de exactitud; no se hace una refactorización amplia dentro del hotfix. |
| 11 | Lecturas de cuentas secuenciales | Conservado. Es una decisión de rendimiento que reduce presión sobre cuotas y no altera exactitud contable. |
| 12 | Descarte irreversible de autorespuesta con texto ambiguo | Excluido. Esa funcionalidad pertenece a trabajo sin confirmar y no forma parte de este release. |
| 13 | Corte silencioso después de tres filas vacías | Corregido. Continúa leyendo y declara un problema de cobertura. |
| 14 | Encabezados tomados de una tabla vecina | Corregido. Se limita la búsqueda a la geometría de cada sección. |
| 15 | Job de estructura ejecutado en fin de semana | Corregido. Se restaura el calendario laboral de España. |

## Barreras de seguridad

- Una coincidencia aproximada nunca escribe ni atribuye empresa automáticamente.
- Una posible duplicidad detectada en la relectura final bloquea la escritura y exige una revisión nueva.
- Una lectura parcial o fallida no permite afirmar que un gasto o movimiento está ausente.
- El hotfix no modifica datos de Holded, Google Sheets ni asientos existentes durante su instalación.

## Validación previa

- TypeScript: 0 errores.
- Suite de núcleo: 397 pruebas aprobadas.
- Frontend y scripts: 19 pruebas aprobadas.
- Build del frontend: aprobado.
- Verificación del motor PDF/Chromium: aprobada.
- `git diff --check`: aprobado.

## Operación y reversión

El despliegue debe salir desde `main` después de fusionar únicamente este hotfix. La versión anterior identificada para reversión es el deployment Railway `7b53632b-0916-4b15-826d-578600d5025a`, commit `531b492`. Después del despliegue se debe comprobar `/health`, los logs de arranque y una consulta de cruce en modo lectura antes de permitir una nueva propuesta contable.
