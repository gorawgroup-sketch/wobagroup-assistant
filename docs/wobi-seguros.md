# Wobi Seguros — diseño propuesto

**Estado (actualizado 2026-09-27): parcialmente implementado** — el registro real de pólizas y su tarjeta en Cerebro ya existen y están cargados con datos reales (ver §19). El sub-agente especialista (§6.5), el extractor documental (§6.1) y el job de gestión continua (§6.4) siguen siendo diseño, no código. Este documento nació como propuesta de arquitectura y ahora también documenta lo que ya se construyó — no asumas que todo lo demás sigue siendo solo teoría, revisa §19 primero.

**Arquitectura elegida (2026-09-18):** sub-agente especialista invocado por una tool desde el mismo Wobi, no un bot aparte — un único hilo de conversación para Carlos. Las preguntas de seguros que requieren interpretación o investigación (no solo consultar un dato) se resuelven con una llamada a Claude aparte, con su propio prompt y sus propias herramientas (incluida investigación). El mecanismo completo está en §6.5. Las partes deterministas — registro, caja disponible, recordatorios de pago — NO pasan por el sub-agente: siguen siendo tools normales del registro principal, igual que el resto de Wobi hoy.

**Arquitectura elegida (2026-09-18):** sub-agente especialista invocado por una tool desde el mismo Wobi, no un bot aparte — un único hilo de conversación para Carlos. Las preguntas de seguros que requieren interpretación o investigación (no solo consultar un dato) se resuelven con una llamada a Claude aparte, con su propio prompt y sus propias herramientas (incluida investigación). El mecanismo completo está en §6.5. Las partes deterministas — registro, caja disponible, recordatorios de pago — NO pasan por el sub-agente: siguen siendo tools normales del registro principal, igual que el resto de Wobi hoy.

## 1. Por qué

Hoy no existe ningún módulo de seguros en el código (confirmado por grep de `seguro|poliza|póliza|insurance|aseguradora|prima` en todo `core/` — cero archivos dedicados), pero el tema ya está presente y disperso:

- `docs/calendario_fiscal.json` ya trackea a mano **5 pólizas de WOBA** (etiquetadas `empresa: "BAE"`, `empresaHolded: "WOBA"`): `seguro_coche` (Pelayo, agosto), `seguro_moto` (Pelayo, mayo), `seguro_piso_perez_lavid` (Pelayo, febrero), `seguro_showroom` (Allianz, marzo), `seguro_markel` (Markel, RC, abril). `core/jobs/revisarAlertasFiscales.ts` avisa 2 días/1 día/mismo día antes del vencimiento; `core/fiscal/pagoRecurrenteCallbackHandler.ts` ofrece un botón para registrar el gasto en Holded.
- **Footprint tiene al menos una póliza real que no está en ningún registro**: movimiento bancario real verificado en `output/seguimiento-comprobantes/footprint/2026/fuentes/revolut-input.json` — Markel Insurance SE, "Poliza 026S00905RCP Recibo 2026/136318 Periodo 25/08/26-24/08/27", **-1.671,03 €** el 27/08/2026 desde la cuenta EUR de Footprint. Nadie la recuerda, nadie verifica que se vaya a renovar.
- El propio frontend Cerebro ya promete esto: `frontend-cerebro/src/App.jsx:103`, tarjeta "Fiscal y Alertas" — *"Avisa con antelación de domiciliaciones, impuestos y **seguros recurrentes**, leyendo el calendario fiscal del grupo — nunca escribe nada"* — hoy esa promesa se sostiene solo sobre el JSON de 5 entradas de WOBA, nada de EWORKS ni Footprint.

Carlos confirmó (2026-09-18) que el disparador es el conjunto completo de motivos que se le propusieron — control centralizado, validación de ajuste, detección de huecos y disciplina de pago — "es importante tener control de todo el tema de seguros porque es mucho".

## 2. Alcance acordado

- **Empresas**: WOBA, EWORKS y Footprint desde el día uno, con el diseño pensado para que sumar una empresa nueva no obligue a tocar el core de Wobi Seguros (ver §7 — es la parte donde el pedido de Carlos choca más con cómo está construido hoy el resto del sistema).
- **Las 4 capacidades con la misma profundidad de diseño** (decisión explícita de Carlos, no priorizada): registro/validación de pólizas, detección de coberturas faltantes, recordatorio de pagos + verificación de caja, gestión continua. La implementación sí necesita un orden (§14), pero el diseño no.
- **Documentos de origen**: Drive, correo electrónico y Holded — los tres a la vez, confirmado por Carlos. Coincide con lo que ya hay disperso: carpetas de Drive, adjuntos de Holded, y borradores de correo ya redactados sobre seguros (`data/borradores_correo.json`, 2 borradores reales sobre "Seguro Footprint" con el corredor IATI Calzado Correduría de Seguros SL y 3 facturas).

## 3. Lo que ya existe y se reutiliza

| Pieza | Ruta | Para qué sirve en Wobi Seguros |
|---|---|---|
| Tipo `Empresa` | `core/holded/client.ts:5` | Identidad de empresa reusada en casi todo el sistema — con matices, ver §7 |
| `ROOT_FOLDERS` | `core/drive/rootFolders.ts` | Carpeta raíz de Drive por empresa (IDs reales verificados en vivo) |
| `listTreasuryAccounts(empresa)` | `core/holded/client.ts` | Saldo real por cuenta/moneda — base de la verificación de caja (§6.2) |
| `adjuntarComprobanteHolded(...)` | `core/holded/write.ts:1439` | Adjuntar el PDF de una póliza a un gasto de prima ya creado |
| `buscarDocumentosHolded` / `consultarEstadoFacturaHolded.ts` | `core/holded/write.ts`, `core/tools/` | Comprobar si una prima ya está cargada antes de recordarla de nuevo |
| `evaluarCuentaContable` (`esServicioNoViaje`) | `core/holded/cuentaContableContexto.ts:30` | Ya reconoce "seguros" como palabra clave de clasificación contable — cuenta PGC 625 "Primas de seguros" documentada en `docs/PGC_4_cuadro_y_definiciones_de_cuentas.md:6453` |
| `core/fiscal/*` (`calendario_fiscal.json`, `revisarAlertasFiscales.ts`, `pagoRecurrenteCallbackHandler.ts`) | — | El mecanismo de "recordar pago → botón → registrar en Holded" ya corre en producción con 5 pólizas reales de WOBA |
| Clasificador de documentos | `core/documental/classifyFile.ts`, `core/drive/client.ts` | Ya cita `"SEGUROS📜"` como ejemplo real de nombre de carpeta (con variación de emoji) al explicar por qué descubre carpetas en vivo en vez de adivinar (`classifyFile.ts:104`, `client.ts:302,353,579`) |
| `docs/responsabilidades.md` | — | Ya tiene contacto del corredor (Pelayo, Gema, 673 345 846) y cuenta bancaria de cargo de cada póliza de WOBA |
| `core/tools/registry.ts` + `types.ts` | — | Patrón establecido para registrar tools nuevas (§8) |
| `core/google/sheetsKeyValueStore.ts` | — | Primitiva compartida y ya endurecida contra el bug de escritura de Sheets (§9) — usar esto, no reimplementar |
| `gastoTeclado.ts` / `gastoCallbackHandler.ts` | `core/gastos/` | Patrón de checkboxes múltiples en un solo mensaje de Telegram, reusable en Cerebro por el mismo router |
| `core/knowledge/loader.ts` | — | Cualquier `.md` en `docs/` (incluido este) se indexa solo, consultable por `consultar_base_conocimiento` |
| `extractInvoiceData.ts` | `core/documental/` | Precedente real de una llamada a Claude aparte, con su propio prompt/schema, orquestada por código — mismo principio detrás del sub-agente especialista (§6.5) |
| `analyze.ts` | `core/gmail/automatico/` | Otro precedente real: Claude analiza, y código determinista (`evaluarAuto`) decide la acción — separar "razonar" de "actuar" ya es un patrón conocido en este proyecto |
| `WEB_SEARCH_TOOL` (tool nativa de Anthropic) | `core/claude/client.ts:62` | **Ya existe y ya corre en producción** — búsqueda web real (`web_search_20250305`), activa solo en el intento completo (Sonnet), nunca en modo rápido. Costo trackeado (`costTracking.ts`) y cada búsqueda queda logueada (`core/claude/webSearchLog.ts`, tab `_busquedas_web`) con panel dedicado en Cerebro (`core/cerebro/conexiones.ts`). El sub-agente especialista (§6.5) la reutiliza directo, no hay que construirla |

## 4. Lo que falta construir

1. Registro estructurado de pólizas (store nuevo, §5).
2. `extractPolicyData.ts` — extractor documental para pólizas.
3. Rama nueva en `procesarDocumentoLocal.ts`/`classifyFile.ts` para reconocer "póliza" como tipo de documento (hoy cae en archivado genérico).
4. Extensión de `classifyEmail.ts` para avisos de aseguradora/corredor (no tocar `core/gmail/automatico/*`, que está soldado a conciliación bancaria de gastos).
5. Función "caja disponible por empresa+moneda" sobre `listTreasuryAccounts` — no existe hoy.
6. Checklist de cobertura esperada por empresa — sin esto, "validar que se ajusta" y "detectar huecos" no tienen contra qué comparar (§6.1, §6.3, y punto abierto en §13).
7. Tools nuevas en `registry.ts` + rama `seguros_` en `despacharCallbackQuery` (`src/server.ts:~1254`).
8. El sub-agente especialista en sí: tool `consultar_agente_seguros` (§6.5) con su propio prompt y su propio subconjunto de tools — incluyendo `WEB_SEARCH_TOOL`, que **ya existe** (`core/claude/client.ts:62`); solo hay que dársela también a este sub-agente y loguearla con `registrarBusquedaWeb`.

## 5. Modelo de datos — Registro de Pólizas

Store nuevo sobre `sheetsKeyValueStore.ts`, en un Sheet propio (no una pestaña del `CASHFLOW_SHEET_ID` — ese Sheet ya es WOBA/EWORKS-only en varias partes del código y no tiene sentido heredar esa limitación para algo que debe cubrir Footprint igual). Una fila por póliza:

