# Tablero de trabajo en curso

Fuente única de verdad de **qué se está construyendo, en qué rama y quién lo lleva**. Existe porque el sistema crece con
varias sesiones a la vez (Claude Code y Codex) y el 03-10-2026 se llegó a 49 copias de trabajo y 247 ramas, con encargos
que describían un estado que ya no existía. Pedido de Carlos: crecer de manera ordenada.

## Reglas (para cualquier sesión, humana o de IA)

1. **Antes de empezar**: lee este tablero y `git fetch`. Si tu encargo cita una rama, un commit o una copia de trabajo,
   compruébalos; si no coinciden con la realidad, detente y dilo antes de tocar nada.
2. **Una fila por trabajo.** Añade tu fila al empezar (rama, área, quién, estado) y actualízala al terminar. Un trabajo que
   no está en el tablero no existe para los demás.
3. **Una sola sesión por área a la vez.** Las áreas son las de la tabla de abajo. Dos sesiones pueden avanzar en paralelo
   en áreas distintas, nunca en la misma.
4. **Rama nueva desde `origin/main` actual y copia de trabajo propia.** Nunca se continúa en una rama ya fusionada ni en
   la copia de trabajo de otra sesión. El checkout principal no se usa para construir.
5. **Cada capacidad nueva vive en su propia carpeta** (`core/seguros/`, `core/informes/`, `core/holded/automatizacion/`…).
   Los archivos centrales (`core/holded/write.ts`, `core/gastos/gastoCallbackHandler.ts`, `src/server.ts`,
   `core/jobs/revisarCorreoNuevo.ts`) solo reciben el punto de conexión; no se les añade lógica nueva.
6. **Lo que mueve dinero va en dos fases**: primero observación (sin escribir), después activo con la autorización
   escrita de Carlos para el caso concreto. La fusión de esos cambios la pulsa Carlos.
7. **Al fusionar**: borra la rama en GitHub, cierra la copia de trabajo y quita la fila del tablero (o pásala a «Hecho
   reciente»). Una rama fusionada que sigue viva es desorden.
8. **Un PR abierto más de 7 días** se decide: se fusiona, se cierra o se anota aquí por qué espera.

## Áreas

| Área | Carpetas principales |
|---|---|
| Conciliación y bancos | `core/holded/` (búsqueda de cargos, conciliaciones), `core/gastos/` |
| Automatización de Holded en servidor | `core/holded/automatizacion/`, `core/jobs/automatizacionHolded.ts` |
| Correo | `core/gmail/`, `core/jobs/revisarCorreoNuevo.ts` |

**Dueño único por área y día (Carlos, 08-10-2026).** Las áreas críticas están en `.github/areas-criticas.json`. El CI rechaza un PR nuevo que toque un área mientras otro PR abierto más antiguo la toca (`scripts/ci/colision-de-area.mjs`); el PR antiguo tiene prioridad. Para aceptar una colisión a sabiendas, Carlos pone la etiqueta `colision-aceptada`. Antes de empezar en un área: mirar los PR abiertos y esta tabla; si hay otro, coordinar o esperar.

**Banco de casos reales (`core/gmail/automatico/casos/`).** Cada correo que bloqueó la revisión queda como caso de extremo a extremo (sin IA) con el informe que debe salir. Al cerrar un incidente de correo, añadir su caso al banco en el mismo PR.
| Documentos y conocimiento | `core/documental/`, `core/knowledge/`, `core/drive/` |
| Seguros | `core/seguros/` |
| Soportes (pedir comprobantes a quien gastó con la tarjeta) | `core/soportes/` |
| Cashflow | `core/google/`, `core/cashflow/` |
| Informes | `core/informes/`, `core/reportes/` |
| Cerebro (front) | `frontend-cerebro/`, `core/cerebro/` |
| Infraestructura | `core/telegram/`, `core/ai/`, `core/utils/`, `src/server.ts` |

## En curso

Saludos y Marin: PR #470 fusionado y desplegado en 985f365; panel y voz verificados, trabajo cerrado.

Alertas de saldos API: Codex, `codex/alertas-saldos-api`, Control diario. Avisos OpenAI/Anthropic, sin recargas. Lecturas confirmadas con fecha y consumo WOBi por proveedor; sin presentar estimación como saldo directo.
Voz Marin: Codex, `codex/voz-marin`, Cerebro/audio. PR #463 fusionado; b908bc2 desplegado SUCCESS. Recarga automática apagada por Carlos. Producción: saludo coincide, MP3 200 Marin y PCM 200 Marin/24 kHz, health 200. Evidencia local output/voz-marin/produccion.json. Trabajo cerrado.

