# Navegador de WOBi — contrato del servidor (fase 3, solo lectura)

Respuesta de Claude Code al encargo de `docs/encargo-navegador-wobi.md` (#432), pensada para acordar con el front del #433. El servidor **interpreta y valida**; no abre nada, no ejecuta herramientas y no modifica datos. Todo vive en `core/cerebro/navegador/` y se monta en `src/server.ts` en `/api/cerebro/navegador`.

## Principios (qué garantiza el servidor)

- **Un único catálogo.** El servidor carga `frontend-cerebro/src/modules/navegador/capabilities.mjs` (`buildCapabilities()`, derivado de `organization.mjs`): no hay copia. Registrar un área o módulo en el front lo hace descubrible aquí sin tocar el backend. Si el archivo falta o tiene una forma inesperada, el servidor responde **503** y no abre nada; nunca un catálogo vacío ni inventado.
- **Versión del catálogo** = `nav-` + 12 primeros hex de SHA-256 de `[id, status, target.kind, target.id, target.area, target.module, scope, companies ordenadas]` de cada capacidad, ordenadas por `id`. Cambia si cambia cualquier destino, estado, alcance o compañía (p. ej. al implementar una vista).
- **Identidad y permisos del servidor.** Misma identidad que el chat: cabeceras `X-Cerebro-Key`, `X-Cerebro-Device` y `X-Cerebro-Nombre`. Del cuerpo solo se leen `texto`, `seleccion`, `companyId` y `requestId`; cualquier otro campo (rol, permisos, capacidades, URLs, selectores) **se ignora**. Seleccionar una compañía no concede permisos.
- **Sin camino a acciones.** El módulo no importa herramientas, chat, modelos, Holded, Drive, Gmail ni Telegram (una prueba estática lo vigila). No hay IA en esta entrega: la interpretación es determinista (nombres y sinónimos contra el catálogo), sin coste por petición.
- **Salida acotada.** Solo `capabilityId` registrado + `companyId` válido. Nunca URLs, scripts ni selectores; el texto del usuario no se copia a la respuesta.

## Endpoints

### `GET /api/cerebro/navegador/catalogo`
```json
{ "version": "nav-298552fbccff", "generadoEn": "2026-10-10T09:00:00.000Z", "companias": ["EWORKS","Footprint","WOBA"],
  "capacidades": [ { "id": "module:finance:cashflow", "label": "Tesorería y cashflow", "description": "…", "status": "available",
    "target": { "kind": "module", "id": "cashflow" }, "companies": ["WOBA","Footprint","EWORKS"],
    "acceso": "permitido | permiso_insuficiente", "nivelRequerido": "admin" } ] }
```
`acceso` es el de **esta** identidad. El front puede usarlo para pintar, pero **no es autorización**: cada interpretación vuelve a validar.

### `POST /api/cerebro/navegador/interpretar`
Cuerpo: `{ "texto": "…" | "seleccion": { "capabilityId", "companyId" }, "companyId": "WOBA", "requestId"?: "8-64 [A-Za-z0-9_-]" }`.
`texto`: 1–200 caracteres. `seleccion`: la opción de una aclaración anterior (se valida igual, sin texto). `requestId` se devuelve tal cual; si falta, lo genera el servidor.
Todas las respuestas llevan `requestId` y `catalogVersion` y `Cache-Control: no-store`. Tres variantes:

```jsonc
// 1) destino
{ "tipo": "destino", "requestId": "…", "catalogVersion": "nav-…", "capabilityId": "module:insurance:seguros",
  "companyId": "Footprint", "companyOrigen": "texto | seleccionada", "etiqueta": "Control de seguros", "avisos": [] }

// 2) aclaracion — solo opciones que esta identidad puede abrir y que están disponibles
{ "tipo": "aclaracion", "requestId": "…", "catalogVersion": "nav-…", "pregunta": "¿A cuál te refieres?",
  "opciones": [ { "capabilityId": "…", "companyId": "WOBA", "etiqueta": "…", "sinFiltro": true } ] }

// 3) no_disponible
{ "tipo": "no_disponible", "requestId": "…", "catalogVersion": "nav-…", "motivo": "agente_previsto | destino_no_implementado | permiso_insuficiente | fuente_no_consultable",
  "mensaje": "…", "capabilityId": "…", "companyId": "…" }
```

Errores HTTP (la UI los muestra como «error», nunca como «sin resultados»): `400` entrada inválida · `403` sesión o dispositivo no reconocidos · `429` demasiadas peticiones (40/min por clave) · `503` identidad o catálogo no disponibles. Ninguno filtra detalles internos.

## Cómo se decide (en este orden)

1. **Compañía.** La seleccionada, salvo que el texto nombre exactamente una (`companyOrigen: "texto"`). Si nombra varias → `aclaracion` entre ellas.
2. **Capacidad.** Se puntúa el texto contra nombres y sinónimos del catálogo. Un solo ganador claro → destino; varios cercanos → `aclaracion`; un área y su único módulo coincidentes → el módulo. Sin coincidencia → `aclaracion` con áreas permitidas, o `no_disponible: destino_no_implementado` si pide cifras/fechas/filtros.
3. **Filtros, secciones, fechas y cifras** (pendientes, vencimientos, pagos, renovaciones, «cuánto…», meses…): hoy ningún destino los admite → `aclaracion` con **una sola opción `sinFiltro: true`** («solo se abre el módulo completo, ¿lo abro?»). Nunca se abre el módulo genérico como si estuviera filtrado.
4. **Estado y permisos del destino:** área `planned` → `agente_previsto` · sin permiso → `permiso_insuficiente` · fuente no consultable → `fuente_no_consultable` · si no, `destino`.

### Permisos (propuesta conservadora, un solo sitio: `permisos.ts`)
Nivel de la identidad: dispositivo sin vincular = `anonimo`; vinculado = su rol (`colaborador` < `admin` < `superadmin`).
`area:finance` y `module:finance:*` → `admin` · `module:operations:correo` → `admin` · seguros, documentos, calendario, conocimiento, planeación y áreas previstas → `anonimo` (ya se consultan en solo lectura) · **una capacidad nueva sin política exige `colaborador`** (se cierra por defecto, no se abre).

### Fuentes (hechos, no permisos)
`module:finance:cashflow`: **Footprint → `fuente_no_consultable`** (sin fuente propia); WOBA y eWorks → `destino` con `avisos: ["El cashflow es conjunto de WOBA y eWorks…"]`. No se atribuyen saldos conjuntos a una empresa.

## Qué cambia en el front (#433) para conectarlo — propuesta

1. **Cliente:** `POST /interpretar` con `AbortController` (cancelar al iniciar otra petición). Estados reales: «Interpretando…» solo mientras la petición está viva; «Abriendo…» al recibir `destino`; «Aquí está» solo **después** de abrir el destino.
2. **`destino`:** validar `capabilityId`/`companyId` con `validateDestination` local (defensa en profundidad) y abrir. Si la versión del catálogo difiere de la que tiene, refrescar `GET /catalogo`. Mostrar `avisos` si los hay y, si `companyOrigen === "texto"`, indicar la compañía abierta.
3. **`aclaracion`:** mostrar `pregunta` y `opciones`; al elegir una, llamar de nuevo con `{ seleccion, companyId }` (el servidor la revalida). La opción `sinFiltro` debe decir claramente que abre el módulo completo.
4. **`no_disponible`:** mostrar `mensaje`; el `motivo` decide el estilo (previsto, no implementado, permiso, fuente). «No pude consultar la fuente» (`fuente_no_consultable`) no es «no hay resultados».
5. **Fallo de red/HTTP:** error visible y reintentable; **no** abrir nada por inferencia local cuando el servidor no respondió. El descubrimiento local por nombre puede seguir como atajo para coincidencias exactas de nombre, pero cualquier petición con compañía explícita, filtro, fecha o cifra debe ir al servidor.
6. **No hacer:** enviar rol/permisos/capacidades, componer URLs o selectores a partir de la respuesta, ni usar `acceso` del catálogo como autorización.

## Fuera de esta entrega
Interpretación con modelo (decisión de coste pendiente), audio/voz (sesión existente, límites y errores) y secciones/filtros reales (Codex registra cada destino exacto y añade pruebas; entonces entran en el catálogo y el servidor los descubre).

---

## Ampliación: destinos precisos de Seguros (secciones)

Una **sección** es un destino preciso *dentro* de un módulo. Solo lectura, con los permisos actuales de Seguros y siempre con compañía explícita; el servidor devuelve ids **registrados** en el catálogo, nunca URLs, rutas ni selectores.

### Qué se registra (catálogo único: `organization.mjs` → `capabilities.mjs`)
El módulo `seguros` declara `sections`; `buildCapabilities()` genera una capacidad por sección:

| `capabilityId` | Qué debe mostrar la vista | `scope` |
|---|---|---|
| `section:insurance:seguros:pagos_pendientes` | Pagos de pólizas sin confirmar (`estado.pagosSinConfirmar`) de **la compañía elegida** | `company` |
| `section:insurance:seguros:proximas_renovaciones` | Renovaciones y vencimientos próximos (`estado.proximos`, `proximasARenovar`) de **la compañía elegida** | `company` |
| `section:insurance:seguros:actividad` | Actividad de Wobi Seguros (`estado.bitacora`) | `group` |

```jsonc
{ "id": "section:insurance:seguros:actividad", "label": "Actividad de Wobi Seguros", "description": "…", "status": "registered",
  "scope": "group", "target": { "kind": "section", "area": "insurance", "module": "seguros", "id": "actividad" }, "companies": ["WOBA","Footprint","EWORKS"] }
```
- **`status`** pasa a tener tres valores: `available` (abrible), `planned` (área prevista) y **`registered`** (destino registrado cuya vista el front aún no ha implementado). Hoy las tres secciones son `registered` (`implemented: false` en `organization.mjs`).
- **`scope`** (nuevo, opcional): `company` = datos de la compañía elegida; `group` = datos del grupo completo, que **no** se atribuyen a una sola compañía. La actividad de Wobi Seguros es del grupo (la vista ya dice «Grupo completo»).
- **`target`** de una sección lleva `area` y `module` además de `kind` e `id`. Los destinos actuales (`area`, `module`) no cambian.
- **Permisos:** una sección **hereda exactamente** los de su módulo (`module:insurance:seguros` → hoy cualquier sesión válida, solo lectura). Una sección de un módulo sin política se cierra por defecto.

### Qué responde el servidor
Peticiones como «pagos pendientes de seguros», «seguros pendientes de pago», «próximas renovaciones», «qué seguros vencen pronto», «actividad de Wobi Seguros», «qué ha hecho Wobi Seguros»:

1. **Vista aún no implementada (`registered`, el estado de hoy)** → `no_disponible` con `motivo: "destino_no_implementado"`, `capabilityId` = la sección reconocida, `companyId`, y **`alternativa`** (campo nuevo y opcional): `{ capabilityId: "module:insurance:seguros", companyId, etiqueta, sinFiltro: true }`, el módulo completo que sí se puede abrir. Nunca `destino`.
2. **Vista implementada (`available`)** → `destino` con `capabilityId` de la sección y `companyId` explícito (`companyOrigen: "seleccionada" | "texto"`). Para `scope: "group"` lleva `avisos: ["Esta vista es del grupo completo: no se atribuye a una sola compañía."]`.
3. **Empresa explícita.** «De todas las empresas», «del grupo» o «conjunto» en una vista `company` → `aclaracion` con una opción por compañía (no existe vista conjunta y no se elige por el usuario). Varias compañías nombradas → `aclaracion` entre ellas. En una vista `group` no se pregunta.
4. **Filtros que la sección no resuelve** (fechas, cifras, otros): `aclaracion` con una única opción `sinFiltro: true` sobre la **sección**. Lo que la sección ya resuelve por sí misma no cuenta como filtro (`pendientes`/`pagos` en pagos pendientes; `renovaciones`/`vencimientos` en renovaciones).
5. **Dos secciones a la vez** («pagos y renovaciones de seguros») → `aclaracion` entre ambas si están implementadas; si no, `destino_no_implementado` nombrando las dos.
6. **Sin la palabra de Seguros** («pagos pendientes» a secas, «actividad») no se adivina el dominio: `destino_no_implementado` (cifras/filtros) o `aclaracion` con áreas. Excepción: «renovaciones» sola, que solo existe en Seguros.
7. **`seleccion`** de una sección se valida igual (implementada → `destino`; sin implementar → `destino_no_implementado`; sin permiso → `permiso_insuficiente`).

**Compatibilidad:** `area` y `module` responden igual que antes (hay una prueba que compara las respuestas con y sin secciones). Lo único que cambia es la respuesta a estas tres intenciones: antes `aclaracion` con el módulo completo, ahora `destino_no_implementado` (+ `alternativa`) hasta que la vista exista, y `destino` después.

### Lo que implementa Codex (front) para activarlas
1. Hacer la vista exacta de cada sección dentro de `SegurosPanel` (datos que ya trae `estado`) y una forma de **abrirla por su id** (`target.module` + `target.id`).
2. En `NucleoVivo` (manejo de `destino`): si `target.kind === 'section'`, abrir el módulo `target.module` y mostrar la sección `target.id`. Hoy ese manejador solo conoce `area` y `module`.
3. Poner `implemented: true` en la sección correspondiente de `organization.mjs`, con sus pruebas. En cuanto se despliegue, el servidor empieza a devolver `destino` para ella sin tocar el backend.
4. Mostrar `avisos` (actividad del grupo) y, ante `no_disponible`/`destino_no_implementado` con `alternativa`, ofrecer abrir el módulo completo marcándolo como «sin filtrar».
5. `findDestinations` (descubrimiento local) ya **no ofrece secciones** por nombre; solo la interpretación del servidor las propone.


### Implementación del front: vistas precisas de Seguros

`SegurosDestination` abre únicamente la sección registrada. Pagos usa `pagosSinConfirmar`; renovaciones combina `proximasARenovar` y los eventos de tipo `vencimiento` de `proximos`, sin duplicar la misma póliza/fecha ni incluir pagos. No calcula importes ni plazos nuevos. `null` conserva «Sin lectura actual»; las dos listas de renovaciones conservan su disponibilidad por separado. Actividad reutiliza la bitácora del grupo sin filtrarla por empresa.

La compañía se indica en las opciones de aclaración. Fechas adicionales sin soporte se rotulan «sin filtro adicional»; nunca se anuncian como aplicadas. «Ver Control de seguros completo» sale de la vista precisa y vuelve al módulo habitual, sin activar escrituras. La voz sigue el camino existente y el enjambre del módulo reacciona a su amplitud.
