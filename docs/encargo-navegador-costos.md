# Consulta de costos desde el navegador — pendiente de backend

Carlos reportó: «dame los últimos costos o los costos de hoy». E1 ofrece lecturas de Seguros, no una lectura de costos. No es un fallo de dictado ni de despliegue: el contrato aún no cubre esa consulta.

Para Claude Code:

1. Preguntar exactamente: «¿Te refieres a los gastos contables de la compañía o a los costos de operación de WOBi?». Los costos de operación pueden incluir IA y otros servicios; precisar la cobertura disponible, sin asumir que IA representa todos los costos. no elegir silenciosamente ni confundirlos con cashflow.
2. Reutilizar las lecturas existentes, permisos y límites de consulta; no iniciar operaciones. Finanzas requiere admin/superadmin.
3. Definir hoy en Europe/Madrid y la moneda/unidad, compañía o alcance de grupo; indicar fuente, última lectura y calidad.
4. Si no existe lectura, responder explícitamente que no está disponible; nunca cero por fallo ni sumar monedas diferentes.
5. Registrar destino preciso y publicar contrato/fixture para que Codex construya la vista; el front no debe abrir un módulo genérico como si ya estuviera filtrado a hoy.
6. Pruebas: frase literal, ambigüedad, permisos, medianoche Madrid, fuente fallida/conservada y alcance por empresa. Cashflow WOBA/eWorks es conjunto; Footprint no tiene fuente propia.

No se activa IA nueva, no se cambian permisos ni se implementa backend en este PR.
