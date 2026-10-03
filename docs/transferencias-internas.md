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

### Recuperación

- **Fallida con asiento creado y movimientos sin conciliar:** el asiento se puede borrar en Holded (Contabilidad → Libro
  diario) o conciliar a mano contra él. Después, marcar la propuesta como revisada.
- **Verificación que no cuadra por líneas de más:** parar; revisar en el libro diario de las dos cuentas contables qué
  asiento adicional apareció. No se procesa ninguna otra pareja hasta entenderlo.
- **Volver a observación:** `WOBI_TRANSFERENCIAS_MODO=observacion` (o quitar la pareja de `WOBI_TRANSFERENCIAS_CASOS`).

### Estado de la validación

Lo que aún no está demostrado en Holded real: que conciliar un movimiento contra un asiento manual (`entry`) deje el mismo
resultado que «Transferir» en la interfaz, sin generar asientos adicionales. Eso es lo que comprueba la **prueba
controlada** con un único par EUR↔EUR pequeño, con autorización escrita de Carlos. Hasta entonces el modo es `apagado` u
`observacion` y nada escribe.

## Lo que falta (cada paso con autorización de Carlos)

1. **Prueba controlada**: un único par EUR↔EUR pequeño e inequívoco. Si cualquier verificación falla, se detiene y no se
   prueba otro par.
2. **Resto de transferencias en la misma moneda**, una vez validada la prueba.
3. **Conversiones de moneda**: diferencias de cambio y comisiones contra las cuentas reales del plan contable de cada
   empresa (668/768 y la de comisiones), nunca asumidas. El ejecutor las rechaza hasta entonces.
4. **Pasada programada** en el servidor para proponer sin que haya que pedirlo.
