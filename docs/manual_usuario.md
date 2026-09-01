# Manual de usuario — WOBA Copilot

Guía de uso para el equipo. Explica qué es el asistente, qué puede hacer y cómo
usarlo desde Telegram. Última actualización: 2026-08-27 (nuevo rol superadmin
— solo Carlos — que centraliza todas las decisiones de escritura y sobre
correo entrante; "admin" ya no alcanza por sí solo).

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
  empresa, por semana, por bloque, o por concepto/proveedor — ej. "¿hay
  facturas de limpieza pendientes en WOBA?"). El detalle cubre TODO lo que
  hay en la hoja DATOS: ingresos, pagos a proyectos, pagos extras,
  aplazamientos de impuestos, gastos fijos (nóminas, créditos, servicios
  como limpieza/renting/alquiler, consultores, impuestos) y pendientes
  (pagos pendientes a Alberto, deudas con otros) — antes la búsqueda por
  concepto solo cubría una parte y podía decir "no hay" aunque la fila
  existiera en gastos fijos; ahora busca en todas las categorías antes de
  responder. Footprint no tiene cashflow en Sheets todavía — sí se
  monitorea directo en Holded (ver abajo). **La búsqueda por concepto es
  tolerante a redacción distinta**: si preguntas "¿está registrada la
  Seguridad social?" y la fila real dice "Impuestos seg social", igual la
  encuentra — cuando no hay coincidencia exacta, busca por palabras
  parecidas y te avisa explícitamente que es una coincidencia aproximada,
  para que la confirmes en vez de darla por hecha en automático.
