# Automatizaciones de Holded en servidor

Dos automatizaciones que corren en Railway aunque tu ordenador esté apagado. **Ambas llegan apagadas**: desplegar el
código no cambia nada del sistema hasta que se enciende cada una con su variable de entorno.

## Qué permite (y qué no) la API de Holded — verificado 2026-10-02

| Necesidad | API oficial | Consecuencia |
|---|---|---|
| Marcar un gasto como ticket («Es una factura de compra») | No existe campo ni endpoint | Solo desde la interfaz web (navegador en servidor) |
| Saber si un gasto es ticket | Indirecto: un ticket se lee por `GET /purchases/{id}` pero **no aparece** en `GET /purchases` | Es la prueba de verificación tras guardar |
| Lanzar o consultar una sincronización bancaria | No existe | «Sincronizar» solo desde la interfaz web |
| Evidencia de sincronización | `synced_at` y `transactions_pending_to_reconcile` por cuenta (`GET /treasury/accounts`) | «Completada» = `synced_at` posterior al lanzamiento |
| Conectar un banco | Solo en la aplicación | Nunca se desconecta ni reconecta automáticamente |

Holded ya sincroniza solo varias veces al día la mayoría de cuentas (a las 08:45 UTC de hoy casi todas tenían `synced_at`
reciente). Hay dos cuentas viejas que probablemente necesitan intervención humana: WOBA «ES90…» (sin sincronizar desde
2026-03-03) y el PayPal «Alberto Comolli» de Footprint (desde 2025-05-29).

## Interruptores (independientes)

| Variable | Valores | Efecto |
|---|---|---|
| `WOBI_HOLDED_SYNC_BANCARIA_MODO` | `apagado` (defecto) · `simulacion` · `activo` | Sincronización bancaria 06:00 |
| `WOBI_HOLDED_SYNC_BANCARIA_EMPRESAS` | `WOBA,EWORKS,Footprint` | Alcance en modo activo (sin lista = ninguna) |
| `WOBI_HOLDED_TICKETS_MODO` | idem | Conversión a ticket |
| `WOBI_HOLDED_TICKETS_EMPRESAS` | idem | Alcance en modo activo |
| `WOBI_HOLDED_WEB_SESSION` | secreto | Sesión web de Holded (ver abajo) |

- `simulacion`: solo **lee** de la API y registra qué haría; nunca abre el navegador ni escribe en Holded.
- `activo` exige PostgreSQL duradero (`WOBI_MAIL_DATABASE_URL`); sin él no se ejecuta.
- Apagar = poner `apagado` (el cron sigue pero termina al instante). Un valor desconocido equivale a `apagado`.

## Sincronización bancaria

- **06:00 Europe/Madrid** (cambio de hora automático) se *inicia*; no se promete hora de fin.
- Cuenta sincronizable = no archivada + con banco enlazado (`institution_id`) + tipo banco/tarjeta/pasarela. Manuales,
  de efectivo y contables se omiten sin ensuciar el registro. Clave estable: `empresa:idCuenta`.
- Estados: `solicitado` → `en_curso` (acción lanzada) → `completado` (verificado) · `fallido` · `requiere_intervencion`
  (sesión caducada, 2FA/CAPTCHA, botón no encontrado/consentimiento) · `no_confirmado` (sin evidencia en 3 h) · `omitido` · `simulado`.
- Pulsar el botón **nunca** marca completada: lo hace la pasada de verificación (06:10, :30, :50 hasta las 09:50) al ver
  `synced_at` posterior; registra la hora de verificación.
- Una cuenta que falla no bloquea a las demás. Errores transitorios: hasta 3 intentos con espera creciente, mirando antes
  el estado real de Holded para no repetir lo que sí surtió efecto.
- A las 09:45 se avisa por Telegram **solo a los administradores** y **solo si** hay cuentas fallidas, que requieren
  intervención o sin confirmar. Silencio = todo bien.
- La conciliación posterior puede consultar `cuentaTieneActualizacionConfirmada(almacen, empresa, cuentaId, desde)`.

## Conversión a ticket

**Regla obligatoria (Carlos, 2026-10-02):** solo se convierte un gasto que **WOBI creó** (marcador `[wobi:…]` en las notas),
que está **conciliado con el banco** (cobro enlazado y nada pendiente), **completo** (contacto, importe, líneas con cuenta,
estado completado) y con su **comprobante adjunto**. Se comprueba justo antes de actuar. Si no lo creó WOBI → `omitido`, no
se toca. Si aún le falta conciliar o adjuntar → espera en cola (hasta 21 días; después decide una persona). Lo creado
antes del marcador queda fuera de la conversión automática (el inventario lo muestra como «no elegible»).

- **Al crear el gasto** (aprobación con botón) se clasifica una vez: `ticket` (se declara ticket/factura simplificada y no
  identifica al comprador) → cola; `factura` → omitido; **dudoso → revisión**. Que falte el número **no** basta para ser ticket.
  Se guarda la evidencia (motivos y señales).
