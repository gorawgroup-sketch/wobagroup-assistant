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

**Dueño único por área y día (Carlos, 08-10-2026).** Las áreas críticas están en `.github/areas-criticas.json`. El CI rechaza un PR nuevo que toque un área mientras otro PR abierto más antiguo la toca (`scripts/ci/colision-de-area.mjs`); el PR antiguo tiene prioridad. Para aceptar una colisión a sabiendas, Carlos pone la etiqueta `colision-aceptada`. Antes de empezar en un área: mirar los PR abiertos y esta tabla; si hay otro, coordinar o esperar.

**Banco de casos reales (`core/gmail/automatico/casos/`).** Cada correo que bloqueó la revisión queda como caso de extremo a extremo (sin IA) con el informe que debe salir. Al cerrar un incidente de correo, añadir su caso al banco en el mismo PR.
| Documentos y conocimiento | `core/documental/`, `core/knowledge/`, `core/drive/` |
| Seguros | `core/seguros/` |
| Soportes (pedir comprobantes a quien gastó con la tarjeta) | `core/soportes/` |
| Cashflow | `core/google/`, `core/cashflow/` |
| Informes | `core/informes/`, `core/reportes/` |
| Cerebro (front) | `frontend-cerebro/`, `core/cerebro/` |
| Infraestructura | `core/telegram/`, `core/ai/`, `core/utils/`, `src/server.ts` |

## En curso

