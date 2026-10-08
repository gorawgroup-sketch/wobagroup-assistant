# Revisión automática de correo y revisión manual

La entrada existente `revisarCorreoNuevo` (cron, comando y herramienta de revisión) ejecuta primero el pase automático y después sincroniza la cola manual. No se añade otro cron ni otra cola de correo. La revisión manual conserva su aprobación individual y el orden del mensaje pendiente más antiguo al más reciente.

El pase programado se ejecuta solamente cuando `WOBI_MAIL_SCHEDULED_REVIEW_ENABLED=true`; puede dejarse deshabilitado para operar solo bajo pedido. Cuando está habilitado, se ejecuta cada dos horas en días hábiles y dos veces al día los fines de semana. Para evitar ruido, solo dos pases diarios publican un informe consolidado; las demás ejecuciones permanecen silenciosas salvo que necesiten comunicar un fallo accionable. Una orden manual responde siempre con su resultado y revisa exhaustivamente todos los correos no leídos del lote, sin heredar el máximo reducido de análisis del cron. Los límites manuales (`WOBI_MAIL_MANUAL_MAX_THREADS_PER_RUN`, `WOBI_MAIL_MANUAL_MAX_RUN_MS` y `WOBI_MAIL_MANUAL_ANALYSIS_CONCURRENCY`) controlan tamaño, duración y paralelismo sin recortar silenciosamente el lote normal de trabajo. La política monetaria separa `correo_gastos_automatico` (cron) de `correo_gastos_automatico_manual` (orden explícita), para que el techo económico del cron no interrumpa una revisión que el operador pidió conscientemente.

## Cuándo se registra un gasto

Se leen todos los mensajes sin leer, incluidos los archivados, excepto spam y papelera. Se descargan el cuerpo completo, el contexto del hilo y los adjuntos. Una lectura fallida, un formato que no se puede analizar o un límite de tamaño deja el mensaje pendiente; no se clasifica un fragmento como si fuera el correo completo.

Para automatizar deben cumplirse todas las comprobaciones:

- Ticket/recibo identificado con confianza alta y evidencia de empresa, proveedor, fecha e importe.
- Empresa habilitada y contacto único exacto en su Holded, admitiendo únicamente alias confirmados previamente.
- Cuenta contable respaldada por una corrección confirmada o precedentes válidos del proveedor.
- Consultas completas, sin gasto existente ni propuesta pendiente equivalente.
- Un único cargo bancario real, pendiente, con saldo conciliado cero, moneda y fecha coincidentes. No se fabrican movimientos.
- Comprobante único por fuente y sin reservas previas del documento, archivo o movimiento.

Las tolerancias existentes identifican candidatos: un céntimo en moneda nativa, o el mayor entre cinco céntimos y 2% para un equivalente explícito en otra moneda. Una diferencia en moneda nativa pasa a revisión; no se cambia el importe del recibo para forzar la conciliación. Con equivalente explícito se registra el cargo real y se conserva la información de ambos importes.

**Versión del análisis ligada al analizador (2026-10-07).** Los análisis se guardan por (huella del correo, `VERSION_ANALISIS`) y se reutilizan mientras la versión no cambie. La lectura robusta del 05-10 se desplegó sin subir la versión y los correos marcados «incompleto» nunca se releyeron (v23 lo corrige). Desde ahora cada cambio de `analyze.ts` obliga a subir `VERSION_ANALISIS` y la huella `HUELLA_ANALIZADOR_CORREO` (guardarraíl `core/guardarrailes/versionAnalisisCorreo.test.ts`). Coste de una subida: se vuelven a analizar solo los correos pendientes (no los ya cerrados).

**La segunda lectura de verificación nunca deja un «incompleto» a medias (v24, 2026-10-07).** Cuando la primera lectura marca un correo «incompleto» sin nombrar la parte, se relee una vez para verificarlo. Si esa relectura falla (tope diario de IA, red), antes se conservaba el primer resultado y quedaba guardado por versión: el recibo de Anthropic y dos de Antaris Suite salieron durante días como «el analizador no dio por completa la lectura» sin volver a leerse. Ahora ese fallo se propaga como fallo técnico (`analisis_no_completado`), no se guarda nada y la pasada siguiente vuelve a leer el correo. Además, cada respuesta del modelo rechazada por la validación deja en el log sus claves y tipos (sin contenido) para diagnosticar casos como Xue Cafe («sin estructura verificable» tres veces).

**La pregunta pendiente del correo activo cubre también los gastos a los que falta un dato (2026-10-07).** `reenviarPreguntaPendienteDelCorreo` (fin de revisión manual, vigilante) y la herramienta de chat «reenvía los botones de…» miran, además de propuestas y conciliaciones, el almacén `_gastos_pendientes_datos` (empresa, moneda real, fecha, proveedor, verificación de duplicados) y vuelven a poner la pregunta al final del chat. Caso real: «Lunch - 180 pesos mexicanos - revolut» tuvo la cola parada con el aviso «fallo temporal al leerla» porque la pregunta (importe exacto en la moneda real) vivía en ese almacén.

**Lectura robusta del analizador (2026-10-05).** Caso real: correos que se leían bien uno a uno salían «El analizador no dio por completa la lectura». Causas corregidas en `core/gmail/automatico/analyze.ts`: (1) un adjunto que el lector visual no admite (Word, Excel…) ya no tumba el correo entero: se intenta su texto sin IA y, si tampoco se puede, se declara NO LEGIBLE al modelo y se decide por regla (nombre tipo comprobante → lectura incompleta; informativo → no afecta); (2) «completo» mide solo LEGIBILIDAD, no dudas de interpretación, y toda lectura incompleta debe citar la parte concreta (`detalleIncompleto`, que llega al aviso del chat); (3) un bucle de reparo (hasta 3 intentos) cuando el modelo responde con formato inválido, número de llamadas incorrecto o se corta por límite de tokens; (4) una segunda lectura de confirmación cuando marca incompleto sin poder nombrar la parte. Verificado en 17 correos reales: 17/17 con lectura completa. Pruebas: `analyze.lectura.test.ts`.

