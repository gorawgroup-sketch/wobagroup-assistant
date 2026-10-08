# Principios de construcción del sistema

Direccionamiento explícito de Carlos (2026-09-27), tras una sesión con fricción real
integrando Wobi Seguros: *"No debemos construir nada que a mediano plazo sea un riesgo
de deterioro o de inestabilidad del sistema... la forma en que se construye este sistema
y sus agentes o subagentes tiene que ser segura... siempre empiezan independientes,
chicas — eso debe ser intrínseco a la forma de construcción."*

Este documento existe para que ese direccionamiento no dependa de que alguien lo recuerde
en una conversación — [CLAUDE.md](../CLAUDE.md) y [AGENTS.md](../AGENTS.md) (raíz del repo,
resumen accionable, se cargan solos en cada sesión) apuntan aquí para el detalle y el porqué.

## Los incidentes reales que motivan esto

No son riesgos hipotéticos — ya pasaron, más de una vez:

- **El mismo bug de escritura en Sheets (`values.append` adivinando fila/columna) se repitió
  7+ veces** en distintos stores antes de corregirse de raíz una sola vez en
  `sheetsKeyValueStore.ts` (ver su comentario). Cada store lo reintroducía porque no había
  un único lugar obligatorio por donde pasar.
- **El mismo patrón de cachear `CASHFLOW_SHEET_ID` en una constante de módulo estaba
  duplicado en 37 archivos** — no en uno. Se descubrió por casualidad al construir Seguros,
  pero afectaba a auditoría, gastos, conciliaciones, autorización de Telegram... todo el
  sistema. Corregido de raíz en el PR #209.
- **Wobi Seguros se construyó dos veces** porque la primera vez partió de una rama de Codex
  ~130 PRs desactualizada respecto a `main` — el código de Cerebro había evolucionado tanto
  (nuevo orquestador `SECCIONES`, nuevo patrón de props) que reusar el código viejo no era
  seguro.
- **`frontend-cerebro/src/App.jsx` ya tiene ~5.000 líneas** y sigue creciendo con cada módulo
  nuevo de Cerebro — todos los módulos existentes (`ConexionesContenido`, `AdminPanel`,
  `UsuariosPanel`, `MiniCalendario`, `BusquedaWebContenido`, el propio `SegurosContenido` que
  se agregó para Seguros...) viven en el mismo archivo, sin límites entre ellos.
- **Un fallo de lectura de Holded se convirtió en un «hecho»** (2026-09-28): con Holded en 502/503 el flujo de
  gastos asumió «solo EUR» como monedas de cuenta de Footprint (que tiene cuentas en EUR, USD y COP) y le dijo a
  Carlos que USD «no es ninguna moneda de cuenta real». **Regla:** un fallo de lectura no demuestra ausencia ni fija
  valores por defecto. Se usa la última lectura buena (`MonedasCuentasReales`) o se avisa y se deja para reintentar;
  y el mensaje distingue «no encontré» de «la consulta falló». Antes de escribir un `.catch(() => valorPorDefecto)`
  sobre una lectura de Holded, comprobar que ese valor no cambia una decisión ni un texto que el operador tomará como cierto.
- **La misma pregunta respondida en seis sitios** (2026-09-28): «¿este cargo puede ser este gasto?» se decidía con
  criterios distintos en la búsqueda, el teclado, la aprobación, la búsqueda sin fecha, el cambio de moneda y el correo
  automático. Al endurecer uno se creaban callejones en otro: un ticket con su cargo exacto en Holded se quedó sin
  botones para crearlo. **Regla:** una decisión de negocio = una función con niveles explícitos y un corpus de casos
  reales en las pruebas; todo teclado debe tener siempre una salida accionable.

El patrón común: cuando no hay un único camino obligatorio para construir algo, el mismo
error se reinventa en cada lugar nuevo, y un archivo compartido crece sin límite hasta que
cualquier cambio ahí se vuelve riesgoso para todo lo demás.

## Los 3 puntos de extensión — úsalos, no los reinventes

1. **Nuevo módulo de Cerebro (front)** → una entrada en `SECCIONES`
   (`core/cerebro/estadoAgregado.ts`, backend) + una entrada en `MODULES`/`GROUPS`
   (`App.jsx`) + un componente propio **en su propio archivo**, bajo
   `frontend-cerebro/src/modules/`. `App.jsx` solo importa y monta — nunca crece con la
   lógica interna del módulo nuevo.
2. **Nuevo almacén persistente** → los primitivos ya existentes de
   `core/google/sheetsKeyValueStore.ts` (`ensureTab`/`leerFilas`/`agregarFila`/
   `actualizarFila`/`eliminarFila`). Nunca un cliente de Sheets propio, nunca un ID de Sheet
   o credencial cacheado en una constante de módulo — leer `process.env` dentro de la
   función, en el momento real de uso (igual que `loadServiceAccountCredentials` en
   `serviceAccount.ts`).
3. **Nueva capacidad especializada ("agente de X")** → un sub-agente detrás de una tool call
   desde el mismo hilo de Wobi (precedente: Wobi Seguros, decisión explícita de Carlos —
   ver `docs/wobi-seguros.md` §6.5). Nunca lógica nueva metida directamente en el prompt o
   el tool-set del agente principal, y nunca una aplicación/front separado salvo que el
   propio Carlos lo pida explícitamente para ese caso.

## Cómo se construye cualquier cambio, sin excepción

- Worktree aislado, partiendo de `origin/main` **actual** — nunca de una rama vieja propia
  o de otra herramienta.
- `npm run typecheck` + build de producción completos antes de dar un cambio por bueno.
- Verificación **en vivo** del escenario real, no solo lectura de código: arrancar el server
  compilado, reproducir el caso que originalmente fallaba, confirmar que el síntoma
  desaparece.
