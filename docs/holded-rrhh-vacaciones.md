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

Por eso la respuesta exacta a "cuántos días les quedan" exige una fuente
adicional soportada y autorizada. La opción recomendada es una exportación
sanitizada de Holded con nombre, solicitados, aprobados, restantes y fecha de
actualización, guardada en un origen de acceso restringido. Antes de crear ese
puente se debe definir quién lo actualiza, su caducidad y qué personas pueden
consultarlo.
