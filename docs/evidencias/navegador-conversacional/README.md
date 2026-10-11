# Integración conversacional E1 — verificación del front

Capturas de Chrome del front compilado contra el router real compilado de Claude (#444), con el fixture público `docs/ejemplos/estado-seguros.json`. No son datos ni credenciales de producción. Las fechas están fijadas para reproducibilidad.

- completa.png: destino preciso y resumen con fuentes y hora de Madrid.
- incompleta.png: fallo de fuente conservando su última lectura, identificado explícitamente.
- no-consultable.png: fuente fallida sin lectura anterior; no abre destino ni representa cero.

Además se verificaron seguimiento WOBA → Footprint → renovaciones → actividad del grupo, reinicio de contexto, permisos de Finanzas, audio/enjambre y ausencia de desbordamiento móvil. El audio local se simula; no se grabó un micrófono físico.

Validación: npm test (2165 backend: 2159 pasan, 6 omitidas; 86 adicionales pasan), npm run typecheck y npm run build sin fallos.
