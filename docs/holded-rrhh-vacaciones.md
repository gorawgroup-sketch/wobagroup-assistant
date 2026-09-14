# Consulta segura de vacaciones en Holded

## Qué queda disponible para Wobi

La herramienta `consultar_vacaciones_holded` es de solo lectura y está
disponible tanto en el chat como en las respuestas automáticas por correo.
Busca hasta cinco personas mediante el endpoint oficial de empleados y solo
devuelve:

- nombre del empleado;
- si tiene una política de ausencias asignada;
- días anuales del contrato, únicamente cuando Holded devuelve una cifra.

Nunca devuelve el objeto original de Holded. Así se evita filtrar salario,
documentos, cuenta bancaria, dirección, fecha de nacimiento, nómina u otros
datos personales al modelo, al chat, al correo o a los registros.

## Reglas de seguridad

- La credencial es la llave de lectura de la empresa y debe tener el permiso
  `team:employees.read`.
- La empresa siempre es explícita: WOBA, EWORKS o Footprint.
- Si un nombre coincide con varias personas, Wobi pide el nombre completo y
  no consulta el contrato de ningún candidato al azar.
- Un campo vacío o `null` nunca se convierte en cero ni en una cifra inferida.
- Un error de Holded se presenta de forma genérica; el cuerpo de la respuesta
  no se entrega al usuario porque podría contener información personal.

## Límite actual del proveedor

La API pública v2 de Holded permite leer empleados y el contrato activo, pero
no publica endpoints para solicitudes de ausencia, aprobaciones, días usados
o saldo restante. Esos datos sí existen en la interfaz de Holded, en
`RRHH > Ausencias`, pero Wobi no usa cookies, scraping ni sesiones personales
en Railway para saltarse esta limitación.

Por eso la respuesta exacta a "cuántos días les quedan" usa un puente
sanitizado y restringido, separado del cashflow. La pestaña `Vacaciones`
contiene exactamente estas columnas:

`empresa`, `nombre`, `ano`, `dias_asignados`,
`dias_solicitados_pendientes`, `dias_aprobados`, `dias_usados`,
`dias_restantes`, `actualizado_en`.

`dias_usados` puede quedar vacío cuando la vista oficial del supervisor no
separa los días ya disfrutados de los días aprobados para fechas futuras.
Wobi omite entonces esa cifra: nunca la calcula ni la sustituye por cero.

Cualquier columna adicional bloquea toda la fuente para impedir que salario,
NIF, email, cuenta bancaria u otra información personal llegue al modelo por
error. La variable `HOLDED_RRHH_VACACIONES_SHEET_ID` identifica la hoja y
`WOBI_RRHH_MAX_AGE_HOURS` limita su vigencia (24 horas por defecto). Un registro
vencido, incompleto, duplicado o ambiguo nunca se usa para responder cifras.

La fuente debe actualizarse desde la vista o un informe oficial de Holded. No
se usan cookies, scraping ni sesiones personales en Railway. Si un nombre es
ambiguo, Wobi pregunta directamente al remitente del correo o a la persona que
hizo la consulta; no lo adivina ni traslada innecesariamente la pregunta a
Carlos.

La hoja se crea con un propietario humano dentro de Google Workspace y se
comparte solamente con la cuenta de servicio de Wobi como lector. Wobi no
recibe permisos para crear archivos, cambiar el acceso ni compartir la hoja.