- **Verificar si está realmente actualizado**: pregúntale "¿el cashflow está
  actualizado?" o "¿falta algo por registrar?" y compara en vivo los
  movimientos bancarios reales de Holded contra lo ya registrado — no es
  solo leer el resumen, cruza los datos y te dice específicamente qué
  movimiento falta, con monto y fecha, si falta algo. Por defecto revisa lo
  que va de la semana actual; puedes pedirle la semana anterior completa.
  Esta consulta por sí sola no registra nada — pero si le dices "regístralos"
  o "muéstramelos con botón" (o de entrada le pides que registre lo que
  falta), dispara el mismo flujo con botones que el chequeo automático del
  viernes/lunes, sin esperar a que llegue esa fecha: un mensaje por
  movimiento, con categoría sugerida y opción de corregirla, para que
  apruebes cada uno con un toque. **Nunca marca como "falta" una conversión
  de moneda entre cuentas propias de la misma empresa** (ej. "Converted USD
  to EUR" entre las cuentas Emoney EUR/Emoney USD) — el cashflow solo
  registra ingresos externos o pagos a externos, nunca movimientos internos
  entre cuentas de la propia empresa. **Convierte a euros antes de
  comparar**: algunas cuentas (ej. Emoney USD) operan en dólares — el
  cashflow siempre está en euros, así que la comparación usa el equivalente
  en EUR que ya calcula Holded (el valor en gris que aparece debajo del
  monto en dólares dentro de Holded), nunca el monto nativo en dólares.
  **Tolera el redondeo de tipo de cambio**: un monto convertido de USD/otra
  divisa puede diferir por unos céntimos entre lo que calculó Holded y lo
  registrado a mano (cada uno redondeó en un momento distinto) — para esos
  casos la comparación admite hasta 5 céntimos de diferencia en vez de 1.
  **Busca también por total agrupado**: si varios cargos del mismo
  proveedor (ej. varias compras de Amazon la misma semana) no coinciden uno
  a uno con el cashflow, suma todos los que compartan la misma descripción
  y compara esa suma contra lo registrado — a veces no se anota cada compra
  por separado sino un solo total (ej. "AMAZON — S35 — 65,83€" cubriendo 5
  cargos individuales).
- Detecta automáticamente movimientos que aparecieron en Holded pero no están
  registrados en el cashflow, y propone agregarlos — con botón de
  aprobación, nunca se agrega solo. Solo WOBA/EWORKS. Corre dos veces por
  semana: el **viernes a las 17:00** como primer punto de control (revisa lo
  que va de la semana actual, lunes a viernes) y el **lunes a las 8:00** como
  revisión de cierre de la semana anterior completa. Si algo se ignora o
  queda pendiente el viernes y sigue sin registrar, se vuelve a proponer el
  lunes.
  - **Categoría sugerida por botones**: para cada gasto detectado, el
    sistema compara el concepto contra el historial ya registrado (qué se
    clasificó como Gastos Fijos, Pagos Proyectos, Pagos Extras, Pagos
    Pendientes Alberto, Deudas Pendientes o Aplazamiento Impuestos antes) y
    ofrece hasta 3 categorías candidatas como botones — tú eliges la
    correcta con un toque, no hay que corregir texto a mano. Los ingresos no
    pasan por esto, van directo a Ingresos. Si ninguna categoría tiene un
    historial parecido, ofrece "Pagos Extras" por defecto. Las 6 categorías
    de gasto ya son escribibles automáticamente con esa misma aprobación por
    botón — incluyendo Pagos Pendientes Alberto y Deudas Pendientes (sin
    semana, si aún no se sabe cuándo se pagará) y Aplazamiento Impuestos.
- **Avisos de Aplazamiento Impuestos**: revisa a diario (8:10) la columna de
  Aplazamiento Impuestos por Pagar y manda un aviso individual (no un
  resumen) cuando la semana registrada de una fila cae a 2 días, 1 día, o el
  mismo día de vencer — mismo criterio de ventana que el resto de alertas
  fiscales. Filas sin semana asignada no generan aviso (no hay fecha que
  comparar). Solo consulta, nunca escribe nada.
- **Anotaciones (comentarios) del Sheet de cashflow**: el equipo deja
  comentarios reales de Google Sheets (clic derecho > Comentar, no la
  "nota" clásica) en la columna VALOR de Pagos Proyectos, Ingresos, etc.,
  con contexto de cobro/pago que no está en ninguna otra parte (ej. "se
  paga solo cuando recibamos el primer pago de X", "avisar al proveedor",
  "cobra a finales de agosto"). Pregúntale "¿hay anotaciones pendientes en
  el cashflow?" y te las lista con su ubicación real (categoría, cliente o
  proyecto, semana, empresa — o te avisa si no pudo ubicar la fila, por si
  el comentario quedó "huérfano" de una fila que ya cambió o se pagó) más
  su propia recomendación de cómo proceder. Además, revisa a diario (8:20)
  si hay anotaciones sin resolver **nuevas o editadas** desde el último
  aviso y manda un mensaje individual por cada una con esa misma
  recomendación — a diferencia de Aplazamiento Impuestos, no repite el
  mismo aviso todos los días mientras siga sin resolver, solo cuando
  cambia. Solo consulta, nunca escribe ni marca nada como resuelto — eso
  se hace a mano en el propio Sheet.

### 🏦 Holded
- Consultar movimientos bancarios reales y cuentas de tesorería (solo
  lectura, en chat normal) — **WOBA, EWORKS y Footprint**. Cada movimiento
  viene directo del área de Bancos de Holded (sincronizado con el banco
  real) con su estado de conciliación (conciliado o pendiente) — útil para
  comparar lo que reporta el banco contra lo ya registrado.
- **Saldos bancarios reales**: pregúntale "¿cuánto hay en las cuentas de
  WOBA?" y te dice el saldo actual de cada cuenta/tarjeta directo de Holded
  (no un cálculo propio), más cuántos movimientos de cada una están sin
  conciliar.
