# Copias bancarias en Holded (aviso diario)

Pedido por Carlos el 15-10-2026: «se concilia una transacción y queda otra por conciliar» en WOBA Main (Revolut). Código: `core/holded/duplicadosBancarios.ts` (lógica pura; ya contenía el filtro que evita ofrecer la copia pendiente de un movimiento conciliado, caso Anthropic −21,63 € del 14-10), `core/jobs/duplicadosBancarios.ts` (lecturas reales y aviso), `core/jobs/duplicadosBancariosStore.ts` (lotes ya avisados, pestaña oculta `_duplicados_bancarios_avisados`).

**Qué se demostró (auditoría de solo lectura, 28 cuentas, 1.602 movimientos, 01-07 → 16-10).** Solo WOBA Main tenía copias reales: 16 pares, todas creadas en el mismo minuto (14-10 09:54 UTC) por el agregador del banco (`origin: bankin`, mismo `banking_account_id`). Wobi no crea movimientos bancarios: solo escribe `…/reconcile` sobre movimientos que ya existen y pagos de ajuste contra la cuenta interna Main; la sincronización diaria corre de 6:00 a 9:45 (Madrid) y llevaba más de 100 días sin generar copias.

**La huella.** Mismo día, importe y descripción que otro movimiento de la cuenta, creado ≥ 6 h después (la fecha de creación son los 4 primeros bytes hex del id de Holded), con un saldo corrido que difiere en una constante distinta del importe. Si el saldo difiere exactamente en el importe, son dos cargos reales seguidos y nunca se marca. Solo se avisa de un LOTE: ≥ 2 pares con el mismo desfase creados en una ventana de 30 minutos.

**Qué hace.** Laborables a las 10:05 (tras cerrar la sincronización de las 9:45) lee 45 días de movimientos de las cuentas con banco enlazado y avisa a los administradores una sola vez por lote, sin botones. No concilia, no borra, no escribe en Holded. Un fallo de lectura de una cuenta se registra y se omite; nunca se toma como «sin copias».

**Límites conocidos.** Un par aislado (sin lote) no se avisa: no se distingue de un segundo cargo real publicado otro día. El filtro de ofrecimiento existente solo cubre la copia pendiente de un original ya CONCILIADO; las parejas con ambos pendientes (4 en el caso real) y la copia que Holded concilió sola (−350 € de Business Atelier) no están cubiertas por él.

**A demanda.** `POST /admin/duplicados-bancarios` (cabecera `x-admin-secret`): simula por defecto; con `{"simular": false}` avisa y marca.

**Coste.** Sin IA. Una lectura de cuentas por empresa y los movimientos de 45 días de cada cuenta con banco, una vez al día.
