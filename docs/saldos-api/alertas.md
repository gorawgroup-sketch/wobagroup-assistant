# Alertas de saldo API

Control diario muestra OpenAI y Anthropic por separado. El saldo se registra desde una consulta humana de facturación, con fecha y umbral (5 USD inicial). No conecta suscripciones ChatGPT/Claude con crédito API ni realiza recargas.

La estimación resta únicamente gastos con autenticación explícita del proveedor, posteriores a la lectura. No cubre consumos externos a WOBA. Lecturas de más de 24 horas, ausentes o fuentes de consumo fallidas exigen verificar; no significan saldo cero. Estimación <= umbral genera recomendación alta; <= 1 USD crítica. La alerta permanece en el diagnóstico mientras la condición existe, sin enviar mensajes externos.

El administrador guarda lecturas mediante el formulario de Control diario; POST /api/cerebro/control-diario/saldos exige la clave maestra existente. El historial de observaciones queda en _saldos_api usando el almacén compartido de Sheets. No se almacena ninguna clave de proveedor.

Validación: tipos, build completo, pruebas de umbrales/frescura/datos inválidos; servidor compilado reproduce 401, 400 y ausencia de fuente sin saldo inventado.