- **Balance y Pérdidas y Ganancias (P&L)**: pídele "el balance y P&L de
  Footprint de este año" (o el rango de fechas que quieras) y genera un
  Excel y un PDF reales, reconstruidos a partir de los datos contables de
  Holded (Holded no tiene una vía de API para descargar su reporte oficial,
  así que esto es una reconstrucción propia agrupada por las categorías que
  el mismo Holded le asigna a cada cuenta — verificado cifra por cifra
  contra el reporte real de Holded antes de activarlo). Si lo pides aquí
  mismo, te manda los archivos directo en el chat; si pides que te lo mande
  por correo, te muestra una propuesta con botón de aprobación antes de
  enviar nada.
- Registrar gastos recurrentes conocidos (seguros, IBI, Google, Salesmate,
  etc.) cuando se acerca su fecha — ver sección de Pagos recurrentes más
  abajo. WOBA, EWORKS y Footprint; para WOBA/EWORKS también se registra la
  línea en cashflow, para Footprint solo se escribe en Holded (no tiene
  cashflow en Sheets).
- **Conciliación de facturas/gastos puntuales** (WOBA, EWORKS y Footprint):
  si le mandas una factura o comprobante por Telegram, o llega por correo
  (adjunto o CAPTURA de un correo con PDF/imagen), lee el documento real y
  sigue este proceso completo, verificado en vivo de punta a punta:
  1. **¿Ya existe este gasto en Holded?** Busca por proveedor (tolera razón
     social vs. nombre comercial — "Booking.com" reconoce a "BOOKING
     HOLDINGS Inc. (Booking)", "Ocean Facility Services, S.A." reconoce a
     "OCEAN FACILITY SERVICES SA.") y monto/fecha cercanos. Si encuentra un
     candidato, propone **adjuntar el comprobante ahí** en vez de crear un
     gasto nuevo — evita duplicados.
  2. **Si no existe, ¿el cargo ya está en el banco?** Antes de proponer
     crear un gasto nuevo, revisa también los movimientos bancarios reales
     sin conciliar (no solo Compras) — puede que el dinero ya haya salido y
     solo falte registrar el documento. Revisa TODAS las cuentas de
     tesorería sin importar su moneda (puede que el cargo caiga en una
     cuenta en USD y no en la de EUR). Si encuentra un movimiento que
     coincide en monto y fecha, te ofrece **los dos botones juntos** —
     "✅ Crear" y "✅ Crear y conciliar" — para que elijas tú según tu
     confianza en el match, en vez de que el sistema decida por ti. Si no
     hay match, solo aparece "✅ Crear gasto en Holded". Cuando el gasto
     original no está en euros (ver 4b más abajo), la comparación tolera
     unos céntimos de diferencia — el monto en EUR de la factura y el que
     calcula Holded para el movimiento vienen de dos conversiones de cambio
     independientes y pueden no coincidir centavo a centavo sin dejar de
     ser la misma transacción.
  3. **Cuenta contable real, no la genérica por defecto**: busca en compras
     ya registradas (mismo proveedor, o palabras clave del concepto) qué
     cuenta contable se usa de verdad para ese tipo de gasto (ej. "Gastos de
     viaje" para vuelos/hoteles/taxis, en vez de que Holded caiga en
     "Otros servicios") — Holded no tiene un listado público de su plan de
     cuentas, así que siempre reutiliza una cuenta YA en uso real, nunca
     inventa una; si hay varias candidatas sin un proveedor que desempate,
     le pide a Claude que elija entre esas opciones reales. Lo muestra en
     la propuesta antes de aprobar.
  4. **Desglose real de IVA** por línea (base + % leído de la factura)
     visible antes de aprobar.
  4b. **Factura en moneda distinta al euro** (ej. un recibo de Uber en COP):
     la conciliación bancaria siempre es en euros, así que el gasto se
     registra en Holded por el monto en EUR — nunca por el monto en la
     moneda local — y el comprobante se deja adjunto tal cual, en su moneda
     original. Para saber el monto en euros, revisa tanto el documento como
     el correo que lo trae (es habitual que el recibo en sí no muestre el
     equivalente en euros, pero si te reenviaron una notificación de tarjeta
     tipo "40.46 EUR | 148.346 COP", ese dato sí está en el asunto/cuerpo del
     correo). Nunca calcula ni inventa un tipo de cambio: si no encuentra el
     equivalente en euros en ningún lado, no crea nada — te pregunta el monto
     exacto en euros antes de continuar.
  5. **Si no encuentra el proveedor** ni por nombre parecido, busca
     alternativas (contactos con nombre parecido, facturas ya registradas
     con el mismo importe) y te las muestra por botones — la que confirmes
     queda **aprendida** como alias, así la próxima factura del mismo
     proveedor no vuelve a preguntar. La tolerancia de nombre parecido
     nunca asigna un contacto solo porque comparte una palabra genérica del
     rubro (ej. "transporte", "servicios") — tiene que ser una palabra
     realmente distintiva del proveedor real; si no hay ninguna coincidencia
     así de segura, no asigna ningún contacto y cae en este mismo paso de
     alternativas/pregunta.
  6. **Al aprobar "Crear"** (crea el gasto, con su cuenta/tags/IVA correctos)
     — si falla adjuntar el comprobante o ya existía y solo faltaba
     adjuntarlo, nunca lo trata como fallo total ni sugiere reenviar el
     documento (crearía un duplicado): dice con claridad que el gasto ya
     está creado (con su id) para que subas el comprobante a mano, y sigue
     el flujo hasta la pregunta de conciliación.
  7. **Conciliación**: al conciliar (de una con "Crear y conciliar", después
     con la pregunta Sí/No, o al adjuntar a un gasto existente), ENLAZA de
     verdad el movimiento bancario con el documento del gasto — nunca
     confía en que el estado diga "conciliado" por sí solo, confirma que el
     monto realmente quedó emparejado antes de reportar éxito.
  8. **Si Holded rechaza la fecha** por un periodo contable ya cerrado, no
     muestra el error técnico crudo: ofrece un botón para reintentar con la
     fecha de hoy.
  - Todo con botón de aprobación — nunca escribe en Holded sin confirmar, y
    solo el superadministrador puede aprobar. Si la clasificación no es
    correcta, puedes corregirla; queda **aprendida** para la próxima
    factura del mismo proveedor.
  - Un movimiento bancario que quedó "forzado" sin enlace real (de antes de
    que este proceso quedara así de preciso) no se puede corregir por API —
    hay que pulsar "Restaurar" en la pantalla de Conciliación de Holded
    para dejarlo pendiente de nuevo.
