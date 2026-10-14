# Correo a una audiencia (comunicaciones a varias personas)

**Origen (Carlos, 14-10-2026).** Pidió escribir a todos los que ya habían recibido una solicitud de soportes —agradecer a quien ya los envió y explicar a quien no cómo hacerlo—. El asistente respondió que «no podía mezclarlo» porque solo existía el proceso específico de pedir cargos nuevos. Carlos pidió una solución **general**, no un parche por cada pedido: que el sistema, ante «envía este correo a toda esa base», busque la base y lo envíe siguiendo la orden.

**Cómo funciona.**
1. Se pide en el chat («envía a todos los de soportes un correo agradeciendo y explicando cómo enviarlos», «avisa a todo el equipo de Footprint de…»).
2. El chat llama a `proponer_correo_a_audiencia`: **redacta el asunto y el cuerpo según la orden** (puede usar `{nombre}`, `{nombre_completo}`, `{empresas}`), elige la **audiencia** y sus parámetros, y opcionalmente `excluir` (nombre y apellido) o `solo_listar` (solo dice a quién iría).
3. Se muestra un resumen con «👁 Ver correo» (texto exacto con los datos de la primera persona), «✅ Enviar a N» (**solo superadmin**) y «❌ Cancelar». **Nada sale sin «Enviar».**
4. Se envía un correo por persona desde `asistente@wobagroup.com`, con clave de idempotencia por comunicación+persona+destinatario (un doble toque no duplica; «🔁 Reintentar» manda solo los que fallaron).

**Audiencias (registro abierto, `core/comunicaciones/audiencias.ts`).** Un módulo con una base de personas la añade con `registrarAudiencia({ id, descripcion, parametros, resolver })` y el chat ya puede usarla, sin código nuevo en el envío. Hoy:
- `solicitud_soportes`: quienes ya recibieron una solicitud de soportes (`_soportes_solicitados`), con su email confirmado (`_titulares_soportes`); un correo por persona aunque se le pidiera en varias empresas; sin sociedades. Parámetro: `empresa` (opcional).
- `directorio`: personas del directorio de contactos del buzón, por texto (`consulta`) y/o `dominio`.
- `lista`: la que da quien pide el envío (`destinatarios: [{ nombre, email }]`), con los emails validados.

**Reglas.** Solo personas con email que consta en un registro o que dio quien lo pide; nunca se adivina. Máximo 60 personas por envío. Se avisa si a alguien ya se le envió un correo con el mismo asunto en los últimos 30 días. El texto es el que se ve en «Ver correo»: lo que se aprueba es lo que sale.

**Estado y registro.** `_comunicaciones_masivas` (cabecera con asunto y cuerpo) y `_comunicaciones_destinatarios` (estado por persona; se purga a los 60 días). Código: `core/comunicaciones/` (`plantilla.ts`, `destinatarios.ts`, `audiencias.ts`, `envioMasivoStore.ts`, `envioMasivoTelegram.ts`) y `core/tools/proponerCorreoAAudiencia.ts`. Botones `cm_v`, `cm_e` (sensible y entrega durable), `cm_c`.

**Formato de soportes.** Lo que se pide a quien envía un soporte (correo aparte y nuevo a `asistente@wobagroup.com`, sin responder a la solicitud; asunto con detalle del gasto, valor, moneda y empresa; documento original adjunto) vive en un solo lugar, `INSTRUCCIONES_ENVIO_SOPORTES` (`core/soportes/redactarCorreoSoportes.ts`), y lo usan el correo de solicitud, la hoja de seguimiento y la regla fija del asistente.

**Pedir al creador del gasto lo que falta (14-10-2026).** Cuando un comprobante recibido por correo no trae un dato imprescindible (fecha, moneda, comercio o empresa) y el gasto queda «pendiente de datos», Wobi ya no se limita a preguntar a Carlos: escribe a **quien envió el comprobante**, de forma profesional, con lo mínimo que hay que preguntar.
- `core/gastos/datosFaltantes/` (`solicitudDatos.ts` puro, `solicitudDatosStore.ts`, `prepararSolicitudes.ts`): agrupa los pendientes de correo por creador (un correo por persona con todo lo suyo; el mismo ticket reenviado cuenta una vez; `verificacion_duplicado` no se pregunta) y redacta una línea por gasto según el motivo (`fecha`, `moneda`, `proveedor`, `empresa`). Se envía como **correo a una audiencia** (`lista` con `{detalle}` por persona): resumen con «Ver correo / Enviar / Cancelar», solo superadmin; el seguimiento de las respuestas entra en el seguimiento de comunicaciones.
- Job `solicitarDatosFaltantes` (laborables 9:05 y 15:05): prepara el resumen para los pendientes con más de 2 horas, sin repetir lo pedido en 7 días. Herramienta `solicitar_datos_faltantes_a_creadores` (a demanda, con `ids` opcional). Registro en `_solicitudes_datos_gasto`.
- Alcance actual: gastos que llegan por correo (el creador es el remitente). Los subidos por Telegram sin correo no tienen a quién escribir todavía. La respuesta del creador la ve Carlos (resumen de seguimiento) y se aplica con «reintenta el gasto pendiente con la fecha X»; aplicarla sola es un paso posterior cuando haya respuestas reales.