## Lectura de la cadena del correo (2026-10-07, `core/correo/lectura/`)

Antes de clasificar, cada correo se lee como una **cadena**: quién lo escribe de verdad, quién lo reenvió, cuál es el mensaje nuevo y qué dice el historial. Es determinista (sin IA), se probó con formatos reales del buzón (28 de 40 correos con «Re:/Fwd:» eran reenvíos) y se valida con 80 correos reales de los últimos 45 días.

- Reconoce reenvíos de Gmail («Forwarded message / Mensaje reenviado», `De:`/`From:`), Outlook en línea (`De/Enviado/Para/Asunto` tras una raya y «Original Message»), atribuciones de respuesta en inglés, español, francés y alemán («On … wrote:», «El … escribió:», incluso partidas en dos líneas) y reenvíos citados con `>` anidados.
- **Remitente real** = el autor del mensaje reenviado más reciente que no sea el propio buzón (si el correo es un reenvío); en una respuesta, la cabecera. Se informa también quién reenvió y el autor más antiguo visible.
- **El mensaje nuevo** es solo lo que escribe quien envía el correo, sin las citas y sin su firma ni aviso legal; un reenvío sin nota se dice como tal («sin nota — solo reenvía»).
- El clasificador de la cola manual ya **no recorta a 8.000 caracteres**: el mensaje nuevo y el primer mensaje de la cadena van completos; el historial más antiguo tiene un presupuesto (24.000 caracteres) y, si se excede, el texto lo avisa para que el modelo no concluya nada sobre lo omitido.
- El resumen del análisis empieza con «Remitente real (según el texto del correo, sin verificar): …, reenviado por …».
- **Seguridad:** el texto de un reenvío lo puede escribir cualquiera. El remitente real sale del cuerpo, nunca se trata como verificado, **no se registra en el directorio de personas** (evita que alguien lo envenene para que el asistente resuelva un nombre a una dirección falsa) y no autoriza nada. Se conservan todas las protecciones del extractor anterior: la dirección es la de los ángulos, un nombre con «@» no es un nombre y un formato corrupto no produce email.
- Sustituye a `core/gmail/remitenteReenvio.ts` (retirado): el camino de «correo puntual» usa el mismo lector.

### Peticiones y adjuntos en la cola manual (paso 2, 2026-10-07)

- **Lista de peticiones.** El mismo clasificador (sin llamada de IA extra) devuelve `peticiones`: una entrada por cada petición distinta —quién la hace, qué pide, sobre qué adjunto, plazo y la acción propuesta para esa petición—. Con dos o más, la propuesta muestra una lista numerada con una acción por petición y la acción global las enumera; con una sola, el mensaje es el de siempre. Lo que ya se atendió en el historial citado no cuenta.
- **Adjuntos que entran al análisis** (`core/correo/lectura/adjuntos.ts`, `adjuntosVisuales.ts`): Word moderno, Excel, PowerPoint, CSV, texto y HTML se leen **sin IA**; los PDF e imágenes se leen con visión pero acotados: primero la lectura de factura (la misma del camino de documentos); si es un comprobante de gasto entra como **una línea de resumen**, y solo si NO lo es (carta, circular, captura) se **transcribe** para que sus peticiones entren al análisis. Máximo 3 lecturas visuales por correo, sin imágenes pequeñas (logos de firma), en paralelo, memorizadas por contenido 30 min. Lo que no se lee (Word antiguo `.doc`, archivos grandes, el resto) figura como «NO leído en este paso» y el modelo no debe concluir nada sobre ello.
- **Interruptor:** `WOBI_LECTURA_ADJUNTOS_VISUAL=false` apaga solo la lectura con visión (queda la determinista).
- **Coste medido (07-10, registro real):** el clasificador pasa de ~0,014 a ~0,023 USD por correo (prompt más largo + lista de peticiones); la lectura visual cuesta ~0,040 USD por PDF/imagen (extracción de factura) y ~0,011 USD la transcripción, solo cuando no es un gasto. Con el volumen de las últimas semanas (~19 clasificaciones/día, ~2 adjuntos visuales/día) son unos 0,3 USD al día (~8 USD al mes). Medir de nuevo con `/costos` tras unos días.

## Imágenes de relleno y avisos repetidos (2026-10-07)

**Incidente:** el correo «Hotel Wynwood – 133.37 usd – revolut» (Booking.com) traía **58 imágenes «noname»** de 0,3 a 17 KB —logos, iconos y píxeles referenciados desde el HTML— y el chat se llenó del mismo aviso «ya tiene una propuesta pendiente para este mismo correo» (una vez por imagen y por pasada), con una acción de 13 minutos y unos 3 USD de lecturas de factura. El filtro de decoración solo conocía las imágenes `inline`: 46 de las 58 llegaban como `attachment` con Content-ID.

- **Causa de fondo** (`core/correo/lectura/decoracion.ts`, conectado en `extraerAdjuntos`): una imagen con Content-ID, de tamaño conocido ≤ 30 KB y con el nombre de relleno «noname» (o sin nombre) es decoración **sea cual sea su disposición**. Un PDF u otro documento, una imagen con nombre real, una grande o sin Content-ID, o de tamaño desconocido siguen siendo adjuntos. Auditado con 150 correos reales de 60 días: solo afecta a 3 correos, todos con imágenes incrustadas en el HTML (el recibo real del tren de Italia sigue siendo adjunto).
- **Freno de fondo** (`core/gastos/avisoPropuestaPendiente.ts`): aunque otra cosa vuelva a generar muchos adjuntos, el aviso de «propuesta pendiente» sale **una vez por propuesta cada 10 min**. El registro es durable (`_avisos_propuesta_pendiente`), se carga una vez en memoria, serializa las decisiones (58 llamadas simultáneas dejan pasar una) y sobrevive a los despliegues. Si no se puede leer el registro, se avisa como siempre (nunca se calla de más).
- El mismo freno cubre el aviso «⛔ No propuse crear ni conciliar… ya fue procesado» (clave: gasto + correo), que también se repetía por cada adjunto.