| Trabajo | Área | Rama | Quién | Estado |
|---|---|---|---|---|
| Enjambre del panel conectado a la voz | Cerebro / visual | codex/wobi-enjambre-voz | Codex | En curso: partículas visibles del panel siguen la amplitud real de Marin. |
| Conversación cotidiana e identidad de sesión | Cerebro / navegador | codex/wobi-dialogo-identidad | Codex | PR #471 fusionado; Carlos verificado en el panel de producción. |
| Dictado revisable y cancelación clara de borradores | Cerebro / pedidos | codex/wobi-corregir-dictado | Codex | PR #472 fusionado y desplegado en cd180712; Corregir y Cancelar visibles en producción, flujo local verificado. |
| Navegador inteligente: front, voz y enjambre | Cerebro (front) | codex/navegador-texto | Codex | PR #433: contrato #434, tres cabeceras, permisos confirmados, voz existente y amplitud real del enjambre. Pruebas completas verdes: 2111 backend (6 omitidas), 67 adicionales; voz PCM real y backend verificados en producción. Dictado según navegador, voz y enjambre por amplitud. PR #433 listo para CI y despliegue. |
| Recuperar colores de áreas del Núcleo | Cerebro (front) | codex/colores-areas | Codex | Verificado: 51 pruebas front, typecheck, build y navegación en tres compañías/móvil; colores originales y transparencia solo en agentes previstos. |
| Área Procesos y estado visual de áreas conectadas / pendientes | Cerebro (front) | `codex/area-procesos` | Codex | Verificado: 51 pruebas del front, typecheck, build y navegación del build compilado. Reserva del futuro subagente; estados visuales según las fuentes, sin cambios de backend. [PR #430](https://github.com/gorawgroup-sketch/wobagroup-assistant/pull/430), pendiente de revisión. |
| Seguros v2: actividad, programación, calendario de pagos y avisos | Cerebro (front) | `codex/seguros-panel-v2` ([PR #425](https://github.com/gorawgroup-sketch/wobagroup-assistant/pull/425)) | Codex | PR abierto para Carlos, pruebas, tipos y build locales en verde; #363 y #421 fusionados, contrato verificado en producción (5 tareas, 6 pagos, bitácora aún vacía). Solo lectura; sin auto-merge. Actualizado con main y #426: hora individual de entrega y marca de texto recortado incorporadas. |
| Panel de Seguros del Núcleo (P1–P7) | Cerebro (front) | `codex/seguros-panel` ([PR #363](https://github.com/gorawgroup-sketch/wobagroup-assistant/pull/363)) | Codex | Abierto para revisión, sin fusionar; solo frontend, pruebas y verificación en vivo. |
| Lecturas de fuentes de Cerebro bajo la cola de Sheets | Cerebro (front) | [PR #330](https://github.com/gorawgroup-sketch/wobagroup-assistant/pull/330) | Codex | Fusionado y desplegado el 04-10-2026; durante la observación las 20 fuentes siguieron completas y frescas. |
| Sonda de Sheets bajo carga de fondo | Cerebro (front) | [PR #334](https://github.com/gorawgroup-sketch/wobagroup-assistant/pull/334) | Codex | Fusionado el 04-10-2026; Railway y comprobación bajo carga pendientes de completar. Usa la reserva interactiva del regulador para evitar falsos timeouts. |
| Núcleo fluido: áreas, búsqueda documental y Telegram Web | Cerebro (front) | `codex/wobi-nucleo-vivo`, [PR #320](https://github.com/gorawgroup-sketch/wobagroup-assistant/pull/320) | Codex | Implementado y probado en copia aislada; publicación tras verificar la sonda de Sheets y los flujos existentes. [Alcance](wobi-nucleo-vivo.md) |
| Puente automático de recibos con varios pagos (fase 1, observación) | Conciliación y bancos | _sin rama todavía_ | Claude Code | Pendiente de empezar. La conciliación múltiple en divisa y reanudar lote ya están en `main` (#313–#317). Los pares emparejados se guardan en un registro aparte, no como columna nueva de `_gastos_pendientes`
| Archivo con una orden en el pie (foto o documento + «envíale un correo a…») que sigue por el chat, y correos con copia (Cc) en los borradores | Infraestructura / Correo | feat/instruccion-en-pie-de-documento | Claude Code | `core/telegram/entradaArchivoConOrden.ts` (hermano de `voiceInput.ts`) + `core/documental/instruccionEnPie.ts`; `cc` en `proponer_envio_correo` y en el envío. Caso: cuadro de impuestos 3T de Footprint (15-10-2026). |
| Aviso diario de lotes de copias bancarias (el agregador reimporta movimientos de golpe; solo lectura, un aviso por lote) | Conciliación y bancos | feat/aviso-duplicados-bancarios | Claude Code | Se añade a `core/holded/duplicadosBancarios.ts` (que ya evita ofrecer la copia pendiente de un conciliado) + `core/jobs/duplicadosBancarios.ts` + `/admin/duplicados-bancarios`; ver `docs/duplicados-bancarios.md`. |
| Propuesta diaria de pagos a colaboradores en divisa (gasto «Monthly fee» ↔ transferencia; solo propone con botón) | Conciliación y bancos | feat/propuesta-pagos-colaboradores | Claude Code | `core/holded/pagosColaboradores.ts` + job laborables 10:30 + `/admin/pagos-colaboradores`. Sin IA. |
| Lectura completa del correo (remitente original en cadenas, mensaje nuevo sin citas, adjuntos y lista de peticiones con una acción cada una) | Correo | _sin rama todavía (paso 3)_ | Claude Code | Pasos 1 (#383) y 2 (#386) hechos el 07-10-2026; falta el paso 3: que la revisión automática use la misma lectura. Carlos dio el visto bueno el 07-10-2026. En 3 PR: (1) remitente original y cadenas + quitar el recorte de 8.000 caracteres del clasificador, sin IA; (2) peticiones y adjuntos en la cola manual; (3) revisión automática y directorio de personas. Carpeta propia `core/correo/lectura/`; los archivos centrales (`classifyEmail.ts`, `revisarCorreoNuevo.ts`) solo reciben el punto de conexión. Una sola sesión en el área Correo mientras dure. Medir el coste de IA antes de activar. |

### Hecho reciente

| Trabajo | PR | Fecha |
|---|---|---|
| Lote de conciliaciones: varios pares gasto↔cargo con un solo botón sobre el motor de conciliación múltiple (`core/holded/loteConciliaciones/`, herramienta `proponer_lote_conciliaciones`; EUR exacto) | #519 | 16-10-2026 |
| Cargo mayor en divisa sin editar el gasto ni pedir ajustes de tasa (la diferencia de cambio queda en el resto del cargo), gasto bancario del resto con aprendizaje (`core/holded/conciliarSinSoporte.ts`, modo «resto»; si el periodo está cerrado no se crea nada y el resto queda para ajustarlo a mano) y `/admin/proponer-accion` para proponer el cierre de un cargo sin soporte. Verificado en Holded con 14 pares de Footprint (16-10-2026) | #521, #523-#526 | 16-10-2026 |
| Conciliación múltiple: aprobar un plan con origen (declaración firmada) y un solo cargo ya no se rechaza; `comprobarAntesDeEscribir` usa el mismo `unico` que `preparar`. Verificado: 0 planes de producción afectados; desplegado en 0a3daab | #520 | 16-10-2026 |
| Auditoría diaria de cargos exactos no ofrecidos (8:45), correo a una audiencia con registro de audiencias, seguimiento de respuestas (9:20/16:20), solicitud de datos faltantes al creador del gasto (9:05/15:05) y lote de impuestos al cashflow desde el chat (`proponer_lote_impuestos_cashflow`, `leer_adjuntos_de_correo`) | #479, #486, #493, #495, #498, #499, #507 | 14-10-2026 |
| Adjuntos de Holded (sin PUT sin cambios, tope por compra, detector diario, reposición de 10 comprobantes, candado estructural) y cierre automático de contactos/compras inciertos antiguos (cron 8:40) | #474, #475, #476, #477 | 13-10-2026 |
| Filas retiradas del tablero por estar fusionadas: navegador (interpretación, destinos de Seguros, conversacional E1), pedidos al procesamiento de Telegram, Proyectos de Holded, lista aprobada de tickets, transferencias internas, cambio de proveedor, conciliación parcial, reglas de cashflow, `/conocimiento`, documentos de Seguros y avisos completos | #306, #319, #324, #327, #336, #356, #396, #424, #426, #434, #437, #444, #450 | 14-10-2026 |
| Bitácora de Wobi Seguros (qué hizo y cuándo): `bitacora`, `programacion`, `calendarioPagos` y `calendario` en el contrato de Cerebro, herramienta `ver_actividad` del especialista y encargo v2 para el front (`core/seguros/bitacora/`) | #421 | 08-10-2026 |
| Lectura inicial de las condiciones de las pólizas vigentes: 19 documentos de Drive integrados (1,99 US$, una vez), todos enlazados a su póliza (§29 de `docs/wobi-seguros.md`) | — (datos) | 08-10-2026 |
| Calendario de pagos de Wobi Seguros: evento en el calendario de Carlos 3 días antes, aviso a 1-3 días con comprobación de caja y siguiente pago de la serie al confirmarse un cobro (`core/seguros/pagos/`, job 8:55) | #368 | 08-10-2026 |
| Botones de propuesta de correo: editan el mensaje pulsado cuando el id guardado falta y «Dar instrucciones específicas» manda la petición aparte si no puede editar (caso 12-10, respuesta de German) (`core/gmail/emailCallbackHandler.ts`) | #455 | 12-10-2026 |
| Respuesta a la solicitud de soportes: el lector solo miraba el cuerpo sin citas y perdía las anotaciones que la persona escribe junto a cada fila de la tabla citada («ENVIADO», «REENVIADO COMO …», «NO LO ENCUENTRO»); ahora recibe también la tabla citada (caso Kelly 14-10) | #502 | 14-10-2026 |
| Cola de correo: si el dato que falta ya se le pidió al creador (solicitud registrada), el correo activo queda aparcado y la cola sigue (caso Kelly / Crepes & Waffles); avisos de tickets con acción clara (qué pasará, nada que hacer) y aviso por cada conversión real | #497 | 14-10-2026 |
| Ajuste automático de la tasa cuando gasto y cargo están en la misma moneda extranjera (recibo USD pagado desde la cuenta USD): la compra toma la tasa contable del cargo y no queda «parcial» (Airbnb 495,13 y 309,74 USD) | #496 | 14-10-2026 |
| Periodo contable cerrado: «Sí, usar hoy» creaba sin conciliar y la pregunta buscaba el cargo cerca de hoy (tasa 8 €, Airbnb 495,13 USD); ahora concilia contra el cargo ya identificado y la pregunta usa la fecha del cargo | #494 | 14-10-2026 |
| Operación automática «incierta, sin compra registrada» que bloqueaba el correo sin salida (Airbnb 309,74 USD): si el registro durable demuestra que la escritura nunca empezó, se cierra como rechazada y el correo queda libre (`operacionAnterior.ts`, `leerHechosCierre`) | #491 | 14-10-2026 |
| Pregunta de conciliación repuesta con identificador nuevo: tras un «Sí, conciliar» sin resultado, el mismo id en el mismo mensaje hacía que cada pulsación respondiera «ya fue procesada» (entrega durable por usuario+mensaje+acción) | #490 | 14-10-2026 |
| Conciliación tras crear: los nombres del documento viajan a la pregunta «¿conciliar?» y a «Sí, conciliar» (columna O en `_conciliaciones_pendientes`, última columna derivada); al elegir con aviso, cargos exactos de nombre desconocido hasta 5 días | #488 | 14-10-2026 |
| «Vuelve a proponer el correo de X»: levanta el descarte del operador y reprocesa (`volver_a_proponer` en `revisar_correo_puntual`, `retirarGastoDescartadoPorOperador`); antes el mensaje decía «dímelo por chat» sin mecanismo | #487 | 14-10-2026 |
| «Vuelve a proponer el correo de X»: levanta el descarte del operador y reprocesa (`volver_a_proponer` en `revisar_correo_puntual`, `retirarGastoDescartadoPorOperador`); antes el mensaje decía «dímelo por chat» sin mecanismo | #487 | 14-10-2026 |
| Norma «crecer ordenado» (buscar antes de construir, una decisión un dueño, sin contradicciones, todo registrado) en principios + CLAUDE.md; sección «Operación desde el servidor» en el manual con todos los puntos `/admin/*` existentes | #485 | 14-10-2026 |
| Cargo reconocido por los nombres del documento, no solo por el emisor (tasa turística Italianway/Queen Home 8 €): campo `nombres_en_documento` en ambos extractores, `nombresAlternativos` en el buscador de cargos y en la propuesta persistida (columna AF, última columna derivada de HEADERS) | #484 | 14-10-2026 |
| Reenvío de la declaración: un correo indicado por Carlos ya no bloquea («envíaselo a german@eworkstudio.com» daba «no hay declaración pendiente»): se localiza por nombre y la dirección se AÑADE al correo registrado como segundo destinatario (Carlos: «deja los 2 mails») | #465 | 12-10-2026 |
| Reenvío de la declaración: la herramienta exigía correo o id y falló en 0 ms cuando Wobi la llamó con «German»; ahora localiza sola la declaración pendiente por nombre, empresa o única pendiente, y registra la entrada al fallar | #462 | 12-10-2026 |
| Declaración de gastos sin soporte: el almacén de borradores escribía y leía 13 columnas (perdía el adjunto y el id de la declaración: correo a German sin documento el 12-10); última columna derivada de HEADERS + reenvío genérico con disculpa y adjunto en el mismo hilo (`core/soportes/declaracion/reenviarDeclaracion.ts`, herramienta `reenviar_declaracion_gastos_sin_soporte`) | #461 | 12-10-2026 |
| Declaración de gastos sin soporte, paso C: con la declaración firmada, botón «Aplicar como soporte» que adjunta el documento a los gastos existentes y propone los nuevos con la declaración como comprobante; plantilla genérica de Footprint (`core/soportes/declaracion/aplicarDeclaracion.ts`) | #459 | 12-10-2026 |
| Declaración de gastos sin soporte, paso B: detección de la respuesta firmada en el hilo (botón de confirmación, Drive, estado «firmada»), reserva del hilo en el flujo automático y recordatorio propuesto tras N días (`core/soportes/declaracion/firmaDeclaracion.ts`). Paso C (soporte en Holded) pendiente | #457 | 12-10-2026 |
| Declaración de gastos sin soporte, paso A: plantilla de la empresa rellenada, Drive, registro `_declaraciones_sin_soporte`, borrador con adjunto y herramienta `preparar_declaracion_gastos_sin_soporte` (`core/soportes/declaracion/`). Pasos B (seguimiento de la firma) y C (soporte en Holded) pendientes | #456 | 12-10-2026 |
| Incidencia #7: notificaciones de la AEAT/TGSS (sanción, apremio, requerimiento, liquidación, embargo) nunca son gasto, regla determinista en el procesado de documentos y en el analizador automático (`core/documental/notificacionTributaria.ts`) | #441 | 10-10-2026 |
| Sincronización bancaria: al cierre de las 09:45 las cuentas que siguen «solicitadas» pasan a «no confirmado» y entran en el aviso (caso 10-10: 5 cuentas conectadas sin sincronizar y sin aviso) (`core/holded/automatizacion/sincronizacionBancaria.ts`) | #438 | 10-10-2026 |
| Incidencia #6: el aviso «Hubo un error revisando el correo» dice ahora la causa y el último punto alcanzado (`core/jobs/revisionCorreoManual.ts`) | #436 | 10-10-2026 |
| Cargo conciliado enlazado a este mismo gasto (ticket invisible en /purchases, número distinto): se sigue el cargo hasta su compra y se dice «ya registrado» (`core/gastos/gastoYaRegistradoPorCargo.ts`, caso Anthropic VJCCOFZT-0016) | #427 | 08-10-2026 |
| Botón «Crear el gasto ahora, sin conciliar» cuando el único cargo parecido ya está conciliado (caso Anthropic) + guarda contra el aviso duplicado (`core/gastos/procesarGastoEntrante.ts`, `gastoPendienteDatosCallbackHandler.ts`) | #423 | 08-10-2026 |
| Informe por diferencias (`core/gmail/automatico/informeDiferencias.ts`): cada revisión dice qué cambió desde la anterior (resueltos, nuevos, cambios de motivo, iguales) antes de la lista completa; resumen por correo guardado en `wobi_mail_events` (`revision_resumen`) | #418 | 08-10-2026 |
| Revisión en seco tras cada despliegue (`core/gmail/automatico/revisionEnSeco.ts`): simulación sin IA ni escrituras unos minutos después de arrancar con versión nueva, comparación por correo con la anterior y aviso solo si empeora; `WOBI_MAIL_DRY_RUN=off` la apaga | #416 | 08-10-2026 |
| Cero motivos genéricos en el informe del correo automático: cada código con explicación concreta, comodín que nombra el motivo, guardarraíl `core/guardarrailes/motivosSinGenericos.test.ts`; aviso veraz del correo activo sin pregunta (`core/jobs/revisionCorreoManual.ts`) | #415 | 08-10-2026 |
| Dueño único por área (guardarraíl de colisión en CI, `.github/areas-criticas.json`) + banco de casos reales de extremo a extremo del correo automático (`core/gmail/automatico/casos/`) | #412 | 08-10-2026 |
| Norma de resolución autónoma centralizada: módulo `core/ia/normaResolucionAutonoma.ts` inyectado en Wobi, Seguros y extractores + guardarraíl de cobertura + docs/norma-resolucion-autonoma.md (primera aplicación: moneda sin cuenta propia, #404) | #405 | 08-10-2026 |
| Correo activo con la pregunta en `_gastos_pendientes_datos` (caso Lunch 180 MXN) + la verificación fallida del analizador ya no se guarda como «incompleto» (v24) + diagnóstico de respuestas rechazadas (`core/gastos/reenviarPreguntaPendiente.ts`, `core/gmail/automatico/analyze.ts`) | #397 | 07-10-2026 |
| Incidente 07-10: imágenes de relleno «noname» como adjuntos y aviso de propuesta pendiente repetido sin freno (`core/correo/lectura/decoracion.ts`, `core/gastos/avisoPropuestaPendiente.ts`) | #389 | 07-10-2026 |
| Pedir soportes a quien gastó con la tarjeta: CSV de Revolut → resumen por persona → un correo por titular (cuadro + enlace a su hoja de Google compartida, direcciones del buzón, regla fija en el prompt) | #370, #371, #372, #373 | 06/07-10-2026 |
| `/preguntas` con un botón por pendiente y búsqueda tolerante | #374, #376 | 06-10-2026 |
| Casa Peppe: tasa COP robusta, teclado en el mensaje pulsado, tasas en paralelo | #375, #377 | 06-10-2026 |
| Banco: una copia «pendiente» de un cargo ya conciliado solo se ofrece «por confirmar» con aviso de posible duplicado (nunca se recomienda ni se concilia sola); proveedor recurrente: si todos los exactos son de otra fecha, gana el aproximado del mismo día (Anthropic 13/10 conciliado contra el duplicado del 08/10) | #506 | 14-10-2026 |
| «Proceder» en la respuesta a soportes: la acción sugerida pide PRIMERO el correo (proponer_envio_correo, mismo hilo) y la declaración, y deja las conciliaciones al flujo de gastos (el modelo agotaba sus pasos conciliando y nunca proponía el correo); `/admin/proponer-accion` admite proponer_envio_correo y preparar_declaracion_gastos_sin_soporte | #506 | 14-10-2026 |
| Lectura completa del hilo de correo: si el último mensaje del hilo no trae adjuntos y uno anterior trae un comprobante sin procesar (ni registrado, ni descartado, ni archivado), la cola procesa ese mensaje conservando la identidad del hilo (`core/gmail/mensajeConAdjuntosDelHilo.ts`, `listarMensajesDeHilo`). Caso RODOAR: factura a las 11:57, acuse «Recibido» a las 17:49 sin adjunto → se proponía «sin comprobante» | #508 | 14-10-2026 |
| `/preguntas` también reenvía los borradores de correo pendientes (respuesta y declaración de gastos sin soporte) con sus botones reales, y el borrador pasa a apuntar al mensaje nuevo (`core/gmail/reenviarBorradorCorreo.ts`). Caso: Carlos borró por error los mensajes de Kelly | #510 | 14-10-2026 |
| `/admin/proponer-accion` admite `conciliar_movimiento_bancario` (pregunta «Conciliar con #1» con botón; caso Rodoar: compra F20269 ya registrada en agosto y pago del 14-10 sin conciliar) | #511 | 15-10-2026 |
| `/admin/proponer-accion` admite `conciliar_multiples_movimientos_bancarios` (desglose con botón «Confirmar conciliación múltiple»; caso German 167,65 € = 4 cargos en Euros EWKS) | #512 | 15-10-2026 |
| Declaración firmada = un gasto por el total + conciliación múltiple de todos sus cargos (paso C rediseñado sobre `conciliacionMultiple`: localizador de cargos en el banco, compra del total, plan con origen, conciliación planificada en la propuesta de gasto, publicación única del desglose) | #513 | 15-10-2026 |
| Herramienta `aplicar_declaracion_firmada`: la frase «aplica la declaración firmada de X» que el sistema sugería no tenía herramienta (German, 15-10); localiza la firmada por titular y propone el paso C o la cierra | #514 | 15-10-2026 |
| «Aplica la declaración firmada de X» por nombre: el selector de declaraciones solo miraba generada/enviada; ahora admite estados (`seleccionarDeclaracionPendiente(..., ["firmada"])`) | #515 | 15-10-2026 |
| Respuesta a soportes «ya lo envié» sin adjunto: se localiza el correo anterior de la persona y su gasto registrado (por importe o asunto citado) y se propone conciliar/procesar en vez de volver a pedir el recibo; cargos sin recibo → declaración de gastos sin soporte | #504 | 14-10-2026 |
| Proveedor recurrente (Anthropic 13/10): un cargo conciliado de otra fecha ya no bloquea como «posible duplicado» (solo ≤2 días); botones de la verificación con rótulos que dicen qué hacen | #503 | 14-10-2026 |
| Respuesta a la solicitud de soportes: lectura completa y una acción por cargo | #378 | 07-10-2026 |
| Cerrar cargos sin soporte (par cargo+reembolso sin gasto; gasto sin soporte conciliado) | #379 | 07-10-2026 |
| Lectura de la cadena del correo, paso 1: remitente real, mensaje nuevo sin citas ni firma, sin recorte de 8.000 caracteres (`core/correo/lectura/`) | #383 | 07-10-2026 |
| Orden: tablero al día y lógica nueva fuera de `gastoCallbackHandler.ts` | #382 | 07-10-2026 |
| Cashflow: filtro «solo ingresos / solo gastos» al proponer, verificar y comparar lo que falta (`core/cashflow/filtroTipoMovimiento.ts`) | #387 | 07-10-2026 |
| Lectura completa del correo, paso 2: lista de peticiones con una acción cada una y adjuntos (Word/Excel sin IA; PDF e imágenes con visión acotada) en el análisis de la cola manual | #386 (+ #385) | 07-10-2026 |

## Pendiente de decisión de Carlos

| Qué | Dónde | Desde | Nota |
|---|---|---|---|
| Distinguir conciliación confirmada de ajuste de cambio pendiente | PR #221 `codex/fx-residual-status` | 28-09-2026 | Abierto sin decidir |
| Saldos residuales tras conciliación multimoneda | PR #219 `codex/fix-fx-residual-reconciliation` | 28-09-2026 | Abierto sin decidir |
| Aplazar un gasto y continuar la cola de correo | PR #217 `codex/skip-pending-email` | 28-09-2026 | Abierto sin decidir |
| Ramas con PR cerrado sin fusionar | `claude/fix-env-loading`, `codex/wobi-seguros-reviewed`, `feat/gasto-siempre-y-soporte-eml`, `fix/desambiguacion-confianza-en-usuario`, `fix/eml-equivalente-eur` | septiembre | ¿Se descartan? |
| Ramas sin PR | `codex/claude-max-worker`, `codex/wobi-microfono-continuo`, `fix/descartar-gasto-pendiente-datos` | septiembre | ¿Se retoman o se descartan? |
| Checkout principal con cambios sin guardar | `/Volumes/Seagate Backup Plus Drive/apps/WOBA_Copilot`, rama `codex/holded-proyectos` (33 archivos modificados, 37 nuevos, desde el 27-09) | 27-09-2026 | Inventariado el 04-10 (solo lectura): ver [inventario](mantenimiento/inventario-checkout-principal-2026-10-04.md). Decidir: respaldar en una rama, portar Proyectos de Holded y la clasificación contable contextual, y limpiar. No se ha tocado nada |

## Mantenimiento

- Limpieza del 03-10-2026: 217 ramas fusionadas borradas de GitHub (lista y cómo recuperarlas en
  [mantenimiento/ramas-eliminadas-2026-10-03.md](mantenimiento/ramas-eliminadas-2026-10-03.md)), 167 ramas locales
  idénticas borradas, 18 copias de trabajo cerradas (10 que ya no existían en disco y 8 limpias y fusionadas).
- No se tocó ninguna copia con cambios sin guardar ni las que gestionan las aplicaciones de Claude (`.claude/worktrees/`)
  y Codex (`~/.codex/worktrees/`): las limpia cada aplicación.
- Railway despliega solo desde `main`; borrar ramas fusionadas no afecta a producción.
- La copia `.worktrees/mail-auto-integration` guarda la instalación completa de `node_modules` que enlazan otras copias:
  no cerrarla sin reinstalar antes en otro sitio.

## Navegación precisa de Seguros (10-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Vistas exactas de pagos pendientes, renovaciones y actividad; solo lectura | `codex/seguros-navegacion-precisa` | Cerebro front / Seguros | Codex | Implementado desde #437. 68 pruebas front, tipos y build verdes; router compilado + navegador real: 9 destinos, compañía/grupo, permisos, fechas no soportadas, null, voz/enjambre y móvil correctos. PR #440. #439 integrado desde main; npm test: 2123 pruebas backend y 75 adicionales, cero fallos. #440 fusionado y desplegado: Railway SUCCESS/RUNNING del commit 200476f; assets y tres destinos, compañía/grupo, voz/enjambre verificados en producción. |

## Navegador: micrófono visible (10-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Micrófono visible y respuestas habladas de cortesía y ayuda, con pruebas de órdenes mixtas | `codex/navegador-seguros-destinos` | Front / navegador | Codex | Verificado: tipos, build, suite completa previa y 62 pruebas del front tras el cambio; navegador real confirma dictado revisable y saludo sin navegación. PR #435: micrófono y cortesía, panel lateral sin modal; verificado en escritorio/móvil y reacción del enjambre al audio y al silenciar. Destinos filtrados requieren ampliar contrato con Claude Code. |

## Voz: conversación y envío fluido (10-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Saludos con el nombre al final y envío automático al terminar de hablar | `codex/voz-interaccion-fluida` | Front / navegador | Codex | Implementado desde main; npm test (2128 backend, 79 adicionales, cero fallos), tipos y build verdes. Chrome con router real y reconocimiento simulado: saludo y destino automáticos, cancelación, permiso de micrófono, rechazo de Finanzas, audio/enjambre, movimiento reducido y móvil correctos. PR #442; main integrado con #441 y verificación de expansión del dibujo durante audio (+9,5% en la prueba). #442 fusionado y desplegado: 3715c3c SUCCESS/RUNNING, saludo, audio real y expansión verificados. Interpretación abierta con modelo requiere contrato de Claude. |

## Integración conversacional E1 (11-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Conectar /conversar, contexto de sesión y resumen hablado con calidad de lectura | `codex/navegador-conversacional-front` | Front / navegador | Codex | Verificado desde main #443/#444: npm test (2159 backend pasan, 6 omitidas; 86 adicionales), tipos y build verdes. Chrome contra router compilado: contexto, tres destinos de Seguros, lectura completa/incompleta/no consultable, reinicio, permisos, voz/enjambre y móvil. Sin cambios en core/ ni src/, sin IA nueva ni escrituras. PR #445 fusionado y desplegado: 8cd5acc SUCCESS/RUNNING; cuatro consultas en producción con lectura completa, voz HTTP 200 y enjambre/silenciar correctos. |

## Ayuda conversacional y consulta de costos (11-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Reconocer ayuda genérica con variaciones naturales sin absorber consultas concretas | `codex/ayuda-conversacional` | Front / navegador | Codex | PR #446 fusionado y desplegado: ddb763d SUCCESS/RUNNING; ayuda y presentación verificadas en producción con voz HTTP 200 y reacción del enjambre. suite completa anterior sin fallos, front final, tipos y build verificados antes de publicar. «Costos de hoy» requiere ampliación del contrato por Claude, con aclaración entre contabilidad y operación de WOBi; encargo en docs/encargo-navegador-costos.md. No se calcula ni inventa en el front. |

## Derivación a Telegram (11-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Abrir chat de WOBi ante operaciones explícitas con aviso hablado y petición copiable | `codex/derivacion-telegram` | Front / navegador | Codex | Verificado: npm test (2159 backend pasan, 6 omitidas; 91 adicionales), tipos/build y Chrome contra router compilado: voz/enjambre, destino fijo sin opener, petición preservada, bloqueo con alternativa y navegación interna intacta. Sin envío automático ni cambios de backend. PR #447 fusionado y desplegado: 62232d0 SUCCESS/RUNNING, apertura real del chat y voz HTTP 200 verificados; sin envío de mensajes. |

## Nombre dictado de WOBi (11-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Corregir Guapi como vocativo y orientar preguntas sobre operaciones con oferta contextual de Telegram | `codex/dictado-nombre-wobi` | Front / voz | Codex | Verificado: npm test (2159 backend pasan, 6 omitidas; 96 adicionales), tipos/build y Chrome con dictado simulado: nombre corregido, saludo/voz/enjambre, oferta de Telegram y sí contextual. Sin modificar el motor de reconocimiento ni el backend. Publicación pendiente. |

| Orientación de revisión de estados financieros hacia Telegram | codex/orientacion-financiera | Front / navegador | Codex | PR #449 fusionado y desplegado: 8ba6685 SUCCESS/RUNNING; orientación, voz, enjambre y solicitud preservada verificados. Sustituido para dispositivos vinculados por el panel del contrato #450. |

## Panel de pedidos desde el front (11-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Borrador, confirmación, vínculo y seguimiento del contrato #450 | `codex/pedidos-front` | Front / navegador | Codex | Implementado desde main #450. npm test: 2182 backend pasan, 6 omitidas; 109 adicionales. Front final: 103/103. Tipos y build completos verdes; Chrome con router/coordinador durable reales y repositorio de prueba: identidad sin vínculo, borrador/hash, doble clic, respuesta perdida, recarga, estados, incierto, historial como texto, dictado/voz/enjambre, apagado y móvil. Capturas en docs/evidencias/pedidos-front/. Sin cambios en core/ ni src/. Prueba real vinculada pendiente de Carlos. |

| Recuperar el panel ante referencia inexistente (404 pedido_no_encontrado) | `codex/pedido-referencia-caducada` | Front / pedidos | Codex | Limpia la referencia y el seguimiento al montar o consultar; permite una solicitud nueva. Sin cambios de backend. Prueba de regresión de 404 y conservación en otros fallos. |

## Costos reales y salida a Telegram (12-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Responder desde Control diario y derivar consultas financieras no soportadas al chat | `codex/costos-reales-telegram` | Front / navegador | Codex | Verificado: tipos, build completo (Chrome local para PDF), 2182 pruebas backend + 115 adicionales y 108 front; front compilado reproduce las dos frases de las capturas con lectura real conservada de Control diario. Publicación en PR #454; seguimiento de fusión y despliegue en ese PR. |

Envío directo y orientación hablada: Codex, `codex/envio-directo-wobi`, Front/navegador-pedidos. Un único botón de envío junto a la consulta; conservar audio y referencia durable.

## Saldos API compactos (12-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Saldos cerrados por defecto, indicadores visibles y edición desplegable | `codex/saldos-compactos` | Front / saldos API | Codex | Tipos y build completos verdes, 109 pruebas del front y Chrome compilado: cierre inicial, expansión, formularios ocultos, controles oscuros y móvil sin desbordamiento. PR #467 fusionado y desplegado: 74f735a SUCCESS, front/CSS y salud HTTP 200. Rama y worktree cerrados. |

## Panel de WOBi esencial (12-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Micrófono al principio, opciones secundarias y pedidos terminados recogidos | `codex/wobi-panel-compacto` | Front / navegador-pedidos | Codex | Tipos y build completos verdes; 109 pruebas del front. Chrome compilado verifica micrófono primero y fijo, ayuda/áreas/pedido terminado recogidos, dictado, envío único, seguimiento e incertidumbre visibles y móvil. PR #468 fusionado y desplegado: 72836a5 SUCCESS, front/CSS y salud HTTP 200; rama y worktree cerrados. |

## Continuidad de Marin en móvil (12-10-2026)

| Trabajo | Rama | Área | Responsable | Estado |
|---|---|---|---|---|
| Recuperar audio interrumpido al usar el micrófono y evitar cortes de red en móvil | `codex/voz-movil` | Front / reproducción de voz | Codex | 114 pruebas front, tipos y build completos verdes. Núcleo compilado y WebAudio real: tres turnos táctiles con PCM Marin existente, red lenta, recuperación automática y manual sin regenerar; micrófono simulado, sin teléfono físico. Seguimiento del despliegue en el PR de esta rama. |