| Campo | Nota |
|---|---|
| `id` | slug estable, ej. `footprint_markel_rc` |
| `empresa` | etiqueta humana libre, no atada al union `Empresa` de Holded (§7) |
| `empresaHolded` | opcional — solo cuando la empresa ya tiene integración Holded, mismo patrón que `calendario_fiscal.json` separa `empresa`/`empresaHolded` |
| `aseguradora`, `correduria`, `contacto_correduria` | ej. Markel / IATI Calzado Correduría de Seguros SL |
| `numero_poliza` | ej. `026S00905RCP` |
| `tipo_cobertura` | vehículo, hogar, RC, showroom/local, flota, D&O, cyber, etc. |
| `activo_asociado` | opcional — qué vehículo/inmueble/local, cuando aplica |
| `capital_asegurado`, `franquicia` | monto + moneda |
| `prima`, `periodicidad`, `cuenta_de_cargo` | monto + moneda; mensual/anual; banco/cuenta real de pago |
| `fecha_inicio_vigencia`, `fecha_vencimiento_renovacion` | |
| `documento_drive_id` | enlace al PDF real |
| `estado` | vigente / vencida / pendiente_renovación / cancelada |
| `fuente_extraccion` | documento / correo / manual — trazabilidad |
| `ultima_verificacion` | fecha del último chequeo automático |

## 6. Diseño de cada capacidad

### 6.1 Registro y validación

- Ingesta por documento: `extractPolicyData.ts`, hermano de `extractInvoiceData.ts` — mismo esqueleto de tool-calling, prompt y schema propios (aseguradora, nº póliza, vigencia, prima, coberturas, capital, franquicia). El propio proyecto ya usa esta estrategia de duplicación deliberada en vez de parametrizar un extractor genérico (`core/gmail/extraerGastoDeCorreo.ts` es el precedente exacto de este patrón).
- Entrada: Telegram (reenvío/subida), Drive (barrido inicial de las carpetas tipo "Seguros" por empresa), correo (adjunto detectado por `classifyEmail.ts`), Holded (adjuntos ya cargados bajo cuenta contable 625).
- Validación = comparar los campos extraídos contra el checklist de cobertura esperada de esa empresa y señalar discrepancias: capital insuficiente, franquicia distinta a lo acordado, vigencia próxima sin renovación agendada. La comparación mecánica de campos puede ser código plano; el juicio sobre si una discrepancia importa de verdad pasa por el sub-agente especialista (§6.5), igual que §6.3.
- Tool de consulta de solo lectura: `consultar_poliza(empresa, tipo_cobertura | numero_poliza)` — esta sí es una tool normal del registro principal, no pasa por el especialista (es solo lectura de datos, no interpretación).

### 6.2 Recordatorio de pagos + verificación de caja

- No se construye un sistema de recordatorios paralelo — se alimenta el mecanismo que ya corre (`core/fiscal/*`). Hoy `calendario_fiscal.json` se mantiene a mano; con el registro de pólizas como fuente de verdad, esa alimentación deja de ser manual para las pólizas (el resto de `calendario_fiscal.json` — Seguridad Social, SaaS, renting — sigue igual, esto no es una migración completa del calendario fiscal).
- Pieza nueva: `verificarCajaDisponible(empresa, moneda, monto)` sobre `listTreasuryAccounts(empresa)` — suma saldo real por moneda y compara contra la prima. El aviso de vencimiento deja de ser solo una fecha; dice explícitamente si hoy no alcanza el saldo.
- Antes de avisar, comprueba con `consultarEstadoFacturaHolded`/`buscarDocumentosHolded` si el pago ya está cargado — evita recordar algo que ya se pagó.
- Ejecución: igual que `pagoRecurrenteCallbackHandler.ts` hoy — propone con botón, adjunta el PDF vía `adjuntarComprobanteHolded`, crea el gasto **en borrador**. Nunca ejecuta el pago ni la transferencia real — eso lo sigue haciendo una persona (ver §11).
- Deliberadamente FUERA del sub-agente especialista (§6.5): esto es cálculo preciso, no interpretación — pasarlo por una llamada a Claude aparte solo añadiría latencia y una capa más donde una cifra se puede transcribir mal.

### 6.3 Detección de coberturas faltantes

Dos modos, no uno solo — y los dos pasan por el sub-agente especialista (§6.5), no por tools deterministas del registro principal, porque ambos requieren juicio, no solo comparar campos:

- **Determinista en el dato, interpretativo en el juicio**: el sub-agente compara el registro de pólizas contra un checklist de cobertura esperada por empresa, pero es él quien decide si una diferencia importa (¿un capital 10% menor es relevante o no, dado el tamaño real de la empresa?). El checklist en sí es el insumo que falta — sin él, "¿qué le falta a EWORKS?" no tiene contra qué compararse. Ver punto abierto en §13.
- **Investigación puntual bajo demanda**: Carlos le pregunta a Wobi algo como "¿a EWORKS le falta algo obligatorio operando en UK, dado que factura en GBP?", Wobi invoca `consultar_agente_seguros`, y el sub-agente investiga (conocimiento general + búsqueda web) y responde en la misma conversación. No se automatiza como job periódico desde el día uno — se espera a que haya un patrón real de uso antes de construir esa automatización.
- Caso real que esta capacidad ya debería poder atrapar el día que exista: la póliza Markel de Footprint (§1) — vigente, pagada, y sin embargo invisible para cualquier alerta o checklist hoy.

### 6.4 Gestión continua

- Job periódico, mismo patrón que `revisarAlertasFiscales.ts`/`revisarHoldedVsCashflow.ts`: reconcilia el registro contra Drive/correo/Holded (documentos nuevos o cambiados), cruza vencimientos próximos con caja disponible, señala huecos contra el checklist, arma un reporte consolidado.
- La parte de vencimientos/caja es cálculo directo (igual que §6.2); la parte de huecos de cobertura invoca al sub-agente especialista (§6.5) para el análisis, igual que en uso conversacional — mismo mecanismo, disparado por un job en vez de por un mensaje de Carlos.
- El reporte consolidado es la extensión natural de la tarjeta "Fiscal y Alertas" de Cerebro (`frontend-cerebro/src/App.jsx:103`), que ya anuncia "seguros recurrentes" — pasaría de leer solo el JSON manual a leer el registro real de las 3 empresas.

### 6.5 Arquitectura: cómo se conecta el sub-agente especialista

Decisión de Carlos (2026-09-18, en respuesta a "¿sería agente?"): ni todo en el mismo agente ni un bot completamente aparte — un sub-agente especialista invocado por una tool desde el mismo Wobi.

**Mecánica concreta:**
- Nueva tool en el registro principal: `consultar_agente_seguros(pregunta, contexto?)`. Como cualquier tool nueva, Sonnet-only por defecto.
- El handler de esa tool no responde directo — internamente hace su propia llamada a la API de Anthropic, con:
  - Un system prompt propio, enfocado en análisis de seguros (no el prompt principal de Wobi, cargado de reglas de IVA/retención/facturas españolas).
  - Su propio subconjunto de tools: `consultar_poliza` (lectura del registro, §5), lectura de documentos de pólizas (Drive), `listTreasuryAccounts` (solo lectura, para poder opinar con contexto de caja), y `WEB_SEARCH_TOOL` — la tool nativa de búsqueda web de Anthropic que **ya existe y ya corre en producción** en el agente principal (`core/claude/client.ts:62`, activa hoy en el intento completo/Sonnet). El sub-agente la reutiliza directo; lo único nuevo es loguear sus búsquedas con `registrarBusquedaWeb` (`core/claude/webSearchLog.ts`) para que el costo no quede invisible, igual que ya se cuida en el agente principal.
  - Su propio ciclo de tool-use (puede llamar varias de esas tools antes de responder), igual que ya hace el agente principal — no es una llamada de un solo turno.
- El resultado (texto ya sintetizado) vuelve como `tool_result` al agente principal, que se lo transmite a Carlos en el mismo hilo — Carlos nunca "cambia de bot".
- **Regla dura: el sub-agente es de solo lectura/asesoría.** Nunca crea una propuesta pendiente ni llama `sendTelegramMessageWithButtons` directamente — eso sigue siendo trabajo exclusivo del agente principal, con el mismo mecanismo de siempre (store de "pendiente" + botón + confirmación humana). Así, aunque haya dos agentes, solo hay un lugar que sabe crear un gasto o mandar un botón — no se duplica esa maquinaria ni el riesgo que ya se cuida ahí (huella, mutex, nunca-auto-pagar).
- Precedente real en el proyecto para "una llamada a Claude aparte, orquestada por código, con su propio prompt": `extractInvoiceData.ts` (extracción documental) y `core/gmail/automatico/analyze.ts` (análisis de correo, con una política determinista aparte decidiendo la acción) — ver §3. Lo nuevo aquí es que la orquestadora es el propio agente conversacional (vía tool call en medio del chat), no un pipeline de documentos o un job de correo.
- Costo real de esta decisión, no gratis: una pregunta de seguros que antes era una llamada a Claude pasa a ser dos encadenadas (principal → especialista → principal) — más latencia y más tokens por pregunta. Vale la pena para las preguntas interpretativas (§6.1 parcial, §6.3, §6.4 parcial); por eso §6.2 y la extracción documental se quedan fuera a propósito.

## 7. Multi-empresa y extensibilidad

Carlos pidió dejar la puerta abierta a empresas que puedan llegar. Tensión real con el código actual: `Empresa` (`core/holded/client.ts:5`) es un union type cerrado (`"WOBA" | "EWORKS" | "Footprint"`), reexportado y reimplementado en variantes aún más estrechas en varios módulos (`EmpresaCashflow` excluye a Footprint; `EmpresaDocumento`/`EmpresaGasto` agregan `"desconocida"`). No hay un archivo de configuración central de empresas — sumar una nueva hoy implica tocar el union type y cada variante estrecha que dependa de él.

