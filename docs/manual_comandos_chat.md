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
| `CAPTURA` | En cualquier parte del mensaje (mayúsculas o minúsculas) | Antes de guardar, pregunta con botones a qué empresa corresponde (WOBA / EWORKS / Footprint / General — se puede marcar más de una). El guardado real ocurre al presionar "✅ Confirmar y guardar": si se escribe correctamente en la base de conocimiento, confirma "✅ Guardado — [empresas]"; si falla (error de red, de la API de Sheets, etc.), lo dice explícitamente ("❌ No se pudo guardar...") y deja la misma selección de empresa lista para reintentar con el mismo botón — nunca confirma un guardado que no ocurrió. "❌ Cancelar" descarta la captura a propósito (no se guarda nada, y se avisa que se descartó). **Excepción**: si el mensaje además menciona un correo (correo/email/mail) y que llegó/se recibió (ej. *"CAPTURA lo que llegó en el correo de Alejandra"*), el sistema detecta que la información NO está en el mensaje — va y lee el correo real (asunto, remitente, cuerpo completo) con la herramienta `capturar_correo` en vez de guardar la instrucción literal, y si no logra leerlo o guardarlo lo dice explícitamente en vez de fingir éxito. |
| `corrección:` / "eso no era así, en realidad..." / "no, en realidad es..." | En cualquier mensaje de chat normal | Registra una corrección permanente (qué se creía antes vs. el dato correcto). A partir de ahí, esa corrección se incluye SIEMPRE que se consulte la base de conocimiento, sin importar el tema. |
| "envíale un correo a...", "contesta ese correo diciendo...", "mándale ese link a Carlos por correo" | En chat normal, lenguaje natural | Prepara un borrador de correo y lo muestra por Telegram con botones de aprobación. Nunca se envía automáticamente. |
| (automático, no se escribe) — correo con notas de reunión de Gemini/Google Meet (asunto `Notas: "..."` o `Fwd: Notas: "..."`) | Detectado por asunto en el correo entrante (`/revisarcorreo` o la revisión automática cada hora) | Lee el correo completo (funciona aunque venga reenviado, no solo directo de Gemini) y dispara el mismo flujo de `CAPTURA` con botones de empresa — nunca se guarda hasta que alguien confirma. Verificado en vivo contra un correo real de Gemini. Otras herramientas de notas (Otter, Fireflies, Read.ai) se detectan por el clasificador de IA como respaldo si el asunto no calza con el patrón de Gemini. |

---

## 3. Botones de Telegram (no se escriben, se presionan)

Aparecen debajo de ciertos mensajes del asistente cuando hace falta tu aprobación
para algo. Nunca se ejecuta una acción irreversible (enviar correo, subir archivo,
registrar en cashflow) sin que presiones uno de estos botones.

**Sobre correos entrantes que requieren acción:**
- ✅ Proceder — investiga/ejecuta lo que corresponda con las herramientas disponibles.
- ❌ Descartar — ignora la propuesta.
- ✏️ Dar instrucciones específicas — te pide una instrucción tuya en texto libre antes de actuar.
- Solo el superadministrador puede presionar cualquiera de estos 3 — la decisión completa sobre un correo entrante (incluso descartarlo) está centralizada en esa persona.

**Sobre movimientos de Holded sin registrar en el cashflow (WOBA/EWORKS):**
- ✅ Agregar — registra el movimiento en el Sheet de cashflow.
- ❌ Ignorar — descarta la propuesta (si sigue sin registrar, se vuelve a proponer en la siguiente revisión).
- Se dispara dos veces por semana: viernes 17:00 (chequeo preliminar de la semana en curso) y lunes 8:00 (cierre de la semana anterior).
- Solo el superadministrador puede aprobar "✅ Agregar".

**Sobre borradores de correo (después de "Proceder", una corrección de orientación, o pedir enviar algo por chat):**
- 📤 Enviar así — envía el correo real, tal como está.
- ✏️ Editar antes de enviar — te pide el texto de reemplazo antes de mostrar el borrador de nuevo con los mismos botones.
- ❌ No enviar — descarta el borrador.
- Solo el superadministrador puede presionar "📤 Enviar así".

**Sobre archivos/documentos enviados por Telegram para archivar en Drive:**
- El asistente propone una carpeta de destino con botones de aprobación (sí/no) antes de subir nada.

**Sobre alertas de pagos recurrentes (seguros, IBI, Google, Salesmate, etc. — WOBA, EWORKS y Footprint, cualquier periodicidad: mensual/trimestral/semestral/anual):**
- Cada pago llega como un mensaje individual (nunca agrupado con otros) exactamente 2 días antes, 1 día antes, y el mismo día del vencimiento — mismo esquema para pagos con día exacto y para los aproximados sin día fijo.
- 💰 Indicar monto y registrar — pide el importe exacto (y el proveedor, si no se conoce de antemano) por texto libre.
- Tras responder con el importe, aparece un mensaje de confirmación con:
  - ✅ Confirmar y registrar — crea el gasto en Holded (como borrador) y, si es WOBA/EWORKS, también la línea en el cashflow. Footprint no tiene cashflow en Sheets, así que para esa empresa solo se escribe en Holded.
  - ❌ Cancelar — descarta la propuesta, no escribe nada.
- Nota: este flujo de escritura en Holded es para pagos recurrentes detectados por `calendario_fiscal.json`. Para facturas/gastos puntuales, ver la sección de abajo.

**Sobre facturas/gastos enviados por Telegram o recibidos por correo (con detalle y comprobante juntos — WOBA, EWORKS y Footprint):**
- El asistente lee el CONTENIDO real del documento (no solo el nombre) para decidir si es una factura/gasto, incluyendo el desglose de IVA por línea (base + % de IVA leído tal cual aparece impreso, nunca inventado). Si no lo es, sigue el flujo normal de archivado en Drive.
- Si encuentra un gasto ya registrado en Holded que podría corresponder (mismo proveedor, monto y fecha cercana):
  - ✅ Es este (#N) — adjunta el comprobante a ese gasto en Holded.
  - ❌ Ninguno, crear nuevo — sigue al flujo de creación de abajo.
- Si no encuentra ninguno, la propuesta muestra el desglose de IVA línea por línea antes de aprobar:
  - ✅ Crear gasto en Holded — crea el gasto (como borrador) con el IVA real de cada línea (mapeado al código de impuesto correcto de Holded, nunca uno inventado) y adjunta el comprobante.
  - ✏️ Corregir clasificación — pide la empresa/concepto correctos por texto libre (ej. "EWORKS, servicio de limpieza") antes de crear el gasto. Esta corrección **queda aprendida**: la próxima factura del mismo proveedor se clasifica con más certeza.
  - ❌ Cancelar — no escribe nada.
- Solo el superadministrador puede aprobar la escritura (adjuntar o crear) — un colaborador o admin recibe el mensaje de que necesita aprobación.
- Tras crear o adjuntar el gasto con éxito, el asistente intenta cerrar el
  círculo automáticamente: busca un movimiento bancario sin conciliar de la
  misma empresa con monto y fecha cercanos. Si encuentra exactamente uno, lo
  concilia y lo confirma en el mensaje ("💳 Movimiento bancario conciliado
  automáticamente..."); si hay varios candidatos parecidos o no logra
  confirmar la conciliación al releer el movimiento, lo dice explícitamente
  en vez de asumir éxito, para que se revise a mano en Holded. Nunca concilia
  movimientos huérfanos sin un gasto real detrás (para eso está la consulta
  de "movimientos sin conciliar", arriba).

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
