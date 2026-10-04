# Inventario del checkout principal (04-10-2026)

Checkout: `/Volumes/Seagate Backup Plus Drive/apps/WOBA_Copilot`, rama `codex/holded-proyectos`, **505 commits por detrás de `main`**,
33 archivos modificados y 37 rutas nuevas sin guardar (269 archivos contando carpetas). Inventario hecho en **solo lectura**: no se
borró ni se cambió nada. Un cambio «en conflicto» con `main` no significa que falte: casi siempre `main` evolucionó el mismo archivo.

## Ya está en `main` (la copia local es redundante o más antigua)

| Bloque | Evidencia |
|---|---|
| Notas de voz de Telegram (`core/ai/transcribeAudio.ts`, `core/telegram/voiceInput*`) | Archivos idénticos a `main` (#263) |
| Correo de gastos automático (`core/gmail/automatico/`, 13 archivos) | En `main`, cambiado por última vez el 30-09; el local es del 18-09 |
| Conciliación múltiple (`core/holded/conciliacionMultiple/`, tool y pruebas) | Portada en #314–#317; `main` ya trae la versión con divisa y reanudar |
| Wobi Seguros (docs, tarjeta de Cerebro) | En `main` (#208); `main` más reciente (01-10) |
| `frontend-cerebro/` (43 archivos sin seguimiento) | Todos ya versionados en `main` |
| Conversión HEIC | Cubierta por #83 (verificar si `convertHeic.ts` aporta algo más antes de descartarlo) |

## Único del checkout y NO está en `main` (candidatos a portar, cada uno en su PR)

| Bloque | Archivos | Riesgo | Recomendación |
|---|---|---|---|
| **Proyectos de Holded (solo lectura)** | `core/holded/client.ts` (+129: `listProjects`, `getProjectSummary`, `matchProject`, `resolveProjectExact`), `core/tools/proyectosHolded.ts`, `core/holded/projects.test.ts`, conexión en `registry.ts` | Bajo (lee, no escribe) | Portar como PR propio. Es lo que da nombre a la rama |
| **Clasificación contable contextual completa** | `core/holded/write.ts` (extracción de `inferirCuentaGasto` + `evaluarCuentaGasto` + `verificarCuentaAntesDeConciliar`), `core/tools/revisarCuentaContableGasto.ts`, `docs/clasificacion-contable-contextual.md` | Medio (toca `write.ts`) | Portar en dos fases. `main` ya tiene una versión previa (`cuentaContableContexto.ts`); comparar antes. Evita cuentas absurdas (p. ej. «Gastos de Viaje» para un servicio de IA) |
| Lectura de formatos de documento | `core/documental/readableFormats.ts`, `convertHeic.ts` y cambios en `documentBlock.ts`, `transcribeForCapture.ts`, `procesarDocumentoLocal.ts` | Bajo | Decidir tras comprobar qué cubre #83 |
| Cambios sueltos en archivos centrales | `gastoCallbackHandler.ts` (+38/−26), `revisarCorreoNuevo.ts` (+66/−21), `gmail/client.ts` (+25/−4), `colaRevisionStore.ts`, `editarCompraHolded.ts` (+29/−5), etc. | Medio | Revisar uno a uno contra `main`; 7 se aplican limpios (es decir, **no** están en `main`) |

## No son código: no van a Git

| Qué | Tamaño | Nota |
|---|---|---|
| `.claude/` y `.worktrees/` | 3,8 GB y 1,4 GB | Copias de trabajo y datos de las aplicaciones; no tocar |
| `Wobi_seguros/` | 26 MB, 49 archivos | **Documentos de pólizas (datos sensibles)**: respaldar fuera del repositorio, nunca en una rama |
| `output/`, `outputs/`, `Telegram/`, `Wobi.png` | — | Salidas generadas y recursos; decidir si se conservan |

## Siguiente paso recomendado

1. Respaldar en GitHub solo el código y los documentos sin datos sensibles del checkout (rama `respaldo/…`), para que deje de depender del disco.
2. Portar «Proyectos de Holded» como PR propio (bajo riesgo).
3. Comparar la clasificación contable contextual contra `main` y decidir.
4. Cuando todo lo útil esté en `main` o respaldado, dejar el checkout limpio.
