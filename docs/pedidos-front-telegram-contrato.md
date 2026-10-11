# «Pídele a WOBi» → procesamiento de Telegram: contrato (backend)

Un pedido escrito en el front, **confirmado** por la persona, entra por el **mismo procesamiento que un mensaje suyo de Telegram**
(`procesarUpdateTelegram` a través del ledger durable de entregas), sin que tenga que copiarlo ni enviarlo a mano. Código:
`core/cerebro/pedidos/` (router, borradores, funciones puras, bitácora) y el montaje en `src/server.ts`
(`/api/cerebro/pedidos`). Pruebas: `core/cerebro/pedidos/pedidos.test.ts`.

## 1. Qué se verificó antes de construir

**Por qué NO se publica un mensaje con el bot.** Un mensaje del bot a la persona es un mensaje **del bot**: Telegram no permite a un bot
enviar «como» un usuario, y el procesamiento solo se dispara con un mensaje **de** la persona. Pero no hace falta pasar por Telegram: el
servidor ya ejecuta ese procesamiento en proceso. Lo que se reutiliza, tal cual:

| Pieza existente | Uso en los pedidos |
|---|---|
| `resolverIdentidadChatWeb` (clave + dispositivo + `chatVinculos`) | Identidad. El dispositivo se vincula a SU Telegram con un código de 10 min que **solo esa persona puede confirmar desde su propia cuenta** (`/api/cerebro/chat/vincular` → `confirmarVinculoChat`). `chatId` = id de usuario de Telegram. Solo `modo: "completo"` con rol vigente. |
| `procesarUpdateTelegram` | Procesamiento. Vuelve a comprobar `esUsuarioAutorizado` (si se revoca el acceso entre medias, no se ejecuta), aplica los roles (`obtenerRolUsuario`) y las cadenas deterministas y de IA igual que un mensaje real. |
| `CoordinadorEntregasTelegram` + ledger `_telegram_entregas_durables` | Recepción durable, idempotencia por `update_id`, recuperación tras un despliegue y aviso «Verificar resultado» si queda incierto. |
| Botones de Telegram (`despacharCallbackQuery`) | **Aprobaciones**. No cambian: cualquier operación financiera o sensible sigue pidiendo su botón (y el rol de superadmin cuando corresponde). Un pedido es solo texto. |

**Qué NO hay que construir y qué sí falta.**
- *Vincular usuarios:* ya existe y no se toca. Lo que **falta por persona** es tenerlo hecho: quien no tenga el dispositivo vinculado a su
  Telegram recibe `403 sin_vinculo` con las instrucciones (no se envía nada ni se usa una identidad compartida). La clave maestra sola
  no identifica a nadie: hace falta además el `X-Cerebro-Device` vinculado (secreto del navegador) y el nombre con el que se vinculó.
- *Telegram impide* (y por eso hay tres diferencias respecto a escribir en Telegram):
  1. El texto de la persona **no aparece** en su chat de Telegram. Solución: WOBi deja un **eco** `📲 Pedido desde el front (ref. XXXXXXXX): «…»` justo antes de procesar (también queda en el historial y sirve de marca para localizar la respuesta).
  2. No hay «responder a» un mensaje concreto (`reply_to_message`). Las respuestas libres a una pregunta pendiente se tratan como si se escribieran sin responder a ningún mensaje; para decidir sobre una pregunta con botones se usan los botones (`POST /api/cerebro/chat/boton`, ya existente).
  3. La respuesta llega **a Telegram** (y al historial visible), no en la respuesta HTTP del pedido.

## 2. Garantías

