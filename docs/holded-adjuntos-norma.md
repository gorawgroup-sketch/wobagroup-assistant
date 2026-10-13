# Norma de adjuntos en Holded (2026-10-13)

**Hecho medido.** En Holded cada `PUT /purchases/{id}` duplica la lista de adjuntos de la compra (adjuntos = 2^n). El PUT es un reemplazo completo y la API v2 **no permite borrar adjuntos** (solo `GET` y `POST`; comprobado en `api.holded.com/openapi/api2.json`). Un duplicado solo se limpia a mano en la interfaz (borrar el primer adjunto borra todas las copias, que comparten nombre) y después hay que volver a subir el comprobante.

**Caso real.** 10 compras de Footprint con entre 4 y 32.768 copias de su comprobante (una imposible de abrir en Holded). Causa: la reparación del correo automático volvía a hacer PUT sobre las mismas compras en cada subida de `VERSION_POLITICA`. Resuelto el 13-10: comprobantes rescatados en Drive y repuestos con `POST /admin/restaurar-comprobante`; las 10 verificadas con 1 adjunto idéntico.

## Reglas (todas con prueba)
1. **Un gasto = un comprobante.** La subida (`adjuntarComprobanteHolded`) es durable, idempotente por clave y por huella del contenido; no sube si la compra ya tiene ≥ 3 adjuntos.
2. **Sin PUT si no hay cambios** (`edicionCompraSinCambios`, huella completa v3).
3. **Una automatización nunca hace PUT sobre una compra con adjuntos**, y no más de 2 PUT automáticos por compra en su vida.
4. **Una edición aprobada por una persona no se hace si la compra ya tiene ≥ 3 adjuntos**: el peor caso son 4 copias, nunca miles.
5. **Una lectura de adjuntos fallida no se toma por «sin adjuntos»**: no se edita ni se sube a ciegas.
6. **Si un PUT aumenta los adjuntos, aviso inmediato a los administradores** (Telegram) con los pasos para dejarla bien.
7. **Detector diario (8:35)** de compras editadas en los últimos 14 días con ≥ 4 adjuntos.
8. **Candado estructural** (`core/guardarrailes/adjuntosCompras.test.ts`): solo existe un punto de PUT sobre compras (`aplicarEdicionPreparada`), solo dos vías de subida de adjuntos y todo llamador entrega clave idempotente. Un cambio que abra otro camino rompe las pruebas.

## Cómo dejar una compra duplicada
Abrir la compra en Holded → borrar el primer adjunto → avisar a Wobi. Para las 10 del caso original, `POST /admin/restaurar-comprobante` (`x-admin-secret`) sube la copia rescatada solo si la compra tiene 0 adjuntos. No editar ni «Guardar» la compra antes de limpiarla.