Propuesta para Wobi Seguros específicamente: el campo `empresa` del registro de pólizas (§5) es texto libre, no atado a ese union type — igual que `calendario_fiscal.json` ya separa `empresa` (etiqueta humana, ej. `"BAE"`) de `empresaHolded` (opcional). Esto permite trackear pólizas de una empresa nueva desde el primer día — incluso antes de que tenga credenciales de Holded o carpeta de Drive integradas — aunque capacidades que sí dependen de Holded (§6.2, adjuntar comprobante, verificar caja) solo funcionan una vez esa empresa tenga `empresaHolded` resuelto. No resuelve la tensión de fondo del resto del sistema, pero evita que Wobi Seguros la herede.

## 8. Ingesta del backlog ya existente

Como los documentos ya están dispersos (confirmado por Carlos: Drive + correo + Holded), el primer trabajo real no es "esperar documentos nuevos" — es una pasada de auditoría sobre lo que ya se sabe que existe:

- Las 5 pólizas de WOBA ya en `calendario_fiscal.json` (con datos de contacto/banco en `docs/responsabilidades.md`).
- La póliza Markel de Footprint (§1), localizable solo hoy en un JSON de conciliación bancaria batch, sin ningún registro propio.
- Los 2 borradores de correo sobre "Seguro Footprint" en `data/borradores_correo.json` (corredor IATI, 3 facturas, enlaces a Drive).
- Las carpetas de Drive por empresa (`ROOT_FOLDERS`) — barrido de subcarpetas de seguros por empresa, con el mismo mecanismo de descubrimiento en vivo que ya usa `classifyFile.ts`.
- Adjuntos ya cargados en Holded bajo cuenta contable 625 "Primas de seguros", si el histórico de alguna empresa ya los tiene clasificados así.

## 9. Aprendizaje

WOBI tiene 8 stores de aprendizaje establecidos (patrón: una decisión humana confirmada se guarda y se consulta antes de volver a preguntar lo mismo), todos sobre `sheetsKeyValueStore.ts`, varios agregados en `core/tools/reporteAprendizaje.ts`. Wobi Seguros debería sumar el suyo siguiendo el mismo patrón en vez de inventar uno nuevo — candidato más claro: un store de alias aseguradora/corredor (nombre detectado en un documento → entidad canónica), calcado de `proveedorAliasSheet.ts`. Alternativa sin tabla propia: el patrón de precedente-en-vivo de `cuentaContableContexto.ts` (puntuar contra pólizas/gastos ya existentes en vez de mantener una tabla de refuerzo aparte) si en la práctica no hace falta la capa de confirmación explícita.

Nota de mantenimiento encontrada de paso, sin relación directa con el diseño: `core/knowledge/correctionsStore.ts` todavía escribe con `values.append` crudo, sin el patrón seguro que ya tienen los otros 7 stores — quedó una tarea aparte para corregirlo, no forma parte de este diseño.

## 10. UX — Telegram y Cerebro

- Tools nuevas en `core/tools/registry.ts`: `consultar_poliza` (lectura directa del registro), verificación de caja (extensión de `saldosBancarios.ts` o tool propia), `proponer_recordatorio_pago_poliza`, y `consultar_agente_seguros` (§6.5 — la puerta de entrada al sub-agente especialista). Sonnet-only por defecto (`seguraParaModoRapido` sin marcar) — norma establecida, cualquier tool nueva empieza cerrada al modelo económico hasta decidir lo contrario a propósito.
- Rama `seguros_` nueva en `despacharCallbackQuery` (`src/server.ts:~1254`) — funciona en Telegram y en el chat web de Cerebro sin trabajo extra, porque ambos comparten ese mismo router.
- Decisiones múltiples simultáneas (ej. "de estas pólizas por vencer, cuáles renovamos") clonan el patrón de checkboxes de `gastoTeclado.ts`/`gastoCallbackHandler.ts` — no el de `conciliacionMultiple`, que pese al nombre es un Sí/No simple sobre varios movimientos bancarios, no una selección múltiple de usuario.

## 11. Límites de seguridad

El agente nunca ejecuta el pago ni la transferencia de una prima por su cuenta. Como mucho: recuerda el vencimiento, verifica si hay caja, crea el gasto en Holded **en borrador** y adjunta el comprobante — la ejecución real del pago la hace una persona, igual que el resto de Wobi hoy. Cualquier aviso automatizado hacia fuera del sistema se queda en correo — nunca WhatsApp/SMS —, y ni siquiera los correos se auto-envían: los borradores de respuesta se ofrecen y esperan clic explícito antes de salir.

## 12. Compatibilidad con el estado actual del código

Antes de construir sobre `extractInvoiceData.ts` como plantilla: ese archivo (y `transcribeForCapture.ts`) importan `core/ai/modelRouting.ts`, que hoy no existe en el working tree de esta rama. Confirmar el estado real de compilación de esa base antes de partir de ella.

## 13. Puntos abiertos — a confirmar con Carlos

1. **Footprint y su cashflow**: hay una nota previa de que Footprint tiene "su propio cashflow separado" del Sheet de WOBA/EWORKS. Hoy, en el código, no hay ningún Sheet de cashflow para Footprint — lo único real es una carpeta de salida `output/seguimiento-comprobantes/footprint/` con JSONs de conciliación batch (como el de la póliza Markel citada arriba), no un registro en vivo. El diseño de "caja disponible" (§6.2) no depende de esto — usa `listTreasuryAccounts` directo de Holded —, así que no bloquea, pero vale confirmarlo para no dar por asumido un Sheet que quizá nunca se llegó a crear.
2. ~~El checklist de cobertura esperada por empresa~~ — **resuelto 2026-09-27**: Carlos lo definió directamente (ver §15), no hizo falta un corredor externo ni que Wobi lo investigara. Genera 3 sub-puntos nuevos — ver puntos 6-8 abajo.
3. **Nombres definitivos** de tools/prefijo de comandos — los de este documento (`seguros_`, `consultar_poliza`, etc.) son provisionales.
4. ~~Herramienta de investigación/búsqueda web para el sub-agente especialista~~ — **corregido 2026-09-18**: sí existe. Error de la primera versión de este documento — ninguna de las 3 investigaciones de arquitectura fue instruida para buscarla específicamente, y su silencio se interpretó (mal) como ausencia confirmada. Ya está en producción: `WEB_SEARCH_TOOL` (`core/claude/client.ts:62`, tool nativa `web_search_20250305` de Anthropic), con costo trackeado y cada búsqueda logueada (ver §3). El sub-agente especialista solo necesita reutilizarla, no construirla.
5. **Costo/latencia aceptado**: la arquitectura elegida encadena dos llamadas a Claude para las preguntas interpretativas de seguros (principal → especialista → principal). Carlos ya lo confirmó como el trade-off preferido frente a mezclar todo en un solo agente o separarlo por completo — queda anotado aquí para no redescubrirlo como "problema" más adelante.
6. ~~Criterio del seguro de accidentes de empleados en WOBA~~ — **resuelto 2026-09-27** (documentos reales, §18): NO depende de una obligación legal general — depende de si el convenio colectivo concreto de los empleados está "legislado" para exigirlo. El de WOBA (Convenio Estatal de Consultoría y Estudios de Mercado) no lo está, confirmado por escrito por Acodrid tras revisar el convenio completo. **Hoy WOBA no tiene esta póliza, y no le hace falta legalmente** — solo la necesitaría si un cliente lo exige comercialmente (Acodrid ya tiene un escrito preparado para ese caso) o si se decide contratar un seguro colectivo privado ad-hoc.
7. ~~Estado real de los complementos de RC y todo riesgo de WOBA~~ — **resuelto del todo 2026-09-29, vía correo real de Acodrid Y de Allianz directo (§22): 🚨 URGENTE, no es un impago rutinario.** El "complemento" es el Suplemento nº 2 de la póliza de Showroom (Allianz 054239034.2 / Pyme 2038, efecto 10/09/2026). El recibo de 289,14€ SÍ es solo el recargo del suplemento (duda anterior resuelta) — pero el banco lo devolvió, y **Allianz puso la póliza EN SUSPENSO** (aviso directo del 3/09, reenviado por Alejandra→Carlos el 8/09): un mes desde la fecha del recibo (1/9/2026) para pagar antes de que Allianz pueda extinguir el contrato, y **sin cobertura ante ningún siniestro mientras siga suspendida**. Ese plazo vence ≈1/10/2026. Ver §22.
8. ~~"Rental co"~~ — **resuelto 2026-09-27**: es "Rental Code", nombre de una actividad/marca de la propia WOBA (no un proveedor externo), "por ahora" según Carlos.
9. ~~AEGON (WOBA, mensual, ~234€/mes)~~ — **resuelto 2026-09-27**: excluido del alcance inicial — no es prioridad ahora (Carlos). Ya no es candidato al punto 6 (accidentes de empleados).
10. ~~SOLUNION (WOBA, seguro de crédito, ~1.305€ cada ~3 meses)~~ — **resuelto 2026-09-27**: Carlos confirmó que ya no lo tienen como servicio (dado de baja) — excluido del alcance.
11. ~~"Business Atelier Europa Sl"~~ — **resuelto 2026-09-27**: es el nombre legal de WOBA (confirmado repetidamente en pólizas, cartas de pago y el correo del corredor). La transferencia EWORKS→WOBA de junio 2026 sigue sin una explicación exacta de qué reparte, pero la entidad ya no es un misterio.
12. ~~IATI en Footprint~~ — **resuelto 2026-10-05**: los cargos «Iati Seguros»/«Iati Colombia» son seguros de viaje contratados trayecto a trayecto con la tarjeta (correo del 28/09 de Juan Camilo Salazar, «€ 22,06 – Iati – Revolut: Travel insurance», con su recibo). Entre 10/2025 y 10/2026 suman al menos ~310 € en 7 cargos, frente a los 1.524,98 € de la póliza anual que Carlos descartó el 30/09. No requieren fila en el registro; el vigilante los trata como cargo «puntual» (§24).
13. ~~Footprint RC 2026 — ¿formalizada y pagada, o solo cotizada?~~ — **resuelto 2026-09-27, vía Drive (§20)**: SÍ está formalizada y pagada. La carpeta local estaba incompleta; la carpeta real de Drive tiene la carta de pago real de Acodrid/Markel, que confirma exacto el nº de póliza, el periodo y el monto.
14. ~~¿La cotización 1/424572 de Footprint y el pago real a la póliza 026S00905RCP son la misma cobertura?~~ — **resuelto 2026-09-27, vía Drive (§20)**: sí, confirmado — la carta de pago real cita el nº de póliza 026S00905RCP, periodo 25/08/2026-24/08/2027 e importe 1.671,03€, coincidiendo exacto con el pago ya visto en Holded.
15. ~~Los 5 PDF de "Conversia" en la carpeta de WOBA~~ — **resuelto 2026-09-27**: confirmado el mismo patrón que Footprint. Son certificados de que Conversia (no WOBA) tiene su propio seguro de RC profesional con Hiscox — no son pólizas de WOBA, quedan fuera del registro (§18).
16. **¿Hay una póliza de General Liability activa hoy para "375LED America LLC" (entidad de WOBA en USA)?** — encontrado en Drive (§21) un histórico real de cotización/contratación con Kinsale Insurance Company vía Bass Underwriters, pero el documento más reciente encontrado es de 2022/2023 (vencía 13/10/2023). Hay más carpetas de cotizaciones (2023, "QUOTE 1/2/3") sin revisar a fondo — antes de asumir que sigue vigente o que se dejó vencer, hay que preguntarle directo a Carlos.
17. **Excluir la garantía de RC del multirriesgo de WOBA (Allianz) — decisión pendiente de Carlos.** Acodrid detectó que esa garantía sigue con la facturación antigua (112.431,28€) en vez de la actual (700.000€) y propone excluirla del todo riesgo (apoyándose en la póliza RC independiente con Markel, 023S00453RCG) para no encarecer la prima. Piden que Carlos confirme **por escrito, respondiendo el correo** — no es algo que Wobi pueda decidir ni ejecutar. Ver §22.
18. **Dos recibos devueltos por el banco, misma fecha de efecto (10/09/2026), dos pólizas distintas de WOBA** — el de 289,14€ (multirriesgo Allianz, punto 7) y uno nuevo de 323,24€ (RC Markel, Suplemento 3.3 por la actividad Rental.co). Acodrid pregunta en ambos casos si puede reintentar el cobro — decisión de Carlos. Ver §22.
19. **Firmar y devolver las condiciones particulares del Suplemento 3.3 de RC** — Acodrid lo pidió explícitamente en el mismo correo del punto 18. Tarea administrativa pendiente de Carlos, no de Wobi.
20. **¿Se contrataron finalmente el seguro de transporte de pantallas (529,16€/año) y el de Equipos Electrónicos (90.000€, 4.142,76€/año) cotizados el 12/08/2026?** — ambos quedaron registrados como `pendiente_confirmacion` (§18/§22) porque en los correos leídos hasta ahora no hay una respuesta explícita de Carlos aceptándolos o rechazándolos.
21. **Seguro de Footprint mencionado por Carlos el 13/08/2026** ("finalmente debemos comprar el seguro de Footprint... quisiera saber si se conserva la cotización") — mención suelta dentro de un correo sobre otro tema, sin respuesta visible en lo leído. No hay datos suficientes para saber a qué póliza se refiere ni su estado — falta preguntarle a Carlos directamente cuál cotización era y si sigue vigente.
22. **Recibo de Markel de 323,24 € (suplemento 3.3): cargo visto, cobro sin confirmar (05/10/2026).** Holded muestra un adeudo «Markel Insurance SE» de −323,24 € en BBVA el 05/10, pero el saldo del banco todavía no lo refleja; el 01/09 pasó lo mismo con Allianz y Aegon y acabaron devueltos. El registro lo tiene en `sin_confirmar` y el vigilante lo reverifica solo (§24). No requiere nada de Carlos salvo que aparezca una devolución.
23. **Condiciones particulares de la RENOVACIÓN 2026/2027 del multirriesgo Allianz (054239034)**: pedidas a Acodrid el 30/09; el 01/10 llegaron el suplemento nº 2 y las condiciones del suplemento 3.3 de Markel, pero no esas. Sin ellas Wobi Seguros solo conoce las condiciones base del ciclo anterior más el suplemento 2.
24. **Por qué se devuelven los recibos de WOBA.** Allianz (01/09), Markel (suplemento, 09/09) y Aegon (01/09) se domicilian en la cuenta BBVA …6229, que el día 1 suele tener un saldo casi nulo (28,94 € el 01/09, antes de que llegara el traspaso de 1.300 € del día 02). El vigilante ya lo detecta cuando ocurre; la causa de fondo —fondear BBVA antes de los días de cargo (alertas con verificación de caja, ya aprobadas por Carlos y pendientes de construir) o cambiar la cuenta de domiciliación— es una decisión de Carlos.