- **Gastos sin comprobante**: pregúntale "¿qué gastos de WOBA/EWORKS/Footprint
  no tienen comprobante?" y revisa Holded para decirte cuáles faltan (con el
  proveedor, monto, fecha, y si hay una pista de a quién corresponde). Solo
  consulta — no escribe nada.
- **Movimientos bancarios sin conciliar**: pregúntale "¿qué movimientos de
  Footprint faltan por conciliar?" y revisa las cuentas de Holded Treasury
  para decirte cuáles no están conciliados todavía (cuenta, descripción,
  monto, fecha) — útil para detectar cargos sin ningún gasto asociado. Solo
  consulta — no escribe ni concilia nada.
- **¿Ya está cargada esta factura en Holded, aunque no se haya pagado?**:
  pregúntale "verifica si el pago de Limpieza de 393,40€ ya está registrado
  en Holded" y busca directo en el módulo de facturas de Holded (gastos vía
  /purchases, ingresos vía /invoices) — no solo en los movimientos
  bancarios. Distingue "no está registrado todavía" de "ya está cargada
  pero pendiente de pago", y para cada factura que encuentra dice el número
  de documento, fecha, vencimiento, y cuánto está pagado vs. pendiente. Si
  el nombre que le das (ej. una categoría genérica del cashflow como
  "Limpieza") no coincide con el proveedor real en Holded, busca igual por
  el monto y te avisa explícitamente que ese resultado coincidió solo por
  importe, no por nombre, para que lo confirmes antes de darlo por hecho.
  Solo consulta — no escribe ni concilia nada.
