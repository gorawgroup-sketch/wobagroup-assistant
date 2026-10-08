# Transferencias internas y conversiones entre cuentas de la misma empresa

Estado: **fases 1 y 2 construidas; ejecución apagada por defecto**. Sin autorización escrita no se escribe nada en Holded.

## Por qué

Un traspaso entre dos cuentas de la misma empresa (o un cambio de moneda) aparece en Holded como dos movimientos
bancarios sin conciliar: una salida y una entrada. No son un gasto ni un ingreso. Hasta ahora había que emparejarlos a
mano; el 03-10-2026 había 22 operaciones así pendientes entre WOBA, eWorks y Footprint.

## Piezas (carpeta `core/holded/transferencias/`)

| Archivo | Qué hace |
|---|---|
| `deteccion.ts` | Reglas puras y deterministas (sin IA, sin red): empareja salida y entrada y decide la confianza. |
| `lectura.ts` | Lee cuentas y movimientos de Holded (solo GET) y las tasas del día, y llama a la detección. |
| `informe.ts` | Texto del informe de observación. |
| `scripts/holded-transferencias.ts` | Simulación en vivo. Bloquea cualquier petición a Holded que no sea GET. |

Reutiliza `core/holded/client.ts` (lectura paginada de movimientos) y `core/utils/exchangeRate.ts` (tasas históricas).

## Reglas

- **Nunca entre empresas.** WOBA, eWorks y Footprint son sociedades distintas; cada una se analiza por separado y un pago
  entre ellas no es una transferencia propia.
- **Cuentas que participan:** bancarias (`type=bank`), no archivadas y sincronizadas en los últimos 3 días. Las pasarelas
  (`gateway`) y las tarjetas quedan fuera. Las cuentas se descubren por API en cada ejecución.
- **Movimientos que participan:** `pending` con `reconciled_amount = 0`.
- **Transferencia (misma moneda):** importe idéntico al céntimo, como mucho 2 días hábiles entre las dos patas, y **las dos
  descripciones** deben nombrar a la propia empresa (su razón social, o «transferencia propia»), o ser un traspaso interno
  del mismo banco con la misma descripción en ambas patas («To Eur Main»).
- **Conversión (monedas distintas):** el banco debe declararla igual en las dos patas («Exchanged To Eur Main»,
  «Converted Usd To Eur»), la moneda declarada debe ser la de destino, y las fechas distar un día como mucho. Se compara
  el valor en EUR de cada pata (`accounting_amount` de Holded) y la tasa aplicada con la del día: hasta 1 % inequívoca,
  hasta 3 % a revisión, por encima bloqueada. Sin tasa histórica, sin valoración de Holded o entre bancos distintos: revisión.
- **Asignación global:** ningún movimiento se usa dos veces. Si un movimiento encaja con más de una pareja, todas las
  parejas implicadas quedan bloqueadas para revisión humana.
- **Cadenas:** una conversión seguida de un traspaso son dos operaciones separadas; no se fusionan ni se inventan diferencias.

Casos reales que estas reglas separan bien: el mismo día y por 1.900 €, WOBA tenía una transferencia propia y un préstamo
de eWorks; un cobro de «Business Atelier Agency» de 6.000 € junto a una transferencia propia de 6.000 €.

## Cómo ejecutarlo

```bash
railway run --service wobagroup-assistant -- npx tsx scripts/holded-transferencias.ts 40
```

Imprime las operaciones detectadas por empresa y, al final, cuántas lecturas hizo a Holded (las escrituras son siempre 0).

## Fase 2 — registro, propuestas y ejecución (apagada por defecto)

| Archivo | Qué hace |
|---|---|
| `modo.ts` | Interruptor `WOBI_TRANSFERENCIAS_MODO` (`apagado` por defecto, `observacion`, `activo`) y lista `WOBI_TRANSFERENCIAS_CASOS` de parejas autorizadas por escrito (`Empresa:movOrigen>movDestino`). |
| `registro.ts` | Pestaña `_transferencias_internas`: una fila por pareja ordenada, con estado (detectada, propuesta, aprobada, ejecutando, verificada, ambigua, fallida, saltada, descartada, revision_manual), versión de la regla y el id del asiento. |
| `telegram.ts` | Propuestas con botones («Conciliar transferencia», «Saltar por ahora», «No es una transferencia», «Revisar manualmente») y su manejador. Máximo 5 propuestas por pasada. |
| `ejecucion.ts` | Ejecuta UNA transferencia en la misma moneda y la verifica. |
| `core/tools/transferenciasInternas.ts` | Tool de chat `revisar_transferencias_internas`. |

### Cómo se concilia (por ahora, solo EUR)

Leído de una transferencia real conciliada a mano en la interfaz (WOBA, 02/09/2026, asiento 3126): Holded deja **un único
asiento**, debe la cuenta contable del banco de destino y haber la del banco de origen, y los dos movimientos conciliados.
El ejecutor reproduce eso por API:

