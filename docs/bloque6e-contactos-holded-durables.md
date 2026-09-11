# Bloque 6E — creación durable de contactos en Holded

## Riesgo auditado

`POST /api/v2/contacts` crea un contacto y devuelve un ID nuevo. La API documentada no expone una clave de idempotencia para esta operación. Antes de este bloque WOBI serializaba dos creaciones simultáneas dentro del mismo proceso, pero un timeout o reinicio después del POST podía permitir que otra aprobación creara un segundo proveedor permanente.

## Flujo implantado

1. Validar y normalizar empresa, nombre y código fiscal antes de cualquier escritura.
2. Reservar la identidad empresa + proveedor + NIF/CIF en `_contactos_holded_durables` antes del efecto.
3. Consultar mediante la credencial de solo lectura. Si existe NIF/CIF, usar el filtro exacto oficial; si no, usar la búsqueda paginada por nombre y exigir igualdad normalizada.
4. Si existe una sola coincidencia, reutilizarla. Si existen varias o hay un código fiscal incompatible, bloquear la creación y pedir revisión.
5. Marcar `creando` antes del único `POST /contacts` permitido.
6. Ante timeout, error transitorio, `408`, `409`, `425`, `429`, caída del ledger o respuesta perdida, ejecutar únicamente lecturas posteriores. Nunca repetir el POST.
7. Reconciliar estados pendientes al arrancar, exponer métricas agregadas en `/health` y elevar incertidumbres en el control diario.

Referencias oficiales: [Create a contact](https://www.holded.com/developers/api-reference/contact/create-a-contact), [List contacts](https://www.holded.com/developers/api-reference/contact/list-contacts) y [Search contacts by name](https://www.holded.com/developers/api-reference/contact/search-contacts-by-name).

## Privacidad y reversión

El ledger conserva nombre y, cuando existe, código fiscal porque son los datos mínimos necesarios para recuperar una creación tras un reinicio. No guarda facturas, importes, direcciones, emails, documentos, prompts ni credenciales. Los identificadores de búsqueda y la huella de solicitud son hashes SHA-256.

- `WOBI_HOLDED_CONTACT_DURABLE_ENABLED=false` recupera temporalmente la ruta anterior.
- Revertir el commit elimina la integración sin borrar el ledger de auditoría.
- Mientras Sheets sea el ledger, Railway debe mantener una sola réplica.

Las pruebas usan repositorio y transporte en memoria: no crean contactos reales ni escriben en Sheets.
