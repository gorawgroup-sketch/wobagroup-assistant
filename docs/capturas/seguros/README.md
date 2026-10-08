# Capturas del panel de Seguros

Estas capturas muestran el recorrido Núcleo → Seguros → Control de seguros en la rama `codex/seguros-panel`, con una sesión local de prueba y **datos completamente ficticios**. No representan el fixture de pruebas ni una lectura actual de producción. Las pruebas automatizadas sí usan `docs/ejemplos/estado-seguros.json`.

- [WOBA](woba.png)
- [eWorks](eworks.png)
- [Footprint](footprint.png)
- [Complementos sin lectura](sin-lectura.png)

Los pendientes y el vigilante conservan la etiqueta «grupo completo» en las tres vistas. La última captura simula `complementosDisponibles: false` para comprobar que memoria, documentos, pendientes y revisión indiquen «Sin lectura actual».
