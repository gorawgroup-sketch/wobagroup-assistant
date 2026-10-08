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
- Una cuenta que falla no bloquea a las demás. **Solo exigen a una persona** la sesión caducada, el 2FA/CAPTCHA, la falta de
  sesión y un banco que pide renovar el consentimiento. Todo lo demás (pantalla recargada, empresa sin activar, botón que aún
  no apareció) es transitorio: la cuenta queda «solicitada» y se repite en las pasadas de las **06:40 y 07:20** (3 pasadas al día;
  después, «fallida»). Antes de repetir se mira el estado real de Holded para no repetir lo que sí surtió efecto. La conversión a
  ticket aplica la misma política (hasta 3 ciclos de 30 min antes de «fallido»).
- Consulta en el chat: «¿se sincronizó el banco hoy?» (herramienta `estado_automatizacion_holded`, solo lectura).
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

## Nombres de las empresas (no confundir título y nombre legal)

El título que Holded muestra arriba a la izquierda **no es el nombre legal**. Validado en Holded → Configuración (2026-10-03):

| Título en Holded | Nombre legal (como lo muestra Holded) |
|---|---|
| WOBA | Business Atelier Europa SL |
| Eworks | COMPAÑIA DE PROYECTOS EWORKS SL (Compañía de Proyectos eWorks SL) |
| Footprint Global | BUSINESS FOOTPRINT EU SL |

Antes de lanzar la sincronización de una empresa, el sistema lee ese nombre legal del panel de Configuración y lo compara (sin
tildes ni mayúsculas) con el esperado (`core/holded/automatizacion/empresas.ts`). Si **no coincide** no se toca nada y lo decide
una persona; si no se pudo leer, es transitorio y se reintenta. Los avisos muestran «WOBA (Business Atelier Europa SL)».
Las cuentas se abren por su id (`/banking/accounts/<id>`), que es propio de cada empresa: en la empresa equivocada simplemente
no existen. `npx tsx scripts/holded-sesion.ts comprobar` valida las tres.

Para pruebas fuera de horario: `WOBI_HOLDED_SYNC_BANCARIA_CRON_EXTRA` (pasada extra de lanzamiento) y
`WOBI_HOLDED_SYNC_BANCARIA_CRON_EXTRA_VERIFICAR` (verificación y cierre), con una expresión cron; vacías por defecto.

## Regla amplia de conversión a ticket (aprobada 2026-10-03, WOBA + EWORKS + Footprint)

Se aplica a gastos que WOBI creó, tras las condiciones de seguridad de siempre (conciliado, completo, con comprobante). Basta **una**
señal de ticket: (1) proveedor sin NIF/CIF y gasto en moneda distinta del euro; (2) proveedor sin NIF de fuera de la UE; (3) ya se
convirtió antes un gasto de ese proveedor; (4) el documento se declara ticket/factura simplificada. **Exclusiones que ganan siempre:**
proveedor con NIF/CIF registrado (factura formal) e importe superior a 500 € (equivalente; total ÷ tasa del documento). Lo demás va a

> **Corrección 04-10-2026:** el equivalente en euros se calculaba leyendo `currency_change` «1.12» como 112, así que en gastos en divisa el tope de 500 € nunca saltaba. Ahora la tasa se lee como decimal plano (`tasaDeCambio` en `escaneoTickets.ts`); un gasto de 600 USD a 1,12 son 535,71 € y queda excluido. Ningún gasto ya convertido superaba el tope.

> **Defensa en profundidad 04-10-2026:** al procesar un caso que vino del escáner de la regla, la cola vuelve a aplicar las EXCLUSIONES (NIF/CIF y tope de 500 €) con datos frescos justo antes de actuar; si ya no se cumplen, el caso queda `omitido` con el motivo. Evita que un candidato apuntado con datos antiguos (o antes de corregir un proveedor) se convierta después. `entradaReglaDesdeCompra` (reglaTicket.ts) es la única forma de armar la entrada de la regla: el escáner y la cola usan la misma.

