# Planeación estratégica en Corporate — contrato de la futura hoja

El espacio en Corporate está reservado para WOBA, Footprint Global y eWorks. **Todavía no hay una hoja conectada**: el front no debe mostrar avances, porcentajes, alertas ni estados inventados. El vínculo se añadirá cuando Carlos apruebe el plan y la ubicación de la hoja en Drive.

## Libro recomendado

Un libro por compañía es lo más fácil de gobernar. También puede usarse un único libro, siempre que cada fila de `Objetivos` e `Iniciativas` tenga `empresa` con uno de los identificadores estables `WOBA`, `Footprint`, `EWORKS`. No mezclar iniciativas de empresas distintas bajo el mismo objetivo. El panel filtrará en el servidor, además del contexto visual de compañía; elegir una empresa en el front nunca concede permisos.

| Pestaña | Unidad de cada fila | Columnas mínimas |
|---|---|---|
| `Objetivos` | Un objetivo estratégico | `id_objetivo`, `empresa`, `eje`, `objetivo`, `responsable`, `patrocinador`, `fecha_inicio`, `fecha_fin`, `prioridad`, `estado` |
| `Iniciativas` | Una iniciativa que ejecuta un objetivo | `id_iniciativa`, `id_objetivo`, `empresa`, `iniciativa`, `responsable`, `fecha_inicio`, `fecha_fin`, `avance_pct`, `estado`, `enlace_evidencia` |
| `Indicadores` | Un KPI de un objetivo | `id_indicador`, `id_objetivo`, `nombre`, `unidad`, `linea_base`, `meta`, `sentido`, `frecuencia`, `responsable` |
| `Seguimiento` | Una revisión fechada de una iniciativa o indicador | `id_revision`, `fecha_corte`, `id_iniciativa`, `id_indicador`, `valor_actual`, `avance_pct`, `resultado`, `bloqueo`, `siguiente_accion`, `proxima_revision`, `enlace_evidencia` |

Usar fechas ISO `AAAA-MM-DD`, porcentajes entre 0 y 100, importes con moneda explícita y enlaces de Drive verificables. Las claves `id_*` no se reutilizan ni se basan en el número de fila. En `Seguimiento` se agrega una fila por revisión, sin sobrescribir la anterior: así WOBi puede explicar cuándo cambió un avance y con qué evidencia. Un indicador puede tener varias mediciones. Los estados se acordarán con Carlos antes de conectar la hoja; el lector rechazará estados desconocidos en vez de interpretarlos como completados.

## Cuando exista el plan

1. Confirmar quién puede editar y aprobar cada compañía y la periodicidad de seguimiento; la hoja no altera los permisos actuales de WOBi.
2. Guardar el ID del libro en configuración del servidor por compañía, nunca en el bundle del front. Dar a la cuenta de servicio permiso de **lectura**.
3. Validar encabezados, claves, referencias cruzadas, fechas y empresa antes de mostrar el primer resumen. Si una lectura falla, mostrar la última lectura válida con fecha o «sin dato verificado».
4. Calcular objetivos vencidos, hitos próximos y desviaciones según fecha, meta y último seguimiento. Alertas y recordatorios se habilitarán después de probar con casos reales; no enviar mensajes automáticos desde el mero hecho de conectar el libro.

Esta primera entrega solo reserva la herramienta y documenta el contrato. El conector y la vigilancia temporal son una fase posterior, separada de la corrección actual de las fuentes de Cerebro.
