# Navegador de WOBi — interpretación conversacional de solo lectura (PROPUESTA)

**Estado: propuesta para aprobar. No hay código nuevo ni consumo de IA activado.** Pedido: entender distintas formas de preguntar, conservar la compañía, pedir aclaraciones y, para Seguros (pagos pendientes, próximas renovaciones y actividad), responder con las lecturas existentes del sistema indicando su fecha y si están incompletas. Solo devuelve destinos registrados y autorizados; no ejecuta operaciones.

Parte de lo ya fusionado: `docs/navegador-wobi-contrato.md` (#434, #437, #439) y el catálogo único del front (`capabilities.mjs`). Hoy `/interpretar` es **determinista y sin coste** (nombres y sinónimos); esta propuesta añade una capa conversacional **encima**, sin sustituirlo.

---

## 1. Principios (lo que no cambia)

1. **El modelo solo elige, nunca redacta datos.** Devuelve un JSON con esquema forzado cuyos únicos valores posibles son ids del catálogo **autorizado** para esa persona, compañías válidas y un nivel de confianza. No hay campo de texto libre: no puede escribir cifras, URLs, selectores ni frases.
2. **Las cifras y fechas salen del servidor, no del modelo.** La respuesta con datos (`lectura`) la construye código determinista a partir de las lecturas que ya existen (`obtenerEstadoCerebro()`), con su fecha y sus señales de fallo. Probado con datos de prueba: lo mostrado = lo leído.
3. **Una lectura fallida nunca es «no hay».** Si la fuente no se pudo leer, la respuesta dice «no pude consultar», sin lista vacía ni ceros; si el dato es antiguo o parcial, lo dice y da su fecha.
4. **Único camino a un destino:** `resolverDestino` del servidor (estado → permiso → fuente). El modelo propone; el servidor valida igual que hoy. Si el modelo propone un id no autorizado o inexistente, se descarta y se pregunta.
5. **Sin consumo nuevo hasta que Carlos lo apruebe.** Interruptor `WOBI_NAVEGADOR_IA=apagado` por defecto; apagado o sin presupuesto, todo sigue como hoy (determinista).

## 2. Qué existe y se reutiliza

| Pieza | Para qué |
|---|---|
| `core/cerebro/navegador/*` | Catálogo único, permisos por identidad, `resolverDestino`, secciones de Seguros (`registered`/`available`, `scope`) |
| `obtenerEstadoCerebro()` (`estadoAgregado.ts`) | Lectura de Seguros en caché SWR (TTL 60 s) con `cacheadoEn`, `generadoEn`, `refrescando`, `actualizacionParcial` y `fuentes[]` |
| `EstadoFuente` (`lecturaFuentes.ts`) | Por fuente: `ok`, `verificadoEn`, `ultimoExitoEn`, `conservado` (se sirve lo anterior), `causa` (`timeout`/`cuota`/`transporte`/`otro`) |
| `EstadoSeguros` (`seguros/estadoCerebro.ts`) | `pagosSinConfirmar`, `proximasARenovar`, `proximos`, `bitacora`, `calendarioPagos`; **`null` = no se pudo leer, no «cero»**; `complementosDisponibles` |
| `crearMensajeAnthropic` + política (`core/ai/*`) | Única puerta facturable: presupuesto por solicitud, tope diario/mensual y por proceso, registro de coste en `/costos_ia` |

Lecturas nuevas: **ninguna**. Se usa el mismo snapshot que ya alimenta el panel, así que no añade consultas a Sheets (cuidado con la cuota).

## 3. Contrato propuesto para conectar el front (Codex)

Todo **aditivo**: `/interpretar` y `/catalogo` no cambian de forma.

### 3.1 Disponibilidad
`GET /api/cerebro/navegador/catalogo` añade `conversacional: { disponible: boolean, motivo?: "apagado" | "limite_diario" | "sin_permiso" }`. El front usa `/conversar` solo si `disponible`; si no, `/interpretar` como hoy. Nunca se asume.

### 3.2 `POST /api/cerebro/navegador/conversar`
Cabeceras de identidad iguales (`X-Cerebro-Key`, `X-Cerebro-Device`, `X-Cerebro-Nombre`).
Cuerpo: `{ "texto": "…1–200 caracteres", "companyId": "WOBA", "requestId": "…", "conversacionId"?: "…" }`.
`conversacionId` lo **emite el servidor**; el cliente solo lo devuelve. El contexto no viaja en el cuerpo.

Respuesta: las **tres variantes actuales** (`destino`, `aclaracion`, `no_disponible`, con `requestId` y `catalogVersion`) más campos nuevos y opcionales:

```jsonc
{ "tipo": "destino", "requestId": "…", "catalogVersion": "nav-…", "capabilityId": "section:insurance:seguros:pagos_pendientes",
  "companyId": "Footprint", "companyOrigen": "texto | seleccionada | contexto", "etiqueta": "…", "avisos": [],
  "modo": "deterministico | modelo",
  "conversacionId": "…",
  "resumen": "Hay 3 pagos de seguros sin confirmar en Footprint. Lectura de hace 2 minutos.",   // plantilla del servidor, sin modelo
  "lectura": { … }  // §3.3, solo si la intención pide datos y la fuente aplica
}
```
- `companyOrigen: "contexto"` = se heredó la compañía de la conversación; el front debe mostrarla («Footprint»).
- `modo` es transparencia y diagnóstico; el front no cambia de comportamiento por él.
- `aclaracion`: `pregunta` y `opciones` salen de **plantillas y del catálogo**, no del modelo (≤ 4 opciones, solo abribles y autorizadas).
- `no_disponible`: mismos motivos; la lectura fallida es `fuente_no_consultable` con su `lectura.estado = "no_consultable"`.

### 3.3 `lectura` (Seguros, v1)
```jsonc
{ "tipo": "seguros_pagos_pendientes | seguros_proximas_renovaciones | seguros_actividad",
  "empresa": "Footprint",                         // null en actividad (es del grupo completo)
  "leidoEn": "2026-10-10T09:12:00.000Z",          // el MÁS ANTIGUO de las fuentes usadas (ultimoExitoEn)
  "generadoEn": "2026-10-10T09:14:03.000Z",       // esta respuesta
  "estado": "completa | incompleta | no_consultable",
  "refrescando": false,
  "fuentes": [ { "fuente": "seguros.polizas", "ok": true, "verificadoEn": "…", "ultimoExitoEn": "…", "conservado": false, "causa": null } ],
  "avisos": ["Lectura conservada: no se pudo releer; es del …"],
  "total": 3, "mostrados": 3,                     // total solo si estado = completa
  "items": [ { "polizaId": "…", "tipoCobertura": "…", "aseguradora": "…", "fecha": "2026-11-01", "diasRestantes": 22, "prima": "1.016,86", "moneda": "EUR", "estadoPago": "pendiente" } ] }
```
Reglas (todas con prueba):
- **Orígenes:** pagos → `pagosSinConfirmar` (+ `calendarioPagos` solo para «próximo pago programado»); renovaciones → `proximasARenovar` y `proximos` de tipo `vencimiento`; actividad → `bitacora`.
- **`estado`:** `no_consultable` si la fuente base falló o el campo es `null` (nunca `items: []` ni `total: 0`); `incompleta` si alguna fuente tiene `ok: false` o `conservado: true`, `complementosDisponibles === false` o falta un dato que la vista usa (p. ej. `calendarioPagos === null`); `completa` en otro caso.
- **Fecha:** `leidoEn` = mínimo de `ultimoExitoEn` de las fuentes usadas; si es un dato conservado, se avisa con su fecha real.
- **Sin sumas inventadas:** importes tal cual constan en el registro, **nunca sumados entre monedas**; en v1 solo conteos. Los totales por moneda (solo con `estado: completa`) quedan para una v2 si Carlos los pide.
- **Actividad:** del grupo completo; `empresa: null` y el aviso de grupo. `bitacora === null` es `no_consultable`, **no** «sin actividad».
- **Límites:** máx. 10 `items`, ordenados por fecha; texto del registro verbatim, sin resumir con IA.

### 3.4 Contexto de conversación (en servidor)
- Guarda **solo datos estructurados**: `{ companyId, capabilityId, opcionesOfrecidas[], ts }`. **Nunca el texto** del usuario ni de la respuesta. En memoria, TTL 10 min, una entrada por identidad+dispositivo; se pierde al desplegar (aceptable: la persona repregunta).
- Aislado por identidad y dispositivo: otra sesión nunca lo lee; el cliente no puede fijarlo ni leerlo (solo devuelve el `conversacionId` opaco, que además se valida contra la identidad).
- Sigue-ups que resuelve: «y el de Footprint» (cambia compañía, conserva destino), «y las renovaciones» (cambia destino, conserva compañía), «ese mismo de eWorks», «el primero / el segundo» y «sí» frente a una aclaración. Una compañía **explícita en el texto** manda sobre el contexto; sin contexto vigente se pregunta, no se adivina.
- Seguridad: cada resolución pasa por `resolverDestino` con la identidad de ESA petición; el contexto nunca eleva permisos.

## 4. Modelo, coste y límites (a aprobar)

### 4.1 Modelo recomendado: **Claude Sonnet 5** (`claude-sonnet-5`)
Es el modelo por defecto del sistema y está validado en chat y clasificación de correo. Tarifa del sistema (`costTracking.ts`): **2 USD / 10 USD por millón de tokens (entrada / salida)**.
- *Haiku 4.5* (1 / 5 USD) costaría ~la mitad, pero la regla vigente de Carlos (07-10) es **no bajar a Haiku** sin comparación de calidad con casos reales. Se puede evaluar después en modo observación; no se propone ahora.
- *Sonnet 4.6* (3 / 15 USD) solo como rollback por variable.

### 4.2 Qué se envía y cuánto cuesta (medido sobre el catálogo real de 25 capacidades)
| Bloque | Tokens aprox. |
|---|---|
| Instrucciones fijas (solo lectura, solo ids, esquema de salida) | ~700 |
| Catálogo **autorizado** compacto (`id`, etiqueta, estado, alcance) | ~780 (medido: 2.572 caracteres) |
| Esquema de herramienta forzada (enums de ids y compañías) | ~500 |
| Contexto estructurado (último destino/compañía/opciones) | ~150 |
| Texto de la persona (≤ 200 caracteres) | ~60 |
| **Entrada total** | **~2.200** |
| **Salida** (JSON forzado, `max_tokens` 300) | **~120–200** |

- **Por consulta con modelo:** ≈ 2.200 × 2 µUSD + 160 × 10 µUSD = **≈ 0,006 USD** sin caché. Con caché de prompt del bloque fijo (~2.000 tokens leídos a 0,2 USD/M) baja a **≈ 0,0025 USD**.
- **Solo se llama al modelo cuando el intérprete determinista no resuelve** (sin coincidencia, ambigüedad o seguimiento tipo «y el de Footprint»). Estimación: ~40 % de las consultas.

| Uso estimado | Llamadas al modelo/día | Coste/día | Coste/mes (sin caché → con caché) |
|---|---|---|---|
| Bajo: 30 consultas/día | ~12 | ≈ 0,07 USD | ≈ 2 → 1 USD |
| Medio: 100 consultas/día | ~40 | ≈ 0,24 USD | ≈ 7 → 3 USD |
| Alto: 200 consultas/día | ~80 | ≈ 0,48 USD | ≈ 14 → 6 USD |
| Techo propuesto (límite duro) | 150 | ≤ 0,90 USD | ≤ 27 → 11 USD |
| Peor caso teórico (100 % por modelo, 200/día) | 200 | 1,20 USD | 36 USD |

Las **respuestas con datos no cuestan IA**: salen de lecturas ya cacheadas con plantillas. La voz (lectura en alto) se factura aparte y no está incluida.

### 4.3 Límites (todos por configuración, todos con prueba)
- Interruptor **`WOBI_NAVEGADOR_IA`** = `apagado` (por defecto) | `observacion` | `activo`. En `observacion` el modelo se ejecuta pero **no decide**: se registra solo si habría coincidido con el intérprete determinista (para medir calidad y coste con tráfico real antes de activarlo).
- Proceso propio **`navegador_interpretacion`** en la política de IA: **150 llamadas/día** (`WOBI_AI_API_PROCESS_DAILY_LIMITS`), 1 llamada por solicitud, sin reintentos, **timeout 10 s**, `max_tokens` 300, temperatura 0, entrada ≤ 40.000 caracteres (la real es ~9.000).
- Por identidad: ≤ 60 llamadas al modelo/día y ≤ 20/min (ya existe 40/min de peticiones).
- **Si falla el modelo, se acaba el presupuesto o está apagado:** se devuelve el resultado determinista (nunca un error ni una invención); `conversacional.disponible` pasa a `false` con su motivo. Los topes globales actuales (30 USD/día, 200 USD/mes) siguen mandando.
- Registro: solo métricas (tokens, coste, latencia, `modo`, coincidencia); **nunca el texto** ni las respuestas. Visible en `/costos_ia`.

## 5. Plan de pruebas (se escriben con el código)
- **Permisos:** el catálogo enviado al modelo excluye lo no autorizado; si el modelo propone un id no autorizado/inexistente → descartado y aclaración; Finanzas/Correo siguen exigiendo `admin`; el contexto no eleva permisos ni cruza identidades o dispositivos; un `conversacionId` ajeno o inventado se ignora.
- **Ambigüedad:** confianza `media/baja` o dos destinos cercanos → `aclaracion` (≤ 4 opciones abribles); «todas las empresas» en vista por compañía → pregunta; varias compañías nombradas → pregunta; sin contexto vigente no se adivina.
- **Contexto:** «y el de Footprint», «y las renovaciones», «el segundo», «sí»; compañía explícita manda; expira a los 10 min; no guarda texto; se aísla por identidad+dispositivo; se reinicia al cambiar de compañía en el selector.
- **Fuentes no disponibles:** fuente `ok: false` → `no_consultable` (nunca `items: []` ni `total: 0`); `conservado: true` → `incompleta` con la fecha real; `bitacora === null` → no es «sin actividad»; `calendarioPagos === null` → avisa de lo que falta; `refrescando` se propaga; `leidoEn` = el más antiguo.
- **Sin invención:** todas las cifras/fechas de `lectura` y `resumen` coinciden con los datos de prueba; las salidas del modelo con cifras, URLs o ids ajenos se rechazan por esquema; prueba de inyección en el texto («ignora las reglas…»).
- **Coste y límites:** apagado/sin presupuesto/timeout → resultado determinista sin llamar o sin error; no hay llamada si la identidad superó su tope; el registro no contiene texto; compatibilidad total de `/interpretar` y `/catalogo`.
- **Estática:** el módulo conversacional sigue sin importar herramientas de escritura, chat ni Holded/Gmail/Drive/Telegram; solo el cliente del modelo vía `crearMensajeAnthropic`.

## 6. Entregas propuestas
1. **E1 — Sin IA, sin coste:** contexto en servidor + `lectura` de Seguros (pagos pendientes, próximas renovaciones, actividad) con fecha/fuentes/estado + plantillas de `resumen` + `/conversar` funcionando en modo determinista, con todas las pruebas de §5 que no dependen del modelo. Codex ya puede conectar el front a este contrato.
2. **E2 — Modelo detrás de interruptor (apagado):** interpretación con esquema forzado, política de IA, límites y pruebas con un modelo simulado. Sigue sin consumir.
3. **E3 — Observación y activación:** `observacion` con tráfico real unos días, informe de coincidencia y coste, y solo entonces `activo` **con tu aprobación**.

## 7. Decisiones que necesito de Carlos
1. ¿Apruebas el **modelo (Sonnet 5)** y la **estimación de coste** (≈ 2–7 USD/mes en uso normal; techo duro ≈ 27 USD/mes)?
2. ¿Apruebas los **límites** (150 llamadas/día, 60 por persona/día, 10 s, sin reintentos) y el interruptor apagado por defecto?
3. ¿Apruebas que el **contexto de conversación** viva en memoria del servidor (solo datos estructurados, 10 minutos, se pierde al desplegar)?
4. ¿Empiezo por **E1** (sin IA, sin coste), que ya permite a Codex conectar el front?
