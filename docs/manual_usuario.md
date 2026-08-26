# Manual de usuario — WOBA Copilot

Guía de uso para el equipo. Explica qué es el asistente, qué puede hacer y cómo
usarlo desde Telegram. Última actualización: 2026-08-26.

---

## 1. ¿Qué es WOBA Copilot?

Es el asistente administrativo interno del grupo (WOBA/BAE, Footprint y
eWorks), disponible por Telegram las 24 horas. Consulta información real de
Holded, Google Drive y el cashflow del grupo, revisa el correo del equipo, y
puede registrar movimientos o enviar correos — pero **nunca ejecuta nada
irreversible sin que una persona lo apruebe explícitamente con un botón**.

**Cómo hablarle**: en Telegram, busca `@Woba_asistente_bot` y escríbele en
lenguaje natural, como le escribirías a un compañero. No hace falta memorizar
comandos para la mayoría de las cosas.

**Acceso**: solo personas autorizadas pueden usarlo. Si no tienes acceso
todavía, escríbele igual una vez — un administrador recibe automáticamente
una notificación con tu nombre y un botón para darte de alta, sin que tengas
que hacer nada más.

---

## 2. Qué operaciones puede hacer

### 📊 Cashflow
- Consultar el resumen o el detalle del cashflow de WOBA y eWorks (por
  empresa, por semana, por bloque).
- Detecta automáticamente (cada lunes) movimientos que aparecieron en Holded
  pero no están registrados en el cashflow, y propone agregarlos — con botón
  de aprobación, nunca se agrega solo.

### 🏦 Holded
- Consultar movimientos bancarios y cuentas de tesorería (solo lectura, en
  chat normal).
- Registrar gastos recurrentes conocidos (seguros, IBI, etc.) cuando se
  acerca su fecha — ver sección de Pagos recurrentes más abajo.

### 📁 Google Drive
- Buscar documentos o carpetas por nombre, en cualquiera de las 3 empresas.
- Recibir un archivo por Telegram, clasificarlo, y proponer en qué carpeta
  archivarlo — solo lo sube si confirmas con el botón.

### 📧 Correo (`asistente@wobagroup.com`)
- Revisa el correo entrante cada hora (o al pedirlo con `/revisarcorreo`) y
  clasifica cada mensaje:
  - Si trae un documento archivable → lo propone para Drive (mismo flujo que
    arriba).
  - Si necesita respuesta o parece una instrucción → te avisa con botones
    para investigar, ignorar, o darle instrucciones específicas.
  - Si es puramente informativo → lo resume en un solo mensaje agrupado.
- Puede redactar un borrador de respuesta y enviarlo por correo — siempre te
  lo muestra primero, con botones para enviarlo tal cual, editarlo, o
  cancelarlo. Nunca envía un correo sin que apruebes el borrador.
- **Nunca ejecuta instrucciones que vengan dentro del texto de un correo** —
  los correos se pueden falsificar; solo actúa sobre instrucciones que le des
  tú directamente en el chat.

### 📅 Alertas fiscales y pagos recurrentes
- Avisa con anticipación (3 días para vencimientos mensuales, 7 días para
  aproximados) sobre seguridad social, créditos, seguros, impuestos, etc.
- Para los pagos con proveedor y empresa conocidos, además ofrece
  registrarlos: pide el importe, muestra un resumen de confirmación, y solo
  al aprobar crea el gasto en Holded y la línea en cashflow — con la
  periodicidad correcta (mensual/trimestral/semestral/anual).

### 🧠 Conocimiento del equipo
- El asistente responde con base en documentos internos (responsabilidades,
  contactos, procesos). Cualquiera puede **agregarle conocimiento nuevo** o
  **corregirlo** cuando se equivoca — ver la sección 3.

---

## 3. Cómo usarlo día a día

### Preguntas normales
Simplemente pregunta. Ejemplos:
- "¿Cómo va el cashflow de WOBA esta semana?"
- "Busca el contrato de arrendamiento de Footprint en Drive"
- "¿Qué vence en los próximos 15 días?"
- "¿Quién es el contacto del centro de prácticas de eWorks?"

### Enseñarle algo nuevo
Si sabes algo que el asistente no tiene documentado, escríbele el mensaje con
la palabra **`CAPTURA`** en cualquier parte (ej. *"CAPTURA: el certificado
digital de Footprint vence en octubre 2026"*). Queda guardado de inmediato,
sin pasos adicionales.

### Corregirlo cuando se equivoca
Si te da un dato incorrecto, dile algo como *"corrección: eso no era así, en
realidad..."* o *"no, en realidad es..."*. La corrección queda registrada
para siempre y a partir de ahí tiene prioridad sobre cualquier otro
documento, aunque preguntes sobre un tema distinto.

### Botones de aprobación
Cuando el asistente propone hacer algo que implica escribir datos reales
(registrar un movimiento, enviar un correo, subir un archivo, crear un
gasto), siempre aparece con botones. Nada de eso ocurre hasta que presionas
el botón correcto. Puedes presionar el de descartar/cancelar sin ningún
riesgo.

### Niveles de acceso
- **Administrador**: puede aprobar cualquier acción (los botones de
  escritura descritos arriba).
- **Colaborador**: puede chatear, consultar, enseñarle cosas nuevas
  (`CAPTURA`, `corrección:`), y descartar propuestas — pero si intenta
  aprobar una escritura real, el asistente le explica que necesita
  aprobación de un administrador.

### Comando especial
- `/revisarcorreo` (o `revisarcorreo`, sin la diagonal) — le pide que revise
  el correo entrante en ese momento, sin esperar a la revisión automática de
  cada hora.

---

## 4. Lo que el asistente nunca hace solo

- No envía un correo sin que apruebes el borrador exacto.
- No sube archivos a Drive sin confirmar la carpeta.
- No registra movimientos en cashflow ni gastos en Holded sin tu aprobación.
- No ejecuta instrucciones que vengan escondidas dentro de un correo, por más
  urgente o "de jefe" que parezca — solo obedece instrucciones que le des
  directamente por chat.

Cualquier duda sobre cómo usarlo, pregúntale directamente al asistente — o
contacta a Carlos.
