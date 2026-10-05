# Encargo para Codex — panel de Seguros en el Núcleo de WOBi

Pedido de Carlos (05-10-2026): que **toda la información de Seguros esté actualizada y completa en el front**. Seguros es un área de WOBi con un agente independiente (Wobi Seguros, `docs/wobi-seguros.md` §24 a §26). Claude Code ha dejado listos y probados los datos; este encargo es solo el front.

## Reparto, para no pisarnos

- **Claude Code (backend, ya hecho):** qué datos entrega Seguros. Contrato en `core/seguros/estadoCerebro.ts` (la forma exacta, comentada) y un ejemplo real en `docs/ejemplos/estado-seguros.json`. Si el front necesita un dato que no está, **se pide a Claude Code**; el front no recalcula nada de seguros ni lee Sheets.
- **Codex (front):** dibujar esos datos en el Núcleo, con el diseño y las reglas que ya existen. Archivos: `frontend-cerebro/`. No tocar `core/`.
- Antes de empezar: leer `docs/trabajo-en-curso.md` y añadir tu fila (área «Cerebro (front)»). Rama sugerida: `codex/seguros-panel`, un solo PR.
- **Los datos ya están en `main` y desplegados** (PR #355: el vigilante, el agente y el contrato de datos llegaron juntos). Parte de `origin/main` actual, construye contra el JSON de ejemplo y verifica en vivo con `GET /api/cerebro/estado`.

## Lo que hay hoy y está mal (comprobado en producción el 05-10-2026)

1. «Pólizas activas: 9» cuando solo 6 están vigentes: cuenta una vencida y dos en hold. (`App.jsx` → `SegurosContenido` y `modules/nucleo/companyScope.mjs`, que recalcula el contador con `estado !== 'no_contratada'`.) El backend ya devuelve `totalPolizasActivas` = vigentes y `resumen`.
2. El distintivo de cada póliza muestra solo el estado de PAGO: una póliza con `estado: pendiente_confirmacion` (en hold) aparece como «No aplica», y la vencida como «Pagado».
3. No se ven los próximos pagos y vencimientos, los documentos que Wobi Seguros ya leyó, lo que espera a Carlos, lo que el vigilante encontró, ni la memoria del agente.
4. Las notas de cada póliza son un bloque de texto largo; el estado actual va en la primera frase y la historia detrás, separada por ` || `.
5. No hay forma de preguntarle a Wobi Seguros desde el panel.

## Qué entregar (por prioridad)

**P1 — Contadores y distintivos veraces.**
- Distintivo de cada póliza por este orden: `estado === 'no_contratada'` → «No contratada»; `'vencida'` → «Vencida»; `'pendiente_confirmacion'` → «En hold / por confirmar»; si no, el de pago (`pagado` verde; `pendiente` y `sin_confirmar` ámbar; `no_aplica` neutro).
- «Pólizas vigentes» = `resumen.vigentes`. El resumen superior usa `resumen` (vigentes · sin confirmar el pago · en hold/por confirmar · vencidas). `companyScope.mjs` debe contar con `estado === 'vigente'` y filtrar también `proximos` por empresa (`esperandoACarlos`, `memoria` y `vigilante` son del grupo entero: rotularlos como conjuntos, igual que haces con correo y conocimiento).

**P2 — «Atención ahora».** Un bloque, arriba, solo si hay algo:
- Pagos sin confirmar (`pagosSinConfirmar`), con importe y póliza.
- Cargos en tránsito de la última revisión (`vigilante.ultimaRevision.enTransito`): son cargos del banco que Holded muestra pero el saldo aún no refleja. **No son pagos hechos**: texto «aún no confirmado por el banco».
- Lo que espera a Carlos (`esperandoACarlos`, con `diasEsperando`).
- Si `vigilante.ultimaRevision.advertencias` no está vacío, mostrarlo como «revisión incompleta».

**P3 — «Próximos pagos y vencimientos».** `proximos` (ya ordenado, con `diasRestantes`, `tipo` vencimiento/pago, empresa y póliza). Destacar los de ≤ 60 días; el resto («próximos 12 meses») plegado. Un mismo hito puede venir como vencimiento (de la póliza) y como pago (de la renovación) con 1 o 2 días de diferencia: agrúpalos por `polizaId`. Si está vacío, decir «ningún pago ni vencimiento anotado», no dejarlo en blanco.

**P4 — Tarjeta de póliza.** Estado actual en la primera frase de `notas` (hasta el primer ` || `), visible; el resto, bajo «ver historia». Debajo, los documentos leídos de esa póliza (`documentos` con `polizaId`): nombre, tipo, vigencia, prima, capital, resumen corto y enlace de Drive. Conservar tal cual el botón en dos pasos «marcar como pagado» (`/api/cerebro/seguros/marcar-pago`) y el aviso de sus errores.

**P5 — «Lo que Wobi Seguros recuerda».** `memoria` (decisiones, reglas, contactos y hechos vigentes), plegado, solo lectura, agrupado por `tipo`. Es lo que el agente usa para no volver a preguntar lo que Carlos ya decidió.

**P6 — «Preguntar a Wobi Seguros».** Botón que reutiliza el diálogo «copiar y abrir Telegram» de `TelegramHandoff.jsx` con consultas preparadas, por ejemplo: «¿Tenemos algo pendiente de seguros?», «¿Cuándo toca pagar lo siguiente?», «¿Qué cubre la RC de WOBA?», «¿Qué le falta pedirle a Acodrid?». El usuario decide qué enviar; no se manda nada solo.

**P7 — Frescura honesta.** Si `complementosDisponibles === false`, `esperandoACarlos`, `memoria`, `documentos` y la última revisión vienen a `null`: mostrar «Sin lectura actual» en esas partes, nunca un cero ni una lista vacía. Mostrar «última revisión del vigilante: hoy 08:35» (`vigilante.ultimaRevision.fecha`) y los `horarios`; si la última revisión es de hace más de 24 h, decirlo.
  - **Dos «null» distintos en `vigilante.ultimaRevision`:** con `complementosDisponibles === false` es «Sin lectura actual»; con `complementosDisponibles === true` significa que aún no se ha registrado ninguna revisión (entorno nuevo): decir «Aún sin revisión registrada», no «Sin lectura actual».
  - `ultimaRevision.enTransito` es la situación de ahora (todos los cargos que siguen sin confirmar, no solo los recién vistos), así que sirve tal cual para «Atención ahora».

## Cómo hacerlo

- Seguros sale de `App.jsx` a su propio módulo, como pide `docs/principios-de-construccion.md` (es el primer caso previsto): `frontend-cerebro/src/modules/seguros/` (`SegurosPanel.jsx` + helpers `.mjs` sin JSX para poder probarlos). `App.jsx` solo importa y monta; el resto del archivo no se toca.
- Reglas del Núcleo que ya has fijado y aplican aquí: foco y Escape en diálogos, movimiento reducido, partículas que nunca tapan texto, tarjetas expandibles con teclado, color por área. No inventar métricas: todo sale de los datos.
- Sin endpoints nuevos. Se usa el estado que ya llega (`snapshot.seguros`) y los endpoints existentes.

## Pruebas y verificación

- Actualizar `frontend-cerebro/src/companyScope.test.mjs` (contador por vigentes, filtro de `proximos`). Pruebas nuevas de los helpers con `docs/ejemplos/estado-seguros.json` como fixture: distintivo por estado, primera frase de las notas, agrupación de memoria, ≤ 60 días, `null` ⇒ «Sin lectura actual».
- `npm test` y `npm run build`.
- En vivo (los datos ya están desplegados): `GET /api/cerebro/estado` debe traer `seguros.resumen.vigentes = 6`, `seguros.proximos` con 11 entradas, `seguros.memoria` con 16, `seguros.esperandoACarlos` con 3 y `seguros.documentos` con 2; el panel debe mostrar 6 vigentes, el recibo de Markel de 323,24 € como sin confirmar, y el cargo en tránsito. Captura de pantalla de las tres vistas (WOBA, eWorks, Footprint) y de «Sin lectura actual» simulando `complementosDisponibles: false`.

## Fuera de alcance

Marketing/otras áreas, el flujo de pagos (el botón «marcar como pagado» no cambia), y cualquier cálculo de seguros en el navegador.