## 14. Próximos pasos sugeridos (orden de implementación)

El diseño cubre las 4 capacidades con la misma profundidad, pero implementarlas en paralelo no tiene sentido — 6.2, 6.3 y 6.4 dependen de que el registro (§5) ya tenga datos reales, y 6.3 además depende del sub-agente especialista (§6.5). Orden sugerido, a validar:

1. Registro de pólizas (§5) + carga del backlog ya identificado (§8), aunque sea semi-manual al principio.
2. `extractPolicyData.ts` + enganche en `procesarDocumentoLocal.ts`/`classifyEmail.ts`, para que lo nuevo entre solo sin seguir cargando a mano.
3. Recordatorio de pagos + verificación de caja (§6.2) sobre el registro ya poblado.
4. Sub-agente especialista (§6.5): tool `consultar_agente_seguros`, su propio prompt/toolset — reutilizando `WEB_SEARCH_TOOL` (ya existe, `core/claude/client.ts:62`) en vez de construir una tool de búsqueda nueva, y logueando sus búsquedas con `registrarBusquedaWeb`.
5. Checklist de cobertura + detección de huecos (§6.1, §6.3) sobre el sub-agente ya construido — depende de resolver el punto abierto 2 (quién arma el checklist).
6. Job de gestión continua + reporte consolidado en Cerebro (§6.4).

## 15. Checklist de cobertura esperada por empresa (confirmado por Carlos, 2026-09-27)

Responde el punto abierto 2 (arriba) — es la referencia contra la que §6.1 (validación) y §6.3 (huecos de cobertura) deben comparar el registro real de pólizas (§5) en cuanto exista.

**WOBA:**
- Responsabilidad civil (RC) — obligatoria.
- Todo riesgo del showroom, para los equipos — obligatoria.
- Accidentes de empleados — **no contratado, y hoy no obligatorio**: depende de si el convenio colectivo de los empleados está legislado para exigirlo; el de WOBA no lo está (confirmado por Acodrid, ver §18). Solo se activaría por exigencia comercial de un cliente o decisión propia de contratarlo.
- **Gap activo señalado por Carlos, no solo hipotético**: la RC y el todo riesgo deberían tener **complementos** nuevos porque llegaron equipos de "rental co" para una nueva actividad de la empresa. No está confirmado si esos complementos ya se tramitaron (puntos abiertos 7 y 8). En cuanto el registro (§5) tenga las pólizas reales de WOBA cargadas, este es el primer caso concreto que §6.3/el sub-agente especialista (§6.5) debería poder señalar.

**EWORKS:**
- Responsabilidad civil (RC) — obligatoria. Es la única que Carlos mencionó; no asumir que falta algo más sin que él lo confirme.

**Footprint:**
- Responsabilidad civil (RC) — obligatoria. Coincide con la póliza real de Markel ya identificada en §1 (nº 026S00905RCP, -1.671,03€) — confirma que esa póliza sí corresponde a una cobertura que Footprint debe tener; el problema no es que sobre, es que hoy no está en ningún registro.

## 16. Datos reales encontrados en Holded (verificado 2026-09-27)

Carlos pidió verificar directamente en Holded, en las 3 empresas, los cobros de seguros, para empezar a registrar fechas y montos reales. Metodología: se revisaron **compras** (`/purchases`, 30 meses, 2024-03-27 a 2026-09-27) y **movimientos bancarios** de TODAS las cuentas de tesorería de cada empresa (`/treasury/accounts` + `/bank-movements`, mismo rango, en ventanas de 3 meses), filtrando por palabras clave con límite de palabra izquierdo — necesario porque la primera pasada tuvo un falso positivo real: "reale" (aseguradora) coincidía dentro de "CORREALES", el apellido de una persona real de Footprint. Mismo criterio que ya usa `contienePalabraClave` en `core/holded/write.ts` para el mismo tipo de problema.

**Limitación real, no solo teórica**: el endpoint de movimientos bancarios no pagina (tope de 200 resultados por consulta). La cuenta `Main` de Footprint tocó ese tope en **las 10 ventanas trimestrales completas**, y una de WOBA en 2 de ellas. Prueba concreta de que esto deja huecos: el pago real de Footprint a Markel del 27/08/2026 (-1.671,03€, ya confirmado en §1 por otra vía — un export de Revolut) **no aparece** en esta búsqueda — cae justo en la ventana trimestral de `Main` que tocó el tope. El resto de esta sección es real y verificado, pero para Footprint en particular, muy probablemente falta más de lo que se encontró.

### WOBA — bancos (cuentas BBVA y Main)

| Proveedor | Patrón real observado | Posible cobertura |
|---|---|---|
| PELAYO MUTUA DE SEGUROS (G-28031466) | ~3 cargos/año, montos distintos: ~1.000-1.040€ (agosto), ~228-267€ (febrero), ~408€ (mayo) | Coincide con las 3 pólizas Pelayo de `calendario_fiscal.json` (coche/agosto, piso/febrero, moto/mayo) — primera vez que se tienen montos reales |
| MARKEL INSURANCE SE | ~1.603,88€ cada abril (2024 y 2025) | Coincide con `seguro_markel` (RC) de `calendario_fiscal.json` |
| ALLIANZ SEGUROS Y REASEGUROS | 2 cargos/año, marzo y septiembre, subiendo con el tiempo (~936€ → ~1.016€) | Probable `seguro_showroom` — el patrón semestral no calza del todo con la única entrada anual de `calendario_fiscal.json`, vale confirmar si es una póliza o dos |
| AEGON ESPAÑA S.A. | **Mensual**, casi todos los meses desde 2024-04, subiendo de ~201€ a ~234€ | **Excluido del alcance inicial** — no es prioridad ahora (Carlos, 2026-09-27) — punto 9, §13 |
| SOLUNION SEGUROS DE CRÉDITO | Recurrente, ~1.305€ cada ~3 meses | **Excluido**: Carlos confirmó que ya no lo tienen como servicio (2026-09-27) — punto 10, §13 |
| "Transferencia propia seguro resp. civil" | 2026-09-01/02, 1.300€ movidos entre cuentas propias de WOBA (BBVA ↔ Main), mencionando "Business Atelier Europa Sl" | No es un pago a una aseguradora — parece fondear un pago de RC próximo. "Business Atelier Europa Sl" sin identificar — punto abierto 11 |