- Un PR por preocupación. Nunca mezclar un fix de infraestructura compartida con una
  feature nueva, aunque los haya encontrado en la misma sesión.
- Un cambio a un módulo **compartido** (`sheetsKeyValueStore.ts`, el orquestador de
  `estadoAgregado.ts`, `serviceAccount.ts`...) es de mayor riesgo que uno aditivo —
  verificación extra: reproducir el fallo original explícitamente, no solo confirmar que
  el caso feliz sigue funcionando.
- Carlos autoriza de forma continuada las correcciones rutinarias solicitadas y su
  publicación, fusión y despliegue tras verificarlas (instrucción del 28-09-2026).
  No pedir una nueva aprobación por cada PR dentro de ese alcance. Guardar primero
  el trabajo en el disco externo, publicar en GitHub y verificar que Railway despliega
  ese mismo commit y funciona correctamente. Respetar pausas expresas (como PR #221),
  los checks obligatorios y las protecciones de rama; no extender esta autorización a
  operaciones financieras ni a acciones destructivas o cambios de acceso.

## Principio de resolución autónoma (Carlos, 2026-10-08)

El sistema es un solucionador de problemas: nunca traslada al usuario algo que puede resolver solo. Toda capacidad nueva
se diseña para agotar primero sus almacenes, sus herramientas, el contenido completo y las fuentes externas verificables;
si el dato depende de un tercero (banco sin sincronizar), el caso se aparca y se reintenta solo; y si pregunta, la
pregunta llega con lo investigado, las opciones y una recomendación, en un solo mensaje. La norma completa, con la escala
para decidir si algo puede resolverse solo y dónde se hace cumplir (prompt central, sub-agentes, extractores y guardarraíl),
está en [docs/norma-resolucion-autonoma.md](norma-resolucion-autonoma.md). Un agente nuevo que llame al modelo sin
declararse en `COBERTURA_NORMA` (`core/ia/normaResolucionAutonoma.ts`) hace fallar las pruebas.

## Cuándo un archivo compartido es una señal de alerta

Si un archivo empieza a acumular módulos o casos no relacionados entre sí — más de un par
de "features" distintas viviendo en el mismo archivo — es momento de extraer, no de seguir
agregando encima. La sección siguiente es el plan concreto vigente para `App.jsx`.

## Plan concreto: dividir `App.jsx`

Mapeado el 2026-09-27 (~5.000 líneas, ~30 declaraciones de nivel superior). Dos capas de
riesgo muy distintas:

### Fase 1 — extracción mecánica, bajo riesgo (hacer primero)

Estos ya son componentes autocontenidos (reciben props, no dependen de estado externo más
allá de props/tokens compartidos) — mover cada uno a su propio archivo bajo
`frontend-cerebro/src/modules/` es, en esencia, cortar/pegar + un import, verificable con
`npm run build` + una revisión visual tras cada uno:

| Componente | Líneas aprox. | Archivo destino sugerido |
|---|---|---|
| `AuditoriaProgramadaContenido` | ~90 | `modules/AuditoriaProgramada.jsx` |
| `ConexionesContenido` | ~115 | `modules/Conexiones.jsx` |
| `BusquedaWebContenido` | ~185 | `modules/BusquedaWeb.jsx` |
| `MiniCalendario` | ~140 | `modules/MiniCalendario.jsx` |
| `AdminPanel` | ~150 | `modules/AdminPanel.jsx` |
| `UsuariosPanel` | ~175 | `modules/UsuariosPanel.jsx` |
| `TablaGastoPorProceso` | ~110 | `shared/TablaGastoPorProceso.jsx` |
| `AccionesIncidencia` | ~215 | `shared/AccionesIncidencia.jsx` |
| `ControlDiarioPanel` | ~325 | `modules/ControlDiario.jsx` |
| `KeyGate` / `EntryScreen` | ~235 | `shared/Auth.jsx` |
| `Desplegable` | ~20 | `shared/Desplegable.jsx` (primitivo de UI, varios módulos ya lo usan) |
| `NeuralField` + `seeded`/`buildField` | ~95 | `shared/NeuralField.jsx` |
| `C` (tokens de diseño) + helpers de formato (`fmtMoney`, `fmtDateTime`, `timeAgo`...) | ~130 | `shared/tokens.js` |

También el nuevo `SegurosContenido` (PR #208, aún sin mergear) debería nacer ya en
`modules/Seguros.jsx` en vez de sumarse a `App.jsx` — sería el primer módulo construido ya
bajo esta regla.

### Fase 2 — los dos monolitos reales (hacerlo con más cuidado, después)

- **`CerebroWoba`** (componente por defecto, ~1.775 líneas): el verdadero corazón del
  problema — mezcla layout del mapa neuronal, estado (apiKey, módulo seleccionado,
  liveData...), y el montaje condicional de cada módulo, todo junto. Extraer primero a
  hooks propios (`useCerebroState`, `useModulePanel`) antes de tocar el JSX; cada extracción
  verificada por separado, no de una sola vez.
- **`WobiChat`** (~800 líneas): el chat en sí. Separar el parseo/formato de mensajes
  (`bloquesRespuesta`, `TablaRespuesta`, `ContenidoRespuesta`, `parsearNumeroVisual`...) del
  componente visual antes de dividir el componente mismo.

La Fase 2 toca código que hoy funciona en producción — no se hace en la misma sesión que
otros cambios, y cada extracción se verifica en vivo por separado, exactamente como pide
este mismo documento.

### Estado

Diagnóstico y plan completos. Extracción todavía no iniciada — pendiente de que Carlos
confirme cuándo arrancar la Fase 1.
