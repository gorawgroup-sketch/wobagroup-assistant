# Navegación precisa de Seguros — 10-10-2026

Capturas con el fixture público `docs/ejemplos/estado-seguros.json`, nunca datos adicionales de producción.
El front compilado se probó en Chrome contra `crearRouterNavegador` compilado, con sesión local de consulta.

- [WOBA: pagos pendientes](woba-pagos.png).
- [eWorks: próximas renovaciones](eworks-renovaciones.png).
- [Footprint seleccionada: actividad del grupo](footprint-actividad-grupo.png).
- [Sin lectura actual](sin-lectura.png).
- [Móvil: grupo completo](movil.png).

Se recorrieron los tres destinos en las tres compañías (nueve aperturas), comprobando separación de pagos,
vencimientos sin pagos y actividad del grupo sin atribución empresarial. Se verificaron aclaraciones por grupo
(y selección de compañía), fechas sin soporte, rechazo de Finanzas con sesión de consulta, null, voz PCM de prueba
por el reproductor existente y amplitud del enjambre al reproducir/silenciar. Ningún error del navegador ni desbordamiento móvil.

En producción, GET `/api/cerebro/estado` respondió 200 y devolvió las cuatro listas necesarias. El intérprete
respondió 200 con `destino_no_implementado` y alternativa: las nuevas vistas aún no están desplegadas.
