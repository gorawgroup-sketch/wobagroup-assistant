# Manual de usuario — Comandos y palabras clave del chat

Documento vivo: se actualiza cada vez que se agrega una palabra clave, comando o
patrón nuevo que el asistente reconoce en el chat de Telegram. Última
actualización: 2026-08-26 (reporte de gastos sin comprobante).

Para casi todo lo demás (consultar cashflow, buscar en Drive, ver movimientos de
Holded, alertas fiscales, preguntas generales) no hace falta ningún comando —
simplemente pregúntalo en lenguaje natural.

**Gastos sin comprobante** (ej. "¿qué gastos de WOBA no tienen comprobante?")
— revisa Holded (lista de gastos + adjuntos de cada uno) y reporta cuáles no
tienen ningún documento soporte adjunto, con el proveedor, monto, fecha y la
etiqueta de responsable si Holded la trae (no todos los gastos la tienen).
Solo consulta, no escribe nada — abierto a cualquier usuario autorizado.
Por defecto revisa los últimos 90 días; se puede pedir un rango distinto.

**Costo de IA** (ej. "¿cuánto ha gastado el sistema este mes?") — solo
administradores pueden consultarlo; un colaborador recibe un mensaje diciendo
que esa consulta es solo para admins. Además, todos los admins reciben un
resumen automático cada mañana (8:30) con el gasto del día anterior y una
alerta si fue inusualmente alto comparado con el promedio de la semana.

**Acceso**: solo los usuarios de Telegram autorizados (guardados en la pestaña
oculta `_usuarios_autorizados` del Sheet de cashflow — no en una variable de
entorno) pueden usar el bot. Cualquier otra persona recibe "🔒 No tienes
acceso a este asistente." y, automáticamente, todos los admins reciben por
Telegram su nombre real y botones **✅ Colaborador / ✅ Admin / ❌ Ignorar** —
un solo toque lo autoriza, sin tocar Railway ni revisar logs.

**Niveles de acceso (rol por usuario):**
- **admin** — acceso completo, incluye presionar los botones que disparan una
  escritura real (✅ Agregar a cashflow, ✅ Confirmar pago recurrente,
  📤 Enviar así, ✅ Sí, archivar aquí).
- **colaborador** — puede chatear, consultar, usar `CAPTURA` y `corrección:`,
  y descartar/cancelar cualquier propuesta — pero si intenta presionar un
  botón de escritura, recibe "Esta acción requiere aprobación de un
  administrador." y no se ejecuta nada.

---

## 1. Comandos exactos

Estos se escriben literalmente (no hace falta may/min exacta, y `/revisarcorreo`
funciona con o sin la diagonal inicial).

| Comando | Qué hace |
|---|---|
| `/revisarcorreo` (o `revisarcorreo`) | Dispara de inmediato una revisión de correos nuevos en `asistente@wobagroup.com`, sin esperar al cron de cada hora. |

---

## 2. Palabras y frases clave que el asistente reconoce

Estas no son comandos exactos — el asistente detecta la intención en el texto,
así que hay flexibilidad en cómo se escriben.

| Palabra/frase clave | Dónde puede aparecer | Qué hace |
|---|---|---|
| `CAPTURA` | En cualquier parte del mensaje (mayúsculas o minúsculas) | Guarda el mensaje completo, tal cual, en la base de conocimiento — sin revisión ni aprobación adicional. Se asume que si lo escribes con CAPTURA, ya está validado. |
| `corrección:` / "eso no era así, en realidad..." / "no, en realidad es..." | En cualquier mensaje de chat normal | Registra una corrección permanente (qué se creía antes vs. el dato correcto). A partir de ahí, esa corrección se incluye SIEMPRE que se consulte la base de conocimiento, sin importar el tema. |
| "envíale un correo a...", "contesta ese correo diciendo...", "mándale ese link a Carlos por correo" | En chat normal, lenguaje natural | Prepara un borrador de correo y lo muestra por Telegram con botones de aprobación. Nunca se envía automáticamente. |

---

## 3. Botones de Telegram (no se escriben, se presionan)

Aparecen debajo de ciertos mensajes del asistente cuando hace falta tu aprobación
para algo. Nunca se ejecuta una acción irreversible (enviar correo, subir archivo,
registrar en cashflow) sin que presiones uno de estos botones.

**Sobre correos entrantes que requieren acción:**
- ✅ Proceder — investiga/ejecuta lo que corresponda con las herramientas disponibles.
- ❌ Descartar — ignora la propuesta.
- ✏️ Dar instrucciones específicas — te pide una instrucción tuya en texto libre antes de actuar.

**Sobre movimientos de Holded sin registrar en el cashflow:**
- ✅ Agregar — registra el movimiento en el Sheet de cashflow.
- ❌ Ignorar — descarta la propuesta.

**Sobre borradores de correo (después de "Proceder", una corrección de orientación, o pedir enviar algo por chat):**
- 📤 Enviar así — envía el correo real, tal como está.
- ✏️ Editar antes de enviar — te pide el texto de reemplazo antes de mostrar el borrador de nuevo con los mismos botones.
- ❌ No enviar — descarta el borrador.

**Sobre archivos/documentos enviados por Telegram para archivar en Drive:**
- El asistente propone una carpeta de destino con botones de aprobación (sí/no) antes de subir nada.

**Sobre alertas de pagos recurrentes (seguros, IBI, etc. con proveedor y empresa conocidos — solo WOBA/EWORKS, cualquier periodicidad: mensual/trimestral/semestral/anual):**
- 💰 Indicar monto y registrar — pide el importe exacto (y el proveedor, si no se conoce de antemano) por texto libre.
- Tras responder con el importe, aparece un mensaje de confirmación con:
  - ✅ Confirmar y registrar — crea el gasto en Holded (como borrador) y la línea en el cashflow.
  - ❌ Cancelar — descarta la propuesta, no escribe nada.
- Nota: este flujo de escritura en Holded es para pagos recurrentes detectados por `calendario_fiscal.json`. Para facturas/gastos puntuales, ver la sección de abajo.

**Sobre facturas/gastos enviados por Telegram o recibidos por correo (con detalle y comprobante juntos — WOBA, EWORKS y Footprint):**
- El asistente lee el CONTENIDO real del documento (no solo el nombre) para decidir si es una factura/gasto. Si no lo es, sigue el flujo normal de archivado en Drive.
- Si encuentra un gasto ya registrado en Holded que podría corresponder (mismo proveedor, monto y fecha cercana):
  - ✅ Es este (#N) — adjunta el comprobante a ese gasto en Holded.
  - ❌ Ninguno, crear nuevo — sigue al flujo de creación de abajo.
- Si no encuentra ninguno:
  - ✅ Crear gasto en Holded — crea el gasto (como borrador) y adjunta el comprobante.
  - ✏️ Corregir clasificación — pide la empresa/concepto correctos por texto libre (ej. "EWORKS, servicio de limpieza") antes de crear el gasto. Esta corrección **queda aprendida**: la próxima factura del mismo proveedor se clasifica con más certeza.
  - ❌ Cancelar — no escribe nada.
- Solo administradores pueden aprobar la escritura (adjuntar o crear) — un colaborador recibe el mensaje de que necesita aprobación.

---

## Notas para quien mantiene este documento

- Cada vez que se agregue un comando, palabra clave o botón nuevo al sistema,
  debe añadirse una fila aquí en la sección correspondiente.
- Este archivo vive en `docs/`, así que el propio asistente también lo puede
  consultar (vía `consultar_base_conocimiento`) si le preguntan "qué comandos
  tienes" desde el chat.