1. **Identidad verificable.** Del cuerpo solo se leen `texto`, `pedidoId` y `textoHash`. Usuario, chat y rol salen de la identidad vinculada del servidor; cualquier otro campo se ignora (prueba).
2. **Texto original + confirmación.** `POST /` crea un **borrador** (nada se envía). El servidor conserva el texto exacto; para enviar hay que confirmar devolviendo el `textoHash` del texto mostrado. Si no coincide → `409 texto_distinto`.
3. **Confirmar el envío ≠ aprobar.** El pedido es un mensaje de texto. Las aprobaciones financieras y sensibles siguen siendo botones de Telegram. `terminado` tampoco significa «aprobado»: lo dice el propio mensaje de estado.
4. **Sin duplicados.** Clave de idempotencia = `update_id` **sintético negativo** (Telegram solo emite positivos) derivado de (persona, `pedidoId`). Doble clic, reintentos o fallos de red → una sola entrega, una sola ejecución, un solo eco. Si el servidor se reinicia y pierde el borrador, volver a confirmar devuelve el estado del ledger, sin ejecutar otra vez.
5. **Recepción ≠ ejecución.** `recibido` solo significa «registrado de forma durable». La ejecución se informa aparte (`ejecucion`).
6. **Fallar cerrado.** Si no se pudo registrar → `503 recepcion_fallida` y no se envía nada (se puede reintentar sin riesgo). Si el procesamiento se interrumpe → `fallido` con `detalle: "resultado_incierto"`: **nunca se repite solo**; Telegram avisa con «Verificar resultado».
7. **No se rompe Telegram.** No se tocó ningún flujo existente: el único cambio en código compartido es un campo opcional `origen` en `TelegramUpdate` (solo informativo).

## 3. Endpoints (`/api/cerebro/pedidos`)

Cabeceras de identidad iguales a las del chat: `X-Cerebro-Key`, `X-Cerebro-Device`, `X-Cerebro-Nombre`. Todas las respuestas son `no-store`. Errores: `{ error, codigo }`.

### `GET /disponibilidad`
`{ disponible: boolean, motivo?: "sin_vinculo"|"apagado"|"entrega_durable_apagada", mensaje?, destino: { canal: "telegram", cuenta }, caducidadBorradorSegundos: 600 }`.
El front muestra «Enviar a WOBi» solo si `disponible`; con `sin_vinculo` ofrece el flujo de vinculación existente.

### `POST /` — crear borrador
Cuerpo `{ texto, pedidoId? }` (`pedidoId`: 16–64 caracteres `[A-Za-z0-9_-]`, lo genera el front para poder reintentar; si falta lo genera el servidor).
`201` (o `200` si es un reintento idéntico): `{ pedidoId, ref, estado: "pendiente_confirmacion", ejecucion: "no_enviada", mensaje, texto, textoHash, expiraEn, destino, duplicada }`.
Errores: `400 texto_invalido` (vacío, >4000, caracteres de control) · `422 texto_no_permitido` (un código de vinculación: **no se puede vincular un dispositivo desde un pedido**, queda constancia) · `409 pedido_id_con_otro_texto` · `429` · `403 sin_vinculo` · `503 apagado|entrega_durable_apagada`.

### `POST /:pedidoId/confirmar`
Cuerpo `{ textoHash }` (el recibido en el borrador). Idempotente.
`202` `{ pedidoId, ref, estado: "recibido", ejecucion: "pendiente", mensaje, resultado, recibidoEn, duplicada: false }`. Un reintento devuelve el estado actual con `duplicada: true` (`202` mientras corre, `200` si ya terminó).
Errores: `404 borrador_no_encontrado` (caducó o el servidor se reinició y nunca se envió) · `409 texto_distinto|pedido_cancelado` · `410 borrador_caducado` · `429` · `503 recepcion_fallida`.

### `POST /:pedidoId/cancelar`
Solo mientras es borrador → `cancelado`. Si ya se envió: `409 ya_enviado`.

### `GET /:pedidoId` — estado y resultado
`{ pedidoId, ref, estado, ejecucion, detalle?, mensaje, resultado: { canal: "telegram", donde }, recibidoEn?, actualizadoEn? }`.
Solo la propia persona ve sus pedidos (otro usuario → `404`). Se conservan en el ledger unos 30 días (`WOBI_TELEGRAM_LEDGER_RETENTION_DAYS`). Sondear cada 2–3 s mientras `recibido`/`procesando`; el servidor cachea el estado 2 s.