> **La regla manda sobre la clasificación provisional (04-10-2026):** cada gasto que crea WOBI recibe al nacer un registro con una clasificación provisional del documento (`registrarClasificacionDocumento`): «ticket» → en cola; «factura» declarada → `omitido`; dudoso → `requiere_intervencion` («Clasificación dudosa»), siempre con 0 intentos. El escáner de la regla saltaba cualquier gasto que ya tuviera registro, así que un gasto que la regla aprobaba (sin NIF y fuera de la UE o en divisa) podía quedarse sin convertir para siempre (casos Uber Colombia, Restaurante Diego Hyatt y Café de Santa Bárbara, 02-10-2026). Ahora, si la regla aprueba un gasto cuyo único registro es esa clasificación provisional y **nunca se intentó**, el escáner lo reabre como `regla_auto` (`reabiertoPorRegla`). Se respeta todo lo demás: convertidos, intentados, fallidos, con NIF/CIF o por encima del tope.
revisión; nunca se convierte solo.

Interruptores propios: `WOBI_HOLDED_TICKETS_REGLA_MODO` (apagado | simulacion | activo) y `WOBI_HOLDED_TICKETS_REGLA_EMPRESAS`.
En **simulación** la exploración (cada 30 min, últimos 14 días) registra candidatos y avisa a los administradores, pero la cola no
procesa ninguno ni toca Holded. Solo con el modo en `activo` se convierten. Ver también `/health` → `automatizacionHolded`.

## Cuidados con el usuario Administrador de WOBI en Holded

El usuario de WOBI en Holded tiene rol Administrador (decisión de Carlos). Para que eso no pueda perjudicar la contabilidad, lo que
el rol permitiría se recorta en el propio navegador de WOBI (`core/holded/automatizacion/cuidados.ts`, con pruebas):
- **Bloqueo de red:** se rechaza cualquier petición DELETE y cualquier escritura sobre invitaciones/gestión de usuarios,
  suscripción, facturación, cierre de periodos o claves de API. Cada bloqueo queda en `/health` (`peticion_bloqueada`).
- **Clics:** el sistema se niega a pulsar etiquetas como «Eliminar», «Borrar», «Invitar», «Cerrar periodo», «Cancelar suscripción».
- **Topes:** máximo 10 conversiones por ciclo (30 min) y 40 por día.
- **Disyuntor:** si 2 gastos de las últimas 24 h terminan con cambios inesperados en Holded, la conversión se detiene sola, se avisa a
  los administradores y no se procesa nada más hasta que una persona lo revise.
- Se mantienen las salvaguardas de siempre: nombre legal de la empresa verificado antes de actuar, id de cuenta/gasto propio de cada
  empresa, alcance por listas aprobadas, botones de aprobación para toda escritura por API, y WOBI nunca reconecta bancos.

## Sesión web de Holded (procedimiento seguro)

**La empresa activa en Holded es del USUARIO, no de la sesión** (descubierto el 2026-10-03: la primera sincronización de las 06:00
falló en las 3 cuentas). Cualquier acción —de WOBI, de una prueba o de una persona usando esa cuenta— cambia la empresa activa
para TODAS las sesiones, así que nunca se puede suponer cuál es. Por eso el trabajador **activa siempre la empresa pedida antes
de actuar** (menú de la empresa → «Cambiar cuenta») y verifica que quedó activa; si ya lo era, no toca nada. Las páginas de
Footprint (miles de documentos) tardan 10-15 s en asentarse porque se recargan al abrir: se espera a que el texto sea estable
antes de interactuar. Variables: `WOBI_HOLDED_WEB_SESSION_WOBA|_EWORKS|_FOOTPRINT` (cualquiera de ellas vale: son el mismo
usuario) y `WOBI_HOLDED_WEB_SESSION` como general. **Efecto a tener en cuenta:** si una persona usa Holded con ese mismo usuario
mientras corre una automatización, su empresa activa puede cambiar al recargar; la solución limpia es un usuario de Holded
dedicado a WOBI.