- Cola cada 30 min (`:05` y `:35`) y revisión nocturna 02:30 (resumen a administradores de lo dudoso/fallido).
- Antes de actuar se lee el estado real; si ya es ticket → `omitido`. Se guarda una instantánea (contacto, fecha, moneda,
  **tasa**, importes, impuestos, líneas/cuentas, etiquetas, cobros y pagos). Tras guardar se verifica: ausente del listado
  **y** instantánea idéntica. Si cambió cualquier campo → `requiere_intervencion`, caso detenido y avisado.
- No modifica tolerancias, tipos de cambio ni importes; no borra ni recrea el gasto.
- **Gastos antiguos**: solo inventario de candidatos (solo lectura), sin conversión masiva:
  `npx tsx scripts/holded-auto.ts inventario Footprint 2026-08-15 2026-10-02`.

## Sesión web de Holded (procedimiento seguro)

1. En tu ordenador: `npx tsx scripts/holded-sesion.ts capturar` → se abre Chrome; **tú** inicias sesión (contraseña, 2FA y
   CAPTCHA los resuelves tú). El script guarda solo cookies en `~/.wobi-holded-sesion.b64` (permisos 600, no se imprimen).
2. Súbela al servidor sin pasar por el chat: `railway variables --set "WOBI_HOLDED_WEB_SESSION=$(cat ~/.wobi-holded-sesion.b64)"` y borra el archivo.
3. Comprobación sin tocar nada: `npx tsx scripts/holded-sesion.ts comprobar`.
4. Si caduca, los trabajos pasan a `requiere_intervencion` y se avisa: se repite el procedimiento. Se recomienda una cuenta
   de Holded dedicada para WOBI y no usar esa misma sesión a la vez en otro sitio.

## Navegador en servidor y costes

Ya existe Chromium en el despliegue (lo usa la generación de PDF): **no hace falta un servicio nuevo ni coste recurrente
extra**. Cada acción abre su propio navegador, con tiempo máximo de 90 s, y solo hay uno a la vez por proceso.
Si en el futuro el consumo de memoria molestara al servidor principal, la alternativa es un worker aparte (coste de un
servicio adicional de Railway); se consultará antes de contratarlo.

## Recuperación y operación

- Cola y registro en PostgreSQL (`wobi_holded_jobs`, `wobi_holded_job_events`; esquema en `SCHEMA_AUTO`, aplicado por el
  `preDeployCommand`). Claves idempotentes: `sync:AAAA-MM-DD:empresa:cuenta` y `ticket:empresa:compra`.
- Candado consultivo por trabajo: dos ejecuciones o instancias a la vez no duplican la acción. Tras un reinicio solo se
  repite lo que no llegó a lanzarse; lo «en curso» se verifica, no se relanza.
- Consulta: `npx tsx scripts/holded-auto.ts status` (modos, alcance, conteos y últimos incidentes).
- Desactivar: poner el modo a `apagado` (redeploy por cambio de variable). No hay nada que revertir en Holded: un ticket
  se puede volver a marcar como factura a mano desde la interfaz.

## Estado de validación de la interfaz web

**Conversión a ticket — validado contra la interfaz real (2026-10-02, solo lectura):** el editor del gasto tiene URL directa
`/doc/purchase/<id>/edit`; ahí está «Opciones» → casilla «Es una factura de compra» (marcada en los gastos actuales) y los
botones «Guardar como borrador» / «Guardar». El contenido vive en un marco anidado (el trabajador lo localiza). Guardado real
**aún no ejecutado**: se hará con el caso controlado aprobado.

Salvaguardas añadidas por lo visto en la interfaz:
- Si el gasto es **borrador** (sin aprobar, sin número) se usa «Guardar como borrador»; «Guardar» podría aprobarlo.
- La instantánea de verificación incluye borrador, aprobación y **vencimiento**: si el guardado los cambia, el caso se detiene.
- El navegador se emula en hora de Madrid (el editor mostraba el vencimiento un día antes con hora UTC).
- Solo actúa si la empresa activa en Holded es la esperada; con una sola sesión para las tres empresas, el cambio de empresa
  aún no está automatizado (primero WOBA).

**Sincronización bancaria — sin validar:** la pantalla de tesorería y el botón «Sincronizar» no se han visto aún; hasta
validarlos solo se usa en modo `simulacion` (observación por API).

**Caso controlado:** `WOBI_HOLDED_TICKETS_CASO="WOBA:<idCompra>"` (con `WOBI_HOLDED_TICKETS_MODO=activo` y
`WOBI_HOLDED_TICKETS_EMPRESAS=WOBA`) limita la ejecución a ese único gasto y avisa del resultado a los administradores.
Para quitarlo: borrar la variable.
