# Manual de usuario — Comandos y palabras clave del chat

Documento vivo: se actualiza cada vez que se agrega una palabra clave, comando o
patrón nuevo que el asistente reconoce en el chat de Telegram. Última
actualización: 2026-08-27 (nuevo rol superadmin — solo Carlos — que centraliza TODAS las decisiones de escritura del sistema y las decisiones sobre correo entrante; "admin" ya no alcanza por sí solo para ninguna de ellas).

Para casi todo lo demás (consultar cashflow, buscar en Drive, ver movimientos de
Holded, alertas fiscales, preguntas generales) no hace falta ningún comando —
simplemente pregúntalo en lenguaje natural.

**Gastos sin comprobante** (ej. "¿qué gastos de WOBA no tienen comprobante?")
— revisa Holded (lista de gastos + adjuntos de cada uno) y reporta cuáles no
tienen ningún documento soporte adjunto, con el proveedor, monto, fecha y la
etiqueta de responsable si Holded la trae (no todos los gastos la tienen).
Solo consulta, no escribe nada — abierto a cualquier usuario autorizado.
Por defecto revisa los últimos 90 días; se puede pedir un rango distinto.

**Movimientos bancarios sin conciliar** (ej. "¿qué movimientos de Footprint
faltan por conciliar?") — revisa las cuentas de Holded Treasury (WOBA, EWORKS
o Footprint) y reporta los movimientos con `status != "reconciled"` en un
rango de días (90 por defecto), con cuenta, descripción, monto y fecha. Mira
el lado del banco, no el de los gastos ya registrados (para eso está "gastos
sin comprobante", arriba) — sirve para detectar cargos (Uber, hoteles, etc.)
que todavía no tienen ningún gasto/factura asociado en Holded. Solo consulta,
no crea ni concilia nada — abierto a cualquier usuario autorizado.

**Gastos del cashflow sin salida bancaria real** (ej. "¿qué pagos del cashflow
de esta semana no se han hecho de verdad?", "cruza los gastos con el banco")
— compara los gastos ya registrados en el cashflow de WOBA/EWORKS (semana
actual o anterior) contra los movimientos bancarios reales de Holded, y
reporta cuáles NO tienen un movimiento bancario que los respalde — el dinero
sigue en la cuenta aunque esté anotado como gasto. Es el sentido CONTRARIO de
"¿el cashflow está actualizado?" (que revisa qué hay en el banco sin
registrar); esta consulta revisa qué está registrado sin salida real todavía.
Solo consulta, no escribe nada.

**Programar actividad en el calendario** (ej. "programa una llamada con
[proveedor] el jueves a las 10am para WOBA", "agenda un recordatorio para
el 15 de septiembre a las 9 para revisar el contrato de EWORKS") — prepara
la actividad (título, tipo, fecha/hora, y el contacto de Holded si lo
menciona) y la muestra por Telegram con botones para aprobar o cancelar.
Solo se crea en el calendario CRM de Holded (WOBA, EWORKS o Footprint) si
se aprueba con el botón "✅ Programar" — solo el superadministrador puede
aprobarlo, igual que el resto de escrituras en Holded.

**Costo de IA** (ej. "¿cuánto ha gastado el sistema este mes?") — solo
administradores pueden consultarlo; un colaborador recibe un mensaje diciendo
que esa consulta es solo para admins. Además, todos los admins reciben un
resumen automático cada mañana (8:30) con el gasto del día anterior y una
alerta si fue inusualmente alto comparado con el promedio de la semana.

**Numeración de semanas del cashflow** (ej. "¿está bien numerado el cashflow?",
"¿las semanas están correctas?") — verifica, leyendo directo la hoja CASHFLOW,
que las semanas tengan formato correcto, sin duplicados, sin saltos ni huecos
en la secuencia (cada una exactamente 7 días después de la anterior), y que
la más reciente no esté a una fecha inverosímil de hoy. Además, todos los
admins reciben un aviso automático cada mañana (8:15) SOLO si encuentra algún
problema — si todo está bien, no llega ningún mensaje.

**Notas sobre gastos/ingresos específicos del cashflow** (ej. "el gasto de
Robar 1076,90 se paga cuando haya plata, se va moviendo semana a semana") —
se guarda de inmediato, ligado a ese concepto y monto exactos, sin pedir
confirmación (es información, no una escritura financiera real — mismo
criterio que las correcciones). Cuando después preguntes "¿qué hacemos con
el gasto de Robar?" o similar, la respuesta usa esa nota guardada en vez de
solo los datos crudos del cashflow. Abierto a cualquier usuario autorizado.

**Acceso**: solo los usuarios de Telegram autorizados (guardados en la pestaña
oculta `_usuarios_autorizados` del Sheet de cashflow — no en una variable de
entorno) pueden usar el bot. Cualquier otra persona recibe "🔒 No tienes
acceso a este asistente." y, automáticamente, todos los admins reciben por
Telegram su nombre real y botones **✅ Colaborador / ✅ Admin / ❌ Ignorar** —
un solo toque lo autoriza, sin tocar Railway ni revisar logs.

**Niveles de acceso (rol por usuario):**
- **superadmin** — solo Carlos. Es el ÚNICO rol que puede presionar cualquier
  botón que dispare una escritura real (✅ Agregar a cashflow, ✅ Confirmar
  pago recurrente, 📤 Enviar así, ✅ Sí archivar aquí, ✅ Programar evento,
  crear/adjuntar gasto en Holded, dar acceso a /cerebro, enviar un reporte
  contable por correo) — y también las decisiones sobre un correo entrante
  (✅ Proceder / ❌ Descartar / ✏️ Dar instrucciones específicas). Ni siquiera
  un usuario con rol "admin" puede aprobar estas acciones.
- **admin** — hoy no desbloquea ninguna escritura por sí solo (todo lo
  sensible requiere superadmin específicamente) — queda como nivel
  intermedio disponible para el futuro. Recibe los mismos resúmenes
  automáticos que superadmin (costo de IA, numeración del cashflow).
- **colaborador** — puede chatear, consultar, usar `CAPTURA` y `corrección:`,
  y descartar/cancelar cualquier propuesta — pero si intenta presionar un
  botón de escritura o decidir algo sobre un correo, recibe "Esta acción
  requiere aprobación del superadministrador." y no se ejecuta nada.

---

## 1. Comandos exactos

Estos se escriben literalmente (no hace falta may/min exacta, y `/revisarcorreo`
funciona con o sin la diagonal inicial).

| Comando | Qué hace |
|---|---|
| `/revisarcorreo` (o `revisarcorreo`, o `revisamail`/`/revisamail`) | Dispara de inmediato una revisión de correos nuevos en `asistente@wobagroup.com`, sin esperar al cron de cada hora. |

---

## 2. Palabras y frases clave que el asistente reconoce

Estas no son comandos exactos — el asistente detecta la intención en el texto,
así que hay flexibilidad en cómo se escriben.

| Palabra/frase clave | Dónde puede aparecer | Qué hace |
|---|---|---|
| `CAPTURA` | En cualquier parte del mensaje (mayúsculas o minúsculas) | Antes de guardar, pregunta con botones a qué empresa corresponde (WOBA / EWORKS / Footprint / General — se puede marcar más de una). **El guardado real NO ocurre al marcar la empresa** — solo ocurre al presionar "✅ Confirmar y guardar" (un botón aparte, en la misma fila que "❌ Cancelar"): si se escribe correctamente en la base de conocimiento, confirma "✅ Guardado — [empresas]"; si falla (error de red, de la API de Sheets, etc.), lo dice explícitamente ("❌ No se pudo guardar...") y deja la misma selección de empresa lista para reintentar con el mismo botón — nunca confirma un guardado que no ocurrió. "❌ Cancelar" descarta la captura a propósito (no se guarda nada, y se avisa que se descartó). Si mandas otro mensaje mientras una captura sigue sin confirmar, el asistente te lo recuerda antes de responder — pasó más de una vez que alguien marcaba la empresa, se le olvidaba pulsar "Confirmar y guardar", y la captura se perdía en silencio a los 30 minutos sin que nadie se diera cuenta. **Excepción**: si el mensaje además menciona un correo (correo/email/mail) y que llegó/se recibió (ej. *"CAPTURA lo que llegó en el correo de Alejandra"*), el sistema detecta que la información NO está en el mensaje — va y lee el correo real (asunto, remitente, cuerpo completo) con la herramienta `capturar_correo` en vez de guardar la instrucción literal, y si no logra leerlo o guardarlo lo dice explícitamente en vez de fingir éxito. **También descarga y lee cualquier adjunto** (PDF/imagen), no solo el texto del cuerpo — si el adjunto es una factura/gasto, propone crearlo en Holded con el comprobante ya adjuntado (botón de aprobación); si no, propone archivarlo en Drive. Nace de un caso real: un correo reenviado con una factura de vuelo como PDF adjunto (el cuerpo solo traía la cadena de reenvío) se capturaba sin ningún dato útil porque nadie miraba el adjunto. **Si a la factura le falta un dato (la empresa, o el monto/moneda equivalente en una factura extranjera), NO se manda ninguna propuesta con botón todavía** — se pregunta ese dato puntual primero, y el asistente lo dice con claridad (nunca confirma "ya te la mandé" antes de que la propuesta con botón exista de verdad); la pregunta queda guardada, así que responderla en texto libre retoma el proceso sin releer el documento. Caso real que lo motivó: una factura en USD sin equivalente explícito se confundió dos veces con "propuesta ya enviada" cuando en realidad solo se había hecho la pregunta de la moneda. **Mandar una foto/documento por Telegram con `captura` (o `CAPTURA`) como pie de foto** funciona igual que un correo con adjunto: descarga y lee el contenido real con Claude vision antes de proponer guardarlo, nunca guarda solo la palabra "captura" como si fuera el conocimiento. Bug real que esto corrigió: una foto de un directorio de accesos real, mandada con pie de foto "captura", se guardaba literalmente como el texto "captura" (la foto nunca se leía) — el asistente confirmaba "✅ Guardado" pero después no tenía ninguna información real que dar. |
| `corrección:` / "eso no era así, en realidad..." / "no, en realidad es..." | En cualquier mensaje de chat normal | Registra una corrección permanente (qué se creía antes vs. el dato correcto). A partir de ahí, esa corrección se incluye SIEMPRE que se consulte la base de conocimiento, sin importar el tema. |
| "envíale un correo a...", "contesta ese correo diciendo...", "mándale ese link a Carlos por correo" | En chat normal, lenguaje natural | Prepara un borrador de correo y lo muestra por Telegram con botones de aprobación. Nunca se envía automáticamente. |
| "verifica los correos sin leer", "los que no he leído", "los correos nuevos" | En chat normal, lenguaje natural | Lista los correos SIN LEER reales de la bandeja de entrada (remitente, asunto, fecha, adjuntos, extracto) — para identificar de qué trata cada uno sin que se lo tengas que describir. Solo lectura; si alguno resulta ser una factura/gasto, sigue con el flujo normal (capturar_correo o gasto) para ese correo en concreto. |
| "cada vez que veas facturas de X, asígnalas a Y", "este proveedor siempre va a nombre de Y" | En chat normal, lenguaje natural | Fija de antemano (sin esperar a que llegue una factura real) que un texto de proveedor debe asignarse siempre al mismo contacto real de Holded, en una empresa concreta (`fijar_alias_proveedor`). Reutiliza la misma búsqueda real de contactos que el flujo de gastos — si no encuentra el contacto con confianza, muestra nombres parecidos y pregunta en vez de adivinar; no guarda nada hasta confirmar. Caso real que lo motivó: una instrucción de este tipo dicha una vez en el chat ("las facturas de iRyo van a INTERMODALIDAD DE LEVANTE SA") nunca se había persistido, así que la siguiente factura real de iRyo volvió a fallar igual — con esta tool queda guardado de inmediato. |
| Cualquier pregunta sobre algo que podría estar en un documento ya archivado (ej. "cómo son las claves de entrada a la oficina", "control de accesos", "política de vacaciones") | En chat normal, lenguaje natural | Si `consultar_base_conocimiento` no encuentra nada, antes de decir "no tengo información" prueba a buscar Y LEER el contenido real de un documento en Drive (`leer_documento_drive`) con palabras clave del tema — incluyendo sinónimos si el primer intento no encuentra nada (ej. "acceso", "llaves", "seguridad"). Archivar un documento en Drive y capturarlo como conocimiento consultable son cosas distintas — un documento archivado no aparece en la base de conocimiento a menos que alguien lo haya capturado explícitamente con `CAPTURA`, así que esta es la forma de consultarlo igual sin tener que volver a capturarlo. Si encuentra varios archivos posibles, nunca elige solo — los lista para que confirmes cuál. Solo lee PDF/imagen por ahora (no Google Docs/Sheets nativos). Caso real que lo motivó: una guía real de control de accesos, ya archivada en Drive, no se encontraba con "control de acceso" (la API de Drive exige la frase completa como texto contiguo) pero sí con la palabra suelta "acceso" — la búsqueda ahora descompone la consulta en palabras significativas por separado para no depender de acertar la frase exacta. |
| Cualquier pregunta que necesite información pública externa (ej. "busca en internet el manual de X", o cualquier pregunta cuya respuesta no está en el conocimiento interno ni en Drive) | En chat normal, lenguaje natural | Pedido explícito de Carlos: el asistente tiene acceso a búsqueda web real (`web_search`, herramienta hospedada por Anthropic) para complementar sus respuestas con manuales, documentación técnica, normativa pública o cualquier dato externo actualizado — siempre cita la fuente real con link, nunca la usa para inventar datos internos del grupo (montos, contactos, contraseñas). Solo disponible en el intento completo (no en el modo rápido/económico), y solo se activa cuando la pregunta de verdad lo requiere — tiene un costo real por búsqueda ($10 USD cada 1.000, además del costo normal de tokens) que queda registrado en `/costos_ia`. Verificado en vivo: encontró y citó el manual real de un dispositivo consultado. |
| "hazlo el jueves", "prográmalo para el 15", "hazlo cuando confirmen el pago de X", "avísame cuando llegue la factura de Y" | En chat normal, o al responder "✏️ Dar instrucciones" sobre una anotación de cashflow o un correo | Pedido explícito de Carlos: "WOBI debe encargarse de las acciones que haya que hacer" — en vez de intentarlo ya con una aproximación, `programar_accion_futura` lo guarda (fecha concreta, o una condición a verificar) y el sistema lo dispara solo en su momento (revisión cada hora), avisando por Telegram con el resultado — sin volver a pedir aprobación para ejecutarlo, esa ya se dio al pedir que se programe. Si de verdad hace falta una escritura real (Holded, correo) en ese momento, esa escritura sigue con su propio botón de aprobación normal. Muestra un botón "❌ Cancelar programación" apenas se programa. Si tiene fecha concreta, además intenta crear un evento visible en el calendario de Google de Wobi (asistente@wobagroup.com, con Carlos invitado) — si el calendario no está disponible, la acción se programa igual, solo sin el evento. |

---

## 3. Botones de Telegram (no se escriben, se presionan)

Aparecen debajo de ciertos mensajes del asistente cuando hace falta tu aprobación
para algo. Nunca se ejecuta una acción irreversible (enviar correo, subir archivo,
registrar en cashflow) sin que presiones uno de estos botones.

**Revisión de correo: uno a uno, del más antiguo al más nuevo:**
- Pedido explícito de Carlos: antes, la revisión horaria mandaba una propuesta por cada correo nuevo de esa hora — con varios correos a la vez, eso eran varias propuestas de golpe, imposibles de procesar todas.
- Se dispara sola cada hora, o al pedirlo por chat (ver comando `revisarcorreo` en la sección 1). Gmail (`is:unread` real, por HILO/conversación — no por mensaje individual) es SIEMPRE la única fuente de verdad de qué falta revisar: no hay ningún historial propio que bloquee volver a mostrar algo, así que si marcas un hilo como no leído otra vez (a mano, o porque llegó un mensaje nuevo en el mismo hilo), se vuelve a detectar y a analizar sin excepción.
- Cuando hay correos nuevos sin leer, se manda un aviso con un botón ("📬 Tienes N correo(s) nuevo(s) sin leer — ¿empezamos por el más antiguo?" / "▶️ Sí, empezar") — nunca se muestra el correo directo sin que se presione el botón.
- Cada correo se resuelve en el chat antes de pasar al siguiente — nunca se muestran dos a la vez. Un correo con varios adjuntos necesita resolver todos sus adjuntos antes de avanzar. Al resolverse, se marca como leído en Gmail de verdad (requiere el scope `gmail.modify` autorizado en Workspace Admin — ya confirmado funcionando).
- Pedido explícito de Carlos: al resolver un correo, YA NO pasa directo al siguiente — manda "✅ Resuelto. Quedan N correo(s) más en la cola — ¿seguimos con el siguiente?" con un botón "▶️ Sí, siguiente", para que no se cruce con otras consultas que se estén haciendo en el mismo chat al mismo tiempo. Si no se presiona, la cola se queda esperando (sin nada "activo") hasta que se apruebe, se pida `revisarcorreo`, o llegue la siguiente revisión horaria — que vuelve a preguntar, nunca muestra el correo directo.
- Si el correo activo lleva más de 48h sin resolverse (algo se quedó a medias), se salta con aviso en vez de trabar el resto de la cola detrás de él indefinidamente.
- Si pides `revisarcorreo` y ya hay un correo activo bloqueando el resto de la cola, el aviso trae un botón "🗑️ Descartar y liberar" — pedido explícito de Carlos, para el caso de "esto ya lo gestioné" (lo resolvió por su cuenta, fuera del chat): libera la cola sin esperar las 48h ni tener que encontrar el mensaje original, y marca el correo como leído en Gmail de verdad (bug real encontrado en vivo: sin esto, Gmail lo seguía contando como sin leer para siempre y la siguiente revisión horaria lo volvía a encolar solo, deshaciendo el descarte sin avisar).
- Todos los días a las 19:00 (hora Madrid), cada admin/superadmin recibe un resumen de TODO lo que le sigue quedando pendiente sin resolver — no solo la cola de correo: propuestas de archivo, contactos por crear, gastos con datos faltantes, reclasificaciones de documento, capturas sin confirmar, alertas de documento, correcciones de gasto, desambiguaciones, ediciones de borrador, montos de pago recurrente, orientaciones de anotación/correo, y reglas de clasificación — cada línea con hace cuánto quedó pendiente. Silencio total si no hay nada (no manda "estás al día", solo avisa cuando de verdad falta algo). Trae un botón "🗑️ Descartar todo" — pedido explícito de Carlos: si al final del día algo ya no hace falta, lo descarta todo de una (menos las propuestas de gasto, los contactos pendientes con una factura completa adentro, y los gastos con datos parciales — esos, por ser dinero real, siguen revisándose una por una, nunca en bloque) y marca como leídos en Gmail los correos que se descarten.

**Sobre cada correo sin adjunto (sin importar el tipo — necesita respuesta, instrucción, notas de reunión, o puramente informativo):**
- Pedido explícito de Carlos: el sistema lee el CUERPO COMPLETO del correo (no solo el asunto ni el fragmento corto de Gmail) y propone qué hacer — nunca una pregunta genérica sin decir de qué correo se trata. El mensaje siempre trae: asunto, remitente, un resumen concreto (con los datos reales — montos, fechas, nombres) y una acción sugerida específica (crear un gasto, guardar como conocimiento, gestionar un documento, responder, programar una alerta, o ninguna acción).
- **Antes de este análisis genérico**, se intenta leer el cuerpo como un gasto real (ej. una notificación de tarjeta pegada como texto/HTML, sin ningún PDF/imagen adjunto) — mismo criterio que un documento adjunto: si describe un pago/cargo ya ocurrido con monto y proveedor identificables, salta directo a la propuesta de gasto (ver la sección de facturas/gastos más abajo, con la misma lógica de moneda equivalente), generando un PDF con los datos + el cuerpo completo como comprobante. Si no describe ningún gasto real, sigue con los 4 botones de abajo con normalidad.
- ✅ Proceder — investiga/ejecuta lo que corresponda con las herramientas disponibles (puede terminar en una propuesta de gasto, un borrador de respuesta, una acción programada, etc., cada una con su propia aprobación).
- 🧠 Guardar como conocimiento — lee el correo y lo ofrece por el flujo normal de captura (selección de empresa + "✅ Confirmar y guardar"), sin ejecutar ninguna otra acción.
- ❌ Descartar — ignora la propuesta.
- ✏️ Dar instrucciones específicas — te pide una instrucción tuya en texto libre antes de actuar.
- Solo el superadministrador puede presionar cualquiera de estos 4 — la decisión completa sobre un correo entrante (incluso descartarlo) está centralizada en esa persona.

**Sobre movimientos de Holded sin registrar en el cashflow (WOBA/EWORKS):**
- ✅ Agregar — registra el movimiento en el Sheet de cashflow.
- ❌ Ignorar — descarta la propuesta (si sigue sin registrar, se vuelve a proponer en la siguiente revisión).
- 🔁 Es duplicado — solo aparece cuando el sistema encontró una fila ya registrada esa semana con nombre parecido y monto cercano (hasta 5€ de diferencia por defecto, y algo más si ese proveedor ya tuvo un caso confirmado antes) pero NO idéntico — típico de un cambio de tarifa real (ej. Banahosting €204.68 registrado vs. €208.73 real de Holded). Al presionarlo, no se crea ninguna fila nueva (igual que "❌ Ignorar") pero además queda anotado el patrón de variación de ese proveedor, para que la próxima vez el sistema lo reconozca con más contexto y dude menos. **Esto nunca hace que deje de preguntar** — por más veces que se confirme un proveedor, siempre vuelve a mostrar el botón y espera la confirmación, nunca decide solo que es un duplicado.
- Se dispara dos veces por semana: viernes 17:00 (chequeo preliminar de la semana en curso) y lunes 8:00 (cierre de la semana anterior).
- Solo el superadministrador puede aprobar "✅ Agregar". "❌ Ignorar" y "🔁 Es duplicado" no requieren superadmin (no escriben nada en Holded ni en el cashflow).

**Sobre borradores de correo (después de "Proceder", una corrección de orientación, o pedir enviar algo por chat):**
- 📤 Enviar así — envía el correo real, tal como está.
- ✏️ Editar antes de enviar — te pide el texto de reemplazo antes de mostrar el borrador de nuevo con los mismos botones.
- ❌ No enviar — descarta el borrador.
- Solo el superadministrador puede presionar "📤 Enviar así".

**Sobre archivos/documentos enviados por Telegram (o adjuntos de correo) para archivar en Drive:**
- El asistente propone una carpeta de destino con botones de aprobación (sí/no) antes de subir nada.
- ✅ Sí, archivar aquí / ✏️ Elegir otra carpeta — las dos acciones de siempre, terminan la propuesta.
- 📚 Enseñar regla — pide una palabra o frase clave (ej. parte del nombre del archivo o del remitente); la próxima vez que un documento de esa empresa coincida, se archiva directo en la misma carpeta **sin volver a preguntar** — es una regla determinista (se revisa antes de gastar una llamada a Claude), no una sugerencia que el asistente pueda olvidar. No consume la propuesta — "Sí, archivar aquí" sigue disponible después. No se ofrece si el sistema todavía no tiene ni siquiera la empresa clara (evita aprender una regla sobre un dato que ni el propio sistema identificó).
- ⏰ Crear alerta — pide qué recordar y cuándo (fecha o condición, en lenguaje natural); usa el mismo programador de acciones futuras del sistema (ver sección de Calendario). Tampoco consume la propuesta.
- 🧠 Guardar como conocimiento — a diferencia de "Enseñar regla" (que solo aprende DÓNDE archivar la próxima vez, no el contenido), este lee el documento con Claude vision, lo transcribe, y ofrece guardar ese CONTENIDO como conocimiento consultable — mismo flujo de captura con selección de empresa que el resto del sistema, nunca se guarda sin confirmar. Tampoco consume la propuesta.
- ❌ Descartar, no archivar — no hace nada con el documento (no lo sube a Drive ni lo guarda como conocimiento); borra la copia local temporal. Termina la propuesta.
- Si el análisis automático no logra ubicar el documento con confianza ni siquiera después de que el usuario responda una vez a la pregunta de "¿a qué empresa y carpeta pertenece?", ya NO se repite esa pregunta en texto libre indefinidamente — pasa directo a estos mismos botones (con un aviso de que ya se preguntó antes), para no quedar atrapado en un ciclo. Esa primera pregunta en texto libre también trae ahora un botón "❌ Descartar, no hacer nada" por si no hace falta archivarlo.
- Si un correo trae **más de un adjunto**, cada uno es una propuesta independiente y trae la nota "📎 Adjunto N de M de este correo" — no es que el mismo documento haya llegado duplicado.

**Sobre alertas de pagos recurrentes (seguros, IBI, Google, Salesmate, etc. — WOBA, EWORKS y Footprint, cualquier periodicidad: mensual/trimestral/semestral/anual):**
- Cada pago llega como un mensaje individual (nunca agrupado con otros) exactamente 2 días antes, 1 día antes, y el mismo día del vencimiento — mismo esquema para pagos con día exacto y para los aproximados sin día fijo.
- 💰 Indicar monto y registrar — pide el importe exacto (y el proveedor, si no se conoce de antemano) por texto libre.
- Tras responder con el importe, aparece un mensaje de confirmación con:
  - ✅ Confirmar y registrar — crea el gasto en Holded (como borrador) y, si es WOBA/EWORKS, también la línea en el cashflow. Footprint no tiene cashflow en Sheets, así que para esa empresa solo se escribe en Holded.
  - ❌ Cancelar — descarta la propuesta, no escribe nada.
- Nota: este flujo de escritura en Holded es para pagos recurrentes detectados por `calendario_fiscal.json`. Para facturas/gastos puntuales, ver la sección de abajo.

**Sobre facturas/gastos enviados por Telegram o recibidos por correo (con detalle y comprobante juntos — WOBA, EWORKS y Footprint):**
- El asistente lee el CONTENIDO real del documento (no solo el nombre) para decidir si es una factura/gasto, incluyendo el desglose de IVA por línea (base + % de IVA leído tal cual aparece impreso, nunca inventado). Si no lo es, sigue el flujo normal de archivado en Drive.
- Mismo camino cuando el correo NO trae ningún adjunto pero el gasto está descrito en el propio cuerpo (ej. una notificación de tarjeta pegada como texto) — el comprobante que se adjunta en Holded es entonces un PDF generado con los datos extraídos + el cuerpo completo del correo (la propuesta lo deja claro: "comprobante generado desde el cuerpo del correo, sin adjunto original"), nunca el desglose de IVA por línea en ese caso (un correo rara vez lo trae limpio, se registra como una sola línea).
- **Si la factura viene en una moneda que la empresa tiene como cuenta real en Holded** (ej. un recibo en USD para Footprint/WOBA/EWORKS, o en GBP para EWORKS — todas tienen cuenta real en esas monedas, consultadas en vivo contra `/treasury/accounts`, nunca asumidas): se registra tal cual, en esa misma moneda — no hay nada que convertir. **Si viene en una moneda que la empresa NO tiene como cuenta real** (ej. un recibo de Uber en COP para una empresa sin cuenta en COP): ahí sí hace falta el monto equivalente en alguna moneda que la empresa sí tenga — el comprobante queda adjunto tal cual, en su moneda original. Para ese equivalente revisa tanto el documento como el correo que lo trae (el recibo en sí muchas veces no lo trae, pero si reenviaron una notificación de tarjeta tipo "40.46 EUR | 148.346 COP", ese dato está en el asunto/cuerpo del correo). Nunca calcula ni inventa un tipo de cambio: si no encuentra el equivalente en ninguna moneda real de la empresa, no crea nada — pregunta el monto exacto y en cuáles monedas reales tiene cuenta la empresa, antes de seguir.
- **Si encuentra un gasto ya registrado en Holded que podría corresponder** (mismo proveedor — tolera razón social vs. nombre comercial — monto y fecha cercana):
  - ✅ Es este (#N) — adjunta el comprobante a ese gasto en Holded (evita duplicarlo). Si el adjuntar falla, el gasto sigue existiendo igual — nunca hay que reenviar el documento, se duplicaría.
  - ❌ Ninguno, crear nuevo — sigue al flujo de creación de abajo.
- **Si no encuentra ninguno**, antes de proponer crear también revisa si el cargo ya está en el banco real (no solo en Compras), en TODAS las cuentas de tesorería sin importar su moneda (puede caer en una cuenta en USD y no en la de EUR):
  - Si encuentra un movimiento bancario sin conciliar que coincide en monto y fecha, aparecen **los dos botones juntos**: ✅ Crear, y ✅ Crear y conciliar (hace ambas cosas de una) — eliges tú según tu confianza en el match. Cuando el gasto original no está en euros, la comparación tolera unos céntimos de diferencia (el monto en EUR de la factura y el que calcula Holded para el movimiento vienen de conversiones de cambio independientes).
  - Si no hay match bancario, solo aparece ✅ Crear gasto en Holded — y la propuesta lo dice explícitamente ("no encontré ningún movimiento que coincida"), nunca se queda callada al respecto. Si en cambio hay **varios** movimientos parecidos y no sabe cuál es el correcto, los lista todos y te pregunta directamente cuál corresponde, en vez de omitirlo.
  - Cualquiera de las dos crea el gasto (como borrador) con el IVA real de cada línea, la **cuenta contable correcta** (reutiliza una cuenta ya en uso real para proveedores/conceptos parecidos, ej. "Gastos de viaje" — nunca la cuenta genérica de Holded por defecto, ni una inventada; si no encuentra ninguna categoría parecida, te lo dice y te pregunta si tú sabes cuál debería ser) y adjunta el comprobante.
  - ✏️ Corregir clasificación — pide la empresa/concepto correctos por texto libre (ej. "EWORKS, servicio de limpieza") antes de crear el gasto. Esta corrección **queda aprendida**: la próxima factura del mismo proveedor se clasifica con más certeza.
  - ❌ Cancelar — no escribe nada.
- **Si no encuentra el proveedor** ni por nombre parecido al crear, busca alternativas (contactos con nombre parecido, facturas con el mismo importe) y las ofrece por botones antes de rendirse. En cualquier caso (con o sin alternativas) aparece además **"🆗 Crear sin proveedor real"**: registra el gasto ya mismo con un contacto genérico ("PROVEEDOR SIN IDENTIFICAR", uno por empresa — la API de Holded exige siempre algún contacto, no acepta crear una compra sin ninguno), dejando el nombre real del proveedor al frente de la descripción del gasto (nunca se pierde) para corregir el contacto a mano en Holded cuando quieras. Útil cuando lo urgente es conciliar el movimiento bancario, sin esperar a crear el proveedor real primero. Requiere aprobación del superadministrador, igual que crear/adjuntar un gasto normal — y nunca aprende esto como alias del proveedor (si lo aprendiera, la próxima factura del mismo proveedor seguiría cayendo en el genérico para siempre, incluso después de crear el contacto real).
- Solo el superadministrador puede aprobar la escritura (adjuntar o crear) — un colaborador o admin recibe el mensaje de que necesita aprobación.
- **Conciliación**: con "✅ Crear y conciliar" o "✅ Es este" ocurre en el mismo paso; con "✅ Crear" (solo crear) llega DESPUÉS, en un mensaje aparte, preguntando "¿quieres que intente conciliar el movimiento bancario?" con botones Sí/No — así puedes revisar el gasto recién creado en Holded antes de decidir. En todos los casos, ENLAZA de verdad el movimiento con el documento (nunca confía en que el estado diga "conciliado" sin confirmar que el monto quedó realmente emparejado); si hay varios candidatos parecidos o no logra confirmarlo, lo dice explícitamente para que se revise a mano en Holded. Nunca concilia movimientos huérfanos sin un gasto real detrás (para eso está la consulta de "movimientos sin conciliar", arriba).
- **Si Holded rechaza la fecha** por un periodo contable ya cerrado ("This date has been locked"), no muestra el error técnico crudo — ofrece un botón para reintentar la creación con la fecha de hoy.

**Sobre a qué empresa corresponde una captura de conocimiento (CAPTURA):**
- El guardado real ocurre al presionar "✅ Confirmar y guardar" — antes de eso no se ha escrito nada en la base de conocimiento.
- Botones ✅ WOBA / ✅ EWORKS / ✅ Footprint / ✅ General — se pueden marcar varios a la vez (toggle, tocar de nuevo desmarca); "General" es excluyente con las demás (marcarlo desmarca el resto y viceversa). Hace falta marcar al menos una para poder confirmar.
- ✅ Confirmar y guardar — guarda la captura con la(s) empresa(s) elegidas. Si la escritura falla, lo dice explícitamente y deja la selección lista para reintentar (no hay que volver a marcar los botones).
- ❌ Cancelar — descarta la captura a propósito, no se guarda nada.
- Abierto a cualquier usuario autorizado (no requiere rol admin) — es una captura de conocimiento, no una escritura financiera.

**Sobre actividades propuestas para el calendario CRM de Holded (WOBA, EWORKS y Footprint):**
- ✅ Programar — crea la actividad real en el calendario de Holded.
- ❌ Cancelar — descarta la propuesta, no escribe nada.
- Solo el superadministrador puede aprobar. Si mencionaste un proveedor/cliente y
  el asistente lo encontró entre los contactos de Holded, la actividad queda
  vinculada a ese contacto; si no lo encuentra, avisa y la crea sin vincular.

**Sobre anotaciones (comentarios) del Sheet de cashflow:**
- El mensaje trae un título siempre visible (ubicación de la anotación) y el análisis completo colapsado debajo — toca el bloque para expandirlo. Pedido explícito de Carlos: poder ver varias anotaciones largas a la vez sin hacer scroll constante, y decidir cuál atender solo mirando los títulos.
- ✅ Hazlo tú — Wobi investiga y ejecuta lo que corresponda con sus herramientas normales (Holded, cashflow, correo). Cualquier escritura real que haga falta sigue pasando por su propio botón de aprobación aparte — esto no le da ningún poder nuevo, solo la vía libre para actuar sobre esa anotación en concreto.
- ✏️ Dar instrucciones — espera una respuesta en texto libre con qué hacer (incluyendo cuándo, ver `programar_accion_futura` arriba) y actúa igual que "Hazlo tú" pero con esa guía.
- ℹ️ Dejar como informativo — no hace nada más.
- Solo el superadministrador puede presionar cualquiera de estos 3 — mismo criterio que las decisiones sobre correo entrante.
- Nunca marca nada como resuelto en el propio Sheet — eso se sigue haciendo a mano ahí.

**Sobre una acción programada (fecha futura o condición a verificar):**
- ❌ Cancelar programación — la retira de la cola antes de que se dispare; no hace falta que ya haya pasado la fecha. Solo el superadministrador puede presionarlo.
- Cuando se dispara sola (llegó la fecha, o se cumplió la condición), no hay botón — Wobi ya avisa directamente con el resultado.

**Sobre el envío por correo de un reporte de balance/P&L (WOBA, EWORKS y Footprint):**
- Pedir el reporte "aquí" o "en el chat" lo manda directo (Excel y PDF), sin botón — es solo responder con un archivo, no una escritura real.
- Si pides que te lo mande por correo, aparece una propuesta con:
  - 📤 Enviar así — genera el Excel y PDF con los datos más actuales de Holded en ese momento (no reutiliza nada guardado) y los manda por correo.
  - ❌ Cancelar — no se envía nada.
- Solo el superadministrador puede aprobar el envío por correo.

---

## Notas para quien mantiene este documento

- Cada vez que se agregue un comando, palabra clave o botón nuevo al sistema,
  debe añadirse una fila aquí en la sección correspondiente.
- Este archivo vive en `docs/`, así que el propio asistente también lo puede
  consultar (vía `consultar_base_conocimiento`) si le preguntan "qué comandos
  tienes" desde el chat.
