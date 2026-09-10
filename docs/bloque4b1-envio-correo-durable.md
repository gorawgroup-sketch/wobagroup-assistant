# WOBI — bloque 4B.1: envío de correo durable

Fecha: 2026-09-10. Base recuperable: `2688e9c` (último `origin/main` al abrir el bloque). Rama aislada: `codex/wobi-bloque4b-effects`.

## Procesos cubiertos

| Proceso | Autorización | Clave estable | Recuperación |
|---|---|---|---|
| Borrador aprobado | Botón de superadmin | id del borrador | Consulta Gmail antes de considerar un reenvío |
| Reporte contable | Botón de superadmin | id de propuesta | No regenera Excel/PDF si el envío ya está confirmado |
| Autorespuesta aprobada | Hilo y contacto preaprobados | id del último mensaje entrante | No vuelve a redactar con IA ni responder si ese mensaje ya fue atendido |

## Garantías

- Cada efecto pasa por `preparado → enviando → verificado`; un resultado que Gmail no puede confirmar queda `incierto`.
- Cada correo lleva un `Message-ID` RFC determinista derivado de SHA-256. El ledger y la cabecera no incluyen la clave original.
- Un estado `enviando` o `incierto` solo permite buscar `in:sent rfc822msgid:...`; nunca vuelve a llamar a `messages.send`.
- Un rechazo 4xx inequívoco vuelve a `preparado` y muestra un botón con una nueva identidad de callback. Timeouts, rate limits y fallos 5xx se consideran ambiguos.
- Al arrancar se reconcilian estados pendientes. Si Gmail todavía no los indexó, se repiten únicamente consultas de lectura a los 30 y 60 segundos, con máximo acotado.
- El control diario eleva como crítico cualquier envío incierto o imposibilidad de leer el ledger. `/health` expone solo contadores.
- El ledger oculto `_envios_correo_durables` guarda hash, proceso, estado, Message-ID técnico, ids de Gmail y tiempos; nunca destinatario, asunto, cuerpo, adjuntos, prompt o credenciales.

## Coste y rendimiento

- No añade llamadas a modelos, API de IA, bases de datos ni servicios Railway.
- El camino normal no busca en Gmail: añade únicamente checkpoints en el Google Sheet existente.
- Las búsquedas de Gmail ocurren solo ante reinicio, timeout, estado ambiguo o consulta previa de una acción ya registrada.
- La consulta previa evita repetir redacción con IA en autorespuestas y evita regenerar reportes si el envío ya existe.

## Límites deliberados

- Este subbloque cubre Gmail. Drive y Holded no reutilizan esta lógica: cada proveedor necesita su propio verificador antes de poder prometer no duplicación.
- Un envío incierto que Gmail no encuentre permanece bloqueado y requiere comprobación humana; no se sacrifica seguridad por continuidad automática.
- La propuesta de reporte y el borrador solo se consumen después de envío confirmado. Una caída anterior al checkpoint `enviando` conserva el pendiente, pero la entrega Telegram puede requerir una nueva acción explícita.
- Producción debe conservar una sola réplica mientras los ledgers usen Google Sheets sin compare-and-swap distribuido.

## Configuración y reversión

- `WOBI_EMAIL_DURABLE_ENABLED=true`. Solo `false` explícito restaura temporalmente el envío anterior; una errata mantiene la ruta segura.
- `WOBI_EMAIL_LEDGER_RETENTION_DAYS=180` (30–365 días) controla la conservación de estados verificados.
- Reversión completa: revertir la PR de este subbloque. No borrar la pestaña durante una incidencia; conservarla permite verificar qué envíos ya se produjeron.
- No se ejecutan envíos reales durante las pruebas.

## Validación realizada

- Envío nuevo y reutilización de resultado verificado sin segunda llamada.
- Recuperación de `enviando` encontrado en Gmail.
- Bloqueo de `enviando`/`incierto` no encontrado.
- Timeout cuyo envío sí aparece en Gmail.
- Rechazo 403 seguro para reintentar.
- Identidad opaca y estable.
- Reconciliación de arranque.
- Consulta previa sin invocar trabajo costoso.
- Cabecera MIME `Message-ID`, `In-Reply-To` y `References`.
- Control diario crítico ante incertidumbre o pérdida de acceso al ledger.
- 97 pruebas aprobadas (93 TypeScript + 4 del worker Claude Max), typecheck y build backend/frontend.