(El cargo AEGON pendiente del 2026-09-09, -234,41€, queda fuera de seguimiento — AEGON está excluido del alcance inicial, ver arriba.)

### EWORKS — bancos

| Proveedor | Patrón real observado |
|---|---|
| MARKEL INSURANCE SE | ~840€ cada semestre (marzo/abril y agosto/septiembre) — coincide con la RC que Carlos confirmó para EWORKS. Pendiente real ahora: 2026-09-15, -838,41€, `pending` |
| "Business Atelier Europa Sl — Pago Seguro" | 2026-06-16, -800€, EWORKS → Business Atelier Europa Sl, mismo día WOBA recibe +800€ "From Compania De Proyectos Eworks Sl. Pago Seguro" — parece un reparto/reembolso entre empresas de un mismo seguro, sin identificar cuál (punto abierto 11) |

### Footprint — bancos + compras

| Fuente | Detalle |
|---|---|
| Movimientos "Iati Seguros" / "Iati Colombia" | Cargos pequeños y frecuentes (24-77€/USD), junio-agosto 2026 — el patrón sugiere seguro de viaje para desplazamientos, no necesariamente la póliza de RC (punto abierto 12) |
| Compra "Reintegro pago póliza de seguro Suramericana vigencia 2025-2026" | **Excluida del alcance inicial** — no es prioridad ahora (Carlos, 2026-09-27). Para referencia: 2026-01-22, 3.472 USD, oficina de Medellín (tag `oficinamedellin`), era un asiento de "ingresos recibidos para terceros" (reintegro), no un pago directo a la aseguradora |
| Markel (ver §1) | El pago real ya confirmado no aparece en esta búsqueda de bancos — ver limitación arriba, cayó en la ventana que tocó el tope de 200 |

Los puntos abiertos 9-12 que esto generó están numerados junto con el resto en §13.

## 17. Integración con Cerebro — monitoreo y alertas

Carlos pidió explícitamente (2026-09-27) poder monitorear lo que el sub-agente especialista (§6.5) hace y ver todas las alertas que genere — esto solo estaba mencionado de pasada en §6.4 ("reporte consolidado en Cerebro"), aquí se detalla el mecanismo. Cuatro piezas, todas apoyadas en patrones que ya existen en el proyecto:

**1. Log de actividad del sub-agente** — store nuevo, misma forma que `core/claude/webSearchLog.ts` (Sheets-backed vía `sheetsKeyValueStore.ts`): cada vez que se invoca `consultar_agente_seguros`, se registra fecha, chatId/origen (chat o panel), la pregunta, un resumen de la respuesta, qué tools usó (incluido si usó `WEB_SEARCH_TOOL`) y el costo. Sin esto, lo que el sub-agente investiga solo existe efímero en el historial de Telegram — es literalmente lo que Carlos pidió poder ver.

**2. Store de alertas activas** — separado del log de actividad (uno es histórico/auditoría, el otro es "estado actual"). El job de gestión continua (§6.4) no solo manda un aviso de Telegram que se pierde en el scroll — también escribe/actualiza un registro de alertas vigentes (vencimientos próximos, pagos pendientes, huecos de cobertura detectados, discrepancias sin resolver como la de los complementos) consultable en cualquier momento, no solo cuando llega el aviso.

**3. Extensión de `core/cerebro/estadoAgregado.ts`** — agrega una sección `seguros: {...}`, mismo patrón que ya usa para `alertasPagosRecurrentesProximas`/`catalogoPagosRecurrentes` del calendario fiscal — lee del registro de pólizas (§5) + el store de alertas activas (pieza 2).

**4. Tarjeta nueva "Seguros" en `frontend-cerebro/src/App.jsx`** (mismo patrón que la tarjeta "Fiscal y Alertas" ya existente, `App.jsx:103`) + endpoint nuevo en `src/server.ts` — muestra pólizas activas por empresa, próximos vencimientos, alertas activas, y el log de actividad del sub-agente (pieza 1). **Solo lectura**, mismo principio que "Fiscal y Alertas... nunca escribe nada" — cualquier acción (aprobar un pago, confirmar una cobertura) se sigue haciendo con botones por Telegram o por el chat de Cerebro (que ya comparte el mismo router de callbacks, §6.5/§10), nunca por un botón nuevo dentro de esta tarjeta.

## 18. Registro real de pólizas — extraído de documentos originales (2026-09-27)

Carlos cargó las pólizas reales en `Wobi_seguros/`. Extracción con lectura completa de cada documento (no solo nombres de archivo/carpeta, que en al menos un caso resultaron engañosos — ver Footprint abajo). WOBA en progreso; EWORKS y Footprint completos.

### EWORKS — RC General (única póliza real; "1-298831"/"2-298831 (USA)" son cotizaciones previas, no pólizas)

| Campo | Valor |
|---|---|
| Aseguradora / correduría | Markel Insurance SE, Sucursal en España / Acodrid Correduría de Seguros, S.A. (contacto Andrés G. Aguado, andres.g.aguado@acodrid.com) |
| Tomador | COMPAÑÍA DE PROYECTOS EWORKS, S.L. — CIF B56942204 |
| Nº póliza | 025S00287RCG |
| Vigencia | 27/02/2025 – 26/02/2026, tácita reconducción |
| Prima | 1.679,15€/año, fraccionada: 840,74€ (27/02-26/08/25) + 838,41€ (27/08/25-26/02/26) — **coincide exacto con los cargos reales ya vistos en el banco (§16)** |
| Capital / franquicia | 1.000.000€ por siniestro/anualidad; franquicia 300€ general, 1.200€ post-trabajos/productos/colindantes |
| Ámbito | Todo el mundo excepto USA/Canadá |
| Cuenta de cargo | Revolut (IBAN …4606), mandato SEPA recurrente firmado 06/03/2025 |
| Estado de pago | Domiciliado; el cargo de 840,74€ ya aparece reconciliado en Holded (§16), el de 838,41€ salió `pending` el 15/09/2026 en esa misma búsqueda — consistente con el calendario de esta póliza |

**Discrepancia real sin resolver**: el domicilio en Condiciones Particulares dice CP 28043, el Mandato firmado dice CP 28033 (misma calle) — confirmar cuál es correcto antes de fijarlo en el registro.

**"1-298831"/"2-298831 (USA)"**: cotizaciones previas de junio 2024 del mismo expediente, no pólizas. La contratada finalmente (025S00287RCG) NO incluye la cláusula de exportación a USA/Canadá que sí tenía la opción "USA" cotizada — si EWORKS llega a operar directamente ahí, haría falta una póliza americana aparte (no existe en esta carpeta).

**Hallazgo colateral valioso**: el correo del corredor (`Eworks/Seguros.docx`) confirma en un solo documento los 3 nombres legales del grupo — Business Atelier Europa, S.L. (WOBA, cliente previo de Markel, mencionado solo de contexto), BUSINESS FOOTPRINT EU, S.L. y COMPAÑÍA DE PROYECTOS EWORKS, S.L. — las 3 cotizadas en la misma ronda por el mismo corredor (Acodrid) en 2024.

### Footprint — más incierto de lo que parecía, un hallazgo urgente

**Hallazgo urgente**: la carpeta `Footprint/SEGURO RESP CIVIL/Aprobado y pagado 2026/` **no contiene ninguna prueba de que la póliza esté realmente formalizada ni pagada**, pese al nombre de la carpeta. Lo que hay dentro es un "PROYECTO DE COTIZACIÓN" (el propio documento se autodefine como orientativo, válido 60 días, sujeto a aprobación de suscripción) más un SEPA firmado a mano pero con **todos los campos del deudor en blanco** — sin IBAN, sin nombre, sin número de póliza, sin fecha. Antes de asumir que la RC de Footprint para 2026 está vigente, hay que confirmarlo con Carlos o con el corredor.

| Documento | Detalle |
|---|---|
| Cotización 1/424572 (Markel) | Footprint RC, vigencia propuesta 28/01/2026–27/01/2027, prima 1.671,03€ (pago único). Capital 600.000€, franquicia 300-400€ según garantía. Tomador BUSINESS FOOTPRINT EU S.L., CIF B56942089. **Sin confirmación de formalización ni pago** |
| Cotización 1/299163 (Markel, más antigua) | Vigencia 17/06/2024–16/06/2025, prima 2.167,30€ — coincide exacto con el correo del corredor citado en EWORKS (misma ronda de cotización). También solo cotización, sin señal de contratación |

**Cruce interesante con el pago real ya confirmado (§1)**: el pago real de Footprint a Markel (-1.671,03€, 27/08/2026, memo "Poliza 026S00905RCP... Periodo 25/08/26-24/08/27") tiene el MISMO monto exacto que la cotización 1/424572 (1.671,03€), pero un número de póliza distinto (026S00905RCP, no la referencia de cotización 1/424572) y un periodo distinto (ago-ago, no ene-ene como la cotización). Es razonable pensar que es la misma cobertura y que el número de póliza final/fecha de inicio cambiaron respecto a la cotización — pero es una hipótesis, no una confirmación. Vale la pena preguntarlo directo.

