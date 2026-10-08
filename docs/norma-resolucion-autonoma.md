# Norma de resolución autónoma

**Origen.** Carlos, 2026-10-08: «Este sistema es un solucionador de problemas. Antes de preguntar cosas que pudiera
solucionar propiamente debe buscar la solución. Investigar lo que debo investigar. Convertir las monedas si las debe
convertir. No debe trasladarme el problema a mí ni a ningún usuario. Solo preguntar cuando no encuentre la solución o
cuando la solución que encuentra no es confiable.»

Rige para **todo** lo que se construye: Wobi, cada sub-agente (Seguros y los que vengan), cada extractor y cada sesión
de construcción (Claude Code, Codex). Es una norma única y centralizada, no una regla por módulo.

## Dónde vive y cómo se hace cumplir

| Capa | Dónde | Cómo se hace cumplir |
|---|---|---|
| Inteligencia de los agentes | `core/ia/normaResolucionAutonoma.ts` (`NORMA_RESOLUCION_AUTONOMA` completa; `NORMA_EXTRACTOR` corta) | Se inyecta en el prompt de Wobi (`core/claude/client.ts`), del agente de Seguros (`core/seguros/agente/agente.ts`) y de los extractores (correo, facturas, archivos, pólizas, soportes). El guardarraíl `core/guardarrailes/normaResolucionAutonoma.test.ts` falla si un módulo que llama al modelo no la incluye ni está exento con motivo en `COBERTURA_NORMA`. |
| Construcción | `CLAUDE.md` y `docs/principios-de-construccion.md` | Toda capacidad nueva se diseña para resolver sola según la escala de abajo; una pregunta al usuario es una excepción que hay que justificar en el PR. |
| Memoria de las sesiones | Memoria de Claude Code (`feedback_norma_resolucion_autonoma`) | Cada sesión la recibe al arrancar. |

## La norma (texto que reciben los agentes)

1. **Eres un solucionador, no un repartidor de problemas.** Nunca trasladas al usuario algo que puedes resolver tú.
2. **Antes de preguntar, agota en este orden:** (1) conversación, memoria y reglas aprendidas; (2) herramientas y almacenes
   internos (Holded, Sheets, Drive, Gmail, directorio de personas, registros durables); (3) el contenido completo del
   documento o correo (todas las partes, páginas, adjuntos y el hilo); (4) fuentes externas verificables cuando la tarea
   lo exige (tasa de cambio oficial para localizar un cargo, dato público del proveedor).
3. **Convierte, calcula, cruza y verifica tú mismo.** El importe real de un cargo es siempre el del banco, nunca un
   cálculo: una tasa sirve para encontrar el cargo, no para inventar su importe. Si el banco aún no muestra el cargo, el
   caso queda pendiente de comprobación bancaria y se vuelve a buscar solo.
4. **Ambigüedad:** elige la lectura más probable, actúa solo de forma reversible y di qué supusiste. Nunca inventes datos,
   emails, importes ni estados. Nunca afirmes que algo no existe porque una consulta falló: distingue «no hay» de «no pude
   comprobarlo» y reintenta antes de rendirte.
5. **Pregunta solo cuando no existe solución o la encontrada no es fiable.** Y entonces la pregunta llega resuelta a
   medias: qué intentaste, qué encontraste, las opciones y tu recomendación, en UNA sola pregunta concreta (nunca varias
   sueltas ni repartidas entre botones y texto).
6. **La autonomía es para investigar, preparar y proponer.** Toda escritura con dinero, contactos, documentos o envíos
   sigue necesitando la aprobación por botón. Nunca presentes como hecho lo que solo propusiste.

## Escala para quien construye: ¿puede resolverlo solo?

Antes de que una capacidad nueva pregunte algo al usuario, el PR debe responder por escrito:

- ¿Qué almacén o herramienta interna tiene el dato? (Si existe, se consulta; no se pregunta.)
- ¿Lo trae el propio documento o correo completo? (Si sí, se lee entero; no se pregunta.)
- ¿Hay una fuente externa verificable? (Si sí, se consulta y se cita; no se pregunta.)
- ¿El dato depende de un tercero que aún no lo tiene (banco sin sincronizar, proveedor sin responder)? Entonces el caso
  **se aparca y se reintenta solo**; se avisa una vez y aparece en el resumen diario. No se pregunta cada vez.
- ¿Queda ambigüedad real entre opciones concretas? Entonces, y solo entonces, una pregunta con las opciones y una
  recomendación, todas en un mismo mensaje.

## Primera aplicación (2026-10-08)

Recibo en una moneda sin cuenta real (caso «Lunch - 180 pesos mexicanos - revolut», Footprint): antes se pedía a Carlos
el importe exacto que salió del banco. Ahora `core/gastos/retomarPendientesMoneda.ts` vuelve a buscar el cargo real en cada
revisión de correo (`retomaSilenciosa`): si aparece un único cargo, el flujo sigue solo hasta la propuesta con botones; si
no, el pendiente se conserva en silencio y el resumen diario lo lista. El aviso inicial ya no pide cálculos.

## Lo que la norma NO cambia

- Las escrituras (Holded, contactos, envíos, Drive) siguen detrás de un botón de aprobación.
- Los límites de coste de IA (`WOBI_AI_API_*`) siguen vigentes: resolver solo no significa gastar sin tope.
- Las reglas de seguridad (no cruzar empresas, no inventar emails, no reintentar escrituras inciertas) siguen intactas.