| Trabajo | Área | Rama | Quién | Estado |
|---|---|---|---|---|
| Lecturas de fuentes de Cerebro bajo la cola de Sheets | Cerebro (front) | [PR #330](https://github.com/gorawgroup-sketch/wobagroup-assistant/pull/330) | Codex | Fusionado y desplegado el 04-10-2026; durante la observación las 20 fuentes siguieron completas y frescas. |
| Sonda de Sheets bajo carga de fondo | Cerebro (front) | [PR #334](https://github.com/gorawgroup-sketch/wobagroup-assistant/pull/334) | Codex | Fusionado el 04-10-2026; Railway y comprobación bajo carga pendientes de completar. Usa la reserva interactiva del regulador para evitar falsos timeouts. |
| Núcleo fluido: áreas, búsqueda documental y Telegram Web | Cerebro (front) | `codex/wobi-nucleo-vivo`, [PR #320](https://github.com/gorawgroup-sketch/wobagroup-assistant/pull/320) | Codex | Implementado y probado en copia aislada; publicación tras verificar la sonda de Sheets y los flujos existentes. [Alcance](wobi-nucleo-vivo.md) |
| Regla de tickets / lista aprobada de Holded | Automatización de Holded | `fix/holded-lista-aprobada-manda` (copia `/private/tmp/woba_auto`) | Otra sesión de Claude | Activa el 03-10-2026; no tocar esa copia |
| Transferencias internas y conversiones entre cuentas de la misma empresa | Conciliación y bancos | `feat/transferencias-conversiones-abiertas` (copia `.worktrees/transferencias-robot`) | Claude Code | EUR↔EUR y conversiones sin diferencia a favor validadas por Carlos el 05-10 y abiertas (`WOBI_TRANSFERENCIAS_ALCANCE=eur,conversiones`). Pendiente: conversiones con diferencia a favor (cuenta de diferencias por empresa) |
| Proyectos de Holded (solo lectura): listar y reporte financiero por proyecto | Conciliación y bancos (`core/holded/`, `core/tools/`) | `feat/holded-proyectos-lectura` | Claude Code | Portado el 04-10-2026 desde la rama de respaldo `respaldo/checkout-principal-2026-10-04`; PR abierto, a la espera de que Carlos decida la fusión. Solo GET, sin escrituras |
| Puente automático de recibos con varios pagos (fase 1, observación) | Conciliación y bancos | _sin rama todavía_ | Claude Code | Pendiente de empezar. La conciliación múltiple en divisa y reanudar lote ya están en `main` (#313–#317). Los pares emparejados se guardan en un registro aparte, no como columna nueva de `_gastos_pendientes`
| Cambiar el proveedor de un gasto ya creado + corregir el alias aprendido | Conciliación y bancos | `feat/cambiar-proveedor-compra` | Claude Code | En PR. Tool `proponer_cambio_proveedor_compra`, reutiliza la edición verificada y los botones `edicioncompra_*` |
| Botón «Conciliar esta parte» tras crear un gasto cuyo recibo se cobró en varios pagos (fase B) | Conciliación y bancos | `feat/conciliacion-parcial-boton` | Claude Code | En PR. Módulo `core/gastos/conciliacionParcialRecibo.ts`; 2 puntos de conexión en `gastoCallbackHandler.ts` |
| Reglas «ya está sumado en otra línea» del cashflow (botón Explicar + herramienta de chat) | Cashflow | `feat/reglas-cashflow-agregadas` | Claude Code | En PR. Carpeta `core/cashflow/` (reglas, explicación, almacén de espera) + 4 puntos de conexión |
| Lectura completa del correo (remitente original en cadenas, mensaje nuevo sin citas, adjuntos y lista de peticiones con una acción cada una) | Correo | _sin rama todavía (paso 3)_ | Claude Code | Pasos 1 (#383) y 2 (#386) hechos el 07-10-2026; falta el paso 3: que la revisión automática use la misma lectura. Carlos dio el visto bueno el 07-10-2026. En 3 PR: (1) remitente original y cadenas + quitar el recorte de 8.000 caracteres del clasificador, sin IA; (2) peticiones y adjuntos en la cola manual; (3) revisión automática y directorio de personas. Carpeta propia `core/correo/lectura/`; los archivos centrales (`classifyEmail.ts`, `revisarCorreoNuevo.ts`) solo reciben el punto de conexión. Una sola sesión en el área Correo mientras dure. Medir el coste de IA antes de activar. |
| Comando `/conocimiento` (modo conocimiento desde el menú de Telegram) | Conocimiento | `feat/comando-conocimiento` | Claude Code | En PR (07-10-2026). Lógica en `core/knowledge/modoConocimiento*.ts`; `server.ts`, `receiveFile.ts` y el menú solo reciben el punto de conexión. |

### Hecho reciente

| Trabajo | PR | Fecha |
|---|---|---|
| Revisión en seco tras cada despliegue (`core/gmail/automatico/revisionEnSeco.ts`): simulación sin IA ni escrituras unos minutos después de arrancar con versión nueva, comparación por correo con la anterior y aviso solo si empeora; `WOBI_MAIL_DRY_RUN=off` la apaga | _PR pendiente_ | 08-10-2026 |
| Cero motivos genéricos en el informe del correo automático: cada código con explicación concreta, comodín que nombra el motivo, guardarraíl `core/guardarrailes/motivosSinGenericos.test.ts`; aviso veraz del correo activo sin pregunta (`core/jobs/revisionCorreoManual.ts`) | #415 | 08-10-2026 |
| Dueño único por área (guardarraíl de colisión en CI, `.github/areas-criticas.json`) + banco de casos reales de extremo a extremo del correo automático (`core/gmail/automatico/casos/`) | #412 | 08-10-2026 |
| Norma de resolución autónoma centralizada: módulo `core/ia/normaResolucionAutonoma.ts` inyectado en Wobi, Seguros y extractores + guardarraíl de cobertura + docs/norma-resolucion-autonoma.md (primera aplicación: moneda sin cuenta propia, #404) | #405 | 08-10-2026 |
| Correo activo con la pregunta en `_gastos_pendientes_datos` (caso Lunch 180 MXN) + la verificación fallida del analizador ya no se guarda como «incompleto» (v24) + diagnóstico de respuestas rechazadas (`core/gastos/reenviarPreguntaPendiente.ts`, `core/gmail/automatico/analyze.ts`) | #397 | 07-10-2026 |
| Incidente 07-10: imágenes de relleno «noname» como adjuntos y aviso de propuesta pendiente repetido sin freno (`core/correo/lectura/decoracion.ts`, `core/gastos/avisoPropuestaPendiente.ts`) | #389 | 07-10-2026 |
| Pedir soportes a quien gastó con la tarjeta: CSV de Revolut → resumen por persona → un correo por titular (cuadro + Excel, direcciones del buzón, regla fija en el prompt) | #370, #371, #372, #373 | 06/07-10-2026 |
| `/preguntas` con un botón por pendiente y búsqueda tolerante | #374, #376 | 06-10-2026 |
| Casa Peppe: tasa COP robusta, teclado en el mensaje pulsado, tasas en paralelo | #375, #377 | 06-10-2026 |
| Respuesta a la solicitud de soportes: lectura completa y una acción por cargo | #378 | 07-10-2026 |
| Cerrar cargos sin soporte (par cargo+reembolso sin gasto; gasto sin soporte conciliado) | #379 | 07-10-2026 |
| Lectura de la cadena del correo, paso 1: remitente real, mensaje nuevo sin citas ni firma, sin recorte de 8.000 caracteres (`core/correo/lectura/`) | #383 | 07-10-2026 |
| Orden: tablero al día y lógica nueva fuera de `gastoCallbackHandler.ts` | #382 | 07-10-2026 |
| Cashflow: filtro «solo ingresos / solo gastos» al proponer, verificar y comparar lo que falta (`core/cashflow/filtroTipoMovimiento.ts`) | #387 | 07-10-2026 |
| Lectura completa del correo, paso 2: lista de peticiones con una acción cada una y adjuntos (Word/Excel sin IA; PDF e imágenes con visión acotada) en el análisis de la cola manual | #386 (+ #385) | 07-10-2026 |

## Pendiente de decisión de Carlos

| Qué | Dónde | Desde | Nota |
|---|---|---|---|
| Distinguir conciliación confirmada de ajuste de cambio pendiente | PR #221 `codex/fx-residual-status` | 28-09-2026 | Abierto sin decidir |
| Saldos residuales tras conciliación multimoneda | PR #219 `codex/fix-fx-residual-reconciliation` | 28-09-2026 | Abierto sin decidir |
| Aplazar un gasto y continuar la cola de correo | PR #217 `codex/skip-pending-email` | 28-09-2026 | Abierto sin decidir |
| Ramas con PR cerrado sin fusionar | `claude/fix-env-loading`, `codex/wobi-seguros-reviewed`, `feat/gasto-siempre-y-soporte-eml`, `fix/desambiguacion-confianza-en-usuario`, `fix/eml-equivalente-eur` | septiembre | ¿Se descartan? |
| Ramas sin PR | `codex/claude-max-worker`, `codex/wobi-microfono-continuo`, `fix/descartar-gasto-pendiente-datos` | septiembre | ¿Se retoman o se descartan? |
| Checkout principal con cambios sin guardar | `/Volumes/Seagate Backup Plus Drive/apps/WOBA_Copilot`, rama `codex/holded-proyectos` (33 archivos modificados, 37 nuevos, desde el 27-09) | 27-09-2026 | Inventariado el 04-10 (solo lectura): ver [inventario](mantenimiento/inventario-checkout-principal-2026-10-04.md). Decidir: respaldar en una rama, portar Proyectos de Holded y la clasificación contable contextual, y limpiar. No se ha tocado nada |

## Mantenimiento

- Limpieza del 03-10-2026: 217 ramas fusionadas borradas de GitHub (lista y cómo recuperarlas en
  [mantenimiento/ramas-eliminadas-2026-10-03.md](mantenimiento/ramas-eliminadas-2026-10-03.md)), 167 ramas locales
  idénticas borradas, 18 copias de trabajo cerradas (10 que ya no existían en disco y 8 limpias y fusionadas).
- No se tocó ninguna copia con cambios sin guardar ni las que gestionan las aplicaciones de Claude (`.claude/worktrees/`)
  y Codex (`~/.codex/worktrees/`): las limpia cada aplicación.
- Railway despliega solo desde `main`; borrar ramas fusionadas no afecta a producción.
- La copia `.worktrees/mail-auto-integration` guarda la instalación completa de `node_modules` que enlazan otras copias:
  no cerrarla sin reinstalar antes en otro sitio.