**Corrección importante — estos NO son pólizas de Footprint**: `Poliza_PBC.pdf` y `Responsabilidad_Civil_PBC.pdf` (en la raíz de la carpeta Footprint) son certificados genéricos que **Conversia** (la consultora de cumplimiento normativo que factura a Footprint) entrega a sus clientes como prueba de que **Conversia misma** tiene su propio seguro de RC profesional (Hiscox, póliza HD IP6 2000078) — ninguno de los dos documentos menciona a Footprint en ningún lugar. Quedan fuera del registro de Footprint; **confirmado que los 5 PDF de la carpeta "Conversia" de WOBA son del mismo tipo** (ver abajo).

**IATI sigue sin confirmar**: `Seguro de viajes .docx` es una cotización de seguro de viaje (10 asegurados, ~1.525€/año total, gastos médicos + asistencia + RC privada en el extranjero) pero NO menciona ninguna aseguradora ni correduría por nombre, ni "IATI" en ningún lugar (verificado en texto, XML crudo y metadatos del documento). La hipótesis de que IATI es el seguro de viaje de Footprint sigue sin confirmar solo con este documento — haría falta cruzarlo directo con los cargos "Iati Colombia"/"Iati Seguros" ya vistos en Holded (§16), o preguntarle a Carlos.

### WOBA — 2 pólizas reales, 1 no contratada (con motivo legal documentado), Conversia no es propia

**RC General (Markel, nº 023S00453RCG)**

| Campo | Valor |
|---|---|
| Aseguradora / correduría | Markel Insurance SE / Acodrid Correduría de Seguros, S.A. |
| Tomador | BUSINESS ATELIER EUROPA, S.L. — CIF B06952261 |
| Vigencia | Anualidades desde 17/04; la más reciente en la carpeta: 17/04/2025–16/04/2026 (falta el documento del Suplemento 1 de 2024/2025 en esta carpeta, no implica que no exista) |
| Prima | 1.603,88€/año, pago anual — **coincide exacto con el cargo real reconciliado en Holded el 23/04/2025 (§16)** |
| Capital / franquicia | 600.000€ límite; franquicia 300€ general (1.200€ algunas específicas) |
| Cuenta de cargo | BBVA, IBAN …6229 — misma cuenta que la póliza de Showroom |
| Estado de pago | La copia 2025/2026 de esta carpeta tiene el mandato de domiciliación en blanco y falta el sello de vuelta de WOBA — **pero el pago real de 1.603,88€ sí está confirmado en Holded**, así que hay fuerte evidencia de que está vigente y pagada aunque el papeleo de esta copia esté incompleto |

**Todo riesgo Showroom (Allianz Negocio PLUS, nº 054239034)**

| Campo | Valor |
|---|---|
| Aseguradora / correduría | Allianz, Compañía de Seguros y Reaseguros, S.A. / Acodrid (mismo corredor que la RC) |
| Tomador / riesgo | BUSINESS ATELIER EUROPA, S.L. — showroom en Calle Tomás Redondo 3, Madrid |
| Recibos 2025/2026 | 955,73€ (01/09/25–01/03/26) y 903,11€ (01/03/26–01/09/26), **ambos marcados PAGADO** — coinciden con los cargos ya vistos en banco (§16) |
| Cuenta de cargo | BBVA, IBAN …6229 |

**El "Complemento" es el Suplemento nº 2 de esta misma póliza (2026/2027), no un producto nuevo** — resuelve el punto abierto 7. Emitido 10/09/2026, vigente hasta 31/08/2027. Sube los capitales asegurados (edificación 75.000€→84.323€, mobiliario 210.000€→236.105€, mercancías 125.000€→230.539€) y **añade una actividad secundaria declarada — "material eléctrico y electrónico, almacén (sin reciclaje)"** — que coincide con la ampliación por los equipos de Rental Code que mencionaste. Su recibo semestral (289,14€, periodo 10/09/26–28/02/27) **no tiene sello de pagado**, a diferencia de los dos recibos anteriores de la misma póliza que sí lo tienen. Duda sin resolver del todo: 289,14€ es bastante menor que los recibos anteriores (~900-955€) — podría ser solo el recargo por el aumento de capital y no la prima completa de la renovación 2026/2027; vale la pena confirmarlo directo con Acodrid junto con si ya se pagó.

**Accidentes de empleados — NO contratado, y hoy no hace falta legalmente** — resuelve el punto abierto 6. El criterio real: depende de si el convenio colectivo de los empleados está "legislado" para exigir este seguro. El de WOBA (Convenio Estatal de Empresas de Consultoría y Estudios de Mercado, XVII) no lo está — confirmado por escrito por Acodrid (21/04/2023) tras revisar el convenio completo: *"el convenio al que pertenecen los empleados de momento, no esta legislado en cuando a la obligatoriedad de la contratación de un seguro de Accidentes."* Si algún cliente de WOBA lo exige de todas formas (exigencia comercial, no legal), Acodrid ya tiene un escrito preparado para ese caso; si aun así se insiste, la alternativa es un seguro colectivo privado ad-hoc.

**Conversia (LSSI/MIGD/PBC/PRP/RGPD) — confirmado, mismo patrón que Footprint**: son 5 certificados de que Conversia (no WOBA) tiene su propio seguro de RC profesional con Hiscox (misma póliza HD IP6 2000078 que en Footprint) — protegen a WOBA solo si el fallo es de asesoramiento de Conversia, nunca por errores propios de WOBA. Ninguna prima que WOBA pague directamente por estos documentos. Quedan fuera del registro de pólizas de WOBA.

## 19. Implementado en el sistema real (2026-09-27)

A petición explícita de Carlos ("esto debe quedar creado en el cerebro de Wobby... y en el front"), se construyó la primera fase real — registro + visibilidad en Cerebro — sobre las 7 pólizas ya extraídas (§18). Todo lo de abajo es código real en el repo, no diseño.

**Registro de pólizas** — `core/seguros/types.ts` + `core/seguros/polizaRegistroSheet.ts`, sobre el primitivo compartido `sheetsKeyValueStore.ts` (mismo patrón que 20+ stores del proyecto, mismo spreadsheet que `CASHFLOW_SHEET_ID`, pestaña nueva `_polizas_seguros`). Ya tiene las 7 pólizas reales de §18 cargadas (WOBA ×4, EWORKS ×1, Footprint ×2) — las 3 exclusiones de §13 (AEGON, Solunion, Suramericana) NO se cargaron, como pidió Carlos.

**Cerebro (backend)** — `core/cerebro/estadoAgregado.ts`: nueva función `construirSeguros()`, sumada al agregado (`EstadoCerebroDatos.seguros`). Calcula en vivo, cada vez que se recalcula el caché de 5 min: pólizas próximas a vencer (ventana 30 días) y pólizas con pago sin confirmar — esto es lo que alimenta las alertas. De paso se encontró y corrigió `invalidarEstadoCerebro` — `src/server.ts` ya la importaba en 4 puntos de escritura pero había dejado de existir en `estadoAgregado.ts` (no lo causó este trabajo, era un hueco preexistente que bloqueaba la compilación de `server.ts` — ver más abajo).

**Cerebro (endpoint de escritura)** — `POST /api/cerebro/seguros/marcar-pago` en `src/server.ts`, mismo patrón que `conexiones/arreglar`: solo key maestra (nunca token temporal), busca la póliza por id, actualiza `estadoPago` a "pagado" e invalida el caché. Es la única acción real expuesta por ahora — confirmar/investigar coberturas sigue siendo diseño (necesita el sub-agente, §6.5).

**Cerebro (front)** — `frontend-cerebro/src/App.jsx`: nuevo nodo "Seguros" en el mapa neuronal (grupo "Finanzas", junto a Holded/Cashflow/Fiscal), con su propio contenido rico (`SegurosContenido`) — pólizas agrupadas por empresa en desplegables, badge de estado de pago por color, botón "marcar como pagado" (solo visible para admin) que llama al endpoint de arriba. Sumado también a "Prioridades de hoy" (`AtencionAhora`): pólizas por renovar pronto y pagos sin confirmar aparecen ahí igual que las alertas fiscales, sin que Carlos tenga que abrir el nodo.

**Verificación real hecha**: `npx tsc --noEmit` confirma que los archivos nuevos (`core/seguros/*`, los cambios en `estadoAgregado.ts` y `server.ts`) no agregan ningún error nuevo. `npm run build` del frontend compila limpio y se confirmó por grep en el bundle generado que el nuevo texto/UI está presente. **Lo que NO se pudo verificar en vivo**: el backend (`src/server.ts`) no arranca localmente — ver el hallazgo aparte de abajo — así que no hay confirmación end-to-end de que el endpoint responda con datos reales fuera de este entorno. Habrá que confirmarlo cuando se despliegue.

**Hallazgo importante, preexistente, no causado por este trabajo**: al correr `npx tsc --noEmit` sobre todo el proyecto aparecieron 114 errores en 9 archivos ajenos a Seguros — `core/documental/{extractInvoiceData,transcribeForCapture,documentCallbackHandler}.ts`, `core/gastos/{gastoCallbackHandler,procesarGastoEntrante}.ts`, `core/jobs/revisarConversacionesAutomaticas.ts`, `core/telegram/client.ts`, `core/tools/reclasificarDocumentoPendiente.ts`, y `src/server.ts` mismo (import de módulos que no existen como `core/ai/modelRouting.ts` y `core/claude/turnSafety.ts`, y referencias a funciones que ya no exportan sus módulos). Es un estado a medio terminar de un refactor en curso (rama `codex/holded-proyectos`), no algo que yo rompí — ninguno de esos archivos fue tocado en este trabajo. Efecto práctico: ahora mismo el servidor completo no compila, así que ningún cambio de nadie (el mío incluido) se puede probar de punta a punta localmente hasta que se resuelva. Vale la pena que Carlos confirme si es trabajo en curso conocido antes de que alguien más pierda tiempo pensando que lo rompió.

**Próximos pasos reales para seguir "manejando todo desde el front"** (lo que Carlos pidió pero todavía no está): acciones para confirmar formalización de una póliza (no solo pago), un botón para disparar el sub-agente especialista desde la propia tarjeta, y el job periódico (§6.4) que mantenga esto actualizado solo en vez de depender de que alguien recargue Cerebro.

## 20. Acceso real a Drive — confirmado (2026-09-27)

