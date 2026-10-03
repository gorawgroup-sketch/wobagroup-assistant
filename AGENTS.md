# WOBA Copilot — instrucciones para construir sobre este repo

Asistente administrativo (Wobi) para WOBA/BAE, Footprint y eWorks: Telegram + el front
`frontend-cerebro` ("Cerebro"), backend en `src/server.ts` + `core/`.

## Direccionamiento de construcción (Carlos, 2026-09-27)

Todo lo que se construya de aquí en adelante debe minimizar el riesgo de desestabilizar el
sistema a medida que crece — elegir siempre el camino que reduce el impacto sobre módulos
existentes, aunque sea más lento. El detalle y el porqué (incidentes reales que lo motivan)
están en [docs/principios-de-construccion.md](docs/principios-de-construccion.md) — léelo
antes de agregar una capacidad nueva.

## Orden de trabajo — antes de empezar cualquier cosa (Carlos, 2026-10-03)

El sistema crece con varias sesiones a la vez (Claude Code y Codex). Para no crecer desordenado:

- Lee y actualiza el tablero [docs/trabajo-en-curso.md](docs/trabajo-en-curso.md): una fila por trabajo, con su rama,
  su área y quién lo lleva. Una sola sesión por área a la vez.
- Si tu encargo cita una rama, un commit o una copia de trabajo, compruébalos primero; si no coinciden con la realidad,
  detente y dilo antes de tocar nada. Nunca continúes en una rama ya fusionada ni en la copia de trabajo de otra sesión.
- Cada capacidad nueva en su propia carpeta; los archivos centrales (`core/holded/write.ts`,
  `core/gastos/gastoCallbackHandler.ts`, `src/server.ts`, `core/jobs/revisarCorreoNuevo.ts`) solo reciben el punto de
  conexión.
- Al fusionar: borra la rama, cierra la copia de trabajo y actualiza el tablero.

## Los 3 puntos de extensión ya existentes — úsalos, no los reinventes

1. **Nuevo módulo de Cerebro (front)** → entrada en `SECCIONES`
   (`core/cerebro/estadoAgregado.ts`) + entrada en `MODULES`/`GROUPS` (`App.jsx`) + un
   componente propio en **su propio archivo** bajo `frontend-cerebro/src/modules/`.
   `App.jsx` solo importa y monta.
2. **Nuevo almacén persistente** → los primitivos de `core/google/sheetsKeyValueStore.ts`.
   Nunca un cliente de Sheets propio, nunca un ID de Sheet o credencial cacheado en una
   constante de módulo — leer `process.env` dentro de la función, en el momento real de uso
   (mismo patrón que `loadServiceAccountCredentials` en `serviceAccount.ts`).
3. **Nueva capacidad especializada ("agente de X")** → sub-agente detrás de una tool call
   desde el mismo hilo de Wobi (precedente: Wobi Seguros — ver `docs/wobi-seguros.md` §6.5).
   Nunca un front o aplicación separada salvo pedido explícito de Carlos para ese caso.

## Cómo se construye cualquier cambio

- Worktree aislado desde `origin/main` **actual** — nunca desde una rama vieja.
- `npm run typecheck` + build de producción completos antes de dar un cambio por bueno.
- Verificación **en vivo** del escenario real (no solo lectura de código): arrancar el
  server compilado, reproducir el caso que fallaba, confirmar que el síntoma desaparece.
- Un PR por preocupación — nunca mezclar un fix de infraestructura con una feature nueva.
- Un cambio a un módulo compartido (`sheetsKeyValueStore.ts`, el orquestador de
  `estadoAgregado.ts`, `serviceAccount.ts`...) exige verificación extra: reproducir el
  fallo original, no solo confirmar el caso feliz.
- Carlos autoriza de forma continuada las correcciones rutinarias solicitadas y su
  publicación, fusión y despliegue tras verificarlas (instrucción del 28-09-2026).
  No pedir una nueva aprobación por cada PR dentro de ese alcance. Guardar primero
  el trabajo en el disco externo, publicar en GitHub y verificar que Railway despliega
  ese mismo commit y funciona correctamente. Respetar pausas expresas (como PR #221),
  los checks obligatorios y las protecciones de rama; no extender esta autorización a
  operaciones financieras ni a acciones destructivas o cambios de acceso.
- Merge: Claude Code bloquea que yo mergee un PR directamente, sin excepción — ni con
  confirmación en el chat, ni repitiendo el intento; no rodearlo. Dentro del mismo
  alcance de la autorización de arriba, Carlos confirmó (30-09-2026) activar en su
  lugar el auto-merge NATIVO de GitHub (`gh pr merge <n> --auto --merge`) al abrir un
  PR ya verificado a fondo (typecheck + build + prueba en vivo) — se fusiona solo en
  cuanto pase el único check obligatorio de la rama ("Pruebas, tipos y build"). Esa
  rama hoy NO exige ninguna aprobación humana además de ese check, así que activar
  esto vuelve al CI el único filtro antes de producción — pedir confirmación
  explícita, SIN auto-merge, para cualquier PR que escriba dinero o pagos reales,
  cambios de acceso o seguridad, o donde haya dudas propias (mismos límites que la
  autorización de arriba).

## Comandos

- `npm run typecheck` — solo tipos.
- `npm run build` — build de producción completo (backend + frontend-cerebro).
- `npm run dev` — server en watch mode (`tsx watch src/server.ts`).
- `npm test` — tests.

## Otros documentos vivos

- [docs/principios-de-construccion.md](docs/principios-de-construccion.md) — el porqué de
  este archivo, los incidentes reales, y el plan vigente para dividir `App.jsx`.
- [docs/wobi-seguros.md](docs/wobi-seguros.md) — diseño del agente de seguros.
- [docs/manual_comandos_chat.md](docs/manual_comandos_chat.md) — comandos/keywords/botones
  del chat; actualizar siempre que se agregue uno nuevo.
