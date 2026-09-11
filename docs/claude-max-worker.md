# Trabajador Claude Code Max para WOBI

## Alcance seguro de esta primera migración

La suscripción Claude Max no sustituye la API Messages dentro del proceso de
Railway. Se aprovecha mediante Claude Code ejecutado por la GitHub Action
oficial, fuera del runtime de WOBI. La primera carga migrable es
`autorrevision_codigo`: es nocturna, trabaja sobre código del repositorio y no
necesita responder en tiempo real.

El workflow `.github/workflows/claude-max-shadow-autoreview.yml`:

- admite ejecución manual; su cron de lunes a viernes está suspendido
  temporalmente por el bloqueo de autenticación descrito abajo;
- rota hasta tres archivos de la lista blanca `core/utils/`, con máximo 400 líneas;
- usa únicamente `Read`, `Glob` y `Grep`;
- no conserva credenciales de Git, no tiene permiso de escritura y no puede
  usar Bash, editar, navegar por internet ni delegar tareas;
- entrega a la Action solo el token efímero integrado de GitHub con permiso
  `contents: read`, evitando un intercambio OIDC o token de aplicación amplio;
- no recibe `ANTHROPIC_API_KEY`, Google, Holded, Telegram ni Railway;
- guarda durante 30 días solo un JSON sanitizado con proceso, proveedor,
  autenticación, turnos, tokens, coste API-equivalente, gasto API real y
  hallazgos breves. Nunca sube el log completo de Claude.

## Activación privada por Carlos

El token es un secreto personal. Debe configurarse desde un terminal y la web
de GitHub que solo controle Carlos; no debe pegarse en un chat, issue, commit,
log ni variable de Railway.

1. Instalar o actualizar Claude Code en el equipo de Carlos e iniciar sesión
   con la cuenta que tiene Claude Max.
2. Ejecutar `claude setup-token` localmente.
3. En GitHub, abrir `Settings > Secrets and variables > Actions` y crear el
   secret `CLAUDE_CODE_OAUTH_TOKEN` con el valor generado.
4. Ejecutar manualmente `Claude Max - autorrevision en sombra` desde la pestaña
   Actions. Confirmar que aparece un artefacto `claude-max-shadow-*`.

El workflow omite limpiamente la invocación si el secret falta. No existe un
fallback oculto a API dentro de GitHub Actions.

## Bloqueo temporal de la Action con Claude Max

Desde que se configuró el secreto, las ejecuciones reales en runners hospedados
por GitHub terminan antes del primer turno con `is_error: true`, cero uso y un
rechazo 401 del token OAuth. Las ejecuciones verdes anteriores no validaban la
integración: omitieron Claude porque el secreto todavía no estaba configurado.

El mismo comportamiento está documentado en la incidencia abierta
[`anthropics/claude-code-action#1613`](https://github.com/anthropics/claude-code-action/issues/1613):
un token creado mediante `claude setup-token` funciona en el CLI local con una
suscripción Max, pero la Action lo rechaza en un runner hospedado. Regenerar el
secreto, cambiar de modelo o actualizar entre las versiones afectadas no lo
resuelve.

Por eso el cron queda desactivado y `workflow_dispatch` se conserva para una
prueba manual cuando Anthropic publique una corrección. Esto evita correos y
minutos de CI fallidos sin fingir que hubo una revisión. La ruta API histórica
permanece disponible y no se cambia a `claude_max` mientras no existan cinco
ciclos reales y válidos.

## Fases y corte reversible

1. **Preparado:** Railway mantiene `WOBI_AUTOREVISION_PROVIDER=api` o la
   variable sin definir. El workflow todavía no consume nada si falta OAuth.
2. **Sombra:** después de validar manualmente OAuth, configurar Railway con
   `WOBI_AUTOREVISION_PROVIDER=claude_max_shadow`. API y Max se comparan durante
   al menos cinco ciclos hábiles. Este valor documenta la fase; no cambia aún
   la ejecución histórica.
3. **Activo:** si los cinco ciclos completan los tres archivos sin errores de
   autenticación, permisos o calidad, cambiar únicamente
   `WOBI_AUTOREVISION_PROVIDER=claude_max`. Railway deja de invocar la API para
   este proceso, pero su código y cron permanecen disponibles.
4. **Rollback:** volver inmediatamente a
   `WOBI_AUTOREVISION_PROVIDER=api`. No requiere revertir commits ni recuperar
   datos.

La fase activa no debe aprobarse hasta que exista una segunda etapa capaz de
convertir un hallazgo de Max en el mismo flujo de PR y aprobación humana por
Telegram. Mientras el workflow sea solo de lectura, un hallazgo debe revisarse
manualmente y la API histórica debe permanecer activa.

## Criterios de aceptación de los ciclos sombra

- autenticación `claude_max_oauth`, facturación `subscription` y
  `actual_api_spend_usd: 0`;
- todos los archivos seleccionados confirmados como revisados, o un estado
  `incomplete` explícito;
- cero accesos fuera de `core/utils/` y cero escrituras;
- salida estructurada válida y sin código o secretos en el artefacto;
- ausencia de fallos OAuth repetidos, límites agotados o ejecuciones solapadas;
- hallazgos iguales o más conservadores que la ruta API actual.

## Límites de la suscripción

Claude Max aporta capacidad de Claude y Claude Code dentro de sus límites de
uso; no incluye créditos de la API tradicional. No se debe colocar el token
OAuth en el servidor Railway ni diseñar un endpoint multiusuario que lo use
como API de producción. Si Anthropic cambia las condiciones, el workflow se
pausa y WOBI vuelve al proveedor `api`.

Referencias oficiales:

- [Claude Code con planes Pro o Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [La suscripción no incluye la API ni Console](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console)
- [Configuración oficial de Claude Code Action](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)
- [Prácticas de seguridad de la Action](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md)