### Estados
| `estado` | `ejecucion` | Significado |
|---|---|---|
| `pendiente_confirmacion` | `no_enviada` | Borrador. Nada se ha enviado. |
| `recibido` | `pendiente` | Registrado de forma durable; todavía no ha empezado. |
| `procesando` | `en_curso` | WOBi lo está procesando. |
| `terminado` | `finalizada` | La cadena de Telegram terminó y respondió **en Telegram**. No implica que una operación se haya aprobado o ejecutado. |
| `fallido` | `incierta` (`detalle: resultado_incierto`) | Se interrumpió; puede haber hecho parte. No se repite solo. |
| `cancelado` / `expirado` | `no_enviada` | Nunca se envió. |

### Dónde está el resultado
La respuesta (y sus botones de decisión) llega al chat de Telegram de la persona. Desde el front se lee con lo que ya existe: `GET /api/cerebro/chat` (historial visible y `botonesActivos`) **a continuación del eco** `Pedido desde el front (ref. XXXXXXXX)`; los botones se resuelven con `POST /api/cerebro/chat/boton`.

## 4. Trazabilidad
- **Ledger durable** (`_telegram_entregas_durables`, ya existente): entrega por pedido con estados `reservada → iniciada → completada|incierta` y tiempos.
- **Bitácora permanente** `_cerebro_pedidos_front` (solo añade filas): `cuando, evento (confirmado|cancelado|rechazado), pedidoId, ref, chatId, nombre, rol, dispositivo (huella de 12 caracteres, nunca el id real), textoHash, longitud, detalle`. **No guarda el texto ni claves**; el texto está en el historial de esa persona tras el eco.
- Si la bitácora falla, el pedido sigue y el fallo queda en el log (`[pedidos] No se pudo registrar la bitácora…`).
- El `update` sintético lleva `origen: { canal: "front", pedidoId, ref, dispositivo, textoHash }`.

## 5. Operación
- `WOBI_PEDIDOS_FRONT=apagado` desactiva el envío (por defecto activo). Requiere el ledger durable activo (`WOBI_TELEGRAM_DURABLE_ENABLED`, activo por defecto).
- Límites por persona: 10 confirmaciones/min, 20 borradores/min, 20 borradores pendientes, 60 consultas/min; texto ≤ 4000 caracteres.
- Un pedido es **igual que escribir ese texto en Telegram**, también en lo incómodo: si la persona tiene activo un modo de Telegram (p. ej. «modo conocimiento» o una captura en curso), ese modo recibe el texto. Las órdenes con «/» (`/preguntas`, `/tickets`, `/revisarcorreo`…) funcionan igual y con los mismos roles.
- Los borradores viven en memoria (10 min): un despliegue entre «escribir» y «confirmar» obliga a repetir el pedido; **nunca** envía algo no confirmado.

## 6. Riesgo residual (honesto)
Si el front se viese comprometido (p. ej. un script malicioso), podría crear y confirmar pedidos como la persona vinculada, con el mismo poder que un mensaje suyo de Telegram. Lo que lo contiene: sin vínculo no hay nada; el vínculo no se puede crear desde un pedido; los límites; y, sobre todo, que **toda aprobación financiera o sensible sigue exigiendo un botón en su Telegram** (canal distinto del navegador).

## 7. Qué implementa Codex
1. Consultar `GET /disponibilidad`; si `sin_vinculo`, ofrecer el flujo de vinculación existente.
2. En «Pídele a WOBi»: crear el borrador (`pedidoId` generado en el front), **mostrar el texto exacto** y pedir confirmación («Se enviará a WOBi en tu Telegram. No aprueba ninguna operación»); al confirmar, enviar el `textoHash` recibido. Desactivar el botón tras el primer clic y reintentar con el **mismo** `pedidoId`.
3. Mostrar los estados con su vocabulario (`recibido` ≠ `procesando` ≠ `terminado`); `fallido` con `resultado_incierto` se muestra como «no sé si llegó a hacerse: revisa Telegram», sin ofrecer reenviar.
4. Para el resultado: enlazar al chat de Telegram y/o leer `GET /api/cerebro/chat` tras la marca `ref.`; las decisiones con botones usan `/chat/boton`.
5. Guardar el `pedidoId` en el navegador para poder consultar el estado tras recargar.
