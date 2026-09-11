# Bloque 6C — comprobantes de compra durables en Holded

## Resultado

La carga de comprobantes a compras ya no interpreta un timeout como permiso para repetir el `POST`. Cada aprobación queda registrada en `_adjuntos_holded_durables` antes del efecto externo y avanza por `preparado → subiendo → verificado` o `incierto`.

El ledger conserva únicamente hashes SHA-256, empresa, identificadores técnicos, nombre opaco, estado y tiempos. No guarda bytes, nombres originales, proveedores, importes ni credenciales.

## Flujo seguro

1. Leer la copia local y rechazar archivos vacíos o superiores a 10 MB antes de Holded y antes del ledger.
2. Calcular SHA-256 y generar un nombre estable `comprobante_wobi_<hash>.ext` por empresa, compra y contenido.
3. Consultar la lista de adjuntos y descargar cualquier candidato con ese nombre.
4. Comparar los bytes descargados por SHA-256. Si coinciden, reutilizarlo sin `POST`.
5. Marcar `subiendo` antes de llamar una sola vez al endpoint de carga.
6. Ante timeout, error transitorio, respuesta exitosa sin identificador o fallo del checkpoint, reconciliar solo con `GET`. Nunca repetir automáticamente el `POST`.
7. Reconciliar estados pendientes al arrancar y elevarlos en `/health` y en el control diario.

La API de Holded documenta el límite de 10 MB y la respuesta `201` con identificador en [Attach a file to a purchase](https://www.holded.com/developers/api-reference/purchases/attach-a-file-to-a-purchase). La verificación usa [List purchase attachments](https://www.holded.com/developers/api-reference/purchases/list-purchase-attachments) y [Get purchase attachment](https://www.holded.com/developers/api-reference/purchases/get-purchase-attachment).

## Reversión

- Código: revertir el commit de este bloque.
- Respaldo temporal: definir `WOBI_HOLDED_ATTACHMENT_DURABLE_ENABLED=false` restaura la ruta anterior sin eliminarla.
- Datos: no borrar `_adjuntos_holded_durables`; sirve para auditar efectos que pudieron quedar inciertos.

Mientras Google Sheets sea el ledger, Railway debe mantener una sola réplica. El mutex en memoria serializa dos aprobaciones concurrentes que convergen en la misma compra y contenido, pero no coordina procesos distintos.

## Validación sin efectos financieros

Las pruebas usan repositorios y transportes en memoria. Cubren repetición de aprobación, deduplicación entre propuestas, interrupción, timeout aplicado y no aplicado, rechazo definitivo, conflicto de contenido, fallo de checkpoint, reconciliación de solo lectura, opacidad de la identidad y configuración de respaldo. No llaman a Holded ni escriben en Sheets.
