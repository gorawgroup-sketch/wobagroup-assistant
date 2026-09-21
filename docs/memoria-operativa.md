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
| Correcciones explícitas del operador | `_correcciones` | Contexto prioritario en consultas posteriores |

## Cuándo aprende

Una conciliación solo alimenta la memoria después de que la operación durable confirma en Holded que el movimiento quedó aplicado y enlazado al documento. No aprende de:

- propuestas todavía no aprobadas;
- búsquedas aproximadas sin decisión humana;
- timeouts o resultados inciertos;
- operaciones fallidas;
- coincidencias basadas únicamente en importe o cuenta bancaria.

## Cómo se autorregula

- Empresa, proveedor y moneda deben coincidir exactamente antes de reutilizar un patrón.
- La cuenta bancaria refuerza una coincidencia, pero nunca basta por sí sola.
- Si dos candidatos obtienen la misma evidencia, ninguno se destaca.
- La memoria solo recomienda en una ambigüedad; el operador conserva la decisión financiera.
- Las escrituras financieras siguen usando idempotencia y verificación posterior. Una incertidumbre bloquea la repetición automática.
- Las reparaciones automáticas quedan reservadas a inconsistencias matemáticamente demostrables y acotadas, como el residuo de cambio de divisa ya validado por el flujo durable.

El comando `reporte_aprendizaje` muestra cuántas evidencias acumula cada mecanismo y cuáles están más reforzadas. Esto permite comprobar que el sistema aprende de casos reales sin ocultar las reglas que está aplicando.