1. En tu ordenador: `npx tsx scripts/holded-sesion.ts capturar` (o `capturar Footprint` para una sola) → se abre Chrome y,
   para cada empresa, una ventana nueva con sesión independiente: **tú** inicias sesión (contraseña, 2FA y CAPTCHA los
   resuelves tú), dejas esa empresa activa y pulsas Enter. Solo se guardan cookies en `~/.wobi-holded-sesion-<empresa>.b64`
   (permisos 600, no se imprimen).
2. Súbelas al servidor sin pasar por el chat con la orden que imprime el script (`railway variables --set …`) y borra los archivos.
3. Comprobación sin tocar nada: `npx tsx scripts/holded-sesion.ts comprobar` (verifica cada empresa y que sea la correcta).
4. No pulses «Cerrar sesión» en Holded con esas cuentas: la invalidaría.
5. Si caduca, los trabajos pasan a `requiere_intervencion` y se avisa: se repite el procedimiento. Se recomienda una cuenta
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

**Sincronización bancaria — validada en ensayo (sin pulsar):** cada cuenta tiene su página `/banking/accounts/<id>` (el mismo id
que la API de tesorería) con un botón azul «Sincronizar» arriba a la derecha; la lista de cuentas muestra «Sincronizado hace N
horas» (Holded sincroniza ~1 vez al día, por eso el aviso de las 06:00 aporta valor). Verificado sin pulsar en WOBA y EWORKS; una cuenta
que pida renovar el consentimiento del banco no mostrará el botón y se informa (nunca se reconecta). El primer día se limita a una
lista aprobada: `WOBI_HOLDED_SYNC_BANCARIA_CUENTAS="Empresa:idCuenta,…"` (con `WOBI_HOLDED_SYNC_BANCARIA_MODO=activo` y
`WOBI_HOLDED_SYNC_BANCARIA_EMPRESAS`). Sin esa variable se sincronizan todas las cuentas conectadas de las empresas en alcance.

**Caso controlado:** `WOBI_HOLDED_TICKETS_CASO="WOBA:<idCompra>"` (con `WOBI_HOLDED_TICKETS_MODO=activo` y
`WOBI_HOLDED_TICKETS_EMPRESAS=WOBA`) limita la ejecución a ese único gasto y avisa del resultado a los administradores.
Para quitarlo: borrar la variable.

## La regla pregunta de verdad y reconoce el recibo en otra moneda (2026-10-08)

Caso real, Footprint: Cnidos y Rifados (180 MXN → 8,92 €), Raku Café, Cocos y Poke Laureles seguían como «Compra». Tres causas:

1. **La pregunta con botones no llegaba nunca.** Todo gasto que crea WOBI trae un registro provisional («Clasificación dudosa»). `registrarDudoso` veía ese registro y no hacía nada, así que la regla, al no decidir, no preguntaba. Ahora `convertirProvisionalEnDudoso` convierte ese registro en la pregunta pendiente (origen `regla_revisar`, la que atienden los botones) y se pregunta una sola vez.
2. **Faltaba una señal.** El contacto no tiene país y el gasto está en EUR (se convirtió al crearlo), así que «sin señal clara». WOBI deja en la descripción del gasto la moneda del recibo («… (180 MXN, comprobante en MXN)»): `monedaOriginalDeDescripcion` la lee y cuenta como señal de ticket. Las exclusiones siguen ganando (NIF/CIF, tope de 500 €). En seco con datos reales: Cnidos, Raku Café, Cocos y Poke Laureles pasan a ticket; solo se preguntan Booking (LATAM), Apartment Vila Olímpica y Rinkel.
3. **Sin forma de lanzarla a mano.** `/tickets` (menú) ejecuta ya la misma pasada que corre cada 30 minutos; solo superadministrador.

No cambia: Uber Colombia sin comprobante adjunto o Metro Art Hotel sin conciliar del todo siguen esperando (son requisitos de seguridad de la cola).