- **Programar actividades en el calendario CRM** (WOBA, EWORKS y Footprint):
  pídele "programa una llamada con [proveedor] el jueves a las 10 para
  WOBA" y prepara la actividad (título, tipo, fecha/hora, y el contacto de
  Holded si lo menciona), mostrándola por Telegram con botones de
  aprobación. Solo se crea en el calendario de Holded si apruebas con
  "✅ Programar" — solo el superadministrador puede aprobarlo. Al crearla,
  le asigna dueño (tu usuario de Holded, cuando existe en esa empresa) y te
  agrega como participante para que Holded mande la notificación por
  correo — sin esto, la actividad se creaba igual pero podía no aparecer en
  tu vista de calendario filtrada por usuario. Después de aprobar, confirma
  que el id existe releyéndolo — si no encuentra tu usuario en esa empresa
  o no puede releerlo, te lo dice explícitamente en vez de callarlo.
  **Puedes preguntarle qué hay programado** ("¿qué tengo agendado en el
  calendario de WOBA?") para confirmar en cualquier momento qué actividades
  existen de verdad — nunca te va a decir que no puede consultar el
  calendario.

### 📁 Google Drive
- Buscar documentos o carpetas por nombre, en cualquiera de las 3 empresas.
- Recibir un archivo por Telegram, clasificarlo, y proponer en qué carpeta
  archivarlo — solo lo sube si confirmas con el botón. (Si el documento
  resulta ser una factura/gasto, sigue en cambio el flujo de Holded de
  arriba.)
- **Si respondes en texto en vez de tocar el botón** ("archívalo ahí",
  "sí, guárdalo, y de paso respóndele el correo a fulano con el link"), el
  asistente reconoce que hay una propuesta de archivo sin responder y la
  confirma igual que si hubieras tocado "✅ Sí, archivar aquí" — sin
  volver a pedirte los datos que ya te mostró. Puede encadenar esto con
  otras instrucciones en el mismo mensaje (ej. redactar un correo con el
  link de Drive resultante).
- **Si el correo/mensaje que trae el documento pide explícitamente que se
  recuerde o quede registrado** (ej. "para que lo memorices", "que quede
  de referencia"), además de la propuesta normal de archivo en Drive, el
  asistente lee el contenido real (con Claude vision, no solo el nombre) y
  propone guardarlo TAMBIÉN como conocimiento (`CAPTURA`, mismo flujo de
  elegir empresa y confirmar) — y si vino de un correo, pregunta aparte si
  quieres que lo responda (Sí/No) antes de redactar nada.

### 📧 Correo (`asistente@wobagroup.com`)
- Revisa el correo entrante cada hora (o al pedirlo con `/revisarcorreo`) y
  clasifica cada mensaje:
  - **Si trae un adjunto real, SIEMPRE lo procesa** (analiza el
    direccionamiento del correo — qué acción hay que tomar) y lo propone
    para Drive, o para Holded si resulta ser una factura/gasto (mismo flujo
    que arriba) — sin depender de que la clasificación inicial del correo
    haya acertado el tipo. Si el destino está claro, te muestra la
    propuesta directo; si es ambiguo (ej. varias carpetas plausibles), te
    pregunta cuál corresponde en vez de adivinar.
  - Si necesita respuesta o parece una instrucción → te avisa con botones
    para investigar, ignorar, o darle instrucciones específicas — solo el
    superadministrador puede presionarlos.
  - **Si trae las notas de una reunión** (ej. "Notes by Gemini" de Google
    Meet, u otra herramienta similar tipo Otter/Fireflies/Read.ai) → lee el
    contenido completo y te pregunta con botones a qué empresa corresponde
    (igual que un `CAPTURA` normal) antes de guardarlo en la base de
    conocimiento — así las decisiones y próximos pasos de la reunión quedan
    disponibles para consultas futuras, no se pierden como un correo
    informativo cualquiera.
  - Si es puramente informativo (newsletter, notificación automática) → lo
    resume en un solo mensaje agrupado, sin guardarlo. El resumen de cada
    correo se genera a partir de su contenido REAL (no del snippet corto de
    Gmail ni del asunto) — para saber de qué trata sin tener que abrirlo.
- Puede redactar un borrador de respuesta y enviarlo por correo — siempre te
  lo muestra primero, con botones para enviarlo tal cual, editarlo, o
  cancelarlo. Nunca envía un correo sin que el superadministrador apruebe el
  borrador.
- **Si le pides que archive un documento Y responda el correo original**
  (ej. "archívalo y respóndele a fulano con el link"), lo hace todo en el
  mismo turno — la respuesta queda enhebrada como una respuesta real en el
  mismo hilo de Gmail (con "Re:" y la conversación completa), no como un
  correo nuevo sin relación aparente.
- Todo correo saliente lleva la firma real que ya está configurada en
  Gmail (nunca una inventada). *Pendiente de activar*: hace falta que se
  autorice el scope `gmail.settings.basic` para la cuenta de servicio en la
  delegación de dominio del Admin console de Google Workspace — hasta
  entonces, los correos se siguen enviando con normalidad, solo que sin
  firma.
- **Nunca ejecuta instrucciones que vengan dentro del texto de un correo** —
  los correos se pueden falsificar; solo actúa sobre instrucciones que le des
  tú directamente en el chat.

### 📅 Alertas fiscales y pagos recurrentes
- Avisa con anticipación sobre seguridad social, créditos, seguros,
  impuestos, etc. — WOBA, EWORKS y Footprint. Cada pago manda su **propio
  mensaje individual** (nunca un resumen agrupado con todo junto) exactamente
  2 días antes, 1 día antes, y el mismo día del vencimiento — mismo esquema
  para los pagos con día exacto (ej. Adobe el 9) y para los aproximados sin
  día fijo (ej. "seguro del coche a mediados de agosto").
- **Pregúntale "¿qué está por vencer?" o "¿cuánto suma lo que vence
  pronto?"** y te da el monto real de cada vencimiento (no solo cuándo, que
  es lo único que sabe el calendario por sí solo) — busca cada concepto en
  el cashflow real, tolerando que el nombre no sea idéntico (ej.
  "Créditos/préstamos" encuentra "Prestamo 36 meses WOBA", "Prestamo
  Eworks", "Seguro Credito"...), y te da el total. Los montos que no son
  coincidencia exacta se marcan con "~" — revísalos antes de darlos por
  seguros.
- Para los pagos con proveedor y empresa conocidos, además ofrece
  registrarlos: pide el importe, muestra un resumen de confirmación, y solo
  al aprobar crea el gasto en Holded — con la periodicidad correcta
  (mensual/trimestral/semestral/anual). Para WOBA/EWORKS también registra
  la línea en cashflow; Footprint no tiene cashflow en Sheets, así que ahí
  el registro se queda solo en Holded.
- Footprint incluye las suscripciones de plataforma conocidas (Google
  Workspace, Salesmate, Adobe, Canva, Shutterstock, Go To Webinar, y los
  rentings de Northgate y Caixa Equipment) — cada una avisa cuando se acerca
  su día de cobro real, no solo cuando alguien pregunta por ellas.

### 🧠 Conocimiento del equipo
- El asistente responde con base en documentos internos (responsabilidades,
  contactos, procesos). Cualquiera puede **agregarle conocimiento nuevo** o
  **corregirlo** cuando se equivoca — ver la sección 3.
- **Directorio de personas**: va reconociendo solo, sin que nadie lo cargue a
  mano, a quien se autoriza para usar el asistente por Telegram y a quien se
  cruza correo (entrante o saliente). Así, si le dices "avísale a Pep" o
  "mándaselo a Alejandra" sin dar el email, lo busca en ese directorio antes
  de proponer el correo — si no encuentra a la persona, te lo dice y pide el
  email en vez de inventarlo.

### 🔌 Panel de conexiones (front /cerebro)
- Justo debajo del enlace a Telegram, en la parte de arriba del panel, se ve
  en todo momento el estado real de las 8 conexiones externas que usa el
  sistema: Telegram, Claude (Anthropic), Google Sheets, Google Drive, Gmail,
  y Holded (WOBA / EWORKS / Footprint) — cada una verificada en vivo (Claude
  se reporta de forma pasiva, según el último mensaje real del chat, para no
  gastar en una llamada de prueba en cada carga del panel).
- Mientras todo esté bien, se ve un punto verde discreto ("Conexiones activas
  8/8") que se puede expandir para ver el detalle. Si algo se cae, el panel
  se pone en rojo y se expande solo — no hay que buscarlo ni refrescar.
- Cada conexión caída trae su propio botón: para Telegram literalmente
  arregla el problema (re-registra el webhook); para el resto, reintenta la
  verificación (arregla blips de red transitorios, que sí ocurren de verdad).
  Si el problema es una API key revocada o un permiso retirado en el
  proveedor externo, ningún botón puede arreglar eso — el mensaje de detalle
  lo dice explícitamente en vez de fingir que se resolvió, y ahí sí hace
  falta una persona (renovar la key, actualizarla en Railway).
- Se revisa solo cada 2 minutos (no en cada carga del panel), porque varias
  de estas APIs son de pago o tienen límite de cuota.

### 💰 Control de costos de IA
- Registra el costo real (en USD, según las tarifas oficiales del modelo) de
  cada llamada que hace al modelo de IA.
- Solo los **administradores** pueden preguntar "¿cuánto ha gastado el
  sistema hoy/esta semana/este mes?".
- Todas las mañanas, los administradores reciben automáticamente un resumen
  del gasto del día anterior, con una alerta si fue inusualmente alto
  comparado con el promedio de la semana.

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
digital de Footprint vence en octubre 2026"*). Antes de guardarlo te pregunta
con botones a qué empresa corresponde (WOBA / EWORKS / Footprint / General,
puedes marcar varias); al presionar "✅ Confirmar y guardar" queda guardado
de verdad — si por alguna razón no se pudo escribir en la base de
conocimiento, te lo dice claramente (nunca confirma un guardado que no
ocurrió) y deja la selección lista para que vuelvas a intentarlo con el
mismo botón.

Si en cambio lo que quieres capturar es **un correo que acaba de llegar** (ej.
*"CAPTURA lo que llegó en el correo de Alejandra sobre las tarjetas"*), no
hace falta que copies el contenido — el asistente va y lee el correo real
(asunto, remitente y cuerpo completo) y guarda eso, no la instrucción que
escribiste.

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
- **Superadministrador** (solo Carlos): el único que puede aprobar cualquier
  escritura real del sistema (Holded, cashflow, eventos CRM, accesos a
  /cerebro, reportes por correo) y cualquier decisión sobre un correo
  entrante (proceder, descartar, dar instrucciones, o enviar la respuesta).
- **Administrador**: recibe los mismos resúmenes automáticos que el
  superadministrador (costo de IA, numeración del cashflow), pero no puede
  aprobar ninguna de las escrituras ni decisiones de arriba por sí solo.
- **Colaborador**: puede chatear, consultar, enseñarle cosas nuevas
  (`CAPTURA`, `corrección:`), y descartar propuestas — pero si intenta
  aprobar una escritura real o decidir algo sobre un correo, el asistente le
  explica que necesita aprobación del superadministrador.

### Comando especial
- `/revisarcorreo` (o `revisarcorreo`, o `revisamail`/`/revisamail`) — le
  pide que revise el correo entrante en ese momento, sin esperar a la
  revisión automática de cada hora.

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
