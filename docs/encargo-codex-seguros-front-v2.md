# Encargo para Codex (v2) — «qué hace Wobi Seguros y cuándo» en el panel de Seguros del Núcleo

Pedido de Carlos (06-10-2026): *«es importante poder ver qué es lo que está haciendo [Wobi Seguros] y saber en qué momento lo hace, ver en qué calendario quedan las cosas registradas y cómo he recibido las alertas».* Es la segunda entrega del panel; la primera es `docs/encargo-codex-seguros-front.md` (PR #363). **No empezar hasta que el PR de la bitácora esté fusionado y desplegado** (los datos tienen que existir en producción).

## Reparto, para no pisarnos
- **Claude Code (backend, hecho):** el contrato. Forma exacta y comentada en `core/seguros/estadoCerebro.ts` (`EstadoSeguros`) y `core/seguros/bitacora/vistas.ts`; ejemplo en `docs/ejemplos/estado-seguros.json` (los campos nuevos del ejemplo están construidos con las mismas funciones que producción, a partir de la siembra real del calendario y de entradas de muestra: **ilustrativos, no datos reales**). Descripción completa: `docs/wobi-seguros.md` §28. Si falta un dato, se pide a Claude Code; el front no recalcula nada de seguros ni lee Sheets.
- **Codex (front):** `frontend-cerebro/src/modules/seguros/` y los helpers de `companyScope.mjs`. No tocar `core/seguros/`.

## Qué entregar (por prioridad)

**P1 — «Actividad de Wobi Seguros»** (`bitacora`, la más reciente primero). Una línea de tiempo agrupada por día (hora de Madrid): hora · etiqueta de la tarea (`etiqueta`) · distintivo de `resultado` (`sin_novedades` neutro, `con_novedades` verde, `con_advertencias` ámbar, `error` rojo) · `resumen`. Al desplegar una línea: sus `avisos` (el texto exacto que recibió Carlos; si `entregado === false`, «No llegó a Telegram»), sus `eventos` de calendario (creado/retirado, título e inicio) y sus `notas`. Filtro por tarea. `bitacora === null` ⇒ «Sin lectura actual» (nunca «sin actividad»); `[]` ⇒ «Aún sin actividad registrada: la bitácora empezó el 08-10-2026».

**P2 — «Cuándo trabaja»** (`programacion`, siempre presente). Una fila por tarea: `nombre`, `cuando` (frase lista), `proxima` (relativa: «hoy 17:35», «mañana 08:35»), `ultima` (hora, resultado y resumen) y `estado`: `al_dia` verde, `retrasada` **rojo y visible** («su última cita no dejó constancia»), `sin_registro` neutro («aún sin constancia: la bitácora es nueva»), `sin_lectura` gris, `bajo_demanda` («cuando se le pregunta»; `conIA` ⇒ distintivo «usa IA al preguntarle»). Sustituye al bloque «Vigilante · horarios» de la v1 (`vigilante.horarios` sigue existiendo).

**P3 — «Calendario de pagos»** (`calendarioPagos` + `calendario`). Cabecera con `calendario.texto` y la cuenta (`calendario.cuenta`). Lista ordenada por fecha: fecha y `diasRestantes`, empresa, concepto, importe (con «estimado» si `estimado`), `cuentaDeCargo` y `forma`, estado del evento (`evento.estado`: `creado` ✓ en el calendario, `pendiente` «se creará mañana a las 8:55», `no_aplica`) con su `evento.titulo`/`evento.inicio`, y los `avisosEnviados` en palabras. Los pagos con `estado !== 'previsto'` (pagado, devuelto, cancelado) se pliegan como historia. `null` ⇒ «Sin lectura actual».

**P4 — «Alertas que recibí».** Un filtro de P1 («Solo avisos») que enseña únicamente las líneas con `avisos` y el texto completo de cada uno, con la hora de entrega. Es la respuesta a «¿cómo he recibido las alertas?».

## Cómo hacerlo
- Selector de empresa: `calendarioPagos` se filtra por `empresa` (en `companyScope.mjs`, junto a `proximos`); `bitacora` y `programacion` son del **grupo entero** (rotularlos «grupo completo», como memoria y vigilante).
- `complementosDisponibles === false` ⇒ `bitacora` y `calendarioPagos` vienen a `null`: «Sin lectura actual».
- Solo lectura: ningún botón nuevo. Cualquier texto que venga de los avisos o de los resúmenes se pinta como **texto** (nunca HTML).
- Pruebas: helpers puros en `segurosView.mjs` con `docs/ejemplos/estado-seguros.json` como fixture (agrupar por día, distintivos, `null` ⇒ sin lectura, `[]` ⇒ aún sin actividad, filtro por tarea, solo avisos) y el filtro de `calendarioPagos` por empresa en `companyScope.test.mjs`.
- Verificación: tras desplegar, `GET /api/cerebro/estado` debe traer `seguros.programacion` con 5 tareas y, pasada la primera mañana (8:35 / 8:50 / 8:55), `seguros.bitacora` con sus entradas; capturas de P1–P4 y del caso «Sin lectura actual».

## Además, en este mismo PR

- **Dos detalles pendientes de la revisión del #363:** (1) con `complementosDisponibles === true` y `vigilante.ultimaRevision === null` debe decir «Aún sin revisión registrada» (hoy dice «Sin lectura actual»); (2) un hito con `diasRestantes === 0` debe decir «hoy», no «vencido».
- **«Documentos leídos» con más documentos:** el 08-10-2026 Wobi Seguros leyó las condiciones de las pólizas vigentes (generales, particulares, cartas de pago, certificados…), así que cada póliza pasa de 0-1 documentos a 3-6, cada uno con un `resumen` de hasta 4.000 caracteres. Comprobar que la lista sigue siendo cómoda: ordenada por `fechaDocumento` (la más reciente primero), plegada por defecto si hay más de 2, con «Ver resumen completo» en cada uno y la `vigencia` bien visible (hay documentos de periodos anteriores).

## Cuándo empezar
Con `main` actualizado y **fusionados** el #363 (panel v1) y el PR de la bitácora (backend). Rama nueva desde `main`; el PR no toca `core/seguros/`, así que no choca con la regla de CI «dueño único por área».

## Fuera de alcance
Avisar por Telegram cuando una tarea va `retrasada` (backend, pendiente de decidir el margen); editar horarios; ejecutar tareas desde el panel.

## Ampliación del contrato (09-10-2026, a petición de Codex en el PR #425)
- `bitacora[].avisos[].texto` ya **no se recorta a 700 caracteres**: viaja entero (hasta 8.000 caracteres; los avisos más recientes siempre enteros). Si algún aviso se cortó (por tamaño de fila o por el presupuesto de texto del contrato, que acorta los más antiguos a 1.500), trae **`truncado: true`**: rotularlo «texto recortado».
- `bitacora[].avisos[].entregadoEn` (ISO UTC, opcional): el instante exacto en que Telegram aceptó **ese** mensaje. Usarlo como «Hora de entrega» (hora de Madrid) cuando exista; si falta (constancias anteriores al 09-10-2026, o `entregado: false`) mantener el rótulo actual de hora de ejecución. Una pasada puede tener varios avisos (p. ej. un informe pendiente reenviado y el nuevo), cada uno con su hora.

