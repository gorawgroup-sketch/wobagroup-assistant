# Navegador inteligente de WOBi — contrato propuesto, fase 1

Carlos autoriza cinco fases: inventario, navegación precisa, interpretación, voz e integración, pruebas/despliegue. Codex lleva frontend; Claude Code lleva backend. Esta entrega solo añade catálogo y validación local sin montar interfaz ni ejecutar acciones.

## Base comprobada

- `organization.mjs` declara 12 áreas y sus herramientas. `capabilities.mjs` deriva de esa misma fuente destinos descubribles; registrar un área/módulo añade capacidades sin editar el navegador.
- `NucleoVivo` abre áreas y módulos. Todavía no hay un protocolo común de sección/filtro: abrir un módulo NO equivale a aplicar un filtro.
- `/api/cerebro/chat` ya tiene identidad vinculada y solicitudes idempotentes; no debe reutilizarse para navegación porque puede ejecutar herramientas.
- Hay voz propia por `/api/cerebro/voz` y reproductor streaming existente. Reutilizar la configuración del servidor; no seleccionar voz del navegador como sustitución silenciosa.
- Seleccionar compañía no concede permisos ni garantiza que los datos estén separados. Cashflow WOBA/eWorks conjunto; Footprint sin fuente de cashflow. No atribuir saldos conjuntos a una empresa.

## Encargo para Claude Code (propuesta para acordar antes de implementación)

Construir interpretación de navegación en carpeta propia, solo lectura, con conexión mínima al servidor. No alterar bot, tools financieras ni chat existente. Recibir texto y compañía seleccionada; resolver identidad/permisos en servidor. Obtener catálogo versionado y autorizado: nunca confiar en capacidades o permisos enviados por cliente.

Devolver una de tres variantes:

- `destino`: capabilityId registrado, companyId autorizado, versión del catálogo y requestId.
- `aclaracion`: pregunta breve y opciones de destinos permitidos (por ejemplo pagos frente a renovaciones pendientes).
- `no_disponible`: motivo explícito, distinguiendo agente previsto, destino no implementado, permiso insuficiente y fuente no consultable.

No aceptar URLs, scripts ni selectores DOM producidos por el modelo. No invocar tools de escritura o conversación para resolver destinos. No fabricar cifras ni afirmar que una fuente está fresca. La lista de capacidades públicas del front es metadata de navegación, nunca autorización. Compartir/servir un único catálogo versionado cuando se añada el backend; no mantener copias manuales divergentes.

La base actual solo admite áreas/módulos. Antes de habilitar secciones/filtros, Codex registra e implementa cada destino exacto y añade pruebas. Una petición de filtro no soportado debe aclararse o declararse no disponible, nunca abrir un módulo genérico como si estuviera filtrado.

Audio: evaluar y acordar transcripción con sesión existente, límites y errores claros. No crear claves nuevas sin revisar servicios configurados. Micrófono explícito; no escucha permanente. La transcripción debe usar el mismo intérprete que el texto.

## Voz y experiencia, responsabilidad Codex

Campo compacto «Pídele a WOBi…», atajo Cmd/Ctrl K y micrófono, dejando documentos como capacidad accesible. Control persistente de voz activada/desactivada; desbloqueo de audio por gesto del usuario. Habla con la voz del servidor ya elegida.

Estados reales: escuchando → interpretando → abriendo → abierto; alternativas aclaración/no disponible/error/cancelado. «Estoy buscando» solo mientras existe solicitud; «Aquí está» solo después de abrir el destino. «No pude consultar la fuente» no es «No hay resultados». Frases cortas, sin repetición continua; cancelar petición/audio anterior al iniciar otra. No anunciar costes numéricos antes de verificar fuente, periodo, compañía y fecha de lectura. Fallo de audio no impide navegación ni resultado textual.

## Próximas entregas

2. Adaptadores exactos y panel de comandos por texto, primero Seguros/Finanzas/Operaciones. Inventario de destinos pendientes antes de prometerlos.
3. Interpretación de Claude Code conectada al catálogo y permisos.
4. Micrófono y voz existente, sin reconstruir un chat gigante.
5. Casos reales por compañía/permisos, ambiguos, fuentes fallidas, capacidades nuevas, cancelación y reintentos; feature flag y reversión antes de producción.

Telegram y derivación a Claude Code externos quedan fuera de estas cinco fases internas. No automatizar pantallas ni enviar mensajes en esta entrega.