1. Relee las dos cuentas y los dos movimientos (con ventana de ±3 días: la consulta de un único día exacto a veces
   devuelve vacío) y **repite la detección**: la pareja debe seguir siendo inequívoca. Si algo cambió (ya conciliado,
   importe distinto, cuenta archivada, no EUR, sin cuenta contable 572/520, otro candidato), no escribe nada y la deja en
   revisión manual.
2. Guarda el estado `ejecutando` **antes** de escribir.
3. `POST /ledger-entries`: debe destino / haber origen, con la marca `[wobi:transferencia:<id>]`. Guarda el id del asiento
   (y lo deja en el registro del servidor). Si Holded rechaza la petición sin crear nada (4xx o la guardia de escrituras),
   la propuesta vuelve a estar disponible.
4. `POST …/reconcile` del movimiento de destino y del de origen contra ese asiento (`document_type: entry`).
5. Verifica por lectura: los dos movimientos conciliados con su importe; el asiento, leído por su id, con exactamente esas
   dos líneas; y que en cada cuenta contable solo apareció UNA línea nueva entre tres días antes de los movimientos y
   mañana (así se ve también un asiento que Holded fechara hoy).

Nunca se reintenta una escritura. Si un paso falla o el proceso se corta, la operación queda `fallida`; el botón
«Verificar cómo quedó en Holded» (siempre en un mensaje nuevo: cada botón de Telegram se atiende una sola vez) solo lee, y
si el id del asiento no llegó a guardarse lo busca por la marca. Un `POST …/reconcile` con cuerpo vacío nunca se usa.

Las transferencias en otra moneda (USD↔USD, COP↔COP) y las conversiones se proponen pero no se ejecutan: el asiento se
escribe en EUR y falta su valoración contable. Las parejas bloqueadas por ambigüedad se publican sin el botón de conciliar.

### Cómo se ejecuta (método vigente desde el 05-10-2026)

Igual que a mano en Holded, en dos pasos:

1. **«Transferir» en la interfaz** sobre el movimiento de ENTRADA, eligiendo la cuenta contable del banco de origen. Lo pulsa
   el robot de navegador (`navegadorTransferencia.ts`, sobre `core/holded/automatizacion/navegadorHolded.ts`): Tesorería →
   cuenta → Conciliación (`/banking/accounts/<id>/reconcile`) → fila con `data-id` = id del movimiento → «Transferir» →
   «Transferir a cuenta contable» → cuenta contable → «Transferir y conciliar». Holded crea un asiento numerado (debe destino /
   haber origen), concilia ese movimiento y deja un cobro y un pago enlazados (`GET /payments`: `document_type: "trans"`,
   `document_id` = movimiento pulsado).
2. **La salida se concilia por la API** contra ese pago (`document_type: "payment"`), que queda pendiente en la cuenta de origen.

Lo ocurrido se decide siempre leyendo: si el cobro y el pago existen, el paso 1 no se repite jamás. Se verifican los dos
movimientos conciliados, el cobro y el pago conciliados y un único asiento nuevo en las dos cuentas contables.

**Método descartado (prueba del 05-10-2026, WOBA 350 €):** crear el asiento con `POST /ledger-entries` y conciliar contra él
(`document_type: "entry"`). El asiento queda sin número y Holded responde 200 sin enlazar nada. La API pública no ofrece
«Transferir» (`POST /payments` no admite cuenta de contrapartida).

### Recuperación

- **Asiento suelto del método descartado:** mientras exista, el ejecutor no hace nada y pide borrarlo en Holded
  (Contabilidad → Libro diario). Wobi no borra asientos.
- **El robot no llegó a pulsar el botón final** (elemento no encontrado, sesión caducada, navegador ocupado): no se
  escribió nada; la propuesta vuelve a estar disponible.
- **Se pulsó pero Holded no muestra la transferencia, o la verificación no cuadra:** queda `fallida`; el botón
  «Comprobar en Holded y continuar» relee y solo termina lo que falte.
- **Volver a observación:** `WOBI_TRANSFERENCIAS_MODO=observacion` (o quitar la pareja de `WOBI_TRANSFERENCIAS_CASOS`).

### Estado de la validación

**Validado por Carlos el 05-10-2026** con la prueba WOBA 01/10, Main → BBVA, 350 €: los dos movimientos conciliados, cobro
y pago conciliados y un único asiento tipo «Cobro» (debe 57200001 / haber 57200015), revisado por él en Holded.

Desde entonces, con `WOBI_TRANSFERENCIAS_MODO=activo` y `WOBI_TRANSFERENCIAS_ALCANCE=eur`, cualquier transferencia EUR↔EUR
inequívoca se ejecuta al pulsar su botón, sin autorización escrita pareja a pareja. Las conversiones se proponen sin botón
de conciliar.

