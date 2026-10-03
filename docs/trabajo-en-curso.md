# Tablero de trabajo en curso

Fuente única de verdad de **qué se está construyendo, en qué rama y quién lo lleva**. Existe porque el sistema crece con
varias sesiones a la vez (Claude Code y Codex) y el 03-10-2026 se llegó a 49 copias de trabajo y 247 ramas, con encargos
que describían un estado que ya no existía. Pedido de Carlos: crecer de manera ordenada.

## Reglas (para cualquier sesión, humana o de IA)

1. **Antes de empezar**: lee este tablero y `git fetch`. Si tu encargo cita una rama, un commit o una copia de trabajo,
   compruébalos; si no coinciden con la realidad, detente y dilo antes de tocar nada.
2. **Una fila por trabajo.** Añade tu fila al empezar (rama, área, quién, estado) y actualízala al terminar. Un trabajo que
   no está en el tablero no existe para los demás.
3. **Una sola sesión por área a la vez.** Las áreas son las de la tabla de abajo. Dos sesiones pueden avanzar en paralelo
   en áreas distintas, nunca en la misma.
4. **Rama nueva desde `origin/main` actual y copia de trabajo propia.** Nunca se continúa en una rama ya fusionada ni en
   la copia de trabajo de otra sesión. El checkout principal no se usa para construir.
5. **Cada capacidad nueva vive en su propia carpeta** (`core/seguros/`, `core/informes/`, `core/holded/automatizacion/`…).
   Los archivos centrales (`core/holded/write.ts`, `core/gastos/gastoCallbackHandler.ts`, `src/server.ts`,
   `core/jobs/revisarCorreoNuevo.ts`) solo reciben el punto de conexión; no se les añade lógica nueva.
6. **Lo que mueve dinero va en dos fases**: primero observación (sin escribir), después activo con la autorización
   escrita de Carlos para el caso concreto. La fusión de esos cambios la pulsa Carlos.
7. **Al fusionar**: borra la rama en GitHub, cierra la copia de trabajo y quita la fila del tablero (o pásala a «Hecho
   reciente»). Una rama fusionada que sigue viva es desorden.
8. **Un PR abierto más de 7 días** se decide: se fusiona, se cierra o se anota aquí por qué espera.

## Áreas

| Área | Carpetas principales |
|---|---|
| Conciliación y bancos | `core/holded/` (búsqueda de cargos, conciliaciones), `core/gastos/` |
| Automatización de Holded en servidor | `core/holded/automatizacion/`, `core/jobs/automatizacionHolded.ts` |
| Correo | `core/gmail/`, `core/jobs/revisarCorreoNuevo.ts` |
| Documentos y conocimiento | `core/documental/`, `core/knowledge/`, `core/drive/` |
| Seguros | `core/seguros/` |
| Cashflow | `core/google/`, `core/cashflow/` |
| Informes | `core/informes/`, `core/reportes/` |
| Cerebro (front) | `frontend-cerebro/`, `core/cerebro/` |
| Infraestructura | `core/telegram/`, `core/ai/`, `core/utils/`, `src/server.ts` |

## En curso

| Trabajo | Área | Rama | Quién | Estado |
|---|---|---|---|---|
| Regla de tickets / lista aprobada de Holded | Automatización de Holded | `fix/holded-lista-aprobada-manda` (copia `/private/tmp/woba_auto`) | Otra sesión de Claude | Activa el 03-10-2026; no tocar esa copia |
| Transferencias internas y conversiones entre cuentas de la misma empresa | Conciliación y bancos | por crear desde `origin/main` | Claude Code | Siguiente trabajo; empieza en modo observación |

## Pendiente de decisión de Carlos

| Qué | Dónde | Desde | Nota |
|---|---|---|---|
| Distinguir conciliación confirmada de ajuste de cambio pendiente | PR #221 `codex/fx-residual-status` | 28-09-2026 | Abierto sin decidir |
| Saldos residuales tras conciliación multimoneda | PR #219 `codex/fix-fx-residual-reconciliation` | 28-09-2026 | Abierto sin decidir |
| Aplazar un gasto y continuar la cola de correo | PR #217 `codex/skip-pending-email` | 28-09-2026 | Abierto sin decidir |
| Ramas con PR cerrado sin fusionar | `claude/fix-env-loading`, `codex/wobi-seguros-reviewed`, `feat/gasto-siempre-y-soporte-eml`, `fix/desambiguacion-confianza-en-usuario`, `fix/eml-equivalente-eur` | septiembre | ¿Se descartan? |
| Ramas sin PR | `codex/claude-max-worker`, `codex/wobi-microfono-continuo`, `fix/descartar-gasto-pendiente-datos` | septiembre | ¿Se retoman o se descartan? |
| Checkout principal con cambios sin guardar | `/Volumes/Seagate Backup Plus Drive/apps/WOBA_Copilot`, rama `codex/holded-proyectos` (33 archivos modificados, 37 nuevos, desde el 27-09) | 27-09-2026 | Revisar qué de eso ya está en `main` antes de limpiar; no se ha tocado |

## Mantenimiento

- Limpieza del 03-10-2026: 217 ramas fusionadas borradas de GitHub (lista y cómo recuperarlas en
  [mantenimiento/ramas-eliminadas-2026-10-03.md](mantenimiento/ramas-eliminadas-2026-10-03.md)), 167 ramas locales
  idénticas borradas, 18 copias de trabajo cerradas (10 que ya no existían en disco y 8 limpias y fusionadas).
- No se tocó ninguna copia con cambios sin guardar ni las que gestionan las aplicaciones de Claude (`.claude/worktrees/`)
  y Codex (`~/.codex/worktrees/`): las limpia cada aplicación.
- Railway despliega solo desde `main`; borrar ramas fusionadas no afecta a producción.
