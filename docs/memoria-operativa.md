# Memoria operativa y autoajuste seguro

La memoria de WOBI no entrena un modelo con datos contables ni convierte cualquier respuesta en una regla. Conserva evidencia estructurada y determinista, separada por empresa y por el contexto mínimo que evita contaminar una operación con otra.

## Qué aprende

| Evidencia confirmada | Memoria | Uso posterior |
|---|---|---|
| Empresa y concepto confirmados para un proveedor | `_clasificaciones_aprendidas` | Mejora la propuesta de clasificación |
| Contacto real elegido para un proveedor y moneda | `_alias_proveedores_holded` | Resuelve el contacto correcto sin mezclar divisas |
| Cuenta contable corregida y comprobada en Holded | `_cuentas_corregidas_aprendidas` | Prioridad máxima, con vigencia acotada |
| Movimiento elegido entre candidatos ambiguos | `_movimientos_ambiguos_aprendidos` | Compatibilidad con el historial anterior |
| Toda conciliación confirmada y realmente enlazada | `_conciliaciones_verificadas_aprendidas` | Destaca el candidato más consistente por empresa, proveedor, moneda, cuenta y descripción bancaria |
| Instrucción futura y explícita del operador para un correo | `_instrucciones_correo_aprendidas` | Orienta propuestas posteriores del mismo remitente y tipo de asunto, sin ejecutar acciones por sí sola |
| Correcciones explícitas del operador | `_correcciones` | Contexto prioritario en consultas posteriores |

## Cuándo aprende

Una conciliación solo alimenta la memoria después de que la operación durable confirma en Holded que el movimiento quedó aplicado y enlazado al documento. No aprende de:

- propuestas todavía no aprobadas;
- búsquedas aproximadas sin decisión humana;
- timeouts o resultados inciertos;
- operaciones fallidas;
- coincidencias basadas únicamente en importe o cuenta bancaria.

Las instrucciones de correo se aprenden por una vía separada. Solo se guardan cuando el operador expresa de forma inequívoca que deben reutilizarse (por ejemplo, "siempre", "cada vez" o "de ahora en adelante"). Una orden puntual como "responde este correo hoy" no se convierte en regla. El contenido del correo o sus adjuntos nunca puede crear una regla de memoria: únicamente lo hace el texto escrito por el operador en el flujo de instrucciones específicas.

## Cómo se autorregula

- Empresa, proveedor y moneda deben coincidir exactamente antes de reutilizar un patrón.
- La cuenta bancaria refuerza una coincidencia, pero nunca basta por sí sola.
- Si dos candidatos obtienen la misma evidencia, ninguno se destaca.
- La memoria solo recomienda en una ambigüedad; el operador conserva la decisión financiera.
- Las escrituras financieras siguen usando idempotencia y verificación posterior. Una incertidumbre bloquea la repetición automática.
- Las reparaciones automáticas quedan reservadas a inconsistencias matemáticamente demostrables y acotadas, como el residuo de cambio de divisa ya validado por el flujo durable.
- Una instrucción de correo se limita por defecto al remitente y a la familia del asunto. Solo se amplía a todos los correos de ese remitente cuando el operador lo dice expresamente.
- "Ya no", "en vez de" o una corrección equivalente desactiva las reglas anteriores del mismo alcance y conserva su historial para auditoría.
- Las reglas aprendidas orientan la propuesta, pero no eliminan las aprobaciones, permisos, idempotencia ni verificaciones posteriores de cada operación real.
- Las instrucciones excesivamente largas no se convierten en reglas. Como máximo se cargan cinco reglas aplicables y se reutilizan durante dos minutos en memoria, sin abrir una llamada adicional de IA.

El comando `reporte_aprendizaje` muestra cuántas evidencias acumula cada mecanismo y cuáles están más reforzadas. Esto permite comprobar que el sistema aprende de casos reales sin ocultar las reglas que está aplicando.

## Comparaciones destinadas a registrar en cash flow

Por instrucción de Carlos, cuando la comparación se orienta a registrar movimientos faltantes,
usar `proponer_registro_cashflow` con la misma semana explícita del informe. Presentar las
opciones sin pedir otra escalada: área sugerida, «Elegir otra área» y «No registrar».
Abrir el selector conserva la propuesta y no escribe. Descartarla no borra nada de Holded ni
del banco. Solo la selección de registro activa el escritor existente, con relectura de duplicados.
Las conversiones bancarias entre divisas no reciben una sugerencia de gasto ordinario.
Solo se ofrecen áreas cuyo escritor está implementado; no anunciar registros que no se verificaron.
