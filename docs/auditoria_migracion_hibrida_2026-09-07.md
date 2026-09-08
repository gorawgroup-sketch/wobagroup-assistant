# Auditoría y migración híbrida de IA — WOBI

Fecha de corte: 7 de septiembre de 2026, 20:36 UTC. Rama reversible: `codex/wobi-hybrid-controls`. Base previa a la auditoría: `9b738fd`. Durante el trabajo, otro proceso de Claude Code siguió confirmando arreglos funcionales en la misma rama; todos esos cambios concurrentes se preservaron y esta auditoría no los revirtió ni los sobrescribió.

## Conclusión ejecutiva

WOBI no era literalmente “API para todo”: la mayoría de sus 13 trabajos programados ya filtran y actúan de forma determinista sin invocar IA. El gasto se concentra en conversación, clasificación/extracción documental y de correo, respuestas automáticas, orientación de excepciones y autorrevisión de código.

No es correcto sustituir las llamadas del backend público por credenciales de una suscripción personal. Anthropic indica que los planes Claude de pago y Claude API son productos separados; OpenAI distingue igualmente el acceso de Codex por ChatGPT del acceso por API y recomienda API key para flujos programáticos generales/CI. Las suscripciones sí son apropiadas para trabajo interactivo y para agentes de desarrollo ejecutados en entornos privados y confiables dentro de las interfaces admitidas.

La migración segura, por tanto, tiene dos carriles:

1. Desarrollo, auditoría, revisión de código y mantenimiento privado: Codex/Claude Code con la suscripción existente.
2. Funciones online de WOBI que responden a Telegram, Gmail, documentos o herramientas empresariales: API controlada, con filtro determinista previo, allowlist, presupuesto y respaldo explícito.

No se desactivó todavía ninguna función online ni se eliminó ninguna ruta API. La política está en `observe` para reunir atribución real por proceso antes del corte.

## Condiciones de uso verificadas