## Única ruta de creación y conversión manual a ticket

La fase automática no mantiene reglas paralelas para crear compras. Reutiliza las mismas funciones durables del flujo uno a uno para inferir la cuenta desde los precedentes y correcciones confirmadas, componer las etiquetas funcionales, crear o corregir la compra, adjuntar el comprobante y conciliar el movimiento. Si esa memoria no permite demostrar una cuenta o cualquier otro dato, el correo queda para revisión manual; no se sustituye por una cuenta, etiqueta o valor por defecto.

Se crea una compra en borrador, se adjunta el comprobante original, se concilia contra el movimiento real y se releen los resultados. Se utiliza el procedimiento acordado: **después se convierte cada compra a ticket manualmente en Holded**. Las identidades técnicas de idempotencia se conservan en los registros internos y en las notas privadas necesarias para recuperación, nunca como etiquetas visibles. El resumen indica empresa, importe e ID de cada compra. La automatización no hace la conversión a ticket.

Solo se marca leído el mensaje concreto cuando todo su contenido ha quedado atendido y las operaciones externas quedaron verificadas. Si contiene otras solicitudes, se conserva sin leer aunque su gasto ya esté creado y conciliado. Los mensajes no elegibles siguen en la cola manual. La identidad exige conjuntamente `threadId` y `messageId`: una acción antigua de otro mensaje del mismo hilo nunca puede cerrar el mensaje activo. Los hilos con revisión manual o conversación automática activa se respetan.

## Coordinación, reintentos y memoria

PostgreSQL conserva operaciones, reservas únicas y eventos. Un bloqueo por buzón coordina cron, comandos y activación manual; un bloqueo por empresa coordina escrituras Holded. El control de versión rechaza actualizaciones de una ejecución obsoleta.

El análisis semántico se conserva por buzón, mensaje, huella completa y versión de política. Un correo inmutable no vuelve a consumir una llamada de IA cada hora; las evidencias reales de proveedor, duplicados, cuenta contable y movimiento bancario sí se consultan de nuevo, de modo que un gasto puede volverse elegible cuando llegue su movimiento o se confirme una corrección.

Antes de cada escritura externa se guarda su intención. Ante un timeout, **no se repite el POST**. Las ejecuciones siguientes intentan recuperar el resultado mediante lecturas y etiquetas, verifican el comprobante y comprueban movimiento, pago y saldo de la compra. Si no pueden demostrar el resultado, conservan la reserva y lo informan. Una operación incierta pausa nuevas escrituras en esa empresa para evitar duplicados; otros correos y empresas pueden seguir evaluándose.

**Salida de una operación sin cerrar.** Una operación incierta o en vuelo no bloquea para siempre el correo. Cuando el operador lo revisa a mano, o cuando el proceso automático se topa con un correo reservado por la cola manual, se lee Holded (solo lecturas) y la operación se cierra como `completada` únicamente si la compra lleva la marca de esa operación (`[wobi:…]` derivado de `correo-auto:<id>` o la nota `WOBI_AUTO:<id>`), coincide en proveedor, moneda e importe, está pagada por completo desde la cuenta prevista, tiene comprobante y el movimiento figura conciliado (`reconciled`/`forced_reconciled`). Un cargo `partial` con saldo residual dentro de la tolerancia del plan cuenta como conciliado (45,65 € frente a 45,66 €, aunque la compra esté en COP). El pago de la compra debe ser el de ese cargo (misma cuenta y fecha; importe igual a lo conciliado o a su equivalente contable). No compara cuenta contable, impuestos, tasa ni etiquetas: un gasto corregido a mano sigue siendo el mismo. El proceso automático aplica este cierre tras la verificación estricta (`cerrarConEvidencia`), de modo que estas operaciones se cierran solas en la siguiente pasada. Si el análisis del correo demuestra que todos sus recibos ya están completados, el chat lo presenta como «ya registrado y conciliado» y no propone crear nada. Si falta algo, el aviso lo dice con precisión y no repite escrituras. Evento de auditoría: `cierre_por_evidencia`.