Carlos preguntó si se estaban leyendo los links de Drive de `Links_Drives.doc`. Respuesta honesta en su momento: no, solo se habían extraído los 3 links del documento, sin abrirlos — el trabajo se había hecho sobre las copias locales de `Wobi_seguros/`. Se verificó en vivo con la cuenta de servicio (`core/google/serviceAccount.ts`, la misma que ya usa Sheets/Drive en el resto del proyecto, scope `drive.readonly`) y **sí tiene acceso real** a las 3 carpetas:

- WOBA: carpeta real `"SEGUROS📜"` (`1DakPgT4W8dRHsu0_xmcubfFVVFjJR__i`)
- EWORKS: carpeta real `"SEGURO / POLIZA"` (`1GeyxPnyIfKFBU__NUO0w3Med7HVvsXgM`)
- Footprint: carpeta real `"SEGUROS"` (`1tsX2CPUcJksCowkDL8b5p2U1sUWSmUTQ`)

**Hallazgo que resolvió los puntos 13-14 de §13**: la carpeta de Drive de Footprint tiene documentos que NO estaban en la copia local que Carlos cargó en `Wobi_seguros/` — la póliza ya formalizada completa (`026S00905RCP`: condiciones particulares, condiciones particulares para devolver firmadas, condiciones generales, carta de asistencia jurídica, información del producto) y, sobre todo, la **carta real de pago** de Acodrid/Markel (25/08/2026), que confirma exacto: nº de póliza 026S00905RCP, periodo 25/08/2026-24/08/2027, "pasaremos a cobro el importe total de 1.671,03 €" — coincide al céntimo con el pago ya visto en Holded (27/08/2026). El registro de pólizas ya se actualizó con esto (`footprint_rc_markel`: estado `vigente`, pago `pagado`, número de póliza corregido a 026S00905RCP).

**Más estructura real encontrada, sin explorar a fondo todavía** (para la próxima pasada):
- **WOBA** (`EUROPA/`, dentro de `SEGUROS📜`): subcarpetas `SEGURO WOBA 2026`, `SEGURO RC 2025`, `seguro facturas SOLUNION` (corrobora que Solunion existió como servicio real, consistente con que Carlos dijo que ya no lo tienen), además de `PLATAFORMAS DE SEGUROS DE VIAJES` y una carpeta `USA` con subcarpetas por nombre de persona (`MONICA`, `YOLEGNIS`) — esto último parece documentación individual (¿seguro de viaje o visado para personas concretas?), no pólizas de empresa — no se abrió por ser potencialmente información personal de personas nombradas, sin que Carlos lo pidiera específicamente.
- **WOBA** (`SEGUROS ASPY/`): un archivo (`OD_02131496_ML01.pdf`) — Aspy es una empresa real de vigilancia de la salud/prevención de riesgos laborales en España — probablemente NO es una póliza de seguro sino un servicio de salud laboral, posiblemente relacionado con el punto 6 (accidentes de empleados) pero de naturaleza distinta (servicio médico obligatorio vs. póliza de accidentes). Sin confirmar.
- **EWORKS** (`2026/`): mandato de domiciliación y condiciones particulares YA FIRMADOS (`_signed`) para lo que parece ser la renovación 2026/2027 — más completo que la copia local. No se leyó el contenido todavía.

No se profundizó en estos tres para no extender más esta pasada — quedan como siguiente paso natural si Carlos confirma que quiere esa lectura completa.

## 21. Segunda pasada por Drive, a fondo (2026-09-27)

Carlos pidió revisar todo lo que había quedado sin abrir en §20. Hallazgos:

**WOBA — renovación real 2026/2027, ya localizada y cargada al registro**: `EUROPA/SEGURO WOBA 2026/` tiene la póliza 023S00453RCG renovada, vigente 17/04/2026–16/04/2027, **prima 1.475,84€** (baja respecto a los 1.603,88€ de la anualidad anterior — confirmado con la carta de pago real, no es un error de lectura). **Esto resuelve un cabo suelto que había quedado del análisis de Holded (§16)**: el cargo de -1.475,84€ en la cuenta Main de WOBA el 16/06/2026, que se había dejado como "posible complemento sin identificar", es en realidad esta renovación normal de RC — nada que ver con el complemento del showroom/Rental Code (que es la póliza de Allianz, un asunto totalmente distinto). Registro actualizado (`woba_rc_markel`).

**WOBA — mandato de domiciliación 2025/2026**: la copia en Drive también está en blanco (igual que la local) — pero como el mandato original de 2023 sí está firmado con IBAN real (…6229, ver §18) y las domiciliaciones SEPA recurrentes no necesitan renovarse cada año, esto no es una alarma — es normal que Acodrid reenvíe una plantilla en blanco cada anualidad sin que haga falta volver a firmar.

**EWORKS — renovación real 2026/2027, ya localizada y cargada al registro**: `2026/` tiene el Suplemento nº 1 de Renovación 025S00287RCG, vigente 27/02/2026–26/02/2027, firmado electrónicamente el 12/02/2026 (certificado AC Representación). Misma prima que el año anterior (1.679,15€, 840,74€+838,41€ semestral) — sin cambios. Registro actualizado (`eworks_rc_markel`).

**WOBA/SEGUROS ASPY — no es una póliza de seguro**: es Aspy Prevención (grupo Atrys), el servicio externo obligatorio de prevención de riesgos laborales (Reglamento de los Servicios de Prevención, RD 39/1997) — evaluación de riesgos, plan de prevención, procedimientos de emergencia, etc. Categoría regulatoria distinta a "seguro de accidentes" (§13 punto 6, ya resuelto: WOBA no tiene ni necesita esa póliza). ASPY no va en el registro de pólizas — es un contrato de servicio, no un seguro — pero es la pieza que sí cumple la parte de "prevención" que la ley exige, en paralelo a que no haga falta la póliza de accidentes.

**WOBA/EUROPA/seguro facturas SOLUNION — confirmado histórico real, sigue excluido**: la carpeta tiene una carta de bienvenida de cliente y sellos reales de "Operación Asegurada Solunion" — confirma que fue un seguro de crédito real y contratado, consistente con lo que ya se había visto en Holded. Sigue fuera del alcance por instrucción de Carlos (§13 punto 10) — no se cargó al registro.

**WOBA/USA — no son datos personales, son cotizaciones de seguro para una entidad de EE.UU. del grupo**: "MONICA" y "YOLEGNIS" resultaron ser nombres de agentes/gestores de cotización, no de empleados — la carpeta contiene el proceso real de contratación de un seguro de Responsabilidad Civil General (General Liability) en Estados Unidos para **"375LED America LLC"**, la entidad del grupo en EE.UU. (mencionada en Holded como tag "375led" en un gasto real de EWORKS, ver §16 — confirma que es la misma entidad). El documento `Detalles para solicitud de seguro.docx` (2022) explica el motivo a un agente: WOBA vende marcas de audio/video y digital signage en LATAM/USA a través de contratistas (no empleados), y quiere cobertura de RC ante reclamos por la actuación de esos contratistas y por los equipos que gestiona en su cadena de suministro (OEM/ODM). Factura declarada: 2021 \$222.000, 2022 \$540.000, 2023 estimado \$1.000.000.

**Cotización real encontrada — pero vieja**: `375LED AMERICA LLC - PROPOSAL.pdf` es una cotización real de Bass Underwriters (agente) / Kinsale Insurance Company (aseguradora, no-admitted/surplus lines, rating A-) para General Liability, periodo **13/10/2022–13/10/2023**, prima \$3.500 + gastos = **\$4.226,26 total**. Es la única que se leyó a fondo — hay más carpetas sin abrir (`YOLEGNIS/QUOUTE 1` con 6 PDFs más de otra cotización en inglés, y `MONICA/Business Atelier/QUOTE 1, 2 y 3 2023`) que probablemente correspondan a la renovación de ese mismo periodo o a rondas posteriores. **No se puede confirmar con lo revisado si esta cobertura de USA sigue activa hoy** — queda como punto abierto 16 en §13, mejor preguntárselo directo a Carlos que seguir abriendo carpetas de 2022/2023.

## 22. Dos correos reales integrados (2026-09-29) — WOBA, suplementos del 10/09/2026

Carlos compartió dos enlaces a correos de Acodrid (correduría), ambos del 24/09/2026, leídos directo desde su Gmail real (vía Claude en Chrome — el navegador integrado de Claude no tenía su sesión iniciada). Mismo patrón de ingesta que el resto de este documento: leer, extraer, cargar al registro real, y separar lo que Wobi puede resolver de lo que es decisión de Carlos.

**Correo 1 — Suplemento 54239034.2 (multirriesgo showroom, Allianz).** Cierra del todo el punto 7 de §13 (ver arriba): el recibo de 289,14€ SÍ es solo el recargo del suplemento (duda anterior resuelta), y el banco lo devolvió — no es solo "sin sello", es un impago activo. Además, Acodrid detectó que la garantía de RC dentro de este multirriesgo sigue con la facturación vieja (112.431,28€ en vez de 700.000€) y propone **excluirla** de la póliza (apoyándose en la RC independiente con Markel), para no encarecerla al actualizar la facturación. Piden confirmación por escrito de Carlos, respondiendo el correo — nuevo punto 17 en §13.

**Correo 2 — Suplemento 3.3 de la póliza de RC (Markel, 023S00453RCG).** Es la contraparte de RC del mismo cambio: incluye la actividad de alquiler de pantallas LED (Rental.co) que ya estaba reflejada en la facturación total (700.000€, de los cuales 200.000€ son de esta actividad). Recibo adicional de 323,24€ (10/09/2026 al 17/04/2027, hasta la próxima renovación) — **también devuelto por el banco**. Acodrid pide además que Carlos les devuelva firmada (todas las páginas) la copia de condiciones particulares del suplemento. Nuevos puntos 18-19 en §13.

**De paso, releyendo el hilo completo (contexto de julio/agosto 2026) aparecieron dos huecos reales sin cerrar**: un seguro de transporte de pantallas (529,16€/año, cotizado 12/08) y uno de Equipos Electrónicos (90.000€, 4.142,76€/año, cotizado 12/08) — ninguno de los dos tiene una confirmación explícita de contratación en lo leído. Y una mención suelta de Carlos (13/08) sobre comprar un seguro para Footprint con una cotización de Andrés García Aguado, sin respuesta visible. Nuevos puntos 20-21 en §13 — ninguno se puede resolver sin preguntarle a Carlos.