### Conversiones de moneda

Igual que se vienen haciendo a mano (leído de conversiones reales de Footprint y eWorks, jun–ago 2026):

1. «Transferir» se pulsa sobre la **SALIDA**, con la cuenta contable del banco de destino. Holded crea el asiento por el valor
   en EUR de la salida (debe destino / haber origen), un pago conciliado en origen y un cobro pendiente en destino.
2. La **entrada** se concilia por la API contra ese cobro. Si vale menos en EUR que la salida, el cobro queda
   `partial_reconciled` con la diferencia de cambio pendiente; así es como queda también a mano.

3. **Diferencia a favor** (la entrada vale MÁS en EUR que la salida): **no se ejecuta** (decisión de Carlos, 08-10-2026). Una
   transferencia entre cuentas propias no toca ninguna cuenta de comisiones o de diferencias (ni la 62600000 ni la pasarela
   «Comision cambio/cobro cliente» de Footprint, que deja un pago pendiente sin movimiento que conciliar). La propuesta sale sin
   botón de conciliar y con el motivo. Criterio nuevo pedido por Carlos y **pendiente de construir**: entre divisas distintas se
   ajusta la tasa de cambio de la propia transferencia (referencia: la tasa de Holded de ese día) para que lo que sale sea lo que
   entra, sin ajustes en otras cuentas; en la misma divisa los importes son exactos.

Los traspasos en una misma moneda distinta del euro (USD↔USD) se ejecutan igual que una conversión (pulsar sobre la salida; valoración en euros de Holded). Límites actuales: diferencia máxima 3 % entre las valoraciones en euros de las dos patas (Holded valora en euros también las patas en otra moneda: USD → COP vale igual). Primera USD → COP pendiente de verificar en vivo (Footprint 11/09, 0,71 € a favor). **Validado por Carlos el 05-10-2026**
(eWorks 02/09, −433,96 EUR → +500 USD: asiento único de 433,96 €, los dos movimientos conciliados y 2,11 € de diferencia
pendientes en el cobro). Con `WOBI_TRANSFERENCIAS_ALCANCE=eur,conversiones` las conversiones dentro de estos límites llevan
botón de conciliar; las demás se proponen sin botón y con el motivo.

### Carril propio

La ejecución corre en segundo plano y en su propia cola (una transferencia cada vez, en el orden en que se pulsaron): el
chat queda libre para correos, gastos y otras conciliaciones. El navegador del robot es único: si lo ocupa la sincronización
de bancos o la conversión de tickets, la transferencia espera su turno (hasta ~6 min) y, si no lo consigue, queda disponible
sin haber escrito nada. Un despliegue en mitad de una transferencia la deja «a medias»: al pedir de nuevo la revisión se
ofrece «Comprobar en Holded y continuar», que lee antes de actuar.

## Lo que falta (cada paso con autorización de Carlos)

1. **Conversiones entre divisas ajustando la tasa de cambio** (sin residuos y sin cuentas de diferencias): hay que ver cómo lo
   permite la pantalla «Transferir» de Holded antes de construirlo.
2. **Pasada programada** en el servidor para proponer sin que haya que pedirlo.

## Varias conversiones el mismo día: emparejar por valor, no por descripción (2026-10-08)

Caso real, Footprint 07-10: el banco repite «Exchanged To Eur Main» en todas sus conversiones del día. Con dos salidas (−9.070,62 USD y −2.237,96 USD) y dos entradas (+8.100 EUR y +2.000 EUR) el detector formaba las 4 combinaciones y, al repetirse cada movimiento, bloqueaba las cuatro por «ambiguo»: Carlos recibía mensajes sin botón de conciliar. Las dos parejas buenas diferían un 0,31 % y un 0,39 % de la tasa del día; los dos cruces, un 75 %.

- `detectarTransferencias`: una pareja cuyo valor en EUR o tasa se desvía más del límite (bloqueada ya en `evaluarPareja`) **no cuenta como competidora** si alguno de sus movimientos tiene otra pareja plausible; se descarta. Si no la tiene, se conserva bloqueada (una conversión realmente rara no desaparece). Dos candidatas plausibles para el mismo movimiento (dos entradas de 2.000 € para una misma salida) siguen siendo ambiguas: no se elige al azar. Las transferencias de la misma moneda no cambian.
- `reapertura.ts` + `telegram.ts`: una pareja registrada como «ambigua» que ahora ya no está bloqueada se **reabre** (se retira el mensaje viejo y se propone con botón, si está autorizada por el alcance). Los registros «ambigua» que la detección ya no devuelve pasan a «saltada» (si vuelven, se proponen de nuevo) y su mensaje se deja sin botones con el motivo.
- Verificado en vivo (solo lectura): Footprint pasó de 4 bloqueadas a 2 inequívocas.
