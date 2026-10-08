# Seguros v2 — verificación visual

Capturas del panel real dentro del Núcleo, con datos **ficticios de demostración** y sin credenciales, cuentas ni avisos privados. P1/P2/P4 son del grupo completo incluso al cambiar la empresa; P3 muestra solo los pagos de la empresa seleccionada.

| Vista | WOBA | EWORKS | Footprint |
|---|---|---|---|
| P1 Actividad | [WOBA](woba-p1.png) | [EWORKS](eworks-p1.png) | [Footprint](footprint-p1.png) |
| P2 Cuándo trabaja | [WOBA](woba-p2.png) | [EWORKS](eworks-p2.png) | [Footprint](footprint-p2.png) |
| P3 Calendario de pagos | [WOBA](woba-p3.png) | [EWORKS](eworks-p3.png) | [Footprint](footprint-p3.png) |
| P4 Solo avisos | [WOBA](woba-p4.png) | [EWORKS](eworks-p4.png) | [Footprint](footprint-p4.png) |

También: [actividad sin lectura](sin-lectura-p1.png), [programación sin lectura](sin-lectura-p2.png), [calendario sin lectura](sin-lectura-p3.png), [móvil](movil-sin-lectura.png), [bitácora nueva](sin-actividad.png) y [seis documentos con resumen completo](documentos.png).

Comprobado en navegador: filtros combinados, avisos no entregados, aislamiento por empresa, bitácora vacía frente a fallo de lectura, revisión sin registro, seis documentos ordenados y plegados, resumen de 4.000 caracteres íntegro y texto parecido a HTML sin ejecución. Sin errores de consola, sin desbordamiento horizontal en móvil y sin solicitudes de escritura durante estas pruebas.

## Verificación real y límites del contrato

GET autenticado `/api/cerebro/estado` en producción devolvió 200, `programacion` con 5 tareas, `calendarioPagos` con 6 pagos, `complementosDisponibles: true` y `bitacora: []` en la consulta de esta entrega. La bitácora todavía no acredita pasadas programadas; el front dice que empezó el 08-10-2026, sin fabricar entradas anteriores. Se necesita comprobar las entradas tras las primeras pasadas programadas del backend.

Datos que debe ampliar Claude Code para completar el requisito de avisos:

1. `vistaBitacora` recorta `avisos[].texto` a 700 caracteres y el almacén también limita el texto. El front muestra todo lo recibido, pero no puede recuperar lo omitido ni garantizar que sea el aviso original completo.
2. `AvisoRegistrado` no incluye fecha/hora individual de entrega. `cuando` es el final de la ejecución, no la entrega. Se rotula «Hora de ejecución» y se declara que la hora individual de entrega no está disponible. Para mostrar la entrega exacta se necesita un campo acordado en el contrato.

No se modificó `core/seguros/`, no se leyó Sheets y no se activó auto-merge.