**Registro actualizado en vivo** (Sheet real, no solo este documento): `woba_showroom_complemento_2026_2027` actualizada (`estadoPago` de `sin_confirmar` a `pendiente`, notas ampliadas); 3 filas nuevas — `woba_rc_suplemento_3_3`, `woba_transporte_pantallas_pendiente`, `woba_equipos_electronicos_pendiente` (estas dos últimas en `estado: pendiente_confirmacion`, no como contratadas). Verificado leyendo el registro de vuelta tras escribir, no solo confiando en que la escritura no falló.

**Lo que Wobi NO hizo, a propósito**: no respondió ni redactó una respuesta a Acodrid, no decidió si excluir la RC del multirriesgo, no decidió si reintentar los cobros devueltos. Son decisiones y comunicaciones externas de Carlos — Wobi las deja registradas y visibles, no las toma por su cuenta (§11, límites de seguridad).

**Dos correos más (mismo día), uno de ellos cambia la urgencia real.** Carlos compartió dos enlaces más:

1. **Aviso directo de Allianz (no de Acodrid), reenviado por Alejandra a Carlos el 8/09 y por Carlos a Acodrid el mismo día preguntando "a qué corresponde".** Confirma que la póliza 054239034 (Pyme 2038) está **EN SUSPENSO** por el recibo devuelto — no es un aviso más de la correduría, es la propia aseguradora. Plazo legal de 1 mes desde la fecha del recibo (1/9/2026) para pagar, es decir **vence ≈1/10/2026**, y mientras siga suspendida **no hay cobertura ante ningún siniestro**. Jaquelin (Acodrid) confirmó el 9/09 que es el mismo recibo ya conocido — el pago lo tiene que iniciar Carlos directo (app myAllianz, teléfono, o Acodrid), no es algo que la correduría gestione sola. Registro (`woba_showroom_complemento_2026_2027`) y punto 7 de §13 actualizados con esta urgencia real.
2. El otro era el mismo presupuesto del 12/08 (transporte + equipos electrónicos) reenviado sin novedad — no generó cambios nuevos en el registro, ya estaba capturado como puntos 20 en §13.

**Regla de envío de correo, confirmada por Carlos (2026-09-29)**: cuando haga falta responder a un corredor/aseguradora, Wobi puede enviar la respuesta usando el correo del asistente (la cuenta dedicada, no la de Carlos) — pero **única y exclusivamente cuando Carlos lo pida explícitamente en ese momento**, nunca por iniciativa propia ni de forma anticipada.

## 23. Documentos de pólizas: archivado + lectura por Wobi Seguros (2026-10-01)

Cierra los puntos 2, 3 y 4 de §4. Detalle de uso en `docs/manual_comandos_chat.md` («Canal de documentos corporativos»).

- `core/documental/extractInvoiceData.ts`: el lector de contenido marca `es_documento_poliza` y deja de proponer como gasto la documentación de una póliza.
- `core/seguros/extraerDatosPoliza.ts`: lector de pólizas (número, suplemento, aseguradora, tomador, coberturas, límites, prima, vigencia, resumen).
- `core/seguros/integrarDocumentoPoliza.ts` + `documentosPolizaStore.ts` (pestaña `_documentos_polizas`): enlaza el documento con su fila del registro por número de póliza y suplemento; idempotente. No escribe en `_polizas_seguros`.
- `core/documental/archiveFile.ts`: tras subir a Drive un documento de póliza o cualquier documento destinado a una carpeta de seguros, llama a la integración. Un fallo de lectura no deshace el archivado.
- `consultar_polizas_seguro` incluye los documentos leídos; `integrar_documento_seguro` integra uno que ya está en Drive.
- Verificado con el correo real de Acodrid (suplemento 3.3 de la RC 023S00453RCG y suplemento 2 del multirriesgo 054239034): ambos se reconocen como póliza, se enlazan a `woba_rc_suplemento_3_3` y `woba_showroom_complemento_2026_2027` y se proponen en `SEGUROS📜 / EUROPA / SEGURO WOBA 2026`.

## 24. Vigilante: Wobi Seguros se mantiene al día solo (2026-10-05)

Pedido explícito de Carlos (05/10/2026): «valida pagos que se hayan hecho o correos que hayamos recibido para que actualice la situación de los seguros y me diga si hay algo pendiente. Pon al agente a trabajar para mantener actualizada nuestra situación de seguros». Es la primera pieza autónoma del agente (§6.4, «gestión continua»): sus **sentidos y manos**, sin IA y sin coste por consulta. El agente especialista que razona sobre las condiciones (§6.5) es la pieza siguiente y usa estas mismas funciones.

**Dónde vive.** `core/seguros/vigilante/` (puro y probado) + `core/jobs/revisarSegurosVigilante.ts` (el job) + dos líneas en `scheduler.ts`. Memoria propia en la pestaña `_seguros_vigilante` (no comparte la de `_alertas_seguros_notificadas`: el job de alertas purga a diario todo id que no sea suyo).

**Cuándo corre.** A las 8:35 y a las 17:35 (antes de los avisos de las 8:50, que ya ven el registro actualizado). Avisa por Telegram solo de lo nuevo.

**Qué hace, con las reglas de cada cosa:**

| Pieza | Archivo | Regla |
|---|---|---|
| Lectura del banco | `lecturaBancaria.ts` | Solo lectura sobre Holded: 45 días, todas las cuentas vivas de las 3 empresas, una repetición por lectura fallida. Una cuenta que no se lee deja a su empresa «no completa»: sobre ella no se afirma que algo «no aparece». |
| Quién cobra | `contrapartes.ts` | Reconoce aseguradoras y corredurías en el concepto del banco con límite de palabra (falsos positivos reales: «reale» en «CORREALES», «iati» en «ASSOCIATION»). Cada contraparte tiene un modo: `poliza`, `fuera_de_alcance` (Aegon, Pelayo, Suramericana), `puntual` (IATI), `baja` (Solunion), `desconocida`. Los modos salen de decisiones de Carlos ya escritas aquí (§13 puntos 9, 10, 12 y §16) y del calendario fiscal. Los traspasos entre cuentas del grupo nunca cuentan. |
| ¿Llegó a aplicarse el cargo? | `cadena.ts` | Cada apunte trae el saldo posterior; los apuntes de una cuenta forman una cadena. Un apunte que no está en la cadena que llega al final de la cuenta no se aplicó. Es lo único que delató los adeudos devueltos del 01/09 (una devolución así no deja apunte contrario). Solo se usa en cuentas cuya cadena es fiable (≤ 15 % de huérfanos en lo asentado): las cuentas Revolut con tarjetas (WOBA Main, Footprint Main) no la cumplen y allí solo se aceptan transferencias nuestras. Lo último que entra en una cuenta sale «en tránsito» hasta que el banco asiente algo posterior. |
| Pagos pendientes ↔ banco | `cruces.ts` · `confirmarPagos` | Marca `pagado` solo con importe exacto al céntimo + contraparte de la póliza + misma empresa + salida de dinero + coincidencia única + cargo aplicado (o transferencia). Prima en texto libre → no se interpreta. Una transferencia que suma varios recibos pendientes (289,14 + 1.016,86 = 1.306,00 €) se reparte si la combinación es única. La prueba (con el id del movimiento) se antepone a `notas`. Se relee el registro justo antes de escribir y no se pisa una fila que alguien editó. |
| Devoluciones | `cruces.ts` · `detectarDevoluciones` | Durante 14 días vigila los movimientos citados como prueba en pólizas pagadas: abono posterior del mismo importe de la misma contraparte (o con texto de devolución), o cargo que el saldo deja de reflejar → la póliza vuelve a `pendiente` y se avisa. Sin almacén aparte: la prueba escrita en `notas` es la lista de lo vigilado. |
| Cargos que no encajan | `cruces.ts` · `detectarCargosAnomalos` | Aseguradora sin póliza registrada (una vez por aseguradora), servicio dado de baja, póliza solo vencida/sin contratar, o cargo reciente que el saldo no refleja. |
| Correos | `correos.ts` | Lee el buzón del asistente (`gmail.readonly`, sin marcar nada): remitentes de Acodrid/Espabrok, Markel y Allianz, filtrados por la dirección real. Señales: incidencia, recibo, documento, firma. La primera revisión da por conocido lo que ya hay. |
| Salud | `vigilante.ts` | Una lectura que falla se anota; si lleva 2 días o más, avisa por sí sola (una vez al día). Nada se concluye de una lectura fallida. |

**Caso que motivó la regla del saldo (verificado en vivo, 05/10/2026).** El 01/09 Holded mostró «ALLIANZ −1.016,86 €» y «AEGON −234,41 €» como cargos conciliados; el saldo de BBVA nunca los incluyó (el abono de 1.300 € del día 02 se calculó sobre un saldo de 28,94 €) y Acodrid confirmó el 30/09 que el banco había devuelto el recibo y exigió transferencia. Un vigilante que se fiara del apunte habría marcado la renovación como pagada un mes antes de que lo estuviera. Hoy el adeudo de Markel (323,24 €, 05/10) está en la misma situación incierta: el vigilante lo trata como «en tránsito» hasta que el saldo lo confirme o lo descarte (tests: `cadena.test.ts` con los 37 movimientos reales).

**Límites conocidos, dichos con franqueza.**
- Con una sola fecha de vencimiento por póliza (§5) el vigilante no sabe cuándo toca la siguiente cuota semestral: no avisa de un pago que falta, solo reconoce los que ya están pendientes. El calendario de pagos con alertas y verificación de caja (§6.2) es la pieza siguiente.
- Solo ve el buzón del asistente: un correo que la correduría envía solo a Carlos no llega hasta que él lo reenvía.
- Dos pólizas pendientes con el mismo importe y la misma contraparte se avisan como «no sé atribuir», nunca se adivina.
- Si `WOBI_AI_API_MODE` pasara a `allowlist`, esta pieza no necesita permisos: no usa IA.