- [OpenAI Docs — autenticación de Codex](https://learn.chatgpt.com/es-419/docs/auth): Codex local puede iniciar sesión con ChatGPT; una API key se factura a tarifa API. Para automatización empresarial confiable existen tokens de acceso en planes elegibles; las llamadas generales a la API siguen usando API keys.
- [OpenAI Docs — precios y disponibilidad de Codex](https://learn.chatgpt.com/en/docs/pricing): Codex está incluido en planes ChatGPT compatibles, con cuota compartida; la clave API es pago por uso.
- [Claude Help — suscripción y API separadas](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console): Claude Max no incluye el consumo de Claude API/Console.
- [Claude Code — configuración](https://docs.anthropic.com/en/docs/claude-code/getting-started): Claude Pro/Max puede autenticar Claude Code para trabajo local.
- [Claude Platform — precios](https://platform.claude.com/docs/es/about-claude/pricing): confirma las tarifas usadas por WOBI y que Batch API descuenta 50% en cargas asíncronas compatibles.

Decisión: no usar cookies, tokens OAuth personales extraídos, reverse proxies ni endpoints privados para convertir Telegram/Gmail en “uso de suscripción”. Eso sería frágil, inseguro y no está respaldado como API de aplicación.

## Línea base real

Fuente: lectura de solo consulta de `_costos_ia`. Ventana disponible: `2026-08-26 12:53:38Z` a `2026-09-07 20:36:29Z` (12,321 días).

| Métrica | Total observado |
|---|---:|
| Llamadas | 999 |
| Tokens de entrada | 13.231.893 |
| Tokens de salida | 343.521 |
| Escritura de caché | 2.112.741 |
| Lectura de caché | 4.851.619 |
| Gasto API | USD 38,1521 |
| Promedio diario | USD 3,0964 |
| Proyección lineal a 30 días | USD 92,89 |
| Proyección de llamadas a 30 días | 2.432 |

Por modelo:

| Modelo | Llamadas | Gasto |
|---|---:|---:|
| `claude-sonnet-4-6` | 345 | USD 20,8545 |
| `claude-sonnet-5` | 311 | USD 12,2970 |
| `claude-haiku-4-5` | 343 | USD 5,0006 |

Septiembre hasta el corte: 685 llamadas, 10.254.887 tokens de entrada, 259.492 de salida y USD 29,9218.

Limitación de la línea base: el esquema anterior no guardaba `proceso` ni `ejecucionId`; por eso no es posible repartir las 999 llamadas históricas entre correo, chat, facturas o autorrevisión sin inventar cifras. El cambio implementado comienza esa atribución hacia delante.

### Diagnóstico estadístico del gasto

- Sonnet 4.6 concentra el 54,7% del gasto. Su entrada mediana fue 8.237 tokens, percentil 95 de 51.776 y máximo de 72.992; ninguna de sus 345 filas tuvo lectura de caché.
- Sonnet 5 tuvo entrada mediana de 5.150, percentil 95 de 54.094 y máximo de 101.854 tokens; el 36,0% de las filas registró lectura de caché.
- Haiku tuvo entrada mediana de 2.705, percentil 95 de 44.992 y un máximo de 176.486 tokens; el 69,1% de las filas registró lectura de caché. El máximo confirma que el contexto conversacional, no la salida, puede dominar incluso en el modelo barato.
- Hubo 57 secuencias inmediatas Sonnet 4.6 → Sonnet 5 en menos de 60 segundos. La primera llamada de esas secuencias costó USD 4,1783 en la muestra, equivalente a USD 10,17/mes. El código confirma que todo correo sin adjunto primero intenta extracción de gasto y, si da negativo, llama al clasificador general. La cifra es un techo de ahorro, no ahorro garantizado: la secuencia temporal histórica no identifica el proceso y no autoriza a omitir detección financiera sin una prueba en sombra.
- Hubo 211 secuencias Sonnet 4.6 → Sonnet 4.6 en menos de 60 segundos. Pueden ser iteraciones con herramientas, varios adjuntos o extracción seguida de clasificación; no se cuentan como duplicados sin `ejecucionId`, pero justifican habilitar caché únicamente en prefijos documentales realmente repetibles.
- El único ciclo nocturno aislable con precisión ejecutó 3 revisiones Sonnet 5 por USD 0,0155. A igual carga, su coste mensual sería aproximadamente USD 0,47: migrarlo a suscripción es correcto arquitectónicamente, pero no es el principal ahorro económico.

Este análisis usó solo fecha, modelo, tokens y coste; no leyó cuerpos de correo, documentos, prompts, resultados, chat IDs ni secretos.

## Inventario de procesos con IA

“Tokens/coste histórico” figura como N/A cuando el registro anterior no permite atribución. El techo es el máximo de salida por llamada, no consumo esperado. Una ejecución con herramientas puede efectuar varias llamadas.

| Proceso | Frecuencia/disparador | Modelo y techo | Herramientas/contexto | Tokens/coste histórico atribuible | Criticidad | Suscripción |
|---|---|---|---|---|---|---|
| Chat conversacional Telegram | Por mensaje que no coincide con comando/flujo determinista | Haiku 4.5, luego Sonnet 5 si escala; 8.192 por llamada, hasta 12 iteraciones | 40 herramientas; historial reciente; caché de prompt | N/A: registro legado sin proceso | Alta | No para el bot público. API controlada |
| Clasificar correo | Solo cada hilo nuevo detectado por cron horario o revisión manual | Sonnet 5; 8.192, hasta 4 | Cuerpo recortado a 8.000 caracteres, conocimiento | N/A: registro legado sin proceso | Alta | No; proceso online |
| Extraer gasto desde correo | En todos los correos sin adjunto, antes del clasificador general | Sonnet 4.6; 8.192, hasta 4 | Cuerpo recortado a 8.000, reglas aprendidas | N/A; techo inferido de secuencias: USD 10,17/mes | Alta financiera | No; API controlada. Mayor candidato a filtro en sombra |
| Extraer factura/recibo | Por adjunto compatible | Sonnet 4.6; 8.192, hasta 4 | PDF/imagen, reglas aprendidas | N/A: registro legado sin proceso | Alta financiera | No; API controlada |
| Clasificar archivo | Tras extracción, salvo regla aprendida directa | Sonnet 4.6; 8.192, hasta 6 | Metadatos, carpetas Drive, conocimiento | N/A: registro legado sin proceso | Alta documental | No; API controlada |
| Transcribir documento para captura | Solo documento sin ruta estructurada aplicable | Sonnet 4.6; 1.500, una llamada | PDF/imagen y contexto mínimo | N/A: registro legado sin proceso | Media | No; API controlada |
| Respuesta automática de correo | Cada 15 min, pero solo mensaje nuevo en hilo aprobado | Sonnet 5; 4.096, hasta 12 | Hilo y herramientas de solo lectura | N/A: registro legado sin proceso | Crítica externa | No; API controlada y revisión de límites |
| Búsqueda web del panel | Manual | Sonnet 5; 2.048, una llamada; hasta 5 búsquedas | `web_search` hospedada | N/A: registro legado sin proceso | Media | No; función del producto |
| Interpretar corrección de gasto | Solo cuando falla parser determinista | Haiku 4.5; 512, una llamada | Texto corto, tool estructurada | N/A: registro legado sin proceso | Alta financiera | No; API económica |
| Elegir cuenta contable | Solo si alias/coincidencias deterministas no resuelven | Sonnet 5; 20, una llamada | Máximo 6 opciones | N/A: registro legado sin proceso | Alta financiera | No; API mínima, revisar Haiku con eval |
| Orientar anotación cashflow | Diario, solo anotación nueva | Haiku→Sonnet | Chat/tooling | N/A: registro legado sin proceso | Alta financiera | No en runtime; posible cola privada no urgente |
| Evaluar/ejecutar acción programada | Horario, solo acción vencida; IA adicional si condición libre | Haiku→Sonnet | Herramientas según acción | N/A: registro legado sin proceso | Crítica | No para ejecución; posible preanálisis privado |
| Redactar borrador/acciones de correo | Bajo callback humano | Haiku→Sonnet | Herramientas y aprobación | N/A: registro legado sin proceso | Alta | No para flujo online |
| Acción/orientación de gasto | Bajo callback humano y tras filtros | Haiku→Sonnet | Herramientas y aprobación | N/A: registro legado sin proceso | Alta financiera | No para flujo online |
| Resolver alerta documental | Solo excepción confirmada | Haiku→Sonnet | Herramientas y aprobación | N/A: registro legado sin proceso | Alta | No para flujo online |
| Healthcheck activo de Claude | Solo botón manual | Haiku 4.5; 1 token | Sin contexto | N/A: registro legado sin proceso | Baja | Mantener manual; nunca cron |
| Autorrevisión de código | 3 archivos cada noche, máximo 400 líneas cada uno | Sonnet 5; 16.384, una llamada por archivo | Archivo completo; PR con aprobación | 7.211 entrada / 111 salida / USD 0,0155 en 1 ciclo inferido | Media | Sí: candidato claro a Codex/Claude Code privado, aunque su coste observado es bajo |

## Inventario de procesos sin IA

Estos procesos cuestan cero tokens y ya cumplen “si no hay novedad, no invocar modelo”:

| Proceso | Frecuencia | Herramientas | Criticidad | Observación |
|---|---|---|---|---|
| Holded vs cashflow cerrado | Lunes 08:00 | Holded, Sheets, Telegram | Alta financiera | Comparación determinista |
| Holded vs cashflow preliminar | Viernes 17:00 | Holded, Sheets, Telegram | Alta financiera | Comparación determinista |
| Alertas fiscales | Diario 08:00 | JSON fiscal, Telegram | Crítica | Filtra vencimientos antes de avisar |
| Aplazamiento de impuestos | Diario 08:10 | Sheets, calendario, Telegram | Crítica | Sin modelo |
| Numeración cashflow | Diario 08:15 | Sheets, Telegram | Alta | Sin modelo |
| Anotaciones cashflow: detección | Diario 08:20 | Sheets | Alta | IA solo por anotación nueva |
| Control coste/salud | Diario 08:30 | Sheets, conexiones, memoria, Telegram | Alta operativa | Ahora incluye servicios, permisos, loops y memoria; cero IA |
| Gastos sin comprobante | Diario 08:35 | Holded, Telegram | Alta | Sin modelo |
| Revisión de correo: detección | Cada hora | Gmail, cola, deduplicación | Alta | IA solo por hilo nuevo |
| Acciones programadas: vencimiento | Cada hora, minuto 5 | Store de acciones | Alta | IA solo al vencer/condición libre |
| Conversaciones automáticas: detección | Cada 15 min | Gmail, allowlist contacto/hilo | Crítica | IA solo con mensaje nuevo externo |
| Vigilante de procesamiento atascado | Cada 2 min | Stores de colas, Telegram | Alta operativa | Añadido concurrentemente en `ee79d20`; sin modelo |
| Resumen de pendientes | Diario 19:00 | Stores/Sheets/Telegram | Media | Sin modelo |
| Callbacks de aprobación | Por botón | Telegram, Gmail, Drive, Holded, Sheets, Calendar, GitHub | Crítica | La mayoría deterministas; escrituras requieren aprobación previa salvo hilos aprobados |
| Cerebro/estado/conexiones/acceso | Bajo demanda | Express, Sheets, integraciones | Alta seguridad | Sin IA salvo buscador manual |

## Cambios implementados

1. Gateway único para Anthropic. Fuera de `core/ai/anthropicGateway.ts` ya no hay llamadas directas a `messages.create`.
2. Política reversible: `observe`, `allowlist`, `disabled`, kill switch, allowlist de procesos y límites diario/mensual. `observe` mantiene estabilidad durante la recopilación.
3. Registro por llamada y ejecución: proceso, modelo, autenticación, ejecución, número de llamada, tokens, coste equivalente de suscripción y gasto real API.
4. Privacidad: el log de herramientas dejó de imprimir valores de parámetros; registra solo nombre y nombres de campos.
5. Control diario ampliado sin IA: servicios caídos, errores de permisos visibles como conexión fallida, gasto anómalo, límites, ejecuciones repetidas y corrupción/pérdida accesible de memoria.
6. Antisolapamiento de cron dentro de una instancia para que una corrida lenta no duplique acciones o gasto en el siguiente intervalo.
7. Pruebas unitarias de la política y script `npm test`.
8. Caché explícita de 5 minutos en los prefijos estáticos de extracción/clasificación documental y de las tres revisiones nocturnas consecutivas. Se dejó fuera de los analizadores de correo: una llamada aislada pagaría una escritura de caché 25% más cara sin reutilizarla. La caché no altera prompts, documentos, modelos ni resultados.
9. Control diario complementario creado en Codex con la suscripción de ChatGPT, a las 09:00, limitado a lectura/análisis local y sin llamadas a APIs de modelos, despliegues, merges ni escrituras externas.

No se tocaron secretos, `.env`, rutas HTTP, modelos ni prompts de negocio. No se desplegó ni se modificó la hoja de producción durante la implementación; las columnas nuevas se añaden de forma aditiva la primera vez que corra la versión desplegada.

## Plan priorizado y reversible

### P0 — Hecho: observabilidad y contención

- Desplegar la rama en staging.
- Mantener `WOBI_AI_API_MODE=observe` durante 14 días o al menos 5 ciclos de cada proceso poco frecuente.
- Confirmar que el total nuevo coincide con la factura de Anthropic y que no aparecen ejecuciones por encima de 12 llamadas.
- Configurar en el proveedor un límite de gasto además del límite de aplicación; la defensa debe existir en dos capas.

Rollback: no hacer un reset global, porque borraría el vigilante concurrente `ee79d20`. Revertir selectivamente los archivos de esta auditoría contra `ee79d20`; las ocho columnas históricas siguen intactas y las columnas I:N pueden permanecer sin afectar la versión anterior.

### P1 — Migrar mantenimiento a suscripción

- Ejecutar auditoría arquitectónica, pruebas, revisión de PR y autorrevisión de código en Codex o Claude Code autenticado con la suscripción, en host privado.
- Comparar durante 3–5 ciclos los hallazgos del nuevo agente contra `autorrevisionCodigo` sin permitir merge automático.
- Solo después, deshabilitar el cron API de autorrevisión y conservar `/admin/run-autorrevision-codigo` como respaldo manual incluido en allowlist.
- No instalar ni autenticar Claude Code automáticamente: el binario no está instalado en este host y el login requiere decisión de Carlos.

Estado al 8 de septiembre de 2026: se eligió Claude Code Max y quedó construido
el workflow oficial en modo sombra, de solo lectura, con rotación compartida y
registro sanitizado. La ruta API continúa activa. Falta que Carlos cree en
GitHub el secret `CLAUDE_CODE_OAUTH_TOKEN` desde `claude setup-token` y completar
cinco ciclos válidos antes de autorizar el corte.

### P2 — Optimización basada en evidencia

- Con 14–30 días de atribución, ordenar procesos por USD y tokens de entrada.
- Ejecutar durante 14 días un prefiltro de gasto de correo en modo sombra: registrar `candidato/no candidato`, pero seguir llamando al extractor. Solo habilitar el salto cuando todos los gastos reales del periodo hayan quedado como candidatos y exista una ruta de revisión manual.
- Crear un conjunto de casos dorados por clasificador/extractor antes de cambiar modelos.
- Probar Haiku en clasificación rutinaria y selección contable; aceptar el cambio solo si mantiene precisión, cobertura y tasa de escalado.
- Medir el historial de 101.854/176.486 tokens y probar compactación de transcripciones de herramientas en una copia: conservar mensajes del usuario, respuesta final y memoria estructurada; no desplegar si empeora preguntas de seguimiento.
- Limitar hilos automáticos por relevancia/recencia solo después de evaluar que no se pierde contexto contractual.
- Agrupar autorrevisión nocturna o clasificación no urgente con Batch API si debe seguir por API (50% de descuento oficial).
- Evitar la doble llamada Haiku→Sonnet cuando un comando determinista o una señal estructurada sabe de antemano que requiere escritura/razonamiento complejo.

### P3 — Corte controlado

- Pasar a `allowlist` con límites positivos y lista exacta de procesos imprescindibles.
- Para cada proceso migrado, retirarlo de `WOBI_AI_API_ALLOWED_PROCESSES`; no borrar su código ni ruta.
- Cuando todos los procesos elegibles acumulen varios ciclos correctos, pasar a `disabled`; activar temporalmente allowlist solo como respaldo explícito.
- Mantener `WOBI_AI_API_KILL_SWITCH=true` como corte inmediato ante bucles o incidente.

## Procesos que deben continuar por API

- Chat de Telegram y callbacks que requieren respuesta inmediata.
- Clasificación/extracción de correo y documentos al entrar.
- Respuestas automáticas de hilos aprobados.
- Búsqueda web del producto.
- Interpretación de excepciones financieras y selección contable cuando falla lo determinista.

Motivo común: son funciones de una aplicación online multiusuario/integrada. Una suscripción personal no equivale a una API de backend y un agente local puede estar apagado, perder conectividad o depender de una sesión humana.

## Procesos migrados

- A infraestructura controlada: todas las llamadas Anthropic (gateway, política y auditoría por ejecución).
- A suscripción: esta auditoría y la implementación se realizaron desde Codex con autenticación de ChatGPT, sin coste API añadido al backend.
- A suscripción: control diario complementario de arquitectura/costes en Codex, manteniendo el control determinista interno del backend como primera capa.
- Pendiente de migrar tras ciclos paralelos: autorrevisión nocturna de código.

No se declara falsamente migrado ningún proceso de producción: aún no existe evidencia de varios ciclos con sustituto.

## Ahorro estimado

- Ahorro confirmado inmediato de producción: USD 0/mes, porque la rama todavía no se ha desplegado ni ha completado ciclos de validación.
- Autorrevisión a suscripción: alrededor de USD 0,47/mes según el único ciclo identificable; puede subir cuando haya un hallazgo que obligue a devolver un archivo completo.
- Doble etapa de correo sin adjunto: techo observado de USD 10,17/mes para la primera llamada de las secuencias 4.6 → 5. El ahorro real será menor y solo puede declararse después de la prueba en sombra.
- Caché documental/nocturna: ahorro esperado pero todavía no cuantificable. La telemetría nueva permitirá medir `cacheCreationTokens` frente a `cacheReadTokens` por proceso y revertir si una ruta no reutiliza el prefijo.
- Escenario conservador tras P2: 10–20% de la línea base, USD 9,29–18,58/mes. Escenario de optimización profunda, condicionado a evals de correo, contexto y modelos: 15–35%, USD 13,93–32,51/mes. No son compromisos ni justifican reducir precisión financiera.
- Batch API puede reducir 50% el componente compatible que permanezca asíncrono y por API; no aplica a Telegram/Gmail en tiempo real.

## Pruebas realizadas

- `npm run typecheck`: correcto.
- `npm test`: 5/5 pruebas correctas (política, fallo cerrado y frontera única del gateway).
- `git diff --check`: correcto.
- Búsqueda estática: una sola aparición de `anthropic.messages.create`, dentro del gateway autorizado.
- Lectura real de costes: solo lectura, sin escribir celdas.
- No se hicieron llamadas de prueba a modelos de pago; se evitó aumentar el gasto para validar infraestructura que puede probarse determinísticamente.

## Riesgos y decisiones para Carlos

1. Elegir límite diario y mensual. Propuesta inicial conservadora: alerta al 70%, bloqueo al 100%, usando el percentil 95 de 14 días por proceso; no fijar cifras antes de contar con esa muestra.
2. Claude Code Max quedó elegido para la autorrevisión. Pendiente de Carlos: generar localmente el OAuth y guardarlo como secret de GitHub; nunca compartir el token en chat ni instalarlo en Railway.
3. Confirmar si existe ChatGPT Enterprise/Business con tokens de acceso para automatización confiable. Plus/Pro no debe tratarse como credencial de backend general.
4. Definir RTO: cuánto tiempo puede quedar sin IA el bot antes de activar respaldo API.
5. Confirmar si los correos automáticos pueden esperar una cola privada. Por defecto se mantienen en API por criticidad y latencia.
6. Validar retención y tratamiento de datos: usar un plan empresarial si documentos, correos y finanzas no deben entrar en condiciones de consumidor.
7. La protección antisolapamiento es por instancia. Si Railway escala a más de una réplica, hace falta un lock distribuido (Sheets/Redis/Postgres) antes de afirmar garantía global.
8. Los límites internos se basan en gasto ya registrado y pueden excederse por una llamada concurrente final; el límite duro del proveedor sigue siendo obligatorio.
9. `observe` es una excepción temporal para no romper producción durante la migración. El estado final requerido es `allowlist` y después `disabled`; desplegar sin fijar conscientemente `WOBI_AI_API_MODE` no debe darse por aprobado.