**Un despliegue no pierde una revisión en curso.** Caso real (2026-09-28 16:12): `/revisarcorreo` murió en «39/50» porque Railway mandó SIGTERM al fusionarse otro PR; el servidor esperaba 55 s y salía sin aviso ni reanudación, y el contenedor nuevo fallaba al arrancar por el mismo bloqueo del buzón. Ahora, al recibir SIGTERM: (1) `core/utils/cierreServicio.ts` activa la señal de cierre y `ServicioCorreoAutomatico` para en su siguiente punto de control (los mismos que respetan el límite de tiempo: no abre análisis, consultas ni escrituras nuevas; una operación ya en vuelo se cierra por lectura, una solo reservada se deja reservada); el resultado sale marcado `interrumpida` y no se publica informe ni se toca la cola. (2) Cada revisión manual deja una fila `en_curso` en `wobi_mail_resume` (`core/gmail/automatico/reanudacion.ts`) desde que empieza, con un latido cada 15 s, y la borra al terminar; al recibir SIGTERM la fila pasa a `pendiente` y se avisa al chat con el último avance, antes de esperar nada. La fila desde el inicio existe porque un contenedor arrancado con `npm start` (lo que hace `railway redeploy`) nunca recibe el SIGTERM —npm es el PID 1 y el kernel ignora la señal— y muere por SIGKILL sin escribir nada: el proceso siguiente lo detecta por el silencio del latido (más de 60 s), igual que un crash o un OOM, y avisa «se cortó de golpe» antes de retomar. (3) El proceso nuevo vigila esas filas de forma periódica (cada 15 s los primeros 15 min, luego cada 2 min; no basta una consulta al arrancar porque Railway manda el SIGTERM al contenedor viejo DESPUÉS de que el nuevo ya arrancó), las reclama junto con las `en_curso` de otra instancia con latido apagado (DELETE … RETURNING, un solo proceso las retoma; un proceso nunca reclama las suyas ni reclama nada si ya se cierra) y relanza la misma revisión por el mismo camino que la orden escrita (`core/jobs/revisionCorreoManual.ts`): los análisis se reutilizan por huella y las escrituras siguen siendo operaciones durables, así que repetirla es seguro. Tope de 3 reanudaciones encadenadas y 6 h de antigüedad; pasado eso se avisa y se pide `/revisarcorreo` a mano. El arranque (`scripts/start.ts`) ya no toma el bloqueo del buzón cuando la migración de la cola está hecha y reintenta un `lock_timeout` en vez de morir; la espera de drenado se lee de `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (120 s en `railway.json`).

Los eventos guardan análisis, evidencia, decisión, regla, versión y resultado. Son observaciones auditables; no se convierten por sí solos en reglas de confianza. Las operaciones completadas también alimentan el registro existente de gasto por correo y asignación contable. Los alias, precedentes contables y correcciones confirmadas usan la memoria existente compartida con el flujo uno a uno. Una funcionalidad nueva debe partir de esas fuentes de verdad y no crear una ruta paralela para un proceso ya aprendido. El contenido de un correo nunca puede modificar las reglas de autorización.

## Configuración y puesta en marcha

El código se entrega desactivado por defecto; instalarlo no ejecuta gastos reales.

1. Configurar una base PostgreSQL persistente en `WOBI_MAIL_DATABASE_URL`, con acceso restringido al servicio y copias de seguridad. Los bloqueos necesitan conexiones de sesión; no usar un pooler en modo transacción.
2. Mantener las credenciales existentes de Gmail, Holded, Sheets y Anthropic. Configurar `GMAIL_IMPERSONATE_EMAIL` y el chat de avisos.
3. El arranque del servicio aplica el esquema idempotente antes de abrir el servidor. `npm run mail:auto:setup` permite prepararlo o repararlo manualmente; ninguna de las dos rutas modifica Gmail ni Holded.
4. Definir `WOBI_MAIL_AUTO_COMPANIES=WOBA,EWORKS,Footprint` (o la lista habilitada) y `WOBI_MAIL_AUTO_MODE=simulate`. Reiniciar el servicio y lanzar la revisión existente. La simulación analiza y audita sin reservar gastos, escribir en Holded ni marcar leído.
5. Tras comprobar la simulación, establecer `WOBI_MAIL_AUTO_MODE=execute` y reiniciar. El cron existente y las órdenes usarán automáticamente el mismo flujo.

`npm run mail:auto:status` muestra modo, empresas y operaciones por estado. `WOBI_MAIL_AUTO_KILL_SWITCH=true` desactiva el pase automático; tras cambiar el entorno hay que reiniciar el proceso. No elimina las reservas ni oculta operaciones incompletas.

`WOBI_MAIL_SCHEDULED_REVIEW_ENABLED=false` desactiva únicamente la revisión general programada del buzón. `/revisarcorreo` y `/admin/run-gmail-check` siguen disponibles bajo pedido. Las conversaciones automáticas de contactos e hilos previamente aprobados continúan cada 15 minutos mediante una sola consulta de Gmail filtrada por remitente; no recorren el buzón completo y solo usan IA cuando existe un mensaje nuevo. `WOBI_AUTOREPLY_MAX_THREADS_PER_RUN` limita cuántos hilos pueden procesarse por pasada (3 por defecto). El vigilante de trabajos manuales también permanece activo para detectar bloqueos.

Si una operación continúa incierta, revisar su evento, etiquetas y estado real en Holded antes de intervenir. No borrar reservas ni cambiarla a rechazada para forzar un reintento de un POST que pudo ejecutarse. Resolver primero la operación externa y reanudar la revisión; la recuperación de resultados confirmados es por lectura.

## Verificación

`npm run test:mail-auto` ejecuta los casos con Gmail/Holded simulados. Para probar además las reservas, bloqueos, auditoría y control de versiones contra PostgreSQL real, pasar `WOBI_MAIL_TEST_DATABASE_URL` apuntando exclusivamente a una base desechable. Esa prueba vacía las tablas de automatización de dicha base; nunca reutilizar la base de producción.

Las pruebas cubren elegibilidad, duplicados, lectura completa, simulación, correos mixtos, interrupciones, recuperación, errores de Gmail, adjuntos reales y conciliación. No se realizaron escrituras reales en Gmail ni Holded durante el desarrollo.

## Factura en moneda sin cuenta propia: el cargo con nombre distinto también cuenta (2026-10-07)

Caso real (Footprint, «Lunch – 180 pesos mexicanos – revolut», 06-10): el único cargo posible era «Merpago*eugeniodiaz» (−8,92 EUR, Mercado Pago). La búsqueda de la rama «moneda sin cuenta real y sin equivalente» no admitía cargos con nombre distinto («por confirmar»), no encontraba nada y Wobi pedía el importe en texto libre, sin botones.

- `procesarGastoEntrante.ts` busca ahora con `incluirPorConfirmar` y `cargoUnicoParaEquivalente` (`movimientoMultimoneda.ts`) decide: un cargo seguro gana a uno por confirmar; sin seguros, un único por confirmar sirve para armar la **propuesta con botones**, que lo muestra con «⚠️ nombre distinto» y exige que se confirme. Con varios candidatos sigue la pregunta en texto libre (pendiente de unificar con «Conciliar con #N»).

## Gasto ya registrado con otra fecha leída (2026-10-07)

Caso real (Footprint, Booking «Pulse 95», documento 5580815125): la misma reserva se leyó con fecha 02-09 (el cargo) y con 21-09 (la entrada al hotel). La búsqueda de duplicados en Holded solo mira ±10 días, así que con 21-09 no veía el gasto ya creado y Wobi propuso **crear uno nuevo** (sin la opción de adjuntar el comprobante al existente).

- `buscarGastoSimilar` (`core/holded/write.ts`): si el pase normal no encuentra nada y el documento tiene número identificable, repite con una ventana de ±120 días aceptando **solo** número de documento + proveedor + importe iguales (`totalSiCompraCoincide`, con prueba). La fecha no cuenta; el pase ancho nunca bloquea si queda incompleto.

## Gasto ya procesado con un soporte sin información: ofrecer el bueno (2026-10-07)

Caso real (Footprint, Booking «Antaris», 207,09 €): el gasto existía pero su único comprobante era una captura de mapa; el PDF bueno del mismo correo (`Hospedaje - Booking Antaris.pdf`) se bloqueaba como «ya procesado» (mismo número y proveedor) y Wobi no ofrecía adjuntarlo.

- `core/gastos/soporteDistinto.ts` (`debeOfrecerSoporteDistinto`, con prueba): en el bloqueo por identidad (`mismo_numero_y_proveedor`) se descargan los adjuntos del gasto y, si ya tiene ese mismo archivo, se bloquea como siempre. Si no lo tiene y o bien no hay adjuntos, o el archivo nuevo es un PDF y todo lo adjunto son imágenes, se ofrece el flujo normal «Es este (#1)» (adjuntar al existente), nunca crear ni conciliar solo.
- Si no se pueden leer los adjuntos de Holded, se bloquea como siempre. Un PDF distinto sobre un gasto que ya tiene un PDF no se ofrece (puede ser otra versión del mismo documento).

## Buscar un correo por asunto cuando lleva importes con coma (2026-10-07)

Caso real: «Revisa el correo con asunto "Fwd: €204.65 - $4,036.92MXN - Hospedaje - Business Trip Guadalajara"» respondía «no encontré ningún correo» aunque el asunto era exacto. Gmail no casa importes con separador de miles («$4,036.92MXN»); el del asunto sin coma sí se encontraba.

- `procesarCorreoPuntual` (`core/jobs/revisarCorreoNuevo.ts`): si la búsqueda literal da 0, repite con `subject:(palabras)` (`core/gmail/consultaCorreoTolerante.ts`, con prueba) y acepta solo un correo cuyo asunto real contenga TODAS esas palabras. No se activa con consultas de Gmail con operadores (`from:`, etc.) ni con búsquedas de menos de 3 palabras.

## Comprobante de texto sin «Ð» ni enlaces kilométricos (2026-10-07)

Caso real (Footprint, gasto Hospedaje Guadalajara): el comprobante generado desde el cuerpo del correo mostraba una «Ð» al final de cada línea y enlaces de seguimiento de 150+ caracteres. Los correos traen saltos `\r\n` y la fuente estándar de pdfkit pinta el `\r` como «Ð».

- `limpiarTextoParaPDF` (`core/gmail/generarComprobantePDF.ts`, con prueba): normaliza saltos a `\n`, quita caracteres de control, compacta líneas en blanco y acorta los enlaces de más de 70 caracteres (conserva acentos, ñ y €). Se aplica a todo el texto del PDF de texto. El render visual desde HTML (Chromium) no cambia.
- Los comprobantes ya adjuntos en Holded no se tocan: Holded no permite sustituirlos por API.

## Aviso de «misma estancia» (recibo de Booking + factura del hotel) (2026-10-07)

Caso real (Footprint, Hotel101 Madrid, 9→11 septiembre): el recibo de Booking (232,20 €) y la factura del hotel 50808 (242,19 € = 232,20 € de habitaciones + 10,00 € de carga eléctrica) llegaron por correos distintos, con números distintos, y se registraron los dos: la misma estancia contada dos veces.

- `core/gastos/mismaEstancia.ts` (pura, con 7 pruebas de casos reales): dos gastos de hospedaje son la misma estancia si coinciden hotel, persona, fechas de entrada y salida (se leen del concepto «Hospedaje <hotel> — <persona> — 09-11 sep 2026 …») e importe (≤ 8 %, misma moneda). Estancias distintas del mismo huésped y hotel, otro huésped o otra moneda no coinciden.
- `core/gastos/mismaEstanciaRegistrada.ts`: busca esa coincidencia en (1) el registro de gastos creados desde correo —los tickets que Holded oculta de /purchases solo se encuentran por su id; las filas antiguas sin concepto se leen por id, con tope— y (2) los hospedajes del listado de compras de Holded (±45 días).
- `procesarGastoEntrante.ts`: añade a la propuesta el aviso «⚠️ Posible MISMA estancia ya registrada: gasto … » y nunca bloquea ni decide. Los candidatos de la propia propuesta se excluyen. Si falla la lectura, el aviso se omite y la propuesta sale como siempre.

## Un archivo sin información contable no puede ser el comprobante (2026-10-07)

Pedido de Carlos: «esto es contabilidad… si pones comprobantes sin información, van a ser problemas legales». Casos reales: la captura de un mapa como único comprobante del gasto de Antaris y los iconos de Booking en el de Pulse 95. Con el contexto del correo, el lector rellenaba proveedor e importe desde el asunto aunque el archivo no mostrara nada.

- El lector (`extraerDatosFactura`) devuelve ahora `datosEnElDocumento`: false si el proveedor, el importe y la fecha no están en el propio archivo y salen solo del correo.
- `core/documental/soporteSinInformacion.ts` (con 6 pruebas): para una **imagen** de un correo marcada así, una **segunda lectura sin el contexto del correo** debe confirmar que no hay proveedor ni importe. Solo entonces el comprobante pasa a ser el **PDF generado desde el cuerpo** de ese correo. Si el lector dice que los datos sí están, o la segunda lectura los encuentra, el archivo no se toca. Ante cualquier fallo se conserva el archivo original.
- Integrado en `procesarDocumentoLocal` (camino de adjuntos). No afecta a PDF ni a archivos de Telegram.
- Comprobado en vivo con adjuntos reales: el mapa de Antaris se sustituye; su PDF real y las tres capturas reales de Guadalajara no.
- Coste: la segunda lectura solo ocurre cuando una imagen sale marcada «sin datos» (unos céntimos).

## El número de reserva del correo cuenta como número de documento (2026-10-07)

Caso real (Footprint, Hospedaje Guadalajara): el gasto existía con la reserva 5773032811 como número de documento, pero al leer una captura del mismo correo el extractor no devolvía ningún número; la detección de duplicados se apoya en el número y no lo reconoció.

- `core/documental/numeroDeReserva.ts` (`numeroDeReservaEnTexto`, con prueba): último recurso **determinista**, solo cuando el modelo no devuelve número. Lee del texto del correo un número de 6 a 20 cifras junto a una etiqueta de reserva o confirmación («Número de reserva», «Booking number», «Confirmation number», «Confirmation:», «Localizador»…). Si el texto menciona dos o más números distintos, no elige ninguno.
- Conectado en `extraerDatosFactura` (contexto del correo del adjunto) y en `extraerGastoDeCorreo` (cuerpo completo).
- Comprobado en vivo con el correo real: las capturas de Guadalajara ahora devuelven el número 5773032811.
- Alcance honesto: el gasto de Guadalajara ya existente no se puede recuperar con esto (es un ticket que Holded oculta de /purchases y no está en el registro de Wobi); sí quedan con número, y por tanto reconocibles, los gastos que se creen desde ahora.

## El equivalente del correo debe cuadrar con la tasa del día (2026-10-07)

Caso real (Footprint, Hospedaje Guadalajara): el recibo era de 4.036,92 MXN (≈ 204,65 €, que fue el cargo del banco) pero en el hilo se comentó «corresponde a 174,60€» —otra reserva—. Un equivalente explícito del correo tiene prioridad sobre buscar el cargo en el banco, así que Wobi propuso crear el gasto por 174,60 €.

- `core/gastos/equivalenteCoherente.ts` (`equivalenteCuadraConTasa`, con prueba): un equivalente que se aparta más del **8 %** de lo que da la tasa del día se **ignora** y se busca el cargo real en el banco (la propuesta lo dice en la razón). Sin tasa, o con datos inválidos, no se juzga y el equivalente se conserva. El spread normal de una tarjeta es del 1-4 %.
- Comprobado con tasas reales: 4.036,92 MXN → 204,65 € cuadra, 174,60 € no. Con 40 gastos reales ya creados con equivalente, 39 cuadran; 1 no (Uber, 9.744,65 CRC → 18,26 USD, −15 %), que con esta regla pasaría por la búsqueda en el banco en vez de aceptarse a ciegas.

## Protección de coste ANTES de leer o descargar adjuntos (2026-10-08)

Regla de Carlos: el sistema debe ser económico y sustentable, y la protección va **antes** de gastar, no cuando el gasto ya está creado. Caso real (07-10): un correo con 58 imágenes «noname» costó unos 3-4 USD sin ser ningún gasto. El 07-10 se cerró en la cola manual (`extraerAdjuntos`); la **revisión automática** seguía descargando y enviando al modelo todas las imágenes del correo.

Capas, todas por metadatos (sin bajar ni leer nada), en `core/correo/lectura/proteccionAdjuntos.ts`:
1. **Decoración incrustada** (imagen + Content-ID + pequeña + «noname», o inline decorativa): se descarta en el origen — ahora también en la revisión automática (`partesAdjuntasAProcesar` en `core/gmail/automatico/gmail.ts`).
2. **Repetidas** (mismo tipo, nombre y tamaño): se lee una.
3. **Tope por correo**: la cola manual lee como mucho 12 adjuntos por correo y avisa una vez de cuántos no (`adjuntosOmitidos` en el resumen del correo); la revisión automática, con más de 20 adjuntos reales, corta **antes de descargar ninguno** y deja el correo para revisión manual (sin gastar IA).

Pruebas: el caso de las 58 imágenes + 1 recibo (solo se descarga el recibo), el corte con 25 facturas sin descargar nada, repetidos y tope.

## Moneda sin cuenta propia: vuelve la búsqueda estricta y gana el cargo exacto con la tasa (2026-10-08)

El 07-10 (#390) la búsqueda de esta rama empezó a admitir también cargos «por confirmar» (nombre distinto). Con los correos en pesos mexicanos de Simon (Uber, Rappi, cafés) eso trajo candidatos sin relación (un hotel noruego para un reparto de 220 MXN) y más ambigüedad: «Taxi 129,94 MXN» pasó a tener cinco cargos y quedó en texto libre, sin botones. Se restaura el comportamiento estricto de la semana anterior y se añade una regla sin riesgo:

- La búsqueda de la rama «moneda sin cuenta y sin equivalente» ya **no** admite cargos «por confirmar».
- `cargoUnicoParaEquivalente` (con pruebas): con varios candidatos, si **uno solo** coincide al céntimo con la tasa del día (±2 céntimos o 0,5 %), ese es el cargo (Taxi 129,94 MXN → «Dlo*serv Uber Rides Ca» −6,43 €, los otros cuatro quedan a 0,09-0,78 €). Con dos o más iguales, o ninguno, se sigue preguntando; no se adivina.
- Pendiente de hacer bien: cuando haya un único cargo con nombre distinto, ofrecerlo como pregunta con botones («¿Es este cargo? Sí / No, escribiré el importe») en lugar de elegirlo.

## Un análisis incompleto ya no se queda fijado para siempre (2026-10-08)

Síntoma (Carlos, 08-10): la revisión automática no concilia ningún correo y deja 5 con «el analizador no dio por completa la lectura» aunque ya se había corregido. Causa: el servicio reutilizaba SIEMPRE el análisis guardado del mismo mensaje y versión, también si estaba marcado incompleto (guardado en un mal momento: adjunto que no se pudo leer entonces, fallo del modelo, tope de coste). Releído ahora, el recibo de Anthropic de 24,20 USD sale **completo** con un recibo; en la revisión salía incompleto.

- `analisisReutilizable` (`core/gmail/automatico/service.ts`, con pruebas): un análisis completo se reutiliza siempre; uno incompleto solo si se guardó hace menos de **2 h** (marca `analizadoEn`); los guardados antes de este cambio, sin marca, se reintentan una vez. Así un correo atascado se vuelve a leer, y uno que sigue ilegible no gasta IA más de una vez cada 2 h. Los límites de coste (`maxAnalisisNuevos`, tope diario por proceso) siguen mandando.

## Moneda sin cuenta propia: Wobi convierte solo y no pregunta (2026-10-08)

Regla de Carlos: una factura en una moneda que la empresa no tiene como cuenta (MXN, NOK, CRC…) se registra en **EUR o USD**, convertida a la tasa del día, y se busca en el banco la transacción que da esa conversión. Wobi no debe pedirle ningún dato que él mismo pueda obtener (la tasa la busca en internet: Frankfurter histórica y, si falla, open.er-api).

- Orden en `procesarGastoEntrante` (`core/gastos/conversionAutomatica.ts`, con pruebas): 1) el único cargo que coincide con la conversión; 2) si hay varios, el **más cercano en fecha (±1 día) e importe (≤ 8 %)**; si dos quedan igual de cerca no se adivina; 3) si no hay ninguno, la conversión a la tasa del día en EUR (o USD si la empresa no tiene EUR). En los tres casos sale la **propuesta con botones** (crear y conciliar con el cargo, o crear sin conciliar si aún no está en el banco); la razón de la propuesta explica de dónde sale el importe.
- Desaparece la pregunta «necesito el monto EXACTO… respóndeme en texto libre». Solo si no hay NINGUNA tasa disponible (ni histórica ni actual) se avisa y se reintenta en la siguiente revisión.
- Los pendientes ya guardados con esa pregunta se **reprocesan solos** al reenviar la pregunta del correo activo (`reprocesarPendienteMoneda.ts`): la propuesta con botones sustituye a la pregunta. Si el reproceso falla, el pendiente se restaura.
- Verificado con los cargos reales de Footprint: Taxi 129,94 MXN → cargo «Dlo*serv Uber Rides» −6,43 €; Taxi 119,95 MXN → −5,94 €; Café 70 MXN → «Rest Drip Cafe» −3,66 €; repartos de 220,11 y 189,98 MXN y el almuerzo de 180 MXN, sin cargo aún → 10,88 €, 9,39 € y 8,90 € a la tasa del día.
- La línea base de errores tragados de `procesarGastoEntrante.ts` baja de 6 a 4 (se eliminaron los de la rama de pregunta).

## El aviso de «misma estancia» solo corre para hospedajes (2026-10-08)

Los logs del 08-10 mostraron que el aviso del #395 se ejecutaba con TODAS las propuestas (también un gasto de comunidad de 550 €), leía hasta 40 gastos del registro por id en Holded una a una y se caía por completo con el 404 de un gasto ya borrado. Corrección en `core/gastos/mismaEstanciaRegistrada.ts`:

- Solo se comprueba si el concepto es de **hospedaje** (`esHospedaje`): para cualquier otro gasto no se lee nada (0 ms).
- Un gasto del registro que ya no existe en Holded se **omite** (y se recuerda 30 min) en vez de abortar la comprobación.
- Las lecturas por id van en **paralelo** (8 a la vez) y con memoria de 30 min: de unos 12 s a unos 3,6 s con los mismos resultados (Hotel101 sigue detectando el recibo `6aba2709` y la factura 50808).

## La factura manda: el gasto es de la sociedad a cuyo nombre va (2026-10-08)

Caso real (Carlos): la factura de renovación de dominios de Name.com (pedido 28837066, 85,57 €) iba a nombre de **Business Atelier Europa SL (WOBA)** y se creó en **EWORKS** porque los dominios eran eworks.studio y eworkstudio.com. El extractor decidía la empresa «según el documento y el contexto» sin comprobar el comprador impreso. Regla de Carlos: «no puedes dar gastos a una empresa con facturas que vienen a nombre de otra».

- El extractor devuelve ahora `compradorRazonSocial` (campo **obligatorio** del lector: el comprador impreso en «Customer information», «Bill to», «Facturar a»…). `empresaNombradaEnTexto` (`core/gastos/empresaPorComprador.ts`, con pruebas) lo traduce a una sociedad del grupo con sus nombres legales (WOBA = Business Atelier Europa SL, EWORKS = Compañía de Proyectos eWorks SL, Footprint = BUSINESS FOOTPRINT EU SL; «Business Atelier» a secas no vale; tolera la errata real «BUSSINES»).
- `procesarGastoEntrante`: si el comprador es una sociedad del grupo distinta de la que propuso el contexto, **manda el comprador** y la razón de la propuesta lo dice. Lo que el operador fijó a mano (`empresaFijadaPorOperador`) no se toca.
- Revisión automática (`evaluarAuto`): si la evidencia de empresa del recibo nombra a OTRA sociedad del grupo, no se crea (`empresa_en_conflicto_con_el_comprador`).
- Comprobado con las dos facturas reales de Name.com (6 de 6 lecturas → WOBA) y con 9 facturas normales de las tres empresas: 8 coinciden, 1 sin comprador reconocible, 0 correcciones falsas.
- Auditoría de los gastos de septiembre-octubre (224 PDF con texto leídos): además del reportado, queda el de Name.com 82,04 USD (pedido 28488474, footprint.global), creado en Footprint y a nombre de Business Atelier Europa SL. 173 comprobantes son imágenes o escaneos y no se pudieron comprobar así.

## La señal débil de «viaje» cede ante el historial del proveedor (2026-10-08)

Caso real (Carlos, WOBA): la factura de comunidad y garaje del edificio Luarca (275 € = 50 %) se creó en **«Gastos de viaje»** aunque los 12 meses anteriores del mismo proveedor (JESUS GOMEZ TARRIÑO) están en **Arrendamiento**. Causa, reproducida en vivo: la foto de la factura se leyó como recibo simplificado y llegó desde un buzón del grupo, así que se activó el atajo «ticket de equipo + recibo simplificado» (`calcularSenalDeViaje`), que se resuelve ANTES que el historial del proveedor. Sin esa señal, la misma entrada daba Arrendamiento con 45 evidencias.

- `inferirCuentaGasto` (`core/holded/write.ts`): si la señal de viaje es **débil** (solo «ticket de equipo»: sin persona identificada, sin contexto de viaje detectado en el documento y sin naturaleza de desplazamiento como taxi, avión, combustible…) y el historial del propio proveedor **contradice** la cuenta de viaje (`historialContradiceCuenta`: al menos 3 líneas y la cuenta de viaje con el 20 % o menos), se sigue con los tiers normales (proveedor, concepto, categoría). Luarca: 1 línea de viaje entre 68 → Arrendamiento.
- La regla de Carlos no cambia: un ticket con persona identificada, contexto de viaje o naturaleza de desplazamiento sigue yendo a viaje. Comprobado antes/después con ALDI + persona, Kruidvat, D1 SAS y Station Gomerco: sin diferencia.
- Ojo: las cuentas «hermanas» de un mismo concepto (varias de arrendamiento) cuentan juntas como «no viaje»; por eso se mide la cuenta de viaje y no una cuenta dominante.

## La relectura de una operación anterior ya no se bloquea por divisa ni por empresa (2026-10-08)

Con el diagnóstico del #410 («el recibo no coincide con el de la operación anterior (antes 24.2 USD del 2026-09-20; ahora 24.2 USD del 2026-09-20 (WOBA))») se vio la causa real de los correos atascados: seis operaciones ya empezadas se bloqueaban aunque el recibo releído tenía el MISMO importe y fecha. Dos condiciones de `reciboCorrespondeALaOperacion` (`core/gmail/automatico/service.ts`, con 4 pruebas) fallaban:

- **Divisa mezclada:** se comparaba el importe del recibo (24,20 USD) con `plan.totalCentimos`, que es el importe del MOVIMIENTO bancario (20,88 EUR). En cualquier gasto en moneda extranjera nunca coincidía. Ahora el total del plan solo se compara si recibo y movimiento están en la misma moneda; si no, basta con que cuadre con el recibo de la operación anterior.
- **Empresa:** se exigía que la relectura repitiera la empresa; si el modelo respondía «desconocida» se bloqueaba. La empresa ya la fijó el plan: «desconocida» no la contradice; otra empresa distinta sí bloquea.
- Se mantienen: misma parte del correo, misma fecha, misma moneda contable e importe dentro de la tolerancia.

**Cero motivos genéricos (punto 3 del plan contra la recurrencia, 2026-10-08).** Cada código de motivo que emite la revisión automática tiene una explicación propia y concreta en `explicarPendiente` (con el dato que lo acompaña: parte no leída, versiones de la relectura, error, paso de la operación que quedó a medias, tipo de documento). El comodín final ya no dice «no se cumplieron las condiciones»: nombra el motivo en claro para que se catalogue. El guardarraíl `core/guardarrailes/motivosSinGenericos.test.ts` extrae los códigos del código fuente y falla si alguno cae en el comodín o usa una frase de `FRASES_GENERICAS_PROHIBIDAS`. En la revisión manual, el aviso del correo activo sin pregunta localizable dice lo que pasa y qué hacer (ya no «fallo temporal al leerla»).

## La relectura compara el importe IMPRESO, no un equivalente que salió del banco (2026-10-08)

El #413 no cubrió Antaris (340 MXN) ni Xue Cafe (19.513 COP): seguían saliendo con «el recibo no coincide… antes 340 MXN del 2026-09-08; ahora 340 MXN del 2026-09-08 (Footprint)» (cifras idénticas). Causa: `plan.recibo.equivalente` puede venir de la búsqueda bancaria (`evidencia.equivalenteBancario`, `service.ts`), no del correo. La relectura no lo trae, y `reciboCorrespondeALaOperacion` comparaba «EUR del plan» contra «MXN de la relectura».

- `motivosDeNoCorrespondencia` (nuevo) devuelve la lista de diferencias; `reciboCorrespondeALaOperacion` es «lista vacía». Se compara el importe y la moneda IMPRESOS; el equivalente solo importa si la relectura lo trae (debe cuadrar con el total del plan en la moneda del cargo, y con el equivalente anterior si ambos están en la misma moneda).
- Si algo sí difiere, el aviso lo dice: «…; difiere en: otro importe impreso».
- Siguen bloqueando: otra parte del correo, otra empresa nombrada, otra fecha, otro importe impreso, un equivalente releído que no cuadra con el cargo. Pruebas con Antaris y Xue Cafe en `service.test.ts`.


**Revisión en seco tras cada despliegue (punto 4, 2026-10-08).** Cinco minutos después de arrancar con una versión nueva (`WOBI_MAIL_DRY_RUN_DELAY_MS`, 1–30 min), `core/gmail/automatico/revisionEnSeco.ts` repite la pasada de correo en modo simulación: sin análisis nuevos (solo los guardados, cero coste de IA), sin escribir en Holded, Gmail ni Sheets, sin mensajes de progreso y sin arrancar si hay una revisión real en marcha. Resume el resultado por correo («automatizable» o el motivo legible), lo guarda en `wobi_mail_events` (`revision_en_seco`) y lo compara con la revisión en seco anterior: solo si un correo que antes se automatizaba ahora queda pendiente, aparece un motivo sin catalogar o la pasada falla, avisa a Carlos por Telegram; si no, una línea en el log. Un reinicio sin despliegue (misma versión) no la repite. `WOBI_MAIL_DRY_RUN=off` la apaga.
