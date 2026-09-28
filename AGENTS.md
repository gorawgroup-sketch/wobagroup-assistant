# WOBA Copilot — instrucciones para construir sobre este repo

Asistente administrativo (Wobi) para WOBA/BAE, Footprint y eWorks: Telegram + el front
`frontend-cerebro` ("Cerebro"), backend en `src/server.ts` + `core/`.

## Direccionamiento de construcción (Carlos, 2026-09-27)

Todo lo que se construya de aquí en adelante debe minimizar el riesgo de desestabilizar el
sistema a medida que crece — elegir siempre el camino que reduce el impacto sobre módulos
existentes, aunque sea más lento. El detalle y el porqué (incidentes reales que lo motivan)
están en [docs/principios-de-construccion.md](docs/principios-de-construccion.md) — léelo
antes de agregar una capacidad nueva.

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
- Toda publicación, fusión o despliegue requiere autorización explícita de Carlos. La
  autorización dada en el chat es suficiente; no exigirle interacción manual en GitHub
  salvo que una protección técnica real de la rama lo haga necesario. Nunca omitir los
  checks obligatorios ni forzar una rama protegida.

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
