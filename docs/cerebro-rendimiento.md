# Panel /cerebro: carga rápida y siempre al día

## Qué pasaba (medido en producción, 2026-09-25)

- Los archivos del front cargan en menos de 1 s. La espera era la consulta `/api/cerebro/estado`: 0,4 s con caché, **26–38 s en frío** y hasta 115 s si llegaba un aviso a mitad de lectura.
- ~23 de esos segundos eran dos conteos de Holded a 90 días («gastos sin comprobante»: una llamada por compra, en serie; «movimientos sin conciliar»: una por cuenta).
- Al entrar, el front forzaba la lectura y bloqueaba la pantalla hasta recibirla; cada aviso en tiempo real (tareas programadas, mensajes de Telegram) hacía que **cada pestaña abierta forzara otra lectura completa**, y una invalidación durante la lectura la descartaba y la repetía.

## Cómo funciona ahora

| Pieza | Archivo | Qué hace |
|---|---|---|
| Caché «servir lo último y refrescar detrás» | `core/cerebro/seccionSWR.ts` | Quien lee recibe al instante lo último; lo vencido o invalidado se recalcula detrás (single-flight). Las invalidaciones se **coalescen**; una lectura completada nunca se descarta. Si falla, se conserva la anterior. |
| Orquestador | `core/cerebro/estadoOrquestador.ts` | 10 secciones con caché propia (cashflow, holded, crm, correo, drive, conocimiento, usuarios, controlDiario, auditoria, conexiones). Mantenimiento cada 15 s si alguien mira el panel (o cada 5 min sin nadie); precalentamiento al arrancar. «Actualizar» fuerza solo las ligeras (~3 s) y una orden dentro de los 5 s de otra se atiende con lo ya calculado. |
| Conteos pesados | `core/cerebro/conteosHolded.ts` | Se calculan aparte, en segundo plano, cada 15 min; el panel muestra el último valor **con su fecha** (`holded.conteosActualizadoEn`). `null` = «calculando», nunca un cero inventado. |
| Lecturas de Holded en paralelo | `core/holded/write.ts`, `core/holded/client.ts` | Adjuntos por compra (6 a la vez) y cuentas (3 a la vez): mismos resultados y orden que en serie (verificado contra Holded real). |
| Front | `frontend-cerebro/src/App.jsx`, `snapshotLocal.js`, `refreshCoordinator.js` | Al recargar pinta al instante la última lectura guardada (misma sesión, máx. 12 h, con su antigüedad) y pide la actual sin forzar. **Solo el botón «actualizar» fuerza.** Si el servidor responde `refrescando: true` se vuelve a leer a los 2,5 s, 5 s… (máx. 6). |

`cacheadoEn` es ahora la antigüedad del dato **más antiguo** de todas las secciones. La respuesta incluye `refrescando` y, al terminar un recálculo provocado por una invalidación, se publica un único aviso `estado_actualizado` por el stream.

`/health` incluye `panelCerebro` con la antigüedad de cada sección y de los conteos (sin datos de negocio).

## Invalidar secciones

`invalidarEstadoCerebro()` marca todas las secciones ligeras; `invalidarEstadoCerebro(["usuarios"])` solo las indicadas. Nunca bloquea: agenda un recálculo coalescido y avisa cuando termina.

## Límites conocidos

- Tras un despliegue la caché está vacía hasta el precalentamiento (~10 s); los dos conteos pesados tardan ~25 s más y se muestran como «calculando…». Persistir el estado calculado en PostgreSQL (fase 2) eliminaría también esa espera.
- Una pestaña con el front antiguo sigue forzando en cada aviso; el servidor lo amortigua (una orden forzada dentro de los 5 s de otra no recalcula).
