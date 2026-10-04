# Núcleo vivo de WOBi

Primera etapa de la nueva navegación de Cerebro. WOBi pertenece a WOBA y gestiona también Footprint Global y eWorks. La portada es un espacio de nanobots a pantalla completa: el núcleo ocupa el centro y la información aparece bajo demanda. Conserva los módulos actuales y mantiene Telegram como canal de conversación y operación.

## Recorrido

- `/cerebro/` abre el Núcleo vivo después del acceso habitual.
- Tocar el enjambre de WOBi despliega las once áreas como puntos flotantes; volver a tocarla las recoge. La portada no contiene columnas de paneles, un encabezado promocional ni textos explicativos largos.
- El selector de compañía acota la búsqueda de documentos. Los pendientes del sistema son conjuntos y están rotulados como tales; los módulos clásicos conservan su propio alcance.
- Al elegir un área se revela su detalle y sus accesos; al cerrarlo se vuelve al núcleo. Las áreas llevan a los módulos que ya existen. Marketing, comercial, compras, personas, compliance, ISO y tecnología tienen espacio reservado y se indican como previstos, sin simular agentes conectados.
- «Buscar un documento» (también Cmd/Ctrl K) consulta nombres en Drive y ofrece rutas verificadas y enlaces. Al cambiar de compañía se cancela y reinicia la búsqueda. No es un chat ni ejecuta operaciones.
- «Abrir Telegram Web» abre `https://web.telegram.org/k/#@Woba_asistente_bot` en otra pestaña. La sesión de Telegram pertenece al usuario y puede requerir inicio de sesión. El acceso alternativo abre `https://t.me/Woba_asistente_bot`.
- Las consultas preparadas desde Control diario se muestran en un diálogo con copiar y abrir Telegram. El usuario decide qué enviar; el texto empresarial no se incorpora a la URL.
- Pendientes, estado de conexiones y opciones se revelan a petición en diálogos que gestionan foco y Escape. El indicador de incidencias permanece visible abajo; «Actualizar ahora» está dentro del estado.
- «Vista clásica», en las opciones inferiores, conserva controles, módulos y administración. `?vista=clasica` es el acceso directo alternativo. El chat interno ya no se monta, incluido el antiguo `?chat=grande`.

Telegram Web declara `X-Frame-Options: DENY` (comprobado en WebA y WebK el 04-10-2026). Sus [widgets oficiales](https://core.telegram.org/widgets) no ofrecen el chat privado completo incrustado. Por eso se utiliza la pestaña adicional y no un iframe ni una sesión de Telegram compartida.

## Límites y organización

La portada vive en `frontend-cerebro/src/modules/nucleo/`; App solo la monta y conecta la navegación y la actualización existentes. El centro ya no utiliza una fotografía: un enjambre volumétrico de partículas azules/cian y filamentos ámbar gira y cambia de forma continuamente. Las corrientes de nanobots se intensifican hacia el área enfocada con cursor o teclado. Los símbolos responden con halos, escala suave y una pulsación al clic. Se mantienen las órbitas holográficas y los colores por área de la referencia visual de Carlos. La imagen de Telegram no cambia. Las órbitas son decoración, no métricas. El gráfico de conexiones, dentro del detalle de estado, se calcula exclusivamente con los resultados reales de la última lectura. Las partículas respetan movimiento reducido, se detienen al ocultar la pestaña y limitan su resolución.

`GET /api/cerebro/documentos?empresa=...&q=...` vive en `core/cerebro/documentos/`, reutiliza `exigeAccesoValido`, las raíces de compañía y `searchDriveFiles`. Solo devuelve metadatos; no descarga ni modifica documentos. Valida la compañía y admite de 3 a 80 caracteres, hasta cuatro palabras. Una búsqueda por sesión y dos simultáneas como máximo, con respuesta limitada a 30 segundos; una consulta subyacente pendiente conserva su plaza hasta finalizar.

La búsqueda existente de Drive omite rutas que no puede verificar: «sin coincidencias verificadas» no prueba ausencia de documentos. Un fallo completo se muestra como error, no como lista vacía. Los enlaces requieren los permisos habituales de Drive.

No se cambian roles, autorizaciones, contabilidad, jobs, voz ni bot. Se conservan los controles de frescura y actualización existentes; las fuentes fallidas no se presentan como ceros confirmados. Incorporar otras compañías requiere configurar primero sus raíces y acceso en el servidor; un elemento del selector no concede permisos.

## Verificación

Tipos, build completo y suite del repositorio. Pruebas nuevas: autenticación y validación del endpoint, raíz seleccionada, errores, timeout y concurrencia; pendientes ausentes frente a ceros confirmados. Verificación local con el servidor compilado y jobs desactivados: búsqueda real en Drive, cambio de compañía, navegación a módulos, portada sin chat grande y destino oficial de Telegram Web. No se envían mensajes de prueba ni se ejecutan operaciones financieras.

Las siguientes etapas integrarán vistas de cada área sin reemplazar sus flujos estables de golpe, y luego los agentes especializados con sus permisos y responsables explícitos.
